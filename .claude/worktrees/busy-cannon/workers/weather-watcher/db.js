/**
 * GRIDHAND Weather Watcher — Supabase Database Layer
 *
 * Thin wrapper around Supabase client for all DB operations.
 * All raw queries go here — jobs.js and API modules stay clean.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Jobber Connections ───────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('jobber_connections_weather')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('jobber_connections_weather')
        .select('client_slug');
    if (error) throw error;
    return data || [];
}

async function upsertConnection({ clientSlug, ownerPhone, accessToken, refreshToken, expiresAt, openweatherApiKey, serviceAreaLat, serviceAreaLon, businessName }) {
    const { error } = await supabase
        .from('jobber_connections_weather')
        .upsert({
            client_slug:         clientSlug,
            owner_phone:         ownerPhone,
            access_token:        accessToken,
            refresh_token:       refreshToken,
            expires_at:          expiresAt,
            openweather_api_key: openweatherApiKey || null,
            service_area_lat:    serviceAreaLat || null,
            service_area_lon:    serviceAreaLon || null,
            business_name:       businessName || null,
            updated_at:          new Date().toISOString(),
        }, { onConflict: 'client_slug' });

    if (error) throw error;
}

async function updateTokens(clientSlug, { accessToken, refreshToken, expiresAt }) {
    const { error } = await supabase
        .from('jobber_connections_weather')
        .update({
            access_token:  accessToken,
            refresh_token: refreshToken,
            expires_at:    expiresAt,
            updated_at:    new Date().toISOString(),
        })
        .eq('client_slug', clientSlug);

    if (error) throw error;
}

// ─── Postponed Jobs ───────────────────────────────────────────────────────────

async function getPostponedJob(clientSlug, jobberJobId) {
    const { data, error } = await supabase
        .from('postponed_jobs')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('jobber_job_id', jobberJobId)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getPostponedJobs(clientSlug, statuses = ['postponed']) {
    const { data, error } = await supabase
        .from('postponed_jobs')
        .select('*')
        .eq('client_slug', clientSlug)
        .in('status', statuses)
        .order('original_date', { ascending: true });

    if (error) throw error;
    return data || [];
}

async function upsertPostponedJob(clientSlug, { jobberJobId, clientName, clientPhone, originalDate, postponeReason, postponeCount, status }) {
    const { error } = await supabase
        .from('postponed_jobs')
        .upsert({
            client_slug:     clientSlug,
            jobber_job_id:   jobberJobId,
            client_name:     clientName,
            client_phone:    clientPhone || null,
            original_date:   originalDate,
            postpone_reason: postponeReason,
            postpone_count:  postponeCount || 1,
            status:          status || 'postponed',
            updated_at:      new Date().toISOString(),
        }, { onConflict: 'client_slug,jobber_job_id' });

    if (error) throw error;
}

async function updatePostponedJob(clientSlug, jobberJobId, { status, rescheduledDate }) {
    const { error } = await supabase
        .from('postponed_jobs')
        .update({
            status:           status,
            rescheduled_date: rescheduledDate || null,
            updated_at:       new Date().toISOString(),
        })
        .eq('client_slug', clientSlug)
        .eq('jobber_job_id', jobberJobId);

    if (error) throw error;
}

// ─── Alert Log ────────────────────────────────────────────────────────────────

async function logAlert(clientSlug, { alertType, recipient, messageBody }) {
    const { error } = await supabase
        .from('weather_alerts')
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
        .from('weather_alerts')
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
    updateTokens,
    getPostponedJob,
    getPostponedJobs,
    upsertPostponedJob,
    updatePostponedJob,
    logAlert,
    getAlertHistory,
};
