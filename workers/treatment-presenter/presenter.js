/**
 * GRIDHAND AI — Treatment Presenter
 * Treatment Plan Presentation Engine
 *
 * Functions:
 *   generatePlanSummary(treatmentPlan, patientName) — Claude-powered plain-language translation
 *   formatInitialMessage(conn, patient, planSummary, totalPatientPortion) — build initial SMS
 *   formatDetailedBreakdown(procedures, insuranceEstimates) — itemized cost breakdown
 *   sendPlanToPatient(conn, patient, plan, summary) — send SMS + log to DB
 */

'use strict';

const Anthropic      = require('@anthropic-ai/sdk');
const twilio         = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// SMS character limit for a single segment (160 chars for GSM-7)
const SMS_SEGMENT_LIMIT = 160;

// ============================================================
// generatePlanSummary
// Use Claude Haiku to translate clinical treatment plan into
// friendly, clear patient language.
// ============================================================

async function generatePlanSummary(treatmentPlan, patientName) {
    const { procedures, total_fee, total_insurance_est, total_patient_portion } = treatmentPlan;

    if (!procedures || procedures.length === 0) {
        return {
            summary:   'Your dentist has recommended some treatment to keep your smile healthy.',
            breakdown: []
        };
    }

    // Build a structured description of each procedure for the prompt
    const procedureList = procedures.map(p => {
        const tooth   = p.tooth   ? ` (tooth #${p.tooth})`   : '';
        const surface = p.surface ? ` (${p.surface} surface)` : '';
        return `- ${p.ada_code}: ${p.description}${tooth}${surface} | Fee: $${p.fee.toFixed(2)} | Insurance Est: $${p.insurance_est.toFixed(2)} | Patient Portion: $${p.patient_portion.toFixed(2)}`;
    }).join('\n');

    const prompt = `You are a dental treatment coordinator speaking directly to a patient named ${patientName}.

Translate this treatment plan into friendly, clear patient language. Avoid clinical jargon. For each item:
1. Say what it is in plain English (not just the procedure name)
2. Briefly explain why it's needed (1 sentence max)
3. Show the patient's estimated cost

Treatment plan:
${procedureList}

Total fee: $${total_fee.toFixed(2)}
Estimated insurance payment: $${total_insurance_est.toFixed(2)}
Your estimated out-of-pocket: $${total_patient_portion.toFixed(2)}

Write a warm, 2-3 sentence summary paragraph first (no bullet points), then list each item clearly. Keep the total under 300 words. Do not include greetings or sign-offs.`;

    const message = await anthropic.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
    });

    const fullText = message.content[0]?.text || '';

    // Extract just the opening summary paragraph (before the first bullet or numbered line)
    const lines        = fullText.split('\n').filter(l => l.trim());
    const summaryLines = [];
    let hitBreakdown   = false;

    for (const line of lines) {
        if (/^[-•*\d]/.test(line.trim())) { hitBreakdown = true; }
        if (!hitBreakdown) summaryLines.push(line);
    }

    const summary = summaryLines.join(' ').trim() || fullText.substring(0, 200);

    // Build itemized breakdown from the Claude output (or fallback to raw data)
    const breakdown = procedures.map(p => ({
        ada_code:       p.ada_code,
        description:    p.description,
        fee:            p.fee,
        insurance_est:  p.insurance_est,
        patient_portion: p.patient_portion,
        tooth:          p.tooth || null,
        surface:        p.surface || null
    }));

    return { summary, breakdown, full_text: fullText };
}

// ============================================================
// formatInitialMessage
// Builds the first SMS sent to the patient after their exam.
// Two-part structure: summary first, then breakdown link.
// ============================================================

function formatInitialMessage(conn, patient, planSummary, totalPatientPortion) {
    const firstName       = patient.first_name || patient.patient_name?.split(' ')[0] || 'there';
    const practiceName    = conn.practice_name;
    const scheduleLink    = conn.schedule_link || '';
    const summarySnippet  = planSummary.length > 80
        ? planSummary.substring(0, 77) + '...'
        : planSummary;
    const costFormatted   = `$${parseFloat(totalPatientPortion).toFixed(2)}`;

    let msg = `Hi ${firstName}! Following your visit at ${practiceName}, here's your personalized treatment summary: ${summarySnippet} Your estimated out-of-pocket: ~${costFormatted}.`;

    if (scheduleLink) {
        msg += ` View full plan + schedule: ${scheduleLink}`;
    }

    msg += ` Questions? Just reply!`;

    return msg;
}

