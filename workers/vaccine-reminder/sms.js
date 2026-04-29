/**
 * GRIDHAND Vaccine Reminder — SMS Functions
 *
 * Sends tiered vaccine reminder SMS messages and booking confirmations.
 * All outbound SMS goes through lib/twilio-client.js sendSMS() to enforce
 * TCPA quiet-hours and opt-out compliance.
 * Logs every outbound message to vaccine_alerts via db.logAlert.
 */

'use strict';

const { sendSMS: twilioSendSMS } = require('../../lib/twilio-client');
const db                          = require('./db');

/**
 * Send a tiered vaccine reminder SMS.
 *
 * reminderType: 'due_soon' | 'overdue_mild' | 'overdue_serious' | 'critical'
 */
async function sendReminderSMS(conn, {
    ownerPhone, petName, vaccineName, dueDate,
    reminderType, daysOverdue, practiceName, practicePhone,
}) {
    const body = buildReminderMessage({
        reminderType, petName, vaccineName, dueDate,
        daysOverdue, practiceName, practicePhone,
    });

    console.log(`[SMS] → ${ownerPhone} [${reminderType}]: ${body.slice(0, 80)}...`);

    await sendSMS(ownerPhone, body, conn.client_slug);

    await db.logAlert(conn.client_slug, {
        alertType:   `vaccine_reminder_${reminderType}`,
        recipient:   ownerPhone,
        messageBody: body,
    });
}

/**
 * Send a booking confirmation SMS after an owner replies YES.
 *
 * If appointmentDate is null (practice hasn't confirmed yet),
 * the message tells them someone will follow up.
 */
async function sendConfirmationSMS(conn, { ownerPhone, petName, vaccineName, appointmentDate }) {
    let body;
    if (appointmentDate) {
        body = `Hi! Your appointment for ${petName}'s ${vaccineName || 'vaccine'} has been scheduled for ${appointmentDate} at ${conn.practice_name}. See you then!`;
    } else {
        body = `Hi! We received your request to schedule ${petName}'s ${vaccineName || 'vaccine'} at ${conn.practice_name}. Our team will confirm your appointment time shortly. Questions? Call ${conn.owner_phone}.`;
    }

    console.log(`[SMS] → ${ownerPhone} [booking_confirmation]: ${body.slice(0, 80)}...`);

    await sendSMS(ownerPhone, body, conn.client_slug);

    await db.logAlert(conn.client_slug, {
        alertType:   'booking_confirmation',
        recipient:   ownerPhone,
        messageBody: body,
    });
}

/**
 * Raw SMS send — used internally. Routes through lib/twilio-client.js.
 */
async function sendSMS(to, body, clientSlug) {
    await twilioSendSMS({
        to,
        body,
        clientSlug,
        clientTimezone: undefined,
    });
}

// ─── Message Builder ──────────────────────────────────────────────────────────

function buildReminderMessage({ reminderType, petName, vaccineName, dueDate, daysOverdue, practiceName, practicePhone }) {
    const practice = practiceName || 'your veterinary clinic';
    const phone    = practicePhone || '';

    switch (reminderType) {
        case 'due_soon':
            return `Hi! ${petName} is due for ${vaccineName} on ${dueDate}. Reply YES to schedule an appointment at ${practice}. Reply STOP to opt out.`;

        case 'overdue_mild':
            return `Hi! ${petName}'s ${vaccineName} was due ${daysOverdue} day${daysOverdue !== 1 ? 's' : ''} ago. Please schedule soon to keep them protected! Reply YES to book an appointment at ${practice}. Reply STOP to opt out.`;

        case 'overdue_serious':
            return `Reminder: ${petName}'s ${vaccineName} is ${daysOverdue} days overdue. This vaccine is important for their health. Please call ${phone || practice} or reply YES to book now. Reply STOP to opt out.`;

        case 'critical':
            return `IMPORTANT: ${petName}'s ${vaccineName} is ${daysOverdue} days overdue. This affects their health and may pose a risk. Please act now — call ${phone || practice} or reply YES to schedule immediately. Reply STOP to opt out.`;

        default:
            return `Hi! ${petName} has a vaccine due. Please contact ${practice} to schedule. Call ${phone || 'us'} or reply YES. Reply STOP to opt out.`;
    }
}

module.exports = {
    sendReminderSMS,
    sendConfirmationSMS,
    sendSMS,
};
