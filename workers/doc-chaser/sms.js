/**
 * GRIDHAND Doc Chaser — SMS Module (Twilio)
 *
 * Sends escalating document reminder SMS to tax clients
 * and weekly summary alerts to the firm owner.
 *
 * All outbound messages are logged to dc_reminders via db.logReminder.
 */

'use strict';

const twilio = require('twilio');
const dayjs  = require('dayjs');
const db     = require('./db');

// ─── Twilio Client Factory ────────────────────────────────────────────────────

/**
 * Build a Twilio client from conn row credentials or fall back to env vars.
 */
function getClient(conn) {
    const sid   = conn?.twilio_sid   || process.env.TWILIO_ACCOUNT_SID;
    const token = conn?.twilio_token || process.env.TWILIO_AUTH_TOKEN;

    if (!sid || !token) {
        throw new Error('Twilio credentials not configured (twilio_sid / twilio_token)');
    }

    return twilio(sid, token);
}

function getFromNumber(conn) {
    const from = conn?.twilio_number || process.env.TWILIO_FROM_NUMBER;
    if (!from) throw new Error('Twilio from number not configured (twilio_number)');
    return from;
}

// ─── Document Reminder SMS ────────────────────────────────────────────────────

/**
 * Send an escalating document reminder to a tax client via SMS.
 *
 * @param {object} conn         - dc_clients row
 * @param {object} request      - dc_document_requests row
 * @param {number} reminderCount - How many reminders have already been sent (0-based)
 */
async function sendDocumentReminder(conn, request, reminderCount) {
    if (!request.client_phone) {
        console.warn(`[SMS] No phone for request ${request.id} (${request.client_name}) — skipping`);
        return { ok: false, error: 'No phone number on file' };
    }

    const firmName    = conn.firm_name || 'Your accounting firm';
    const name        = request.client_name.split(' ')[0] || request.client_name;
    const docName     = request.document_name;
    const dueDate     = request.due_date ? dayjs(request.due_date).format('MMM D') : null;

    let body;

    if (reminderCount === 0) {
        body = `Hi ${name}, ${firmName} needs your ${docName} to proceed with your tax return. Please upload it at your client portal or reply for help. Reply STOP to opt out.`;
    } else if (reminderCount === 1) {
        const duePart = dueDate ? ` Deadline: ${dueDate}.` : '';
        body = `Following up — ${firmName} is still waiting on your ${docName}.${duePart} Upload at your client portal or call us. Reply STOP to opt out.`;
    } else {
        body = `URGENT: ${firmName} cannot file your return without your ${docName}. Please upload immediately or contact us today. Reply STOP to opt out.`;
    }

    const from = getFromNumber(conn);
    const client = getClient(conn);

    try {
        await client.messages.create({
            from,
            to:   request.client_phone,
            body,
        });

        console.log(`[SMS] Reminder ${reminderCount + 1} → ${request.client_phone} for "${docName}" (${request.client_name})`);

        await db.logReminder(conn.id, {
            requestId:  request.id,
            channel:    'sms',
            recipient:  request.client_phone,
            subject:    null,
            body,
            status:     'sent',
        });

        return { ok: true, body };
    } catch (err) {
        console.error(`[SMS] Failed to send reminder for request ${request.id}: ${err.message}`);

        await db.logReminder(conn.id, {
            requestId:    request.id,
            channel:      'sms',
            recipient:    request.client_phone,
            subject:      null,
            body,
            status:       'failed',
            errorMessage: err.message,
        });

        return { ok: false, error: err.message };
    }
}

// ─── Weekly Report SMS (Owner Alert) ─────────────────────────────────────────

/**
 * Send a weekly outstanding documents summary SMS to the firm owner.
 *
 * @param {object} conn       - dc_clients row (has owner_phone)
 * @param {object} reportData - { totalRequests, pendingCount, overdueCount, receivedCount }
 */
async function sendWeeklyReport(conn, reportData) {
    if (!conn.owner_phone) {
        console.warn(`[SMS] No owner_phone configured for ${conn.client_slug} — skipping weekly SMS`);
        return { ok: false, error: 'No owner phone configured' };
    }

    const { totalRequests, pendingCount, overdueCount, receivedCount } = reportData;
    const firmName = conn.firm_name || 'Your firm';

    const body = `${firmName} Weekly Doc Summary: ${totalRequests} total requests — ${receivedCount} received, ${pendingCount} pending, ${overdueCount} overdue. Log in to review outstanding items.`;

    const from   = getFromNumber(conn);
    const client = getClient(conn);

    try {
        await client.messages.create({
            from,
            to:   conn.owner_phone,
            body,
        });

        console.log(`[SMS] Weekly report → ${conn.owner_phone} for ${conn.client_slug}`);
        return { ok: true, body };
    } catch (err) {
        console.error(`[SMS] Failed to send weekly report for ${conn.client_slug}: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    getClient,
    sendDocumentReminder,
    sendWeeklyReport,
};
