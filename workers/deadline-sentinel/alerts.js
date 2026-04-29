/**
 * GRIDHAND Deadline Sentinel — Alert Engine
 *
 * Handles all outbound SMS via Twilio.
 * Implements the full escalation ladder:
 *   14 days → 1 warning SMS
 *    7 days → SMS + mark urgent
 *    3 days → SMS every morning
 *    1 day  → SMS morning + evening
 *   Day of  → SMS 7am + 12pm
 *   Missed  → Immediate SMS to attorney + managing partner
 *
 * Environment vars:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

'use strict';

require('dotenv').config();

const dayjs  = require('dayjs');
const { createClient } = require('@supabase/supabase-js');
const caseMgmt = require('./case-mgmt');
const { sendSMS } = require('../../lib/twilio-client');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Message Formatters ───────────────────────────────────────────────────────

/**
 * Build an alert SMS body for a deadline.
 *
 * @param {object} opts
 * @param {string} opts.firmName
 * @param {string} opts.clientName
 * @param {string} opts.deadlineType   — human-readable label
 * @param {string} opts.deadlineDate   — 'YYYY-MM-DD'
 * @param {number} opts.daysUntil
 * @param {string} opts.attorneyName
 * @param {string} urgencyLevel        — 'critical' | 'urgent' | 'warning' | 'missed'
 * @returns {string}
 */
function formatDeadlineAlert(opts, urgencyLevel) {
    const { firmName, clientName, deadlineType, deadlineDate, daysUntil, attorneyName } = opts;
    const dateFormatted = dayjs(deadlineDate).format('MMM D, YYYY');
    const typeLabel     = formatDeadlineType(deadlineType);
    const dayLabel      = daysUntil === 0
        ? 'TODAY'
        : daysUntil === 1
            ? '1 day'
            : `${daysUntil} days`;

    if (urgencyLevel === 'missed') {
        return (
            `🚨 MISSED DEADLINE — ${firmName}\n` +
            `Matter: ${clientName}\n` +
            `Deadline: ${typeLabel} was ${dateFormatted}\n` +
            `Attorney: ${attorneyName}\n` +
            `Immediate action required`
        );
    }

    return (
        `⚠️ DEADLINE ALERT — ${firmName}\n` +
        `Matter: ${clientName}\n` +
        `Deadline: ${typeLabel} on ${dateFormatted} (${dayLabel})\n` +
        `Attorney: ${attorneyName}\n` +
        `Action required immediately`
    );
}

/**
 * Format the weekly deadline report SMS body.
 *
 * @param {object} report — from deadlines.generateWeeklyReport()
 * @returns {string}
 */
function formatWeeklyReport(report) {
    const {
        firmName, weekOf,
        criticalCount, urgentCount, warningCount, missedCount,
        courtDatesCount, filingCount,
    } = report;

    return (
        `📅 Weekly Deadline Report — ${firmName}\n` +
        `Week of ${weekOf}\n` +
        `─────────────────\n` +
        `Critical (≤3 days): ${criticalCount}\n` +
        `Urgent (≤7 days): ${urgentCount}\n` +
        `Upcoming (≤14 days): ${warningCount}\n` +
        `Missed this week: ${missedCount}\n` +
        `─────────────────\n` +
        `Court dates this week: ${courtDatesCount}\n` +
        `Filing deadlines: ${filingCount}\n` +
        `Reply DETAIL for full list`
    );
}

function formatDeadlineType(type) {
    const labels = {
        statute_of_limitations: 'Statute of Limitations',
        filing_deadline:        'Filing Deadline',
        court_date:             'Court Date',
        discovery_cutoff:       'Discovery Cutoff',
        response_due:           'Response Due',
        general_task:           'Task',
    };
    return labels[type] || type;
}

// ─── Dedup Guard ──────────────────────────────────────────────────────────────

/**
 * Check if we've already sent an alert of this type for this deadline today.
 *
 * @param {string} clientSlug
 * @param {number} deadlineId
 * @param {string} alertType
 * @returns {boolean}
 */
async function alreadySentToday(clientSlug, deadlineId, alertType) {
    const today = dayjs().format('YYYY-MM-DD');

    const { data } = await supabase
        .from('deadline_alerts')
        .select('id')
        .eq('client_slug', clientSlug)
        .eq('deadline_id', deadlineId)
        .eq('alert_type', alertType)
        .gte('created_at', `${today}T00:00:00Z`)
        .limit(1);

    return (data || []).length > 0;
}

// ─── Core Send ────────────────────────────────────────────────────────────────

