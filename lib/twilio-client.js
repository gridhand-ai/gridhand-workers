// Twilio Client Factory
// Each client brings their own Twilio credentials
// Falls back to server env vars (for GRIDHAND's own clients)

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

async function sendSMS({ from, to, body, clientApiKeys, clientSlug, clientTimezone }) {
    // Compliance guard — must pass before any SMS leaves the system
    if (clientSlug) {
        optoutManager.guardOutbound(clientSlug, to);
    }
    // Use client's actual timezone for TCPA quiet-hours check.
    // Defaulting to Chicago without checking the client's TZ can cause messages
    // to send past 9pm local time for East/West Coast clients — TCPA violation.
    if (tcpaChecker.isQuietHours(clientTimezone || 'America/Chicago')) {
        throw new Error('TCPA quiet hours — message blocked. Retry after 8am.');
    }

    const client = getClient(clientApiKeys);
    const msg = await client.messages.create({ from, to, body });
    console.log(`[Twilio] Sent to ${to}: "${body.slice(0, 50)}..." (SID: ${msg.sid})`);

    // Save to memory
    if (clientSlug) {
        try {
            const memory = require('../workers/memory');
            memory.saveMessage(clientSlug, to, 'assistant', body);
        } catch (e) {
            console.log(`[Twilio] Memory save failed: ${e.message}`);
        }
    }

    return msg;
}

module.exports = { getClient, sendSMS };
