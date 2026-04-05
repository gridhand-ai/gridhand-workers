/**
 * GRIDHAND Lease Renewal Agent — Twilio SMS Module
 */

'use strict';

const twilio = require('twilio');
const db     = require('./db');

function getClient() {
    return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendToTenant(conn, renewalId, tenantPhone, messageBody, channel = 'sms') {
    const from = process.env.TWILIO_FROM_NUMBER;
    console.log(`[SMS] → Tenant ${tenantPhone}: ${messageBody.slice(0, 60)}...`);
    await getClient().messages.create({ from, to: tenantPhone, body: messageBody });
    await db.logCommunication(conn.client_slug, renewalId, {
        channel: 'sms', direction: 'outbound', recipient: tenantPhone, messageBody,
    });
}

async function sendToOwner(conn, renewalId, messageBody) {
    const from = process.env.TWILIO_FROM_NUMBER;
    console.log(`[SMS] → Owner ${conn.owner_phone}: ${messageBody.slice(0, 60)}...`);
    await getClient().messages.create({ from, to: conn.owner_phone, body: messageBody });
    await db.logCommunication(conn.client_slug, renewalId, {
        channel: 'sms', direction: 'outbound', recipient: conn.owner_phone, messageBody,
    });
}

module.exports = { sendToTenant, sendToOwner };
