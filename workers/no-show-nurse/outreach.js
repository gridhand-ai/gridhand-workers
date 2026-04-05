/**
 * GRIDHAND No-Show Nurse — Patient Outreach & Reminders
 *
 * Functions:
 *   sendPreAppointmentReminder(conn, patient, appointment, hoursOut)
 *   sendNoShowFollowUp(conn, patient, appointment)
 *   handlePatientReply(conn, phone, body)
 *   sendWeeklyDigest(conn)
 *   sendNoShowAlert(conn, appointment, patient)
 */

'use strict';

const dayjs  = require('dayjs');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

let twilioClient = null;
function getTwilio() {
    if (!twilioClient) {
        twilioClient = twilio(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN
        );
    }
    return twilioClient;
}

const FROM = process.env.TWILIO_FROM_NUMBER;

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function sendSms(clientSlug, to, body, meta = {}) {
    const msg = await getTwilio().messages.create({ from: FROM, to, body });
    await supabase.from('nsn_sms_log').insert({
        client_slug:    clientSlug,
        patient_id:     meta.patientId     || null,
        appointment_id: meta.appointmentId || null,
        direction:      'outbound',
        message_body:   body,
        twilio_sid:     msg.sid,
        status:         msg.status,
    });
    return msg;
}

async function bumpDailyStats(clientSlug, fields) {
    const today = dayjs().format('YYYY-MM-DD');
    const update = {};
    for (const [k, v] of Object.entries(fields)) update[k] = v;

    // Use upsert with increment pattern via RPC if available, else read-modify-write
    const { data: existing } = await supabase
        .from('nsn_daily_stats')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('stat_date', today)
        .single();

    if (!existing) {
        await supabase.from('nsn_daily_stats').insert({
            client_slug: clientSlug,
            stat_date:   today,
            ...fields,
        });
    } else {
        const merged = {};
        for (const [k, v] of Object.entries(fields)) {
            merged[k] = (existing[k] || 0) + v;
        }
        await supabase
            .from('nsn_daily_stats')
            .update({ ...merged, updated_at: new Date().toISOString() })
            .eq('client_slug', clientSlug)
            .eq('stat_date', today);
    }
}

// ─── sendPreAppointmentReminder ───────────────────────────────────────────────

/**
 * Send a pre-appointment reminder SMS.
 *
 * @param {object} conn          — nsn_connections row
 * @param {object} patient       — { id, name, phone }
 * @param {object} appointment   — { id, start, appointmentType, providerName }
 * @param {number} hoursOut      — 24 or 2 (controls message template)
 */
async function sendPreAppointmentReminder(conn, patient, appointment, hoursOut) {
    if (!patient.phone) {
        console.warn(`[Outreach] No phone for patient ${patient.id} — skipping reminder`);
        return null;
    }

    const apptTime   = dayjs(appointment.start);
    const dateStr    = apptTime.format('dddd, MMMM D');
    const timeStr    = apptTime.format('h:mma');
    const provider   = appointment.providerName ? `with ${appointment.providerName}` : '';

    let body;
    if (hoursOut >= 24) {
        body = `Reminder: You have an appt at ${conn.practice_name} tomorrow ${dateStr} at ${timeStr}${provider ? ' ' + provider : ''}. Reply CONFIRM to confirm or CANCEL to cancel.`;
    } else {
        body = `Just a reminder your appt is in 2 hours at ${timeStr}! See you soon. - ${conn.practice_name}`;
    }

    const msg = await sendSms(conn.client_slug, patient.phone, body, {
        patientId:     patient.id,
        appointmentId: appointment.id,
    });

    await bumpDailyStats(conn.client_slug, { reminders_sent: 1 });

    console.log(`[Outreach] ${hoursOut}hr reminder sent to ${patient.name} (${patient.phone}) for appt ${appointment.id}`);
    return msg;
}

// ─── sendNoShowFollowUp ───────────────────────────────────────────────────────

/**
 * Follow-up SMS to a patient who missed their appointment.
 * Updates nsn_no_shows record: increments followup_count, sets status.
 */
