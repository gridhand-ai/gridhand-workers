/**
 * GRIDHAND Parts Prophet — Twilio SMS Wrapper
 */

'use strict';

const twilio = require('twilio');
const db     = require('./db');

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const FROM = process.env.TWILIO_FROM_NUMBER;

async function sendToOwner(conn, messageBody, alertType) {
    const to = conn.owner_phone;
    if (!to) {
        console.warn(`[SMS] No owner phone for ${conn.client_slug} — skipping ${alertType}`);
        return;
    }

    await client.messages.create({ body: messageBody, from: FROM, to });

    await db.logAlert(conn.client_slug, {
        alertType,
        recipient:   to,
        messageBody,
    });

    console.log(`[SMS] Sent ${alertType} to ${to}`);
}

module.exports = { sendToOwner };
