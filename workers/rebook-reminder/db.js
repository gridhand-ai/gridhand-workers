/**
 * GRIDHAND Rebook Reminder — Supabase Database Layer
 *
 * Thin wrapper around Supabase client for all DB operations.
 * All raw queries go here — jobs.js and booking.js stay clean.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Exposed for internal use in index.js inbound SMS handler
function __supabase() {
    return supabase;
}

// ─── Salon Connections ────────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('salon_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('salon_connections')
        .select('client_slug');
    if (error) throw error;
    return data || [];
}

async function upsertConnection({
    clientSlug,
    bookingSystem,
    boulevardApiKey,
    boulevardBusinessId,
    squareAccessToken,
    squareLocationId,
    ownerPhone,
    salonName,
    bookingUrl,
}) {
    const { error } = await supabase
        .from('salon_connections')
        .upsert({
            client_slug:           clientSlug,
            booking_system:        bookingSystem,
            boulevard_api_key:     boulevardApiKey     || null,
            boulevard_business_id: boulevardBusinessId || null,
            square_access_token:   squareAccessToken   || null,
            square_location_id:    squareLocationId    || null,
            owner_phone:           ownerPhone          || null,
            salon_name:            salonName           || clientSlug,
            booking_url:           bookingUrl          || null,
            updated_at:            new Date().toISOString(),
        }, { onConflict: 'client_slug' });

    if (error) throw error;
}

// ─── Salon Clients ────────────────────────────────────────────────────────────

async function getClient(clientSlug, externalClientId) {
    const { data, error } = await supabase
        .from('salon_clients')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('external_client_id', externalClientId)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function upsertClient(clientSlug, {
    externalClientId,
    name,
    phone,
    email,
    lastVisitDate,
    lastServiceType,
    visitCount,
    avgRebookDays,
    overdueDays,
}) {
    const { error } = await supabase
        .from('salon_clients')
        .upsert({
            client_slug:        clientSlug,
            external_client_id: externalClientId,
            name:               name,
            phone:              phone          || null,
            email:              email          || null,
            last_visit_date:    lastVisitDate  || null,
            last_service_type:  lastServiceType || null,
            visit_count:        visitCount     || 0,
            avg_rebook_days:    avgRebookDays  || 0,
            overdue_days:       overdueDays    || 0,
            updated_at:         new Date().toISOString(),
        }, { onConflict: 'client_slug,external_client_id' });

    if (error) throw error;
}

async function getClientsWithRebookInterval(clientSlug) {
    const { data, error } = await supabase
        .from('salon_clients')
        .select('*')
        .eq('client_slug', clientSlug)
        .gt('avg_rebook_days', 0)
        .eq('opted_out', false)
        .order('last_visit_date', { ascending: true });

    if (error) throw error;
    return data || [];
}

async function getOverdueClients(clientSlug, limit = 50, offset = 0) {
    const { data, error } = await supabase
        .from('salon_clients')
        .select('*')
        .eq('client_slug', clientSlug)
        .gt('overdue_days', 0)
        .eq('opted_out', false)
        .order('overdue_days', { ascending: false })
        .range(offset, offset + limit - 1);

    if (error) throw error;
    return data || [];
}

async function updateClientReminderSent(clientSlug, clientId) {
    const { error } = await supabase
        .from('salon_clients')
        .update({
            last_reminder_sent: new Date().toISOString(),
            reminder_count:     supabase.rpc('increment', { x: 1 }), // fallback below
            updated_at:         new Date().toISOString(),
        })
        .eq('client_slug', clientSlug)
        .eq('id', clientId);

    if (error) {
        // Fallback: manual increment if rpc not available
        const { data: existing } = await supabase
            .from('salon_clients')
            .select('reminder_count')
            .eq('client_slug', clientSlug)
            .eq('id', clientId)
            .single();

        const { error: err2 } = await supabase
            .from('salon_clients')
            .update({
                last_reminder_sent: new Date().toISOString(),
                reminder_count:     (existing?.reminder_count || 0) + 1,
                updated_at:         new Date().toISOString(),
            })
            .eq('client_slug', clientSlug)
            .eq('id', clientId);

        if (err2) throw err2;
    }
}

// ─── Alert Log ────────────────────────────────────────────────────────────────

async function logAlert(clientSlug, { alertType, recipient, messageBody }) {
    const { error } = await supabase
        .from('rebook_alerts')
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
        .from('rebook_alerts')
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
    __supabase,
    getConnection,
    getAllConnectedClients,
    upsertConnection,
    getClient,
    upsertClient,
    getClientsWithRebookInterval,
    getOverdueClients,
    updateClientReminderSent,
    logAlert,
    getAlertHistory,
};
