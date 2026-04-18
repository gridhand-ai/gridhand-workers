'use strict';

// ─── Credential Monitor Agent ────────────────────────────────────────────────
//
// Watches all client OAuth tokens in client_integrations.
// Runs every 6 hours (wired in server.js). Manual trigger via:
//   POST /agents/credential-monitor  (requireApiKey)
//
// Per-token logic:
//   1. If already expired → sendCriticalAlert (Telegram)
//   2. If expiring within 7 days + has refresh_token → attempt auto-refresh
//      - Google: POST https://oauth2.googleapis.com/token
//      - Success → update row with new access_token + token_expires_at
//      - Failure → flag as critical, send alert
//   3. If expiring within 7 days + no refresh_token → SMS MJ via NOTIFY_PHONES
//
// Never throws — all errors are caught and logged. Server stays alive.

const { createClient } = require('@supabase/supabase-js');
const { sendCriticalAlert } = require('../lib/events');
const { sendSMS } = require('../lib/twilio-client');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ''
);

const WARN_WINDOW_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse NOTIFY_PHONES env var into an array of E.164 numbers.
 * Format: "+12627972304" or "+12627972304,+14145550001"
 */
function getNotifyPhones() {
    const raw = process.env.NOTIFY_PHONES || '';
    return raw
        .split(',')
        .map(p => p.trim())
        .filter(p => p.startsWith('+'));
}

/**
 * Send SMS alert to every number in NOTIFY_PHONES.
 * Uses the server's default Twilio credentials (no client context needed).
 * Non-blocking — failures are logged, not thrown.
 */
async function alertViaSms(message) {
    const phones = getNotifyPhones();
    if (!phones.length) {
        console.warn('[CredMonitor] NOTIFY_PHONES not set — cannot send SMS alert');
        return;
    }

    const from = process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER;
    if (!from) {
        console.warn('[CredMonitor] TWILIO_FROM_NUMBER not set — cannot send SMS alert');
        return;
    }

    for (const to of phones) {
        try {
            await sendSMS({ from, to, body: message });
        } catch (e) {
            console.error(`[CredMonitor] SMS alert to ${to} failed: ${e.message}`);
        }
    }
}

/**
 * Attempt to refresh a Google OAuth access token.
 * Returns { accessToken, expiresAt } on success, throws on failure.
 */
async function refreshGoogleToken(refreshToken) {
    const clientId     = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — cannot auto-refresh');
    }

    const body = new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
        client_id:     clientId,
        client_secret: clientSecret,
    });

    const res = await fetch(GOOGLE_TOKEN_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    body.toString(),
    });

    const data = await res.json();

    if (!res.ok || !data.access_token) {
        throw new Error(data.error_description || data.error || `HTTP ${res.status}`);
    }

    const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
    return { accessToken: data.access_token, expiresAt };
}

/**
 * Attempt token refresh for a given platform.
 * Currently supports: google.
 * Extend here when new OAuth platforms are added.
 */
async function attemptRefresh(integration) {
    const platform = (integration.platform || '').toLowerCase();

    if (platform === 'google' || platform === 'google_calendar' || platform === 'google_business') {
        return await refreshGoogleToken(integration.refresh_token);
    }

    throw new Error(`Auto-refresh not supported for platform: ${integration.platform}`);
}

// ─── Core run function ────────────────────────────────────────────────────────

async function run() {
    const startedAt = Date.now();
    const results   = { checked: 0, healthy: 0, warned: 0, refreshed: 0, failed: 0, errors: [] };

    console.log('[CredMonitor] Starting credential check...');

    let integrations;
    try {
        const { data, error } = await supabase
            .from('client_integrations')
            .select('id, client_id, platform, status, access_token, refresh_token, token_expires_at')
            .not('token_expires_at', 'is', null);

        if (error) throw error;
        integrations = data || [];
    } catch (e) {
        console.error('[CredMonitor] Failed to query client_integrations:', e.message);
        await sendCriticalAlert('credential-monitor', `DB query failed: ${e.message}`);
        return results;
    }

    const now       = Date.now();
    const warnCutoff = now + WARN_WINDOW_MS;

    for (const row of integrations) {
        results.checked++;

        const label = `[CredMonitor] ${row.platform}/${row.id} (client: ${row.client_id})`;

        try {
            const expiresMs = new Date(row.token_expires_at).getTime();
            const isExpired  = expiresMs <= now;
            const isWarning  = expiresMs <= warnCutoff;

            if (isExpired) {
                // Already expired — critical alert
                console.error(`${label} EXPIRED at ${row.token_expires_at}`);
                results.failed++;
                await sendCriticalAlert(
                    'credential-monitor',
                    `OAuth token EXPIRED for ${row.platform} (client: ${row.client_id})`,
                    { clientId: row.client_id }
                );

            } else if (isWarning) {
                const daysLeft = Math.ceil((expiresMs - now) / (24 * 60 * 60 * 1000));
                console.warn(`${label} expiring in ${daysLeft}d — ${row.refresh_token ? 'attempting auto-refresh' : 'no refresh token'}`);
                results.warned++;

                if (row.refresh_token) {
                    // Attempt auto-refresh
                    try {
                        const { accessToken, expiresAt } = await attemptRefresh(row);

                        const { error: updateErr } = await supabase
                            .from('client_integrations')
                            .update({
                                access_token:    accessToken,
                                token_expires_at: expiresAt,
                                updated_at:       new Date().toISOString(),
                            })
                            .eq('id', row.id);

                        if (updateErr) throw updateErr;

                        console.log(`${label} auto-refreshed successfully — new expiry: ${expiresAt}`);
                        results.refreshed++;

                    } catch (refreshErr) {
                        // Refresh failed — escalate as critical
                        console.error(`${label} auto-refresh FAILED: ${refreshErr.message}`);
                        results.failed++;
                        await sendCriticalAlert(
                            'credential-monitor',
                            `Token auto-refresh failed for ${row.platform} (client: ${row.client_id}): ${refreshErr.message}`,
                            { clientId: row.client_id }
                        );
                    }

                } else {
                    // No refresh token — SMS MJ
                    const msg = `[GRIDHAND] OAuth token for ${row.platform} expires in ${daysLeft}d (client: ${row.client_id}). Manual re-auth required.`;
                    await alertViaSms(msg);
                    console.warn(`${label} SMS alert sent (no refresh token)`);
                }

            } else {
                // Healthy
                const daysLeft = Math.ceil((expiresMs - now) / (24 * 60 * 60 * 1000));
                console.log(`${label} healthy (expires in ${daysLeft}d)`);
                results.healthy++;
            }

        } catch (e) {
            // Unexpected per-row error — log and continue
            console.error(`${label} unexpected error: ${e.message}`);
            results.errors.push({ id: row.id, platform: row.platform, error: e.message });
        }
    }

    const elapsed = Date.now() - startedAt;
    console.log(
        `[CredMonitor] Done in ${elapsed}ms — checked: ${results.checked}, healthy: ${results.healthy}, ` +
        `warned: ${results.warned}, refreshed: ${results.refreshed}, failed: ${results.failed}`
    );

    return results;
}

module.exports = { run };