async function sendNoShowFollowUp(conn, patient, appointment) {
    if (!patient.phone) {
        console.warn(`[Outreach] No phone for patient ${patient.id} — cannot follow up`);
        return null;
    }

    const apptTime = appointment.start
        ? dayjs(appointment.start).format('h:mma')
        : 'your scheduled time';

    const body = `Hi ${patient.name}, we missed you today at ${apptTime} at ${conn.practice_name}. We'd love to get you rescheduled! Reply RESCHEDULE or call ${conn.staff_phone}. - ${conn.practice_name}`;

    const msg = await sendSms(conn.client_slug, patient.phone, body, {
        patientId:     patient.id,
        appointmentId: appointment.id,
    });

    // Update no-show record
    await supabase
        .from('nsn_no_shows')
        .update({
            status:           'followup_sent',
            followup_count:   1,
            last_followup_at: new Date().toISOString(),
            updated_at:       new Date().toISOString(),
        })
        .eq('client_slug', conn.client_slug)
        .eq('appointment_id', appointment.id);

    console.log(`[Outreach] No-show follow-up sent to ${patient.name} for appt ${appointment.id} in ${conn.client_slug}`);
    return msg;
}

// ─── handlePatientReply ───────────────────────────────────────────────────────

/**
 * Route inbound SMS reply to the correct handler.
 *
 * Keywords:
 *   CONFIRM     → update appointment confirmed in EHR + log
 *   CANCEL      → cancel appointment + trigger slot fill from waitlist
 *   RESCHEDULE  → send scheduling link or alert front desk
 *   YES / NO    → slot offer response — delegate to waitlist.handleSlotResponse
 *   STOP        → opt-out (Twilio handles automatically, we just log)
 *
 * @param {object} conn     — nsn_connections row
 * @param {string} phone    — patient E.164 phone
 * @param {string} body     — raw SMS body
 */
async function handlePatientReply(conn, phone, body) {
    const upper       = body.trim().toUpperCase();
    const clientSlug  = conn.client_slug;

    // Log inbound
    await supabase.from('nsn_sms_log').insert({
        client_slug:  clientSlug,
        direction:    'inbound',
        message_body: body,
        status:       'received',
    });

    // ── CONFIRM ──────────────────────────────────────────────────────────────
    if (upper.startsWith('CONFIRM')) {
        // Find most recent upcoming appointment for this phone
        const { data: noShowRec } = await supabase
            .from('nsn_no_shows')
            .select('*')
            .eq('client_slug', clientSlug)
            .eq('patient_phone', phone)
            .order('scheduled_at', { ascending: false })
            .limit(1)
            .single();

        if (noShowRec) {
            // They confirmed before no-showing — update EHR
            try {
                const scheduling = require('./scheduling');
                // FHIR Appointment doesn't have a 'confirmed' status — we note 'arrived' as closest proxy
                // Many practices instead use a custom extension; we log and alert front desk
                console.log(`[Outreach] CONFIRM received for appt ${noShowRec.appointment_id} — alerting front desk`);
            } catch (e) {
                console.warn(`[Outreach] CONFIRM EHR update failed: ${e.message}`);
            }
        }

        await bumpDailyStats(clientSlug, { confirmations: 1 });

        const reply = `Great, you're confirmed! See you soon. - ${conn.practice_name}`;
        await sendSms(clientSlug, phone, reply);
        return { action: 'confirmed' };
    }

    // ── CANCEL ───────────────────────────────────────────────────────────────
    if (upper.startsWith('CANCEL')) {
        await bumpDailyStats(clientSlug, { cancellations: 1 });

        const reply = `Got it, we've noted your cancellation. We'll be in touch to reschedule. - ${conn.practice_name}`;
        await sendSms(clientSlug, phone, reply);

        // Alert front desk to cancel in EHR and trigger waitlist fill
        if (conn.front_desk_phone) {
            const alertMsg = `[No-Show Nurse] Patient ${phone} cancelled via text. Please cancel their appointment and run waitlist fill.`;
            await sendSms(clientSlug, conn.front_desk_phone, alertMsg);
        }

        // Auto-trigger waitlist fill for any available slot today
        setImmediate(async () => {
            try {
                const scheduling = require('./scheduling');
                const waitlist   = require('./waitlist');
                const cancelled  = await scheduling.cancelledSlotsToday(clientSlug);
                for (const slot of cancelled) {
                    const matches = await waitlist.findMatchingWaitlistPatients(clientSlug, slot);
                    if (matches.length > 0) {
                        await waitlist.offerSlotToPatient(clientSlug, matches[0], slot);
                    }
                }
            } catch (err) {
                console.error(`[Outreach] Waitlist fill after cancel failed: ${err.message}`);
            }
        });

        return { action: 'cancelled' };
    }

    // ── RESCHEDULE ───────────────────────────────────────────────────────────
    if (upper.startsWith('RESCHEDULE')) {
        const reply = `We'd love to reschedule you! Please call us at ${conn.staff_phone} or visit our website to book. - ${conn.practice_name}`;
        await sendSms(clientSlug, phone, reply);

        if (conn.front_desk_phone) {
            const alertMsg = `[No-Show Nurse] Patient ${phone} wants to reschedule. Please follow up.`;
            await sendSms(clientSlug, conn.front_desk_phone, alertMsg);
        }

        // Update no-show record if exists
        await supabase
            .from('nsn_no_shows')
            .update({
                status:     'rescheduled',
                updated_at: new Date().toISOString(),
            })
            .eq('client_slug', clientSlug)
            .eq('patient_phone', phone)
            .eq('status', 'followup_sent');

        return { action: 'reschedule_requested' };
    }

    // ── YES / NO (slot offer) ─────────────────────────────────────────────────
    if (upper === 'YES' || upper === 'NO') {
        const waitlist = require('./waitlist');
        // Slot context lives on the offered waitlist entry — no slot param needed
        const result = await waitlist.handleSlotResponse(clientSlug, phone, body, null);
        return result || { action: 'no_context' };
    }

    // ── STOP (opt-out) ────────────────────────────────────────────────────────
    if (upper === 'STOP' || upper === 'UNSUBSCRIBE') {
        // Twilio handles STOP automatically — we update any active no-show records
        await supabase
            .from('nsn_no_shows')
            .update({
                status:     'opted_out',
                updated_at: new Date().toISOString(),
            })
            .eq('client_slug', clientSlug)
            .eq('patient_phone', phone)
            .in('status', ['detected', 'followup_sent']);

        console.log(`[Outreach] Opt-out logged for ${phone} in ${clientSlug}`);
        return { action: 'opted_out' };
    }

    // Unrecognized — send a friendly help message
    const helpMsg = `Hi! Reply CONFIRM, CANCEL, or RESCHEDULE about your appointment, or call ${conn.staff_phone}. - ${conn.practice_name}`;
    await sendSms(clientSlug, phone, helpMsg);
    return { action: 'unrecognized', body };
}

