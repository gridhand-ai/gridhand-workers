'use strict';
// tier: quality

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
//   3. If expiring within 7 days + no refresh_token → SMS MJ via ADMIN_NOTIFY_PHONES
//
// Infrastructure checks (run once per daily invocation):
//   4. Twilio account balance — alert if < $5
//   5. ElevenLabs character quota — alert if < 10% remaining
//   6. Groq API key — test call to confirm key is valid
//   7. Daily Telegram summary — "all clear" or list of issues
//
// Never throws — all errors are caught and logged. Server stays alive.

const { createClient } = require('@supabase/supabase-js');
const { sendCriticalAlert, sendTelegramAlert } = require('../lib/events');
const { sendSMS } = require('../lib/twilio-client');
const { validateInternal } = require('../lib/message-gate');
const { encrypt, decrypt } = require('../lib/crypto');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ''
);

const WARN_WINDOW_MS   = 7 * 24 * 60 * 60 * 1000; // 7 days
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Minimum Twilio balance (USD) before we alert
const TWILIO_MIN_BALANCE_USD = 5.00;

// Minimum ElevenLabs quota remaining (fraction, 0–1) before we alert
const EL_MIN_QUOTA_FRACTION  = 0.10;

// ─── Alert deduplication ──────────────────────────────────────────────────────
// Prevents repeated Telegram/SMS alerts for the same ongoing issue.
// Resets on server restart — acceptable since Railway dynos stay up for days.
const _alertedAt = new Map(); // issueKey → timestamp
const ALERT_THROTTLE_MS = 24 * 60 * 60 * 1000; // 24 hours

function _shouldAlert(key) {
    const last = _alertedAt.get(key);
    return !last || (Date.now() - last) > ALERT_THROTTLE_MS;
}

