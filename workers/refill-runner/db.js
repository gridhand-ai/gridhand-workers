/**
 * GRIDHAND Refill Runner — Supabase Database Layer
 *
 * Thin wrapper around Supabase client for all DB operations.
 * All raw queries go here — jobs.js, pms.js, and vetsource.js stay clean.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Vet Refill Connections ───────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('vet_refill_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('vet_refill_connections')
        .select('client_slug');
    if (error) throw error;
    return data || [];
}

async function upsertConnection({
    clientSlug, evetBaseUrl, evetApiKey,
    vetsourceApiKey, vetsourcePracticeId,
    ownerPhone, practiceName,
}) {
    const { error } = await supabase
        .from('vet_refill_connections')
        .upsert({
            client_slug:          clientSlug,
            evet_base_url:        evetBaseUrl,
            evet_api_key:         evetApiKey,
            vetsource_api_key:    vetsourceApiKey,
            vetsource_practice_id: vetsourcePracticeId,
            owner_phone:          ownerPhone,
            practice_name:        practiceName,
            updated_at:           new Date().toISOString(),
        }, { onConflict: 'client_slug' });

    if (error) throw error;
}

// ─── Prescription Tracker ─────────────────────────────────────────────────────

async function getPrescription(clientSlug, prescriptionId) {
    const { data, error } = await supabase
        .from('prescription_tracker')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('prescription_id', prescriptionId)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function upsertPrescription(clientSlug, {
    prescriptionId, patientId, patientName, medicationName,
    ownerPhone, lastFillDate, daysSupply, refillsRemaining,
    status, reminderSentAt,
}) {
    const { error } = await supabase
        .from('prescription_tracker')
        .upsert({
            client_slug:       clientSlug,
            prescription_id:   prescriptionId,
            patient_id:        patientId,
            patient_name:      patientName,
            medication_name:   medicationName,
            owner_phone:       ownerPhone,
            last_fill_date:    lastFillDate,
            days_supply:       daysSupply,
            refills_remaining: refillsRemaining,
            status:            status || 'active',
            reminder_sent_at:  reminderSentAt || null,
            updated_at:        new Date().toISOString(),
        }, { onConflict: 'client_slug,prescription_id' });

    if (error) throw error;
}

/**
 * Get prescriptions where the next refill date falls within the next N days.
 */
async function getPrescriptionsDueSoon(clientSlug, withinDays = 14) {
    // We query all active/pending prescriptions and filter in-memory
    // since Supabase doesn't do computed column filtering easily.
    const { data, error } = await supabase
        .from('prescription_tracker')
        .select('*')
        .eq('client_slug', clientSlug)
        .in('status', ['active', 'pending_reminder']);

    if (error) throw error;

    const today = new Date();
    return (data || []).filter((rx) => {
        if (!rx.last_fill_date || !rx.days_supply) return false;
        const refillDate = new Date(rx.last_fill_date);
        refillDate.setDate(refillDate.getDate() + rx.days_supply);
        const diffDays = Math.ceil((refillDate - today) / (1000 * 60 * 60 * 24));
        return diffDays <= withinDays;
    });
}

async function getPrescriptionsByStatus(clientSlug, status) {
    const { data, error } = await supabase
        .from('prescription_tracker')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', status)
        .order('updated_at', { ascending: false });

    if (error) throw error;
    return data || [];
}

async function getApprovedRefills(clientSlug, limit = 100) {
    const { data, error } = await supabase
        .from('prescription_tracker')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'approved')
        .order('approved_at', { ascending: true })
        .limit(limit);

    if (error) throw error;
    return data || [];
}

async function updatePrescriptionStatus(clientSlug, prescriptionId, status, extra = {}) {
    const update = {
        status,
        updated_at: new Date().toISOString(),
    };

    if (extra.approvedAt)  update.approved_at   = extra.approvedAt;
    if (extra.processedAt) update.processed_at  = extra.processedAt;
    if (extra.trackingUrl) update.tracking_url   = extra.trackingUrl;

    const { error } = await supabase
        .from('prescription_tracker')
        .update(update)
        .eq('client_slug', clientSlug)
        .eq('prescription_id', prescriptionId);

    if (error) throw error;
}

/**
 * Used by inbound SMS handler to find the prescription most recently
 * reminded for a given owner phone, so we know which Rx to approve.
 */
async function getMostRecentPendingPrescription(ownerPhone) {
    const { data, error } = await supabase
        .from('prescription_tracker')
        .select('*')
        .eq('owner_phone', ownerPhone)
        .eq('status', 'pending_reminder')
        .order('reminder_sent_at', { ascending: false })
        .limit(1)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

// ─── Alert Log ────────────────────────────────────────────────────────────────

async function logAlert(clientSlug, { alertType, recipient, messageBody, prescriptionId = null }) {
    const { error } = await supabase
        .from('refill_alerts')
        .insert({
            client_slug:     clientSlug,
            alert_type:      alertType,
            recipient,
            message_body:    messageBody,
            prescription_id: prescriptionId,
        });

    if (error) throw error;
}

async function getAlertHistory(clientSlug, alertType = null, limit = 50) {
    let query = supabase
        .from('refill_alerts')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('created_at', { ascending: false })
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
    getPrescription,
    upsertPrescription,
    getPrescriptionsDueSoon,
    getPrescriptionsByStatus,
    getApprovedRefills,
    updatePrescriptionStatus,
    getMostRecentPendingPrescription,
    logAlert,
    getAlertHistory,
};
