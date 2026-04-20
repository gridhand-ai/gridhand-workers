// lib/twilio-client.js
// Provider-agnostic SMS client for gridhand-workers.
//
// Provider selection (checked at send time):
//   TELNYX_API_KEY set  → Telnyx REST API v2
//   Otherwise           → Twilio SDK (per-client credentials or server env vars)
//
// All compliance guards (opt-out, TCPA quiet hours) run before any provider is called.
//
// Env vars:
//   TELNYX_API_KEY        — Telnyx API v2 key
//   TELNYX_PHONE_NUMBER   — E.164 send-from number for Telnyx
//   TWILIO_ACCOUNT_SID    — Twilio fallback
//   TWILIO_AUTH_TOKEN     — Twilio fallback
//   TWILIO_PHONE_NUMBER   — Twilio fallback send-from number

const twilio = require('twilio');
const optoutManager = require('../subagents/compliance/optout-manager');
const tcpaChecker   = require('../subagents/compliance/tcpa-checker');

function getClient(clientApiKeys) {
    const sid   = clientApiKeys?.twilio?.accountSid || process.env.TWILIO_ACCOUNT_SID;
    const token = clientApiKeys?.twilio?.authToken  || process.env.TWILIO_AUTH_TOKEN;

    if (!sid || !token) {
        throw new Error('Twilio credentials missing. Add apiKeys.twilio.accountSid and apiKeys.twilio.authToken to client config, or set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN on the server.');
    }

    return twilio(sid, token);
}

// ── Telnyx transport ──────────────────────────────────────────────────────────

async function sendViaTelnyx(from, to, body) {
    const apiKey = process.env.TELNYX_API_KEY;
    const res = await fetch('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify({ from, to, text: body }),
    });

    if (!res.ok) {
        let detail = res.statusText;
        try {
            const json = await res.json();
            detail = json.errors?.[0]?.detail ?? res.statusText;
        } catch { /* ignore parse errors */ }
        throw new Error(`Telnyx ${res.status}: ${detail}`);
    }

    const json = await res.json();
    return { sid: json.data?.id };
}

// ── Main sendSMS ──────────────────────────────────────────────────────────────

async function sendSMS({ from, to, body, clientApiKeys, clientSlug, clientTimezone }) {
    // Compliance guard — must pass before any SMS leaves the system
    if (clientSlug) {
        optoutManager.guardOutbound(clientSlug, to);
    }
    // Use client's actual timezone for TCPA quiet-hours check.
    if (tcpaChecker.isQuietHours(clientTimezone || 'America/Chicago')) {
        throw new Error('TCPA quiet hours — message blocked. Retry after 8am.');
    }

    const useTelnyx = !!process.env.TELNYX_API_KEY;

    let sid;
    if (useTelnyx) {
        const sendFrom = from || process.env.TELNYX_PHONE_NUMBER;
        if (!sendFrom) throw new Error('TELNYX_PHONE_NUMBER not set');
        const result = await sendViaTelnyx(sendFrom, to, body);
        sid = result.sid;
        console.log(`[SMS/Telnyx] Sent to ${to}: "${body.slice(0, 50)}..." (ID: ${sid})`);
    } else {
        const client = getClient(clientApiKeys);
        const sendFrom = from || process.env.TWILIO_PHONE_NUMBER;
        if (!sendFrom) throw new Error('TWILIO_PHONE_NUMBER not set');
        const msg = await client.messages.create({ from: sendFrom, to, body });
        sid = msg.sid;
        console.log(`[SMS/Twilio] Sent to ${to}: "${body.slice(0, 50)}..." (SID: ${sid})`);
    }

    // Save to memory
    if (clientSlug) {
        try {
            const memory = require('../workers/memory');
            memory.saveMessage(clientSlug, to, 'assistant', body);
        } catch (e) {
            console.log(`[SMS] Memory save failed: ${e.message}`);
        }
    }

    return { sid };
}

module.exports = { getClient, sendSMS };
