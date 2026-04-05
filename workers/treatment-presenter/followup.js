/**
 * GRIDHAND AI — Treatment Presenter
 * Follow-Up Sequence & Patient Reply Handler
 *
 * Functions:
 *   getUnscheduledPlans(clientSlug)          — plans sent but not accepted after 3+ days
 *   runFollowUpSequence(clientSlug)          — drive the day-3 / day-7 / day-14 / day-30 cadence
 *   handlePatientReply(conn, phone, body)    — route inbound SMS replies
 *   sendWeeklyDigest(conn)                   — Monday morning stats to practice owner
 *   escalateToFrontDesk(conn, plan, patient, reason) — alert front desk with context
 */

'use strict';

const twilio         = require('twilio');
const dayjs          = require('dayjs');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ============================================================
// HELPER: send one SMS and log it
// ============================================================

async function _sendSms(conn, toPhone, body, planDbId = null, patientId = null) {
    const twilioClient = twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
    );

    const fromNumber = conn.twilio_number || process.env.TWILIO_DEFAULT_NUMBER;

    try {
        const msg = await twilioClient.messages.create({ from: fromNumber, to: toPhone, body });

        await supabase.from('tp_sms_log').insert({
            id:           uuidv4(),
            client_slug:  conn.client_slug,
            plan_id:      planDbId || null,
            patient_id:   patientId ? String(patientId) : null,
            direction:    'outbound',
            message_body: body,
            twilio_sid:   msg.sid,
            status:       msg.status,
            created_at:   new Date().toISOString()
        });

        return { ok: true, sid: msg.sid };
    } catch (err) {
        console.error('[FollowUp] SMS send error:', err.message);
        return { ok: false, error: err.message };
    }
}

// ============================================================
// getUnscheduledPlans
// Returns plans in 'contacted' status that were last contacted
// 3+ days ago and have not been accepted or declined.
// ============================================================

async function getUnscheduledPlans(clientSlug) {
    const threeDaysAgo = dayjs().subtract(3, 'day').toISOString();

    const { data, error } = await supabase
        .from('tp_plans')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'contacted')
        .lte('last_contact_at', threeDaysAgo)
        .order('last_contact_at', { ascending: true });

    if (error) {
        console.error('[FollowUp] getUnscheduledPlans error:', error.message);
        return [];
    }

    return data || [];
}

// ============================================================
// runFollowUpSequence
// Drives follow-up cadence for all contacted plans:
//   Day 3  — gentle check-in
//   Day 7  — offer financing / flexible scheduling
//   Day 14 — oral health urgency + front desk escalation
//   Day 30 — mark stale, remove from active follow-up, alert front desk
// ============================================================

