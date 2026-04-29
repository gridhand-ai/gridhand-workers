/**
 * GRIDHAND Chair Filler — SMS Sender
 *
 * All outbound SMS goes through lib/twilio-client.js sendSMS() to enforce
 * TCPA quiet-hours and opt-out compliance.
 * Tone is conversational and urgent without being pushy.
 */

'use strict';

const { sendSMS: twilioSendSMS } = require('../../lib/twilio-client');
const db                          = require('./db');

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

    await sendSMS(clientPhone, body, conn.client_slug);

    await db.logAlert(conn.client_slug, {
        alertType:   'last_minute_text',
        recipient:   clientPhone,
        messageBody: body,
    });
}

/**
 * Core SMS send via lib/twilio-client.js.
 */
async function sendSMS(to, body, clientSlug) {
    console.log(`[SMS] → ${to}: ${body.slice(0, 60)}...`);

    await twilioSendSMS({
        to,
        body,
        clientSlug,
        clientTimezone: undefined,
    });
}

module.exports = {
    sendLastMinuteText,
    sendSMS,
};
