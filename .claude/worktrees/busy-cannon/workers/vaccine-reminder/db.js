/**
 * GRIDHAND Vaccine Reminder — Supabase Database Layer
 *
 * Thin wrapper around Supabase client for all DB operations.
 * All raw queries go here — jobs.js and pms.js stay clean.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Vet Connections ──────────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('vet_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('vet_connections')
        .select('client_slug');
    if (error) throw error;
    return data || [];
}

async function upsertConnection({
    clientSlug, evetBaseUrl, evetApiKey, petdeskApiKey,
    ownerPhone, practiceName,
}) {
    const { error } = await supabase
        .from('vet_connections')
        .upsert({
            client_slug:     clientSlug,
            evet_base_url:   evetBaseUrl,
            evet_api_key:    evetApiKey,
            petdesk_api_key: petdeskApiKey,
            owner_phone:     ownerPhone,
            practice_name:   practiceName,
            updated_at:      new Date().toISOString(),
        }, { onConflict: 'client_slug' });

    if (error) throw error;
}

// ─── Vaccine Reminders ────────────────────────────────────────────────────────

async function getVaccineReminder(clientSlug, patientId, vaccineName) {
    const { data, error } = await supabase
        .from('vaccine_reminders')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('patient_id', patientId)
        .eq('vaccine_name', vaccineName)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function upsertVaccineReminder(clientSlug, {
    patientId, patientName, ownerPhone, vaccineName,
    dueDate, daysOverdue, reminderType, reminderCount,
    lastReminderSent, status,
}) {
    const { error } = await supabase
        .from('vaccine_reminders')
        .upsert({
            client_slug:        clientSlug,
            patient_id:         patientId,
            patient_name:       patientName,
            owner_phone:        ownerPhone,
            vaccine_name:       vaccineName,
            due_date:           dueDate,
            days_overdue:       daysOverdue,
            reminder_type:      reminderType,
            reminder_count:     reminderCount,
            last_reminder_sent: lastReminderSent,
            status,
        }, { onConflict: 'client_slug,patient_id,vaccine_name' });

    if (error) throw error;
}

async function getUpcomingReminders(clientSlug, statusFilter = null, limit = 50) {
    let query = supabase
        .from('vaccine_reminders')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('due_date', { ascending: true })
        .limit(limit);

    if (statusFilter) query = query.eq('reminder_type', statusFilter);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

/**
 * Used by inbound SMS handler to find the most recent pending reminder
 * for a given owner phone number, so we know which pet/vaccine to confirm.
 */
async function getMostRecentPendingReminder(ownerPhone) {
    const { data, error } = await supabase
        .from('vaccine_reminders')
        .select('*')
        .eq('owner_phone', ownerPhone)
        .in('status', ['due_soon', 'overdue'])
        .order('last_reminder_sent', { ascending: false })
        .limit(1)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

// ─── Alert Log ────────────────────────────────────────────────────────────────

async function logAlert(clientSlug, { alertType, recipient, messageBody }) {
    const { error } = await supabase
        .from('vaccine_alerts')
        .insert({
            client_slug:  clientSlug,
            alert_type:   alertType,
            recipient,
            message_body: messageBody,
        });

    if (error) throw error;
}

async function getAlertHistory(clientSlug, alertType = null, limit = 50) {
    let query = supabase
        .from('vaccine_alerts')
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
    getVaccineReminder,
    upsertVaccineReminder,
    getUpcomingReminders,
    getMostRecentPendingReminder,
    logAlert,
    getAlertHistory,
};
