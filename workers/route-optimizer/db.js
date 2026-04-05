/**
 * GRIDHAND Route Optimizer — Supabase Database Layer
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
        .from('jobber_connections_route')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('jobber_connections_route')
        .select('client_slug');
    if (error) throw error;
    return data || [];
}

async function upsertConnection({ clientSlug, ownerPhone, accessToken, refreshToken, expiresAt, depotAddress, googleMapsApiKey }) {
    const { error } = await supabase
        .from('jobber_connections_route')
        .upsert({
            client_slug:       clientSlug,
            owner_phone:       ownerPhone,
            access_token:      accessToken,
            refresh_token:     refreshToken,
            expires_at:        expiresAt,
            depot_address:     depotAddress || null,
            google_maps_api_key: googleMapsApiKey || null,
            updated_at:        new Date().toISOString(),
        }, { onConflict: 'client_slug' });

    if (error) throw error;
}

async function updateTokens(clientSlug, { accessToken, refreshToken, expiresAt }) {
    const { error } = await supabase
        .from('jobber_connections_route')
        .update({
            access_token:  accessToken,
            refresh_token: refreshToken,
            expires_at:    expiresAt,
            updated_at:    new Date().toISOString(),
        })
        .eq('client_slug', clientSlug);

    if (error) throw error;
}

// ─── Daily Routes ─────────────────────────────────────────────────────────────

async function saveRoute(clientSlug, { routeDate, crewId, crewName, crewLeadPhone, stops, totalDistanceKm, estimatedDriveMinutes }) {
    const { error } = await supabase
        .from('daily_routes')
        .upsert({
            client_slug:            clientSlug,
            route_date:             routeDate,
            crew_id:                crewId,
            crew_name:              crewName,
            crew_lead_phone:        crewLeadPhone || null,
            stops:                  stops,
            total_distance_km:      totalDistanceKm || 0,
            estimated_drive_minutes: estimatedDriveMinutes || 0,
            optimized:              true,
            updated_at:             new Date().toISOString(),
        }, { onConflict: 'client_slug,route_date,crew_id' });

    if (error) throw error;
}

async function getRoutesForDate(clientSlug, routeDate) {
    const { data, error } = await supabase
        .from('daily_routes')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('route_date', routeDate)
        .order('crew_name', { ascending: true });

    if (error) throw error;
    return data || [];
}

async function getRouteForCrew(clientSlug, crewId, routeDate) {
    const { data, error } = await supabase
        .from('daily_routes')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('crew_id', crewId)
        .eq('route_date', routeDate)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

// ─── Alert Log ────────────────────────────────────────────────────────────────

async function logAlert(clientSlug, { alertType, recipient, messageBody }) {
    const { error } = await supabase
        .from('route_alerts')
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
        .from('route_alerts')
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
    saveRoute,
    getRoutesForDate,
    getRouteForCrew,
    logAlert,
    getAlertHistory,
};