// ============================================================
// formatDetailedBreakdown
// Builds a second SMS (or follow-up) with itemized cost table.
// ============================================================

function formatDetailedBreakdown(procedures, conn) {
    const lines = ['Your treatment cost breakdown:'];

    for (const proc of procedures) {
        const tooth = proc.tooth ? ` (#${proc.tooth})` : '';
        lines.push(`• ${proc.description}${tooth}: ~$${proc.patient_portion.toFixed(2)} est. out-of-pocket`);
    }

    if (conn && conn.financing_options_text) {
        lines.push('');
        lines.push(conn.financing_options_text);
    }

    lines.push('Reply SCHEDULE to book or call us anytime.');

    return lines.join('\n');
}

// ============================================================
// sendPlanToPatient
// Send initial message (+ detailed breakdown if plan is large)
// and log everything to tp_sms_log.
// ============================================================

async function sendPlanToPatient(conn, patient, plan, planSummaryResult) {
    const twilioClient = twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
    );

    const fromNumber   = conn.twilio_number || process.env.TWILIO_DEFAULT_NUMBER;
    const toPhone      = patient.phone;

    if (!toPhone) {
        return { ok: false, error: 'Patient has no phone number' };
    }

    const { summary, breakdown } = planSummaryResult;
    const totalPatientPortion = plan.total_patient_portion || 0;

    const initialMsg = formatInitialMessage(conn, patient, summary, totalPatientPortion);
    const sent       = [];

    // Part 1: summary message
    try {
        const msg1 = await twilioClient.messages.create({
            from: fromNumber,
            to:   toPhone,
            body: initialMsg
        });
        sent.push(msg1.sid);

        await _logSms({
            client_slug:  conn.client_slug,
            plan_db_id:   plan.db_id || null,
            patient_id:   patient.patient_id,
            direction:    'outbound',
            message_body: initialMsg,
            twilio_sid:   msg1.sid,
            status:       msg1.status
        });
    } catch (err) {
        console.error('[Presenter] Failed to send initial message:', err.message);
        return { ok: false, error: err.message };
    }

    // Part 2: detailed breakdown if the plan has 2+ procedures
    if (breakdown && breakdown.length >= 2) {
        const detailMsg = formatDetailedBreakdown(breakdown, conn);

        try {
            const msg2 = await twilioClient.messages.create({
                from: fromNumber,
                to:   toPhone,
                body: detailMsg
            });
            sent.push(msg2.sid);

            await _logSms({
                client_slug:  conn.client_slug,
                plan_db_id:   plan.db_id || null,
                patient_id:   patient.patient_id,
                direction:    'outbound',
                message_body: detailMsg,
                twilio_sid:   msg2.sid,
                status:       msg2.status
            });
        } catch (err) {
            // Part 2 failure is non-fatal — part 1 already delivered
            console.warn('[Presenter] Failed to send breakdown message:', err.message);
        }
    }

    return { ok: true, twilio_sids: sent, parts_sent: sent.length };
}

// ============================================================
// INTERNAL: log SMS to tp_sms_log
// ============================================================

async function _logSms({ client_slug, plan_db_id, patient_id, direction, message_body, twilio_sid, status }) {
    const { error } = await supabase.from('tp_sms_log').insert({
        id:           uuidv4(),
        client_slug,
        plan_id:      plan_db_id || null,
        patient_id:   String(patient_id),
        direction,
        message_body,
        twilio_sid,
        status:       status || 'sent',
        created_at:   new Date().toISOString()
    });

    if (error) {
        console.error('[Presenter] SMS log insert error:', error.message);
    }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    generatePlanSummary,
    formatInitialMessage,
    formatDetailedBreakdown,
    sendPlanToPatient
};
