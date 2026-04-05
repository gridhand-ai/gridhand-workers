/**
 * GRIDHAND Maintenance Dispatcher — Twilio SMS Module
 */

'use strict';

const twilio = require('twilio');
const db     = require('./db');

function getClient() {
    return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendToTenant(conn, tenantPhone, messageBody, alertType, requestId = null) {
    const from = process.env.TWILIO_FROM_NUMBER;
    console.log(`[SMS] → Tenant ${tenantPhone} [${alertType}]`);
    await getClient().messages.create({ from, to: tenantPhone, body: messageBody });
    await db.logAlert(conn.client_slug, { alertType, recipient: tenantPhone, messageBody, requestId });
}

async function sendToVendor(conn, vendorPhone, messageBody, alertType, requestId = null) {
    const from = process.env.TWILIO_FROM_NUMBER;
    console.log(`[SMS] → Vendor ${vendorPhone} [${alertType}]`);
    await getClient().messages.create({ from, to: vendorPhone, body: messageBody });
    await db.logAlert(conn.client_slug, { alertType, recipient: vendorPhone, messageBody, requestId });
}

async function sendToOwner(conn, messageBody, alertType, requestId = null) {
    const from = process.env.TWILIO_FROM_NUMBER;
    console.log(`[SMS] → Owner ${conn.owner_phone} [${alertType}]`);
    await getClient().messages.create({ from, to: conn.owner_phone, body: messageBody });
    await db.logAlert(conn.client_slug, { alertType, recipient: conn.owner_phone, messageBody, requestId });
}

module.exports = { sendToTenant, sendToVendor, sendToOwner };
