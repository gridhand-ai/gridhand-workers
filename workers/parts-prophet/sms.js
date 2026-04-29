/**
 * GRIDHAND Parts Prophet — SMS Wrapper
 *
 * All outbound SMS goes through lib/twilio-client.js sendSMS() to enforce
 * TCPA quiet-hours and opt-out compliance.
 */

'use strict';

const { sendSMS } = require('../../lib/twilio-client');
const db          = require('./db');

async function sendToOwner(conn, messageBody, alertType) {
    const to = conn.owner_phone;
    if (!to) {
        console.warn(`[SMS] No owner phone for ${conn.client_slug} — skipping ${alertType}`);
        return;
    }

    await sendSMS({
        to,
        body:           messageBody,
        clientSlug:     conn.client_slug,
        clientTimezone: undefined,
    });

    await db.logAlert(conn.client_slug, {
        alertType,
        recipient:   to,
        messageBody,
    });

    console.log(`[SMS] Sent ${alertType} to ${to}`);
}

module.exports = { sendToOwner };
