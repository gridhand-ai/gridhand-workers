'use strict';
// tier: simple
//
// ─── Email Triage Agent ──────────────────────────────────────────────────────
//
// Receives Gmail-watch payloads forwarded from n8n via:
//   POST /api/email-triage  (requireApiKey)
//
// Pure keyword classification — no AI calls. Routes to:
//   - Railway deploy failure  → Telegram + worker-guardian Railway recheck
//   - Vercel deploy failure   → Telegram
//   - Make.com error          → Telegram
//   - Sentry alert            → Telegram
//   - General alert           → Telegram
//   - Nothing matched         → silent (return false, no spam)
//
// Never throws. All errors caught + sent to Sentry. Server stays alive.
//
// Payload shape from n8n:
//   { subject: string, from: string, body: string, receivedAt: ISO timestamp }

const { sendTelegramAlert } = require('../lib/events');
const sentry = require('../lib/sentry-client');

// ─── Classification ──────────────────────────────────────────────────────────

const ERROR_TERMS  = ['error', 'failed', 'failure', 'fatal', 'crash'];
const ALERT_TERMS  = ['alert', 'down', 'critical', 'failed', 'failure', 'incident'];

function _has(haystack, needle) {
    return haystack.includes(needle.toLowerCase());
}

function _hasAny(haystack, needles) {
    return needles.some(n => _has(haystack, n));
}

/**
 * Classify an email payload into one of the alert types.
 * Returns { type, label } or null if nothing matched.
 */
function classify(payload) {
    const subject = (payload.subject || '').toLowerCase();
    const from    = (payload.from    || '').toLowerCase();
    const body    = (payload.body    || '').toLowerCase();
    const all     = `${subject} ${from} ${body}`;

    // Railway deploy failure
    const looksLikeError = _hasAny(subject, ERROR_TERMS) || _has(body, 'deployment failed');
    if (looksLikeError && (_has(from, 'railway') || _has(all, 'railway'))) {
        return { type: 'railway', label: 'Railway Deploy Failure' };
    }

    // Vercel deploy failure
    if (_has(all, 'vercel') && _hasAny(all, ['error', 'failed', 'failure'])) {
        return { type: 'vercel', label: 'Vercel Deploy Failure' };
    }

    // Make.com error
    if ((_has(all, 'make.com') || _has(all, 'make scenario')) &&
        _hasAny(all, ['error', 'failed', 'failure'])) {
        return { type: 'make', label: 'Make.com Scenario Error' };
    }

    // Sentry alert
    if (_has(from, 'sentry') || _has(payload.subject || '', 'Sentry')) {
        return { type: 'sentry', label: 'Sentry Alert' };
    }

    // General alert — last-resort match
    if (_hasAny(all, ALERT_TERMS)) {
        return { type: 'general', label: 'System Alert' };
    }

    return null;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function _formatTime(iso) {
    try {
        const d = iso ? new Date(iso) : new Date();
        return d.toLocaleString('en-US', {
            timeZone: 'America/Chicago',
            hour:     'numeric',
            minute:   '2-digit',
            hour12:   true,
            timeZoneName: 'short',
        });
    } catch {
        return new Date().toISOString();
    }
}

function _truncate(str, max) {
    if (!str) return '(none)';
    return str.length > max ? str.slice(0, max) + '…' : str;
}

function buildAlertMessage(classification, payload) {
    const time = _formatTime(payload.receivedAt);

    const lines = [
        '🚨 *Email Alert Detected*',
        `Type: ${classification.label}`,
        `From: ${_truncate(payload.from, 120)}`,
        `Subject: ${_truncate(payload.subject, 200)}`,
        `Time: ${time}`,
        '',
    ];

    // Type-specific tail
    switch (classification.type) {
        case 'railway':
            lines.push('Checking Railway status now...');
            break;
        case 'vercel':
            lines.push('Check Vercel dashboard for deployment status.');
            break;
        case 'make':
            lines.push('Open Make.com to inspect failed scenario run.');
            break;
        case 'sentry':
            lines.push('Open Sentry for full stack trace.');
            break;
        default:
            lines.push('Review email manually for next steps.');
    }

    return lines.join('\n');
}

// ─── Railway follow-up ───────────────────────────────────────────────────────

/**
 * For Railway alerts — re-check current deployment state via worker-guardian.
 * If still failing, send a confirming follow-up Telegram.
 * Never throws; always logs.
 */
async function railwayFollowUp() {
    let checkRailwayDeployments;
    try {
        ({ checkRailwayDeployments } = require('./worker-guardian'));
    } catch (e) {
        console.warn('[email-triage] worker-guardian not loadable:', e.message);
        return;
    }

    if (typeof checkRailwayDeployments !== 'function') {
        console.warn('[email-triage] worker-guardian.checkRailwayDeployments not exported — skipping follow-up');
        return;
    }

    try {
        const result = await checkRailwayDeployments();
        if (result && result.ok === false) {
            const detail = result.detail || 'Latest deploy still failing';
            await sendTelegramAlert(
                `⚠️ Confirmed still failing. Manual redeploy needed.\n${detail}`
            );
        } else if (result && result.skipped) {
            console.log('[email-triage] Railway recheck skipped:', result.detail);
        } else {
            console.log('[email-triage] Railway recheck OK — alert was likely transient');
        }
    } catch (e) {
        console.error('[email-triage] Railway recheck failed:', e.message);
        try { sentry.captureError?.(e, { agent: 'email-triage', stage: 'railway-followup' }); } catch {}
    }
}

// ─── Core run function ───────────────────────────────────────────────────────

/**
 * Main entry. Called fire-and-forget from POST /api/email-triage.
 * Always resolves — never rejects — so callers don't need to handle errors.
 *
 * @param {{ subject?: string, from?: string, body?: string, receivedAt?: string }} payload
 * @returns {Promise<{ matched: boolean, type?: string }>}
 */
async function run(payload = {}) {
    try {
        if (!payload || typeof payload !== 'object') {
            console.warn('[email-triage] invalid payload — ignored');
            return { matched: false };
        }

        const classification = classify(payload);
        if (!classification) {
            console.log(`[email-triage] no match — subject="${_truncate(payload.subject, 80)}" from="${_truncate(payload.from, 80)}"`);
            return { matched: false };
        }

        console.log(`[email-triage] match: ${classification.type} — ${_truncate(payload.subject, 80)}`);

        const message = buildAlertMessage(classification, payload);

        try {
            await sendTelegramAlert(message);
        } catch (e) {
            console.error('[email-triage] Telegram send failed:', e.message);
            try { sentry.captureError?.(e, { agent: 'email-triage', stage: 'telegram-send' }); } catch {}
        }

        // Railway-specific follow-up: confirm whether it's still failing
        if (classification.type === 'railway') {
            await railwayFollowUp();
        }

        return { matched: true, type: classification.type };

    } catch (e) {
        console.error('[email-triage] unexpected error:', e.message);
        try { sentry.captureError?.(e, { agent: 'email-triage', stage: 'run' }); } catch {}
        return { matched: false, error: e.message };
    }
}

module.exports = { run, classify, buildAlertMessage };
