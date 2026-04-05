/**
 * GRIDHAND Plan of Care Tracker — Supabase Database Layer
 *
 * Thin wrapper around Supabase client for all DB operations.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── EHR Connections ─────────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('poc_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('poc_connections')
        .select('client_slug');
    if (error) throw error;
    return data || [];
}

async function upsertConnection(conn) {
    const { error } = await supabase
        .from('poc_connections')
        .upsert({ ...conn, updated_at: new Date().toISOString() }, { onConflict: 'client_slug' });
    if (error) throw error;
}

// ─── Treatment Plans ─────────────────────────────────────────────────────────

async function upsertTreatmentPlan(clientSlug, plan) {
    const { error } = await supabase
        .from('treatment_plans')
        .upsert({
            client_slug:          clientSlug,
            ehr_patient_id:       plan.ehrPatientId,
            patient_name:         plan.patientName,
            patient_phone:        plan.patientPhone || null,
            patient_email:        plan.patientEmail || null,
            diagnosis_code:       plan.diagnosisCode || null,
            diagnosis_label:      plan.diagnosisLabel || null,
            total_visits:         plan.totalVisits || null,
            visits_completed:     plan.visitsCompleted || 0,
            frequency_per_week:   plan.frequencyPerWeek || null,
            plan_start_date:      plan.planStartDate || null,
            plan_end_date:        plan.planEndDate || null,
            status:               plan.status || 'active',
            last_visit_date:      plan.lastVisitDate || null,
            next_scheduled_date:  plan.nextScheduledDate || null,
            updated_at:           new Date().toISOString(),
        }, { onConflict: 'client_slug,ehr_patient_id' });

    if (error) throw error;
}

async function getActivePlans(clientSlug) {
    const { data, error } = await supabase
        .from('treatment_plans')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'active');

    if (error) throw error;
    return data || [];
}

async function getPatientsWithUpcomingVisits(clientSlug, hoursAhead) {
    const now   = new Date();
    const cutoff = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);
    const today  = now.toISOString().split('T')[0];
    const cutoffDate = cutoff.toISOString().split('T')[0];

    const { data, error } = await supabase
        .from('treatment_plans')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'active')
        .gte('next_scheduled_date', today)
        .lte('next_scheduled_date', cutoffDate);

    if (error) throw error;
    return data || [];
}

async function getDropoffCandidates(clientSlug, thresholdDays) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - thresholdDays);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];

    const { data, error } = await supabase
        .from('treatment_plans')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'active')
        .eq('dropoff_flagged', false)
        .or(`last_visit_date.lt.${cutoffStr},last_visit_date.is.null`);

    if (error) throw error;
    return data || [];
}

async function flagDropoff(clientSlug, ehrPatientId) {
    const { error } = await supabase
        .from('treatment_plans')
        .update({
            dropoff_flagged:    true,
            dropoff_flagged_at: new Date().toISOString(),
            status:             'dropoff',
            updated_at:         new Date().toISOString(),
        })
        .eq('client_slug', clientSlug)
        .eq('ehr_patient_id', ehrPatientId);

    if (error) throw error;
}

// ─── Visit Records ────────────────────────────────────────────────────────────

async function upsertVisitRecord(clientSlug, visit) {
    const { error } = await supabase
        .from('poc_visit_records')
        .upsert({
            client_slug:         clientSlug,
            ehr_patient_id:      visit.ehrPatientId,
            ehr_appointment_id:  visit.ehrAppointmentId,
            visit_date:          visit.visitDate,
            visit_type:          visit.visitType || null,
            status:              visit.status,
            provider_name:       visit.providerName || null,
            notes:               visit.notes || null,
        }, { onConflict: 'client_slug,ehr_appointment_id' });

    if (error) throw error;
}

// ─── Alert Log ────────────────────────────────────────────────────────────────

async function logAlert(clientSlug, { alertType, ehrPatientId, recipient, messageBody }) {
    const { error } = await supabase
        .from('poc_alerts')
        .insert({
            client_slug:     clientSlug,
            ehr_patient_id:  ehrPatientId || null,
            alert_type:      alertType,
            recipient,
            message_body:    messageBody,
        });

    if (error) throw error;
}

async function getAlertHistory(clientSlug, alertType = null, limit = 50) {
    let query = supabase
        .from('poc_alerts')
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
    upsertTreatmentPlan,
    getActivePlans,
    getPatientsWithUpcomingVisits,
    getDropoffCandidates,
    flagDropoff,
    upsertVisitRecord,
    logAlert,
    getAlertHistory,
};