/**
 * Send an SMS and log it.
 *
 * @param {string} to             — E.164 phone number
 * @param {string} body           — message text
 * @param {string} clientSlug
 * @param {number|null} deadlineId
 * @param {string} alertType
 * @param {string} urgencyLevel
 */
async function sendSms(to, body, clientSlug, deadlineId, alertType, urgencyLevel) {
    let twilioSid = null;

    try {
        const { sid } = await sendSMS({
            to,
            body,
            clientSlug,
            clientTimezone: undefined,
        });
        twilioSid = sid;
        console.log(`[Alerts] SMS sent to ${to} [${alertType}] SID: ${sid}`);
    } catch (err) {
        console.error(`[Alerts] SMS error sending to ${to}: ${err.message}`);
        // Still log the attempt
    }

    await logAlert(clientSlug, {
        deadline_id:   deadlineId,
        alert_type:    alertType,
        urgency_level: urgencyLevel,
        recipient:     to,
        message_body:  body,
        twilio_sid:    twilioSid,
    });
}

// ─── Main: sendDeadlineAlert ──────────────────────────────────────────────────

/**
 * Evaluate a deadline and send the appropriate alert based on urgency.
 * Implements the full escalation ladder with dedup.
 *
 * @param {string} clientSlug
 * @param {object} deadline   — row from tracked_deadlines
 * @param {string} urgencyLevel
 */
async function sendDeadlineAlert(clientSlug, deadline, urgencyLevel) {
    const conn = await caseMgmt.getConnection(clientSlug);
    if (!conn?.attorney_phone) {
        console.warn(`[Alerts] No attorney phone for ${clientSlug} — skipping alert`);
        return;
    }

    const daysUntil = dayjs(deadline.deadline_date).diff(dayjs().startOf('day'), 'day');
    const hour      = dayjs().hour();  // 0-23 in server time

    const alertPayload = {
        firmName:      conn.firm_name || clientSlug,
        clientName:    deadline.client_name || deadline.matter_name,
        deadlineType:  deadline.deadline_type,
        deadlineDate:  deadline.deadline_date,
        daysUntil,
        attorneyName:  deadline.attorney_name,
    };

    // ── Missed: fire immediately to attorney + partner ──────────────────────
    if (urgencyLevel === 'missed') {
        const body = formatDeadlineAlert(alertPayload, 'missed');

        const alreadySent = await alreadySentToday(clientSlug, deadline.id, 'missed');
        if (!alreadySent) {
            await sendSms(conn.attorney_phone, body, clientSlug, deadline.id, 'missed', 'critical');

            if (conn.partner_phone && conn.partner_phone !== conn.attorney_phone) {
                await sendSms(conn.partner_phone, body, clientSlug, deadline.id, 'missed_partner', 'critical');
            }

            // Update tracked deadline alert metadata
            await supabase
                .from('tracked_deadlines')
                .update({
                    last_alerted_at: new Date().toISOString(),
                    alert_count: (deadline.alert_count || 0) + 1,
                })
                .eq('id', deadline.id);
        }
        return;
    }

    // ── Day of: 7am + 12pm ─────────────────────────────────────────────────
    if (daysUntil === 0) {
        const isAm   = hour >= 7  && hour < 9;
        const isNoon = hour >= 12 && hour < 14;

        if (!isAm && !isNoon) return;  // Not in an alert window

        const alertType = isNoon ? 'day_of_noon' : 'day_of_morning';
        const alreadySent = await alreadySentToday(clientSlug, deadline.id, alertType);
        if (alreadySent) return;

        const body = formatDeadlineAlert(alertPayload, 'critical');
        await sendSms(conn.attorney_phone, body, clientSlug, deadline.id, alertType, 'critical');
        await bumpAlertCount(deadline.id);
        return;
    }

    // ── 1 day out: morning + evening ───────────────────────────────────────
    if (daysUntil === 1) {
        const isAm = hour >= 7  && hour < 9;
        const isPm = hour >= 17 && hour < 19;

        if (!isAm && !isPm) return;

        const alertType   = isPm ? 'one_day_evening' : 'one_day_morning';
        const alreadySent = await alreadySentToday(clientSlug, deadline.id, alertType);
        if (alreadySent) return;

        const body = formatDeadlineAlert(alertPayload, 'critical');
        await sendSms(conn.attorney_phone, body, clientSlug, deadline.id, alertType, 'critical');
        await bumpAlertCount(deadline.id);
        return;
    }

    // ── ≤3 days: every morning ─────────────────────────────────────────────
    if (daysUntil <= 3) {
        const isAm    = hour >= 7 && hour < 9;
        if (!isAm) return;

        const alreadySent = await alreadySentToday(clientSlug, deadline.id, 'critical_morning');
        if (alreadySent) return;

        const body = formatDeadlineAlert(alertPayload, 'critical');
        await sendSms(conn.attorney_phone, body, clientSlug, deadline.id, 'critical_morning', 'critical');
        await bumpAlertCount(deadline.id);

        // Also update urgency in DB
        await supabase
            .from('tracked_deadlines')
            .update({ urgency: 'critical' })
            .eq('id', deadline.id);
        return;
    }

    // ── ≤7 days: one SMS + mark urgent ────────────────────────────────────
    if (daysUntil <= 7) {
        // Only send once per day
        const alreadySent = await alreadySentToday(clientSlug, deadline.id, 'urgent_daily');
        if (alreadySent) return;

        const body = formatDeadlineAlert(alertPayload, 'urgent');
        await sendSms(conn.attorney_phone, body, clientSlug, deadline.id, 'urgent_daily', 'urgent');
        await bumpAlertCount(deadline.id);

        await supabase
            .from('tracked_deadlines')
            .update({ urgency: 'urgent' })
            .eq('id', deadline.id);
        return;
    }

    // ── ≤14 days: one-time warning SMS ────────────────────────────────────
    if (daysUntil <= 14) {
        // Only send the warning once (check alert_count)
        if ((deadline.alert_count || 0) > 0) return;

        const body = formatDeadlineAlert(alertPayload, 'warning');
        await sendSms(conn.attorney_phone, body, clientSlug, deadline.id, 'warning', 'warning');
        await bumpAlertCount(deadline.id);

        await supabase
            .from('tracked_deadlines')
            .update({ urgency: 'warning' })
            .eq('id', deadline.id);
        return;
    }

    // >14 days — no alert
}

