/**
 * GRIDHAND Reputation Engine — SMS Wrapper
 *
 * All outbound SMS goes through lib/twilio-client.js sendSMS() to enforce
 * TCPA quiet-hours and opt-out compliance.
 */

'use strict';

const { sendSMS } = require('../../lib/twilio-client');
const db          = require('./db');

async function sendToManager(conn, messageBody, alertType, alertMeta = {}) {
    const to = conn.manager_phone || conn.owner_phone;
    if (!to) {
        console.warn(`[SMS] No manager/owner phone for ${conn.client_slug} — skipping ${alertType}`);
        return;
    }

    await sendSMS({
        to,
        body:           messageBody,
        clientSlug:     conn.client_slug,
        clientTimezone: undefined,
    });

    await db.logAlert(conn.client_slug, {
        reviewId:    alertMeta.reviewId || null,
        alertType,
        platform:    alertMeta.platform || null,
        starRating:  alertMeta.starRating || null,
        recipient:   to,
        messageBody,
    });

    console.log(`[SMS] Sent ${alertType} to manager ${to}`);
}

module.exports = { sendToManager };
