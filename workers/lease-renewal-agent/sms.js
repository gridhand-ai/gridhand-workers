/**
 * GRIDHAND Lease Renewal Agent — SMS Module
 *
 * All outbound SMS goes through lib/twilio-client.js sendSMS() to enforce
 * TCPA quiet-hours and opt-out compliance.
 */

'use strict';

const { sendSMS } = require('../../lib/twilio-client');
const db          = require('./db');

async function sendToTenant(conn, renewalId, tenantPhone, messageBody, channel = 'sms') {
    console.log(`[SMS] → Tenant ${tenantPhone}: ${messageBody.slice(0, 60)}...`);
    await sendSMS({
        to:             tenantPhone,
        body:           messageBody,
        clientSlug:     conn.client_slug,
        clientTimezone: undefined,
    });
    await db.logCommunication(conn.client_slug, renewalId, {
        channel: 'sms', direction: 'outbound', recipient: tenantPhone, messageBody,
    });
}

async function sendToOwner(conn, renewalId, messageBody) {
    console.log(`[SMS] → Owner ${conn.owner_phone}: ${messageBody.slice(0, 60)}...`);
    await sendSMS({
        to:             conn.owner_phone,
        body:           messageBody,
        clientSlug:     conn.client_slug,
        clientTimezone: undefined,
    });
    await db.logCommunication(conn.client_slug, renewalId, {
        channel: 'sms', direction: 'outbound', recipient: conn.owner_phone, messageBody,
    });
}

module.exports = { sendToTenant, sendToOwner };