async function runFollowUpSequence(clientSlug) {
    const { data: conn } = await supabase
        .from('tp_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (!conn) return { error: `No connection found for ${clientSlug}` };
    if (!conn.followup_enabled) return { ok: true, skipped: true, reason: 'followup_enabled is false' };

    const now           = dayjs();
    const day3Cutoff    = now.subtract(3, 'day').toISOString();
    const day7Cutoff    = now.subtract(7, 'day').toISOString();
    const day14Cutoff   = now.subtract(14, 'day').toISOString();
    const day30Cutoff   = now.subtract(30, 'day').toISOString();

    // Load all active contacted plans at once and bucket them by age
    const { data: plans } = await supabase
        .from('tp_plans')
        .select('*')
        .eq('client_slug', clientSlug)
        .in('status', ['contacted', 'interested'])
        .lte('last_contact_at', day3Cutoff)
        .order('last_contact_at', { ascending: true })
        .limit(200);

    if (!plans || plans.length === 0) return { ok: true, sent: 0 };

    let day3Sent = 0, day7Sent = 0, day14Sent = 0, staleMade = 0, errors = 0;

    for (const plan of plans) {
        const contactedAt = plan.last_contact_at;
        const daysSince   = now.diff(dayjs(contactedAt), 'day');
        const count       = plan.contact_count || 0;

        try {
            if (daysSince >= 30 && count >= 3) {
                // Day 30+ — mark stale, alert front desk
                await supabase.from('tp_plans')
                    .update({ status: 'stale', updated_at: new Date().toISOString() })
                    .eq('id', plan.id);

                await escalateToFrontDesk(conn, plan, null, 'Plan is 30+ days old with no response. Removing from active follow-up.');
                staleMade++;

            } else if (daysSince >= 14 && count === 2) {
                // Day 14 — oral health urgency message + front desk escalation
                const msg = `Hi ${plan.patient_name?.split(' ')[0] || 'there'}! We want to make sure your oral health stays on track. Your treatment plan from ${conn.practice_name} is still waiting — untreated dental issues can worsen over time. Our team is ready to work with your schedule and budget. Reply YES to connect or call us directly!`;

                const result = await _sendSms(conn, plan.patient_phone, msg, plan.id, plan.patient_id);
                if (result.ok) {
                    await supabase.from('tp_plans').update({
                        contact_count:   count + 1,
                        last_contact_at: new Date().toISOString(),
                        updated_at:      new Date().toISOString()
                    }).eq('id', plan.id);
                    day14Sent++;

                    await escalateToFrontDesk(conn, plan, null, 'Day 14 follow-up sent. Patient may need a direct phone call.');
                } else {
                    errors++;
                }

            } else if (daysSince >= 7 && count === 1) {
                // Day 7 — offer financing / flexible scheduling
                const financingText = conn.financing_options_text
                    ? ` We also offer: ${conn.financing_options_text}.`
                    : ' We offer flexible payment options.';

                const scheduleText = conn.schedule_link
                    ? ` Book online: ${conn.schedule_link}`
                    : '';

                const msg = `Hi ${plan.patient_name?.split(' ')[0] || 'there'}! Following up on your treatment plan from ${conn.practice_name}.${financingText} We can work around your schedule too — evenings and Saturdays available.${scheduleText} Questions? Just reply!`;

                const result = await _sendSms(conn, plan.patient_phone, msg, plan.id, plan.patient_id);
                if (result.ok) {
                    await supabase.from('tp_plans').update({
                        contact_count:   count + 1,
                        last_contact_at: new Date().toISOString(),
                        updated_at:      new Date().toISOString()
                    }).eq('id', plan.id);
                    day7Sent++;
                } else {
                    errors++;
                }

            } else if (daysSince >= 3 && count === 0) {
                // Day 3 — gentle check-in
                const msg = `Hi ${plan.patient_name?.split(' ')[0] || 'there'}! Just checking in from ${conn.practice_name}. Did you have any questions about your treatment plan? We're here to help — just reply to this message!`;

                const result = await _sendSms(conn, plan.patient_phone, msg, plan.id, plan.patient_id);
                if (result.ok) {
                    await supabase.from('tp_plans').update({
                        contact_count:   count + 1,
                        last_contact_at: new Date().toISOString(),
                        updated_at:      new Date().toISOString()
                    }).eq('id', plan.id);
                    day3Sent++;
                } else {
                    errors++;
                }
            }

            // 400ms pause between sends to respect Twilio rate limits
            await _sleep(400);

        } catch (err) {
            console.error(`[FollowUp] Error processing plan ${plan.id}:`, err.message);
            errors++;
        }
    }

    console.log(`[FollowUp] ${clientSlug} — day3: ${day3Sent}, day7: ${day7Sent}, day14: ${day14Sent}, stale: ${staleMade}, errors: ${errors}`);
    return { ok: true, day3Sent, day7Sent, day14Sent, staleMade, errors };
}

// ============================================================
// handlePatientReply
// Route inbound SMS replies based on content keywords.
// ============================================================

async function handlePatientReply(conn, phone, body) {
    const text        = (body || '').trim().toUpperCase();
    const clientSlug  = conn.client_slug;

    // Log the inbound message
    await supabase.from('tp_sms_log').insert({
        id:           uuidv4(),
        client_slug:  clientSlug,
        plan_id:      null,
        patient_id:   null,
        direction:    'inbound',
        message_body: body,
        twilio_sid:   null,
        status:       'received',
        created_at:   new Date().toISOString()
    });

    // Find the most recent active plan for this patient phone
    const { data: plan } = await supabase
        .from('tp_plans')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('patient_phone', phone)
        .in('status', ['contacted', 'interested', 'pending'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    // STOP / UNSUBSCRIBE — opt-out; Twilio also handles this automatically
    if (/^(STOP|UNSUBSCRIBE|CANCEL|QUIT|END)/.test(text)) {
        if (plan) {
            await supabase.from('tp_plans').update({
                status:     'opted_out',
                updated_at: new Date().toISOString()
            }).eq('id', plan.id);
        }
        console.log(`[FollowUp] ${phone} opted out.`);
        return { action: 'opted_out' };
    }

    // NO / DECLINE — mark declined, stop follow-ups
    if (/^(NO|DECLINE|DECLINED|NOT INTERESTED|NOPE)/.test(text)) {
        if (plan) {
            await supabase.from('tp_plans').update({
                status:      'declined',
                declined_at: new Date().toISOString(),
                updated_at:  new Date().toISOString()
            }).eq('id', plan.id);
            console.log(`[FollowUp] Plan ${plan.id} declined by patient.`);
        }
        // Acknowledge the decline
        const ackMsg = `We understand! If you ever change your mind, we're here. Have a great day! — ${conn.practice_name}`;
        await _sendSms(conn, phone, ackMsg, plan?.id || null, plan?.patient_id || null);
        return { action: 'declined', planId: plan?.id };
    }

    // YES / ACCEPT / SCHEDULE — mark interested, alert front desk
    if (/^(YES|ACCEPT|ACCEPTED|SCHEDULE|BOOK|BOOKING|READY|OK|OKAY|SURE|DEFINITELY|ABSOLUTELY)/.test(text)) {
        if (plan) {
            await supabase.from('tp_plans').update({
                status:     'interested',
                updated_at: new Date().toISOString()
            }).eq('id', plan.id);
        }

        // Acknowledge the patient
        const scheduleText = conn.schedule_link
            ? ` Book online here: ${conn.schedule_link} or`
            : '';
        const ackMsg = `Great news! Our front desk will reach out shortly to schedule your appointment.${scheduleText} call us anytime. See you soon! — ${conn.practice_name}`;
        await _sendSms(conn, phone, ackMsg, plan?.id || null, plan?.patient_id || null);

        // Alert front desk
        await escalateToFrontDesk(
            conn,
            plan || { patient_name: 'Unknown Patient', patient_phone: phone, total_patient_portion: 0 },
            null,
            `Patient replied YES/SCHEDULE — ready to book. Call them now: ${phone}`
        );

        return { action: 'interested', planId: plan?.id };
    }

    // QUESTIONS / ? — forward to front desk for manual response
    if (/[?]/.test(body) || /^(QUESTION|QUESTIONS|HELP|HOW|WHAT|WHEN|WHERE|WHO|WHY|CAN|COULD|WOULD|SHOULD|IS |ARE |DO |DOES )/.test(text)) {
        await escalateToFrontDesk(
            conn,
            plan || { patient_name: phone, patient_phone: phone, total_patient_portion: 0 },
            null,
            `Patient has a question: "${body.substring(0, 200)}"`
        );

        const ackMsg = `Thanks for reaching out! A team member from ${conn.practice_name} will follow up with you shortly.`;
        await _sendSms(conn, phone, ackMsg, plan?.id || null, plan?.patient_id || null);

        return { action: 'question_forwarded' };
    }

    // Default — unrecognized reply, forward to front desk
    await escalateToFrontDesk(
        conn,
        plan || { patient_name: phone, patient_phone: phone, total_patient_portion: 0 },
        null,
        `Unrecognized patient reply: "${body.substring(0, 200)}"`
    );

    return { action: 'forwarded_unrecognized' };
}

// ============================================================
// sendWeeklyDigest
// Monday morning stats SMS to practice owner.
// ============================================================

async function sendWeeklyDigest(conn) {
    const weekStart = dayjs().startOf('week').format('YYYY-MM-DD');
    const lastWeekStart = dayjs().subtract(1, 'week').startOf('week').format('YYYY-MM-DD');
    const lastWeekEnd   = dayjs().subtract(1, 'week').endOf('week').format('YYYY-MM-DD');

    // Count plans by status over the last 7 days
    const since = dayjs().subtract(7, 'day').toISOString();

    const { data: recentPlans } = await supabase
        .from('tp_plans')
        .select('status, total_patient_portion, accepted_at, created_at')
        .eq('client_slug', conn.client_slug)
        .gte('created_at', since);

    const stats = (recentPlans || []).reduce((acc, p) => {
        acc.total++;
        if (p.status === 'accepted')  acc.accepted++;
        if (p.status === 'declined')  acc.declined++;
        if (['pending', 'contacted', 'interested'].includes(p.status)) acc.pending++;
        if (p.status === 'accepted') acc.revenue_accepted += parseFloat(p.total_patient_portion || 0);
        acc.revenue_pipeline += parseFloat(p.total_patient_portion || 0);
        return acc;
    }, { total: 0, accepted: 0, declined: 0, pending: 0, revenue_accepted: 0, revenue_pipeline: 0 });

    const acceptanceRate = stats.total > 0
        ? Math.round((stats.accepted / stats.total) * 100)
        : 0;

    // Fetch last week's acceptance rate for comparison
    const { data: lastWeekRow } = await supabase
        .from('tp_weekly_stats')
        .select('acceptance_rate')
        .eq('client_slug', conn.client_slug)
        .eq('week_start', lastWeekStart)
        .single();

    const lastWeekRate  = lastWeekRow?.acceptance_rate || 0;
    const rateDiff      = acceptanceRate - parseFloat(lastWeekRate);
    const rateTrend     = rateDiff > 0 ? `+${rateDiff}%` : rateDiff < 0 ? `${rateDiff}%` : 'flat';

    // Save this week's stats
    await supabase.from('tp_weekly_stats').upsert({
        client_slug:        conn.client_slug,
        week_start:         weekStart,
        plans_presented:    stats.total,
        plans_accepted:     stats.accepted,
        plans_declined:     stats.declined,
        plans_pending:      stats.pending,
        revenue_pipeline:   parseFloat(stats.revenue_pipeline.toFixed(2)),
        revenue_accepted:   parseFloat(stats.revenue_accepted.toFixed(2)),
        created_at:         new Date().toISOString()
    }, { onConflict: 'client_slug,week_start' });

    const digestMsg = [
        `GRIDHAND Weekly Report — ${conn.practice_name}`,
        `Plans presented: ${stats.total}`,
        `Accepted: ${stats.accepted} | Declined: ${stats.declined} | Pending: ${stats.pending}`,
        `Acceptance rate: ${acceptanceRate}% (${rateTrend} vs last week)`,
        `Revenue accepted: $${stats.revenue_accepted.toFixed(2)}`,
        `Revenue in pipeline: $${stats.revenue_pipeline.toFixed(2)}`
    ].join('\n');

    const result = await _sendSms(conn, conn.owner_phone, digestMsg);
    console.log(`[FollowUp] Weekly digest sent to ${conn.owner_phone} for ${conn.client_slug}`);

    return { ok: result.ok, stats, acceptanceRate };
}

// ============================================================
// escalateToFrontDesk
// Sends an alert SMS to the front desk phone with context.
// ============================================================

async function escalateToFrontDesk(conn, plan, patient, reason) {
    const frontDesk = conn.front_desk_phone;
    if (!frontDesk) {
        console.warn('[FollowUp] escalateToFrontDesk: no front_desk_phone configured for', conn.client_slug);
        return { ok: false, error: 'No front_desk_phone configured' };
    }

    const patientName  = plan?.patient_name  || patient?.full_name  || 'Unknown Patient';
    const patientPhone = plan?.patient_phone || patient?.phone      || 'N/A';
    const planAmount   = plan?.total_patient_portion != null
        ? ` | Est. out-of-pocket: $${parseFloat(plan.total_patient_portion).toFixed(2)}`
        : '';

    const alertMsg = [
        `GRIDHAND ALERT — ${conn.practice_name}`,
        `Patient: ${patientName} (${patientPhone})${planAmount}`,
        `Reason: ${reason}`
    ].join('\n');

    return _sendSms(conn, frontDesk, alertMsg, plan?.id || null, plan?.patient_id || null);
}

// ============================================================
// HELPERS
// ============================================================

function _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    getUnscheduledPlans,
    runFollowUpSequence,
    handlePatientReply,
    sendWeeklyDigest,
    escalateToFrontDesk
};
