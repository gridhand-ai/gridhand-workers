/**
 * GRIDHAND Chair Filler — SMS Sender
 *
 * Twilio wrapper for last-minute slot notifications.
 * Tone is conversational and urgent without being pushy.
 */

'use strict';

const twilio = require('twilio');
const db     = require('./db');

function getTwilioClient(accountSid, authToken) {
    if (!accountSid || !authToken) {
        throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
    }
    return twilio(accountSid, authToken);
}

/**
 * Send a last-minute slot text to a matched client.
 * Uses "today" or "tomorrow" naturally in the message.
 */
async function sendLastMinuteText(conn, {
    clientPhone,
    clientName,
    serviceType,
    slotTime,
    slotDate,
    salonName,
    bookingUrl,
}) {
    const firstName = (clientName || '').split(' ')[0] || 'there';
    const service   = serviceType || 'an appointment';
    const salon     = salonName   || 'us';
    const url       = bookingUrl  ? ` Book here: ${bookingUrl}` : '';

    const body = `Hi ${firstName}! We just had a ${service} opening ${slotDate} at ${slotTime} at ${salon}. Interested?${url} Reply YES to grab it or STOP to opt out.`;

    await sendSMS(
        clientPhone,
        process.env.TWILIO_FROM_NUMBER,
        body,
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
    );

    await db.logAlert(conn.client_slug, {
        alertType:   'last_minute_text',
        recipient:   clientPhone,
        messageBody: body,
    });
}

/**
 * Core SMS send via Twilio.
 */
async function sendSMS(to, from, body, accountSid, authToken) {
    if (!from) throw new Error('TWILIO_FROM_NUMBER must be set');

    console.log(`[SMS] → ${to}: ${body.slice(0, 60)}...`);

    const client = getTwilioClient(accountSid, authToken);
    await client.messages.create({ from, to, body });
}

module.exports = {
    sendLastMinuteText,
    sendSMS,
};
