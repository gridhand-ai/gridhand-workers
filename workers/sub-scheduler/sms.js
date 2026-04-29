/**
 * GRIDHAND Sub-Scheduler — SMS Module
 *
 * All outbound SMS goes through lib/twilio-client.js sendSMS() to enforce
 * TCPA quiet-hours and opt-out compliance.
 */

'use strict';

const { sendSMS } = require('../../lib/twilio-client');
const db          = require('./db');

async function sendToSub(conn, subPhone, messageBody, alertType, scheduleId = null) {
    console.log(`[SMS] → Sub ${subPhone} [${alertType}]: ${messageBody.slice(0, 60)}...`);
    await sendSMS({
        to:             subPhone,
        body:           messageBody,
        clientSlug:     conn.client_slug,
        clientTimezone: undefined,
    });
    await db.logAlert(conn.client_slug, { alertType, recipient: subPhone, messageBody, scheduleId });
}

async function sendToOwner(conn, messageBody, alertType, scheduleId = null) {
    console.log(`[SMS] → Owner ${conn.owner_phone} [${alertType}]: ${messageBody.slice(0, 60)}...`);
    await sendSMS({
        to:             conn.owner_phone,
        body:           messageBody,
        clientSlug:     conn.client_slug,
        clientTimezone: undefined,
    });
    await db.logAlert(conn.client_slug, { alertType, recipient: conn.owner_phone, messageBody, scheduleId });
}

module.exports = { sendToSub, sendToOwner };
