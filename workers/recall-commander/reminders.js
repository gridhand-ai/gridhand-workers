/**
 * GRIDHAND AI — Recall Commander
 * SMS Reminders, Follow-Ups, Escalations, and Daily Digest
 *
 * All outbound messages are logged to rc_sms_log.
 * All inbound patient replies are handled and routed.
 */

'use strict';

const twilio = require('twilio');
const dayjs = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

// ============================================================
// SEND RECALL REMINDER (initial outreach)
// ============================================================

/**
 * Send the first recall reminder to a patient.
 * @param {Object} conn         - rc_connections row
 * @param {Object} patient      - rc_recall_queue row
 * @param {number} daysOverdue
 */
async function sendRecallReminder(conn, patient, daysOverdue) {
    const monthsOverdue = Math.ceil(daysOverdue / 30);
    const monthsSinceVisit = patient.last_visit_date
        ? Math.floor(dayjs().diff(dayjs(patient.last_visit_date), 'month'))
        : monthsOverdue + (conn.recall_hygiene_interval_months || 6);

    const recallLabel = patient.recall_type === 'exam' ? 'check-up exam' : 'dental cleaning';
    const firstName = patient.patient_name.split(' ')[0];

    const body = `Hi ${firstName}! You're due for your ${recallLabel} at ${conn.practice_name}. It's been ${monthsSinceVisit} month${monthsSinceVisit !== 1 ? 's' : ''} since your last visit. Reply YES to schedule or call us at ${conn.front_desk_phone}. - ${conn.practice_name}`;

    const fromNumber = conn.twilio_number || FROM_NUMBER;
    if (!fromNumber) {
        console.error(`[Reminders] No Twilio number configured for ${conn.client_slug}`);
        return { ok: false, error: 'No Twilio number configured' };
    }

    let sid = null;
    let sendStatus = 'sent';

    try {
        const msg = await twilioClient.messages.create({
            body,
            from: fromNumber,
            to: patient.patient_phone
        });
        sid = msg.sid;
    } catch (err) {
        console.error(`[Reminders] sendRecallReminder to ${patient.patient_phone} failed:`, err.message);
        sendStatus = 'failed';
    }

    // Log the SMS
    await _logSms(conn.client_slug, patient.patient_id, 'outbound', body, sid, sendStatus);

    if (sendStatus === 'failed') return { ok: false, error: 'Twilio send failed' };

    // Update queue record
    await supabase
        .from('rc_recall_queue')
        .update({
            status: 'contacted',
            reminder_count: (patient.reminder_count || 0) + 1,
            last_reminder_sent_at: new Date().toISOString()
        })
        .eq('id', patient.id);

    // Increment today's recalls_sent stat
    await _upsertDailyStat(conn.client_slug, { recalls_sent: 1 });

    return { ok: true, sid };
}

// ============================================================
// SEND FOLLOW-UP (day 3 and day 7)
// ============================================================

/**
 * Send a follow-up reminder if patient hasn't replied.
 * @param {Object} conn     - rc_connections row
 * @param {Object} patient  - rc_recall_queue row
 * @param {number} attempt  - 1 (day 3) or 2 (day 7)
 */
async function sendFollowUp(conn, patient, attempt) {
    const firstName = patient.patient_name.split(' ')[0];
    const recallLabel = patient.recall_type === 'exam' ? 'exam' : 'cleaning';

    let body;
    if (attempt === 1) {
        body = `Hi ${firstName}, just a quick reminder from ${conn.practice_name} — your ${recallLabel} is overdue! We have openings this week. Reply YES to schedule or call ${conn.front_desk_phone}. Reply STOP to opt out.`;
    } else {
        body = `${firstName}, last reminder from ${conn.practice_name} — your dental ${recallLabel} is still due. Your oral health matters to us! Reply YES to book or call ${conn.front_desk_phone}. Reply STOP to opt out.`;
    }

    const fromNumber = conn.twilio_number || FROM_NUMBER;
    if (!fromNumber) return { ok: false, error: 'No Twilio number configured' };

    let sid = null;
    let sendStatus = 'sent';

    try {
        const msg = await twilioClient.messages.create({
            body,
            from: fromNumber,
            to: patient.patient_phone
        });
        sid = msg.sid;
    } catch (err) {
        console.error(`[Reminders] sendFollowUp attempt ${attempt} to ${patient.patient_phone} failed:`, err.message);
        sendStatus = 'failed';
    }

    await _logSms(conn.client_slug, patient.patient_id, 'outbound', body, sid, sendStatus);

    if (sendStatus === 'failed') return { ok: false, error: 'Twilio send failed' };

    await supabase
        .from('rc_recall_queue')
        .update({
            reminder_count: (patient.reminder_count || 0) + 1,
            last_reminder_sent_at: new Date().toISOString()
        })
        .eq('id', patient.id);

    await _upsertDailyStat(conn.client_slug, { recalls_sent: 1 });

    return { ok: true, sid };
}

