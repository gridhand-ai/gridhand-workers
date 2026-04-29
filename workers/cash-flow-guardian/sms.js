/**
 * GRIDHAND Cash Flow Guardian — SMS Sender
 *
 * All outbound SMS goes through lib/twilio-client.js sendSMS() to enforce
 * TCPA quiet-hours and opt-out compliance.
 * Logs every sent message to cash_flow_alerts via db.logAlert.
 */

'use strict';

const { sendSMS } = require('../../lib/twilio-client');
const db          = require('./db');

/**
 * Send an SMS to the business owner.
 * conn: qb_connection row (has owner_phone and client_slug)
 */
async function sendToOwner(conn, messageBody, alertType) {
    console.log(`[SMS] → Owner ${conn.owner_phone} [${alertType}]: ${messageBody.slice(0, 60)}...`);

    await sendSMS({
        to:             conn.owner_phone,
        body:           messageBody,
        clientSlug:     conn.client_slug,
        clientTimezone: undefined,
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
    console.log(`[SMS] → Customer ${customerPhone} [${alertType}]: ${messageBody.slice(0, 60)}...`);

    await sendSMS({
        to:             customerPhone,
        body:           messageBody,
        clientSlug:     conn.client_slug,
        clientTimezone: undefined,
    });

    await db.logAlert(conn.client_slug, {
        alertType,
        recipient:   customerPhone,
        messageBody,
        invoiceId,
    });
}

module.exports = { sendToOwner, sendToCustomer };
