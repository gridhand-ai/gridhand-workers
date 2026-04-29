/**
 * GRIDHAND Rebook Reminder — SMS Sender
 *
 * All outbound SMS goes through lib/twilio-client.js sendSMS() to enforce
 * TCPA quiet-hours and opt-out compliance.
 * Message tone varies by how overdue the client is.
 */

'use strict';

const { sendSMS: twilioSendSMS } = require('../../lib/twilio-client');
const db                          = require('./db');

/**
 * Send a rebook reminder — tone adjusts based on how overdue the client is.
 *   1-14 days overdue   → gentle, friendly nudge
 *   15-30 days overdue  → warmer urgency
 *   30+ days overdue    → winback tone
 */
async function sendRebookReminder(conn, {
    clientPhone,
    clientName,
    lastServiceType,
    overdueDays,
    salonName,
    bookingUrl,
}) {
    const firstName = (clientName || '').split(' ')[0] || 'there';
    const service   = lastServiceType || 'your last service';
    const salon     = salonName || 'us';
    const url       = bookingUrl ? ` Book here: ${bookingUrl}` : '';

    let body;

    if (overdueDays <= 14) {
        // Gentle nudge
        body = `Hi ${firstName}! Just a friendly reminder — it's been a little while since your ${service} at ${salon}. Ready to book your next appointment?${url} Reply YES and we'll reach out, or reply STOP to opt out.`;
    } else if (overdueDays <= 30) {
        // Warmer urgency
        body = `Hey ${firstName}! We miss you at ${salon}. It's been ${overdueDays} days since your last ${service} — your hair (and we!) would love to see you soon.${url} Reply YES to book or STOP to opt out.`;
    } else {
        // Winback
        body = `Hi ${firstName}, it's been a while! We'd love to welcome you back to ${salon}. Book your ${service} appointment anytime —${url} Reply YES and we'll set it up. Reply STOP to opt out.`;
    }

    await sendSMS(clientPhone, body, conn.client_slug);

    await db.logAlert(conn.client_slug, {
        alertType:   'rebook_reminder',
        recipient:   clientPhone,
        messageBody: body,
    });
}

/**
 * Send booking confirmation when client replies YES.
 */
async function sendConfirmation(conn, { clientPhone, clientName, salonName }) {
    const firstName = (clientName || '').split(' ')[0] || 'there';
    const salon     = salonName || 'us';
    const url       = conn.booking_url ? ` ${conn.booking_url}` : '';

    const body = `Great to hear from you, ${firstName}! Someone from ${salon} will reach out shortly to confirm your appointment.${url ? ` Or book directly:${url}` : ''} See you soon!`;

    await sendSMS(clientPhone, body, conn.client_slug);

    await db.logAlert(conn.client_slug, {
        alertType:   'confirmation',
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
    sendRebookReminder,
    sendConfirmation,
    sendSMS,
};