// ============================================================
// ESCALATION ALERT TO FRONT DESK
// ============================================================

/**
 * Send front desk a batch alert of patients who have not responded after 7+ days.
 * @param {Object} conn               - rc_connections row
 * @param {Array}  noResponsePatients - array of rc_recall_queue rows
 */
async function sendEscalationAlert(conn, noResponsePatients) {
    if (!noResponsePatients || noResponsePatients.length === 0) return { ok: true, skipped: true };

    const frontDeskPhone = conn.front_desk_phone;
    if (!frontDeskPhone) return { ok: false, error: 'No front desk phone configured' };

    // Build list (max 10 names to keep SMS readable)
    const displayList = noResponsePatients.slice(0, 10);
    const remainder = noResponsePatients.length - displayList.length;

    const nameList = displayList.map(p => {
        const overdueDays = p.days_overdue || 0;
        return `• ${p.patient_name} (${p.recall_type}, ${overdueDays}d overdue)`;
    }).join('\n');

    const suffix = remainder > 0 ? `\n...and ${remainder} more.` : '';

    const body = `[${conn.practice_name}] ${noResponsePatients.length} patient${noResponsePatients.length !== 1 ? 's' : ''} haven't responded to recall texts — please call:\n${nameList}${suffix}`;

    const fromNumber = conn.twilio_number || FROM_NUMBER;
    let sid = null;
    let sendStatus = 'sent';

    try {
        const msg = await twilioClient.messages.create({
            body,
            from: fromNumber,
            to: frontDeskPhone
        });
        sid = msg.sid;
    } catch (err) {
        console.error(`[Reminders] sendEscalationAlert to front desk failed:`, err.message);
        sendStatus = 'failed';
    }

    // Log escalation
    await supabase.from('rc_escalations').insert({
        client_slug: conn.client_slug,
        patient_count: noResponsePatients.length,
        message_body: body,
        sent_to_phone: frontDeskPhone
    });

    await _logSms(conn.client_slug, null, 'outbound', body, sid, sendStatus);

    return { ok: sendStatus === 'sent', sid };
}

// ============================================================
// HANDLE PATIENT REPLY
// ============================================================

/**
 * Process inbound patient SMS reply (YES / NO / STOP).
 * Logs the reply and updates recall queue status.
 * @param {Object} conn          - rc_connections row
 * @param {string} patientPhone  - E.164 patient phone number
 * @param {string} body          - raw SMS body text
 */
