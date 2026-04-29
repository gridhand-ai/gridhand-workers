/**
 * GRIDHAND Maintenance Dispatcher — SMS Module
 *
 * All outbound SMS goes through lib/twilio-client.js sendSMS() to enforce
 * TCPA quiet-hours and opt-out compliance.
 */

'use strict';

const { sendSMS } = require('../../lib/twilio-client');
const db          = require('./db');

async function sendToTenant(conn, tenantPhone, messageBody, alertType, requestId = null) {
    console.log(`[SMS] → Tenant ${tenantPhone} [${alertType}]`);
    await sendSMS({
        to:             tenantPhone,
        body:           messageBody,
        clientSlug:     conn.client_slug,
        clientTimezone: undefined,
    });
    await db.logAlert(conn.client_slug, { alertType, recipient: tenantPhone, messageBody, requestId });
}

async function sendToVendor(conn, vendorPhone, messageBody, alertType, requestId = null) {
    console.log(`[SMS] → Vendor ${vendorPhone} [${alertType}]`);
    await sendSMS({
        to:             vendorPhone,
        body:           messageBody,
        clientSlug:     conn.client_slug,
        clientTimezone: undefined,
    });
    await db.logAlert(conn.client_slug, { alertType, recipient: vendorPhone, messageBody, requestId });
}

async function sendToOwner(conn, messageBody, alertType, requestId = null) {
    console.log(`[SMS] → Owner ${conn.owner_phone} [${alertType}]`);
    await sendSMS({
        to:             conn.owner_phone,
        body:           messageBody,
        clientSlug:     conn.client_slug,
        clientTimezone: undefined,
    });
    await db.logAlert(conn.client_slug, { alertType, recipient: conn.owner_phone, messageBody, requestId });
}

module.exports = { sendToTenant, sendToVendor, sendToOwner };
