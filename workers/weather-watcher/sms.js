/**
 * GRIDHAND Weather Watcher — SMS Sender
 *
 * All outbound SMS goes through lib/twilio-client.js sendSMS() to enforce
 * TCPA quiet-hours and opt-out compliance.
 * Logs every sent message to weather_alerts via db.logAlert.
 */

'use strict';

const { sendSMS } = require('../../lib/twilio-client');
const db          = require('./db');

/**
 * Send an SMS to any recipient.
 * conn: jobber_connections_weather row (has client_slug)
 */
async function send(conn, toPhone, messageBody, alertType) {
    console.log(`[SMS] → ${toPhone} [${alertType}]: ${messageBody.slice(0, 60)}...`);

    await sendSMS({
        to:             toPhone,
        body:           messageBody,
        clientSlug:     conn.client_slug,
        clientTimezone: undefined,
    });

    await db.logAlert(conn.client_slug, {
        alertType,
        recipient:   toPhone,
        messageBody,
    });
}

/**
 * Send an SMS to the business owner.
 */
async function sendToOwner(conn, messageBody, alertType) {
    return send(conn, conn.owner_phone, messageBody, alertType);
}

module.exports = { send, sendToOwner };