async function handlePatientReply(conn, patientPhone, body) {
    const normalized = body.trim().toUpperCase();

    // Log the inbound message first
    await _logSms(conn.client_slug, null, 'inbound', body, null, 'received');

    // Find the most recently contacted patient with this phone
    const { data: queueRow } = await supabase
        .from('rc_recall_queue')
        .select('*')
        .eq('client_slug', conn.client_slug)
        .eq('patient_phone', patientPhone)
        .in('status', ['contacted', 'no_response'])
        .order('last_reminder_sent_at', { ascending: false })
        .limit(1)
        .single();

    if (!queueRow) {
        console.warn(`[Reminders] Inbound reply from unknown patient: ${patientPhone} for ${conn.client_slug}`);
        return { ok: false, reason: 'patient_not_found' };
    }

    // Update the SMS log with patient_id now that we have it
    await supabase
        .from('rc_sms_log')
        .update({ patient_id: queueRow.patient_id })
        .eq('client_slug', conn.client_slug)
        .eq('direction', 'inbound')
        .is('patient_id', null)
        .order('created_at', { ascending: false })
        .limit(1);

    let newStatus = null;
    let replyBody = null;
    const fromNumber = conn.twilio_number || FROM_NUMBER;
    const firstName = queueRow.patient_name.split(' ')[0];

    if (['YES', 'Y', 'YES.', '1'].includes(normalized)) {
        newStatus = 'contacted'; // Front desk will convert to scheduled after booking
        replyBody = `Great, ${firstName}! We'll have our team reach out shortly to confirm your appointment. See you soon! - ${conn.practice_name}`;

        await _upsertDailyStat(conn.client_slug, { responses_received: 1 });

        // Alert front desk immediately
        const alertBody = `[${conn.practice_name}] ${queueRow.patient_name} (${queueRow.recall_type}) replied YES to recall text. Call to book: ${patientPhone}`;
        try {
            await twilioClient.messages.create({
                body: alertBody,
                from: fromNumber,
                to: conn.front_desk_phone
            });
            await _logSms(conn.client_slug, queueRow.patient_id, 'outbound', alertBody, null, 'sent');
        } catch (err) {
            console.error('[Reminders] Front desk YES alert failed:', err.message);
        }

    } else if (['NO', 'N', 'NO.', '2', 'NOPE'].includes(normalized)) {
        newStatus = 'declined';
        replyBody = `Understood, ${firstName}. We'll check back in 6 months. Take care! - ${conn.practice_name}`;
        await _upsertDailyStat(conn.client_slug, { responses_received: 1 });

    } else if (['STOP', 'UNSUBSCRIBE', 'CANCEL', 'QUIT', 'END'].includes(normalized)) {
        newStatus = 'opted_out';
        // Twilio handles STOP compliance automatically, but we log it
        replyBody = null; // Let Twilio handle the STOP confirmation

    } else {
        // Unrecognized reply — forward to front desk for manual handling
        await _upsertDailyStat(conn.client_slug, { responses_received: 1 });
        const fwdBody = `[${conn.practice_name}] Reply from ${queueRow.patient_name} (${patientPhone}) re: ${queueRow.recall_type} recall: "${body}" — please respond manually.`;
        try {
            await twilioClient.messages.create({
                body: fwdBody,
                from: fromNumber,
                to: conn.front_desk_phone
            });
            await _logSms(conn.client_slug, queueRow.patient_id, 'outbound', fwdBody, null, 'sent');
        } catch (err) {
            console.error('[Reminders] Unknown reply forward to front desk failed:', err.message);
        }
        return { ok: true, action: 'forwarded_to_front_desk' };
    }

    // Update queue status
    if (newStatus) {
        await supabase
            .from('rc_recall_queue')
            .update({ status: newStatus })
            .eq('id', queueRow.id);
    }

    // Send patient reply confirmation
    if (replyBody) {
        try {
            const confirmMsg = await twilioClient.messages.create({
                body: replyBody,
                from: fromNumber,
                to: patientPhone
            });
            await _logSms(conn.client_slug, queueRow.patient_id, 'outbound', replyBody, confirmMsg.sid, 'sent');
        } catch (err) {
            console.error('[Reminders] Reply confirmation send failed:', err.message);
        }
    }

    return { ok: true, action: newStatus, patientName: queueRow.patient_name };
}

// ============================================================
// DAILY DIGEST (morning briefing to front desk)
// ============================================================

/**
 * Send morning stats SMS to front desk and owner.
 * @param {Object} conn - rc_connections row
 */