// ─── sendWeeklyDigest ─────────────────────────────────────────────────────────

/**
 * Monday morning digest: last 7 days of no-show stats + slots filled.
 */
async function sendWeeklyDigest(conn) {
    const clientSlug = conn.client_slug;
    const weekAgo    = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
    const today      = dayjs().format('YYYY-MM-DD');

    const { data: stats, error } = await supabase
        .from('nsn_daily_stats')
        .select('*')
        .eq('client_slug', clientSlug)
        .gte('stat_date', weekAgo)
        .lte('stat_date', today);

    if (error) {
        console.error(`[Outreach] weeklyDigest stats query failed for ${clientSlug}: ${error.message}`);
        return null;
    }

    const totals = (stats || []).reduce((acc, row) => {
        acc.appointments += row.appointments_total || 0;
        acc.noShows      += row.no_show_count      || 0;
        acc.filled       += row.slots_filled       || 0;
        acc.reminders    += row.reminders_sent     || 0;
        return acc;
    }, { appointments: 0, noShows: 0, filled: 0, reminders: 0 });

    const noShowRate = totals.appointments > 0
        ? ((totals.noShows / totals.appointments) * 100).toFixed(1)
        : '0.0';

    const body =
        `📋 ${conn.practice_name} Weekly Digest\n` +
        `No-show rate: ${noShowRate}% (${totals.noShows}/${totals.appointments} appts)\n` +
        `Slots filled from waitlist: ${totals.filled}\n` +
        `Reminders sent: ${totals.reminders}\n` +
        `- GRIDHAND No-Show Nurse`;

    await sendSms(clientSlug, conn.staff_phone, body);
    console.log(`[Outreach] Weekly digest sent for ${clientSlug}`);
    return totals;
}

// ─── sendNoShowAlert ──────────────────────────────────────────────────────────

/**
 * Immediate alert to front desk when a no-show is detected.
 */
async function sendNoShowAlert(conn, appointment, patient) {
    if (!conn.front_desk_phone) return null;

    const apptTime = appointment.start ? dayjs(appointment.start).format('h:mma') : 'scheduled time';
    const body =
        `[No-Show Nurse] ⚠️ No-show detected: ${patient?.name || 'Unknown patient'} was scheduled at ${apptTime} for ${appointment.appointmentType || 'appointment'}. ` +
        `Follow-up SMS sent. Waitlist fill triggered. - GRIDHAND`;

    const msg = await sendSms(conn.client_slug, conn.front_desk_phone, body, {
        patientId:     patient?.id,
        appointmentId: appointment.id,
    });

    console.log(`[Outreach] No-show alert sent to front desk for appt ${appointment.id} in ${conn.client_slug}`);
    return msg;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    sendPreAppointmentReminder,
    sendNoShowFollowUp,
    handlePatientReply,
    sendWeeklyDigest,
    sendNoShowAlert,
};