function _markAlerted(key) {
    _alertedAt.set(key, Date.now());
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse ADMIN_NOTIFY_PHONES env var into an array of E.164 numbers.
 * Format: "+12627972304" or "+12627972304,+14145550001"
 */
function getNotifyPhones() {
    const raw = process.env.ADMIN_NOTIFY_PHONES || '';
    return raw
        .split(',')
        .map(p => p.trim())
        .filter(p => p.startsWith('+'));
}

/**
 * Send SMS alert to every number in ADMIN_NOTIFY_PHONES.
 * Uses the server's default Twilio credentials (no client context needed).
 * Non-blocking — failures are logged, not thrown.
 */
async function alertViaSms(message) {
    const phones = getNotifyPhones();
    if (!phones.length) {
        console.warn('[CredMonitor] ADMIN_NOTIFY_PHONES not set — cannot send SMS alert');
        return;
    }

    const from = process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER;
    if (!from) {
        console.warn('[CredMonitor] TWILIO_FROM_NUMBER not set — cannot send SMS alert');
        return;
    }

    const gateResult = validateInternal(message);
    if (!gateResult.valid) {
        console.warn(`[CredMonitor] message-gate blocked SMS alert: ${gateResult.reason}`);
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

    // Tokens are AES-256-GCM encrypted in the DB — decrypt before sending to Google
    let plainRefreshToken;
    try {
        plainRefreshToken = decrypt(refreshToken);
    } catch (e) {
        throw new Error(`Failed to decrypt refresh token: ${e.message}`);
    }

    const body = new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: plainRefreshToken,
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

// ─── Infrastructure checks ────────────────────────────────────────────────────

/**
 * Check Twilio account balance. Returns an issue string or null if healthy.
 */
async function checkTwilioBalance() {
    const sid   = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;

    if (!sid || !token) {
        console.warn('[CredMonitor] TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set — skipping balance check');
        return null;
    }

    try {
        const res = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${sid}/Balance.json`,
            {
                headers: {
                    Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
                },
            }
        );

        if (!res.ok) {
            console.error(`[CredMonitor] Twilio balance check HTTP ${res.status}`);
            return `Twilio API returned HTTP ${res.status} — cannot verify balance`;
        }

        const data = await res.json();
        const balance = parseFloat(data.balance);

        console.log(`[CredMonitor] Twilio balance: $${balance}`);

        if (isNaN(balance)) {
            return 'Twilio: could not parse account balance';
        }

        if (balance < TWILIO_MIN_BALANCE_USD) {
            return `Twilio balance critically low: $${balance.toFixed(2)} (threshold: $${TWILIO_MIN_BALANCE_USD})`;
        }

        return null; // healthy
    } catch (e) {
        console.error('[CredMonitor] Twilio balance check failed:', e.message);
        return `Twilio balance check error: ${e.message}`;
    }
}

/**
 * Check ElevenLabs character quota. Returns an issue string or null if healthy.
 */
async function checkElevenLabsQuota() {
    const apiKey = process.env.ELEVENLABS_API_KEY;

    if (!apiKey) {
        console.warn('[CredMonitor] ELEVENLABS_API_KEY not set — skipping EL quota check');
        return null;
    }

    try {
        const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
            headers: { 'xi-api-key': apiKey },
        });

        if (res.status === 401 || res.status === 403) {
            // Key exists but lacks user_read scope — not a critical failure, just log and skip
            console.warn(`[CredMonitor] ElevenLabs key missing user_read permission (HTTP ${res.status}) — skipping quota check`);
            return null;
        }
        if (!res.ok) {
            console.error(`[CredMonitor] ElevenLabs quota check HTTP ${res.status}`);
            return `ElevenLabs API returned HTTP ${res.status}`;
        }

        const data = await res.json();
        const used  = data.character_count ?? 0;
        const limit = data.character_limit ?? 0;

        if (limit === 0) {
            console.warn('[CredMonitor] ElevenLabs: could not determine character limit');
            return null;
        }

        const remaining = limit - used;
        const fraction  = remaining / limit;

        console.log(`[CredMonitor] ElevenLabs quota: ${used}/${limit} used (${(fraction * 100).toFixed(1)}% remaining)`);

        if (fraction < EL_MIN_QUOTA_FRACTION) {
            return `ElevenLabs quota low: ${remaining.toLocaleString()} chars remaining (${(fraction * 100).toFixed(1)}% of ${limit.toLocaleString()})`;
        }

        return null; // healthy
    } catch (e) {
        console.error('[CredMonitor] ElevenLabs quota check failed:', e.message);
        return `ElevenLabs quota check error: ${e.message}`;
    }
}

/**
 * Verify Groq API key is valid via a minimal completions call.
 * Returns an issue string or null if healthy.
 */
async function checkGroqApiKey() {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
        console.warn('[CredMonitor] GROQ_API_KEY not set — skipping Groq check');
        return null;
    }

    try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1,
            }),
        });

        if (res.status === 401 || res.status === 403) {
            return `Groq API key is invalid or revoked (HTTP ${res.status})`;
        }

        // 429 rate-limit or 200 both confirm the key is valid
        console.log(`[CredMonitor] Groq API key valid (HTTP ${res.status})`);
        return null; // healthy
    } catch (e) {
        console.error('[CredMonitor] Groq key check failed:', e.message);
        return `Groq key check network error: ${e.message}`;
    }
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
        // Skip integrations that are already marked disconnected or have no refresh token.
        // These are either intentionally disabled or already nulled-out due to past decrypt
        // failures — alerting on them is pure noise and produces a Telegram spam loop on
        // every Railway restart (the 24h in-memory throttle resets each boot).
        if (!row.refresh_token || (row.status || '').toLowerCase() === 'disconnected') {
            continue;
        }

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
                const alertKey = `expired-${row.platform}-${row.client_id}`;
                if (_shouldAlert(alertKey)) {
                    await sendCriticalAlert(
                        'credential-monitor',
                        `OAuth token EXPIRED for ${row.platform} (client: ${row.client_id})`,
                        { clientId: row.client_id }
                    );
                    _markAlerted(alertKey);
                } else {
                    console.log(`[CredMonitor] ${alertKey} — already alerted within 24h, skipping`);
                }

            } else if (isWarning) {
                const daysLeft = Math.ceil((expiresMs - now) / (24 * 60 * 60 * 1000));
                console.warn(`${label} expiring in ${daysLeft}d — ${row.refresh_token ? 'attempting auto-refresh' : 'no refresh token'}`);
                results.warned++;

                if (row.refresh_token) {
                    // Attempt auto-refresh
                    try {
                        const { accessToken, expiresAt } = await attemptRefresh(row);

                        // Encrypt new access token before storing — matches portal encryption
                        let encryptedAccessToken;
                        try {
                            encryptedAccessToken = encrypt(accessToken);
                        } catch (e) {
                            throw new Error(`Failed to encrypt new access token: ${e.message}`);
                        }

                        const { error: updateErr } = await supabase
                            .from('client_integrations')
                            .update({
                                access_token:    encryptedAccessToken,
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
                        const alertKey = `refresh-failed-${row.platform}-${row.client_id}`;
                        if (_shouldAlert(alertKey)) {
                            await sendCriticalAlert(
                                'credential-monitor',
                                `Token auto-refresh failed for ${row.platform} (client: ${row.client_id}): ${refreshErr.message}`,
                                { clientId: row.client_id }
                            );
                            _markAlerted(alertKey);
                        } else {
                            console.log(`[CredMonitor] ${alertKey} — already alerted within 24h, skipping`);
                        }
                    }

                } else {
                    // No refresh token — SMS MJ
                    const alertKey = `no-refresh-token-${row.platform}-${row.client_id}`;
                    if (_shouldAlert(alertKey)) {
                        const msg = `[GRIDHAND] OAuth token for ${row.platform} expires in ${daysLeft}d (client: ${row.client_id}). Manual re-auth required.`;
                        await alertViaSms(msg);
                        _markAlerted(alertKey);
                        console.warn(`${label} SMS alert sent (no refresh token)`);
                    } else {
                        console.log(`[CredMonitor] ${alertKey} — already alerted within 24h, skipping`);
                    }
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

    // ─── Infrastructure checks ─────────────────────────────────────────────────
    const infraIssues = [];

    const twilioIssue = await checkTwilioBalance();
    if (twilioIssue) {
        infraIssues.push(twilioIssue);
        results.failed++;
        if (_shouldAlert('twilio-balance')) {
            _markAlerted('twilio-balance');
        } else {
            console.log('[CredMonitor] twilio-balance — already alerted within 24h, will skip in summary');
        }
    }

    const elIssue = await checkElevenLabsQuota();
    if (elIssue) {
        infraIssues.push(elIssue);
        results.failed++;
        if (_shouldAlert('elevenlabs-quota')) {
            _markAlerted('elevenlabs-quota');
        } else {
            console.log('[CredMonitor] elevenlabs-quota — already alerted within 24h, will skip in summary');
        }
    }

    const groqIssue = await checkGroqApiKey();
    if (groqIssue) {
        infraIssues.push(groqIssue);
        if (_shouldAlert('groq-key')) {
            await sendCriticalAlert('credential-monitor', groqIssue);
            _markAlerted('groq-key');
        } else {
            console.log('[CredMonitor] groq-key — already alerted within 24h, skipping');
        }
    }

    // ─── Daily Telegram summary ────────────────────────────────────────────────
    const oauthIssues = results.failed - infraIssues.length; // rough count before we added infra
    const totalIssues = infraIssues.length + results.errors.length + (results.failed - infraIssues.length);

    const allClear = totalIssues === 0 && results.warned === 0;

    let summaryMsg;
    if (allClear) {
        summaryMsg =
            `✅ *Credential check: all clear*\n` +
            `Checked ${results.checked} OAuth token(s), Twilio balance, ElevenLabs quota, and Groq key.\n` +
            `Time: ${new Date().toISOString()}`;
    } else {
        const lines = ['⚠️ *Credential check — issues found:*'];

        if (results.warned > 0) {
            lines.push(`• ${results.warned} OAuth token(s) expiring soon`);
        }
        if (results.refreshed > 0) {
            lines.push(`• ${results.refreshed} token(s) auto-refreshed`);
        }
        if (results.failed - infraIssues.length > 0) {
            lines.push(`• ${results.failed - infraIssues.length} OAuth token(s) expired or refresh failed`);
        }
        for (const issue of infraIssues) {
            lines.push(`• ${issue}`);
        }
        for (const err of results.errors) {
            lines.push(`• Unexpected error on ${err.platform}: ${err.error}`);
        }

        lines.push(`\nTime: ${new Date().toISOString()}`);
        summaryMsg = lines.join('\n');
    }

    if (allClear) {
        // All clear — log only, no Telegram spam
        console.log('[CredMonitor] All clear — no Telegram alert sent');
    } else {
        await sendTelegramAlert(summaryMsg);
    }

    const elapsed = Date.now() - startedAt;
    console.log(
        `[CredMonitor] Done in ${elapsed}ms — checked: ${results.checked}, healthy: ${results.healthy}, ` +
        `warned: ${results.warned}, refreshed: ${results.refreshed}, failed: ${results.failed}`
    );

    return results;
}

// Export both names: run (used by existing server.js) and runCredentialMonitor (new canonical name)
module.exports = { run, runCredentialMonitor: run };