async function sendDailyDigest(conn) {
    const today = dayjs().format('YYYY-MM-DD');
    const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

    // Yesterday's stats
    const { data: stats } = await supabase
        .from('rc_daily_stats')
        .select('*')
        .eq('client_slug', conn.client_slug)
        .eq('stat_date', yesterday)
        .single();

    // Current queue totals
    const [pendingResult, contactedResult, scheduledResult, noResponseResult] = await Promise.all([
        supabase.from('rc_recall_queue').select('id', { count: 'exact', head: true })
            .eq('client_slug', conn.client_slug).eq('status', 'pending'),
        supabase.from('rc_recall_queue').select('id', { count: 'exact', head: true })
            .eq('client_slug', conn.client_slug).eq('status', 'contacted'),
        supabase.from('rc_recall_queue').select('id', { count: 'exact', head: true })
            .eq('client_slug', conn.client_slug).eq('status', 'scheduled'),
        supabase.from('rc_recall_queue').select('id', { count: 'exact', head: true })
            .eq('client_slug', conn.client_slug).eq('status', 'no_response')
    ]);

    const recallsSent = stats?.recalls_sent || 0;
    const booked      = stats?.appointments_booked || 0;
    const responses   = stats?.responses_received || 0;
    const rate        = recallsSent > 0 ? ((booked / recallsSent) * 100).toFixed(0) : '0';

    const pending    = pendingResult.count || 0;
    const contacted  = contactedResult.count || 0;
    const scheduled  = scheduledResult.count || 0;
    const noResponse = noResponseResult.count || 0;

    const body = `[${conn.practice_name}] Good morning! Yesterday's recall summary:\n• Texts sent: ${recallsSent}\n• Responses: ${responses}\n• Booked: ${booked} (${rate}% rate)\n\nQueue now:\n• Pending: ${pending}\n• Contacted: ${contacted}\n• Scheduled: ${scheduled}\n• No response: ${noResponse}\n\n- GRIDHAND Recall Commander`;

    const fromNumber = conn.twilio_number || FROM_NUMBER;
    const targets = [conn.front_desk_phone, conn.owner_phone].filter(Boolean);
    const results = [];

    for (const to of targets) {
        let sid = null;
        let sendStatus = 'sent';
        try {
            const msg = await twilioClient.messages.create({ body, from: fromNumber, to });
            sid = msg.sid;
        } catch (err) {
            console.error(`[Reminders] sendDailyDigest to ${to} failed:`, err.message);
            sendStatus = 'failed';
        }
        await _logSms(conn.client_slug, null, 'outbound', body, sid, sendStatus);
        results.push({ to, status: sendStatus });
    }

    return { ok: true, results, stats: { recallsSent, booked, responses, rate } };
}

// ============================================================
// HELPERS
// ============================================================

async function _logSms(clientSlug, patientId, direction, body, twilioSid, status) {
    const row = {
        client_slug:  clientSlug,
        direction,
        message_body: body,
        status:       status || 'sent'
    };
    if (patientId) row.patient_id = patientId;
    if (twilioSid) row.twilio_sid = twilioSid;

    const { error } = await supabase.from('rc_sms_log').insert(row);
    if (error) console.error('[Reminders] _logSms error:', error.message);
}

/**
 * Upsert today's daily stats row, incrementing the given counters.
 * @param {string} clientSlug
 * @param {Object} increments - keys: recalls_sent | responses_received | appointments_booked
 */
async function _upsertDailyStat(clientSlug, increments) {
    const today = dayjs().format('YYYY-MM-DD');

    // Try to increment existing row with a raw SQL upsert
    const sets = Object.entries(increments)
        .map(([col, val]) => `${col} = COALESCE(${col}, 0) + ${parseInt(val) || 1}`)
        .join(', ');

    // Use Supabase upsert — on conflict increment
    const { data: existing } = await supabase
        .from('rc_daily_stats')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('stat_date', today)
        .single();

    if (existing) {
        const updates = {};
        for (const [col, inc] of Object.entries(increments)) {
            updates[col] = (existing[col] || 0) + (parseInt(inc) || 1);
        }
        await supabase.from('rc_daily_stats').update(updates)
            .eq('client_slug', clientSlug).eq('stat_date', today);
    } else {
        const newRow = { client_slug: clientSlug, stat_date: today, recalls_sent: 0, responses_received: 0, appointments_booked: 0 };
        for (const [col, inc] of Object.entries(increments)) {
            newRow[col] = parseInt(inc) || 1;
        }
        await supabase.from('rc_daily_stats').insert(newRow);
    }
}

module.exports = {
    sendRecallReminder,
    sendFollowUp,
    sendEscalationAlert,
    handlePatientReply,
    sendDailyDigest,
    _upsertDailyStat  // exported for jobs.js to mark appointments_booked
};
