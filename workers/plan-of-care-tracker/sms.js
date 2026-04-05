/**
 * GRIDHAND Plan of Care Tracker — Twilio SMS Wrapper
 */

'use strict';

const twilio = require('twilio');
const db     = require('./db');

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const FROM = process.env.TWILIO_FROM_NUMBER;

async function sendToPatient(conn, patientPhone, messageBody, ehrPatientId, alertType) {
    await client.messages.create({
        body: messageBody,
        from: FROM,
        to:   patientPhone,
    });

    await db.logAlert(conn.client_slug, {
        alertType,
        ehrPatientId,
        recipient:   patientPhone,
        messageBody,
    });

    console.log(`[SMS] Sent ${alertType} to patient ${patientPhone}`);
}

async function sendToProvider(conn, messageBody, alertType) {
    const to = conn.provider_phone || conn.owner_phone;
    if (!to) {
        console.warn(`[SMS] No provider/owner phone for ${conn.client_slug} — skipping ${alertType}`);
        return;
    }

    await client.messages.create({ body: messageBody, from: FROM, to });

    await db.logAlert(conn.client_slug, {
        alertType,
        ehrPatientId: null,
        recipient:    to,
        messageBody,
    });

    console.log(`[SMS] Sent ${alertType} to provider ${to}`);
}

module.exports = { sendToPatient, sendToProvider };
