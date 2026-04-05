/**
 * GRIDHAND Vaccine Reminder — Twilio SMS Functions
 *
 * Sends tiered vaccine reminder SMS messages and booking confirmations.
 * Logs every outbound message to vaccine_alerts via db.logAlert.
 */

'use strict';

const twilio = require('twilio');
const db     = require('./db');

function getClient(accountSid, authToken) {
    if (!accountSid || !authToken) {
        throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
    }
    return twilio(accountSid, authToken);
}

/**
 * Send a tiered vaccine reminder SMS.
 *
 * reminderType: 'due_soon' | 'overdue_mild' | 'overdue_serious' | 'critical'
 */
async function sendReminderSMS(conn, {
    ownerPhone, petName, vaccineName, dueDate,
    reminderType, daysOverdue, practiceName, practicePhone,
}) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    const from       = process.env.TWILIO_FROM_NUMBER;
    if (!from) throw new Error('TWILIO_FROM_NUMBER must be set');

    const body = buildReminderMessage({
        reminderType, petName, vaccineName, dueDate,
        daysOverdue, practiceName, practicePhone,
    });

    console.log(`[SMS] → ${ownerPhone} [${reminderType}]: ${body.slice(0, 80)}...`);

    await sendSMS(ownerPhone, from, body, accountSid, authToken);

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
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    const from       = process.env.TWILIO_FROM_NUMBER;
    if (!from) throw new Error('TWILIO_FROM_NUMBER must be set');

    let body;
    if (appointmentDate) {
        body = `Hi! Your appointment for ${petName}'s ${vaccineName || 'vaccine'} has been scheduled for ${appointmentDate} at ${conn.practice_name}. See you then!`;
    } else {
        body = `Hi! We received your request to schedule ${petName}'s ${vaccineName || 'vaccine'} at ${conn.practice_name}. Our team will confirm your appointment time shortly. Questions? Call ${conn.owner_phone}.`;
    }

    console.log(`[SMS] → ${ownerPhone} [booking_confirmation]: ${body.slice(0, 80)}...`);

    await sendSMS(ownerPhone, from, body, accountSid, authToken);

    await db.logAlert(conn.client_slug, {
        alertType:   'booking_confirmation',
        recipient:   ownerPhone,
        messageBody: body,
    });
}

/**
 * Raw Twilio send — used internally.
 */
async function sendSMS(to, from, body, accountSid, authToken) {
    const client = getClient(accountSid, authToken);
    await client.messages.create({ from, to, body });
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