// ─── Weekly Report Send ───────────────────────────────────────────────────────

/**
 * Format and send the weekly deadline report SMS.
 *
 * @param {string} clientSlug
 * @param {object} report  — from deadlines.generateWeeklyReport()
 */
async function sendWeeklyReport(clientSlug, report) {
    const conn = await caseMgmt.getConnection(clientSlug);
    if (!conn?.attorney_phone) {
        console.warn(`[Alerts] No attorney phone for ${clientSlug} — skipping weekly report`);
        return;
    }

    const body = formatWeeklyReport(report);

    await sendSms(
        conn.attorney_phone,
        body,
        clientSlug,
        null,
        'weekly_report',
        'normal'
    );

    // Also send to managing partner if configured
    if (conn.partner_phone && conn.partner_phone !== conn.attorney_phone) {
        await sendSms(
            conn.partner_phone,
            body,
            clientSlug,
            null,
            'weekly_report_partner',
            'normal'
        );
    }

    console.log(`[Alerts] Weekly report sent for ${clientSlug}`);
}

// ─── Alert Logger ─────────────────────────────────────────────────────────────

/**
 * Write an alert to the deadline_alerts table.
 *
 * @param {string} clientSlug
 * @param {object} alertData
 */
async function logAlert(clientSlug, alertData) {
    const { error } = await supabase.from('deadline_alerts').insert({
        client_slug:   clientSlug,
        deadline_id:   alertData.deadline_id || null,
        alert_type:    alertData.alert_type,
        urgency_level: alertData.urgency_level,
        recipient:     alertData.recipient,
        message_body:  alertData.message_body,
        twilio_sid:    alertData.twilio_sid || null,
        created_at:    new Date().toISOString(),
    });

    if (error) {
        console.error(`[Alerts] Failed to log alert: ${error.message}`);
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function bumpAlertCount(deadlineId) {
    await supabase.rpc('increment_alert_count', { row_id: deadlineId }).catch(() => {
        // Fallback if RPC not set up: fetch + update manually
        supabase
            .from('tracked_deadlines')
            .select('alert_count')
            .eq('id', deadlineId)
            .single()
            .then(({ data }) => {
                supabase
                    .from('tracked_deadlines')
                    .update({
                        alert_count:    (data?.alert_count || 0) + 1,
                        last_alerted_at: new Date().toISOString(),
                    })
                    .eq('id', deadlineId);
            });
    });
}

module.exports = {
    sendDeadlineAlert,
    sendWeeklyReport,
    logAlert,
    formatDeadlineAlert,
    formatWeeklyReport,
};
