/**
 * GRIDHAND Compliance Watchdog — SMS Wrapper
 *
 * All outbound SMS goes through lib/twilio-client.js sendSMS() to enforce
 * TCPA quiet-hours and opt-out compliance.
 */

'use strict';

const { sendSMS } = require('../../lib/twilio-client');
const db          = require('./db');

async function sendToOwner(conn, messageBody, alertType, alertMeta = {}) {
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
        amsAgentId:      alertMeta.amsAgentId || null,
        daysUntilExpiry: alertMeta.daysUntilExpiry || null,
        itemId:          alertMeta.itemId || null,
        itemDescription: alertMeta.itemDescription || null,
        recipient:       to,
        messageBody,
    });

    console.log(`[SMS] Sent ${alertType} to ${to}`);
}

module.exports = { sendToOwner };
