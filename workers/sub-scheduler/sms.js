/**
 * GRIDHAND Sub-Scheduler — Twilio SMS Module
 */

'use strict';

const twilio = require('twilio');
const db     = require('./db');

function getClient() {
    return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendToSub(conn, subPhone, messageBody, alertType, scheduleId = null) {
    const from = process.env.TWILIO_FROM_NUMBER;
    console.log(`[SMS] → Sub ${subPhone} [${alertType}]: ${messageBody.slice(0, 60)}...`);
    await getClient().messages.create({ from, to: subPhone, body: messageBody });
    await db.logAlert(conn.client_slug, { alertType, recipient: subPhone, messageBody, scheduleId });
}

async function sendToOwner(conn, messageBody, alertType, scheduleId = null) {
    const from = process.env.TWILIO_FROM_NUMBER;
    console.log(`[SMS] → Owner ${conn.owner_phone} [${alertType}]: ${messageBody.slice(0, 60)}...`);
    await getClient().messages.create({ from, to: conn.owner_phone, body: messageBody });
    await db.logAlert(conn.client_slug, { alertType, recipient: conn.owner_phone, messageBody, scheduleId });
}

module.exports = { sendToSub, sendToOwner };
