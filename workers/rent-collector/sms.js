/**
 * GRIDHAND Rent Collector — SMS Module
 *
 * All outbound SMS goes through lib/twilio-client.js sendSMS() to enforce
 * TCPA quiet-hours and opt-out compliance.
 */

'use strict';

const { sendSMS } = require('../../lib/twilio-client');
const db          = require('./db');

async function sendToTenant(conn, tenantPhone, messageBody, alertType, leaseId = null) {
    console.log(`[SMS] → Tenant ${tenantPhone} [${alertType}]: ${messageBody.slice(0, 60)}...`);
    const { sid } = await sendSMS({
        to:             tenantPhone,
        body:           messageBody,
        clientSlug:     conn.client_slug,
        clientTimezone: undefined,
    });
    await db.logAlert(conn.client_slug, { alertType, recipient: tenantPhone, messageBody, leaseId });
    return sid;
}

async function sendToOwner(conn, messageBody, alertType, leaseId = null) {
    console.log(`[SMS] → Owner ${conn.owner_phone} [${alertType}]: ${messageBody.slice(0, 60)}...`);
    const { sid } = await sendSMS({
        to:             conn.owner_phone,
        body:           messageBody,
        clientSlug:     conn.client_slug,
        clientTimezone: undefined,
    });
    await db.logAlert(conn.client_slug, { alertType, recipient: conn.owner_phone, messageBody, leaseId });
    return sid;
}

module.exports = { sendToTenant, sendToOwner };
