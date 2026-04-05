/**
 * GRIDHAND Cash Flow Guardian — SMS Sender
 *
 * Thin Twilio wrapper. Reads credentials from environment.
 * Logs every sent message to cash_flow_alerts via db.logAlert.
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
 * Send an SMS to the business owner.
 * conn: qb_connection row (has owner_phone and client_slug)
 */
async function sendToOwner(conn, messageBody, alertType) {
    const from = process.env.TWILIO_FROM_NUMBER;
    if (!from) throw new Error('TWILIO_FROM_NUMBER must be set');

    console.log(`[SMS] → Owner ${conn.owner_phone} [${alertType}]: ${messageBody.slice(0, 60)}...`);

    await getClient().messages.create({
        from,
        to:   conn.owner_phone,
        body: messageBody,
    });

    await db.logAlert(conn.client_slug, {
        alertType,
        recipient:   conn.owner_phone,
        messageBody,
    });
}

/**
 * Send an SMS to a customer (invoice reminders).
 * invoiceId is stored in the alert log for traceability.
 */
async function sendToCustomer(conn, customerPhone, messageBody, invoiceId, alertType = 'invoice_reminder') {
    const from = process.env.TWILIO_FROM_NUMBER;
    if (!from) throw new Error('TWILIO_FROM_NUMBER must be set');

    console.log(`[SMS] → Customer ${customerPhone} [${alertType}]: ${messageBody.slice(0, 60)}...`);

    await getClient().messages.create({
        from,
        to:   customerPhone,
        body: messageBody,
    });

    await db.logAlert(conn.client_slug, {
        alertType,
        recipient:   customerPhone,
        messageBody,
        invoiceId,
    });
}

module.exports = { sendToOwner, sendToCustomer };
