/**
 * GRIDHAND Route Optimizer — SMS Sender
 *
 * Thin Twilio wrapper. Reads credentials from environment.
 * Logs every sent message to route_alerts via db.logAlert.
 */

'use strict';

const twilio = require('twilio');
const db     = require('./db');

function getClient() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
        throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
    }
    return twilio(accountSid, authToken);
}

/**
 * Send an SMS to any recipient.
 * conn: jobber_connections_route row (has client_slug)
 */
async function send(conn, toPhone, messageBody, alertType) {
    const from = process.env.TWILIO_FROM_NUMBER;
    if (!from) throw new Error('TWILIO_FROM_NUMBER must be set');

    console.log(`[SMS] → ${toPhone} [${alertType}]: ${messageBody.slice(0, 60)}...`);

    await getClient().messages.create({
        from,
        to:   toPhone,
        body: messageBody,
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
