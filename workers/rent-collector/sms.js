/**
 * GRIDHAND Rent Collector — Twilio SMS Module
 */

'use strict';

const twilio = require('twilio');
const db     = require('./db');

function getClient() {
    return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendToTenant(conn, tenantPhone, messageBody, alertType, leaseId = null) {
    const from = process.env.TWILIO_FROM_NUMBER;
    console.log(`[SMS] → Tenant ${tenantPhone} [${alertType}]: ${messageBody.slice(0, 60)}...`);
    await getClient().messages.create({ from, to: tenantPhone, body: messageBody });
    await db.logAlert(conn.client_slug, { alertType, recipient: tenantPhone, messageBody, leaseId });
}

async function sendToOwner(conn, messageBody, alertType, leaseId = null) {
    const from = process.env.TWILIO_FROM_NUMBER;
    console.log(`[SMS] → Owner ${conn.owner_phone} [${alertType}]: ${messageBody.slice(0, 60)}...`);
    await getClient().messages.create({ from, to: conn.owner_phone, body: messageBody });
    await db.logAlert(conn.client_slug, { alertType, recipient: conn.owner_phone, messageBody, leaseId });
}

module.exports = { sendToTenant, sendToOwner };
