/**
 * GRIDHAND Outcomes Reporter — Supabase Database Layer
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Connections ──────────────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('outcome_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('outcome_connections')
        .select('client_slug');
    if (error) throw error;
    return data || [];
}

async function upsertConnection(conn) {
    const { error } = await supabase
        .from('outcome_connections')
        .upsert({ ...conn, updated_at: new Date().toISOString() }, { onConflict: 'client_slug' });
    if (error) throw error;
}

// ─── Patient Outcomes ─────────────────────────────────────────────────────────

async function upsertPatientOutcome(clientSlug, outcome) {
    const { error } = await supabase
        .from('patient_outcomes')
        .upsert({
            client_slug:            clientSlug,
            ehr_patient_id:         outcome.ehrPatientId,
            patient_name:           outcome.patientName,
            patient_dob:            outcome.patientDob || null,
            insurance_company:      outcome.insuranceCompany || null,
            claim_number:           outcome.claimNumber || null,
            injury_date:            outcome.injuryDate || null,
            diagnosis_code:         outcome.diagnosisCode || null,
            diagnosis_label:        outcome.diagnosisLabel || null,
            initial_pain_score:     outcome.initialPainScore ?? null,
            current_pain_score:     outcome.currentPainScore ?? null,
            initial_function_score: outcome.initialFunctionScore ?? null,
            current_function_score: outcome.currentFunctionScore ?? null,
            outcome_measure:        outcome.outcomeMeasure || null,
            visits_at_eval:         outcome.visitsAtEval || null,
            goals_met:              outcome.goalsMet ? JSON.stringify(outcome.goalsMet) : null,
            discharge_ready:        outcome.dischargeReady || false,
            last_eval_date:         outcome.lastEvalDate || null,
            next_eval_due:          outcome.nextEvalDue || null,
            updated_at:             new Date().toISOString(),
        }, { onConflict: 'client_slug,ehr_patient_id' });

    if (error) throw error;
}

async function getPatientsWithEvalDue(clientSlug) {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await supabase
        .from('patient_outcomes')
        .select('*')
        .eq('client_slug', clientSlug)
        .lte('next_eval_due', today);

    if (error) throw error;
    return data || [];
}

async function getAllPatientOutcomes(clientSlug) {
    const { data, error } = await supabase
        .from('patient_outcomes')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('last_eval_date', { ascending: false });

    if (error) throw error;
    return data || [];
}

async function getPatientOutcome(clientSlug, ehrPatientId) {
    const { data, error } = await supabase
        .from('patient_outcomes')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('ehr_patient_id', ehrPatientId)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

// ─── Functional Score History ─────────────────────────────────────────────────

async function upsertFunctionalScore(clientSlug, score) {
    const { error } = await supabase
        .from('functional_score_history')
        .upsert({
            client_slug:         clientSlug,
            ehr_patient_id:      score.ehrPatientId,
            eval_date:           score.evalDate,
            visits_completed:    score.visitsCompleted || null,
            pain_score:          score.painScore ?? null,
            function_score:      score.functionScore ?? null,
            outcome_measure:     score.outcomeMeasure || null,
            percent_improvement: score.percentImprovement ?? null,
            notes:               score.notes || null,
        }, { onConflict: 'client_slug,ehr_patient_id,eval_date' });

    if (error) throw error;
}

async function getScoreHistory(clientSlug, ehrPatientId) {
    const { data, error } = await supabase
        .from('functional_score_history')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('ehr_patient_id', ehrPatientId)
        .order('eval_date', { ascending: true });

    if (error) throw error;
    return data || [];
}

// ─── Outcome Reports ──────────────────────────────────────────────────────────

async function saveReport(clientSlug, report) {
    const { error } = await supabase
        .from('outcome_reports')
        .upsert({
            client_slug:     clientSlug,
            ehr_patient_id:  report.ehrPatientId,
            report_date:     report.reportDate,
            report_type:     report.reportType,
            insurance_company: report.insuranceCompany || null,
            claim_number:    report.claimNumber || null,
            report_body:     report.reportBody,
            status:          report.status || 'generated',
        }, { onConflict: 'client_slug,ehr_patient_id,report_date,report_type' });

    if (error) throw error;
}

async function markReportSent(clientSlug, ehrPatientId, reportDate, reportType, sentTo) {
    const { error } = await supabase
        .from('outcome_reports')
        .update({ status: 'sent', sent_to: sentTo, sent_at: new Date().toISOString() })
        .eq('client_slug', clientSlug)
        .eq('ehr_patient_id', ehrPatientId)
        .eq('report_date', reportDate)
        .eq('report_type', reportType);

    if (error) throw error;
}

async function getRecentReports(clientSlug, limit = 50) {
    const { data, error } = await supabase
        .from('outcome_reports')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('report_date', { ascending: false })
        .limit(limit);

    if (error) throw error;
    return data || [];
}

// ─── Alert Log ────────────────────────────────────────────────────────────────

async function logAlert(clientSlug, { alertType, ehrPatientId, recipient, messageBody }) {
    const { error } = await supabase
        .from('outcome_alerts')
        .insert({
            client_slug:    clientSlug,
            ehr_patient_id: ehrPatientId || null,
            alert_type:     alertType,
            recipient,
            message_body:   messageBody,
        });

    if (error) throw error;
}

async function getAlertHistory(clientSlug, alertType = null, limit = 50) {
    let query = supabase
        .from('outcome_alerts')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('sent_at', { ascending: false })
        .limit(limit);

    if (alertType) query = query.eq('alert_type', alertType);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

module.exports = {
    getConnection,
    getAllConnectedClients,
    upsertConnection,
    upsertPatientOutcome,
    getPatientsWithEvalDue,
    getAllPatientOutcomes,
    getPatientOutcome,
    upsertFunctionalScore,
    getScoreHistory,
    saveReport,
    markReportSent,
    getRecentReports,
    logAlert,
    getAlertHistory,
};
