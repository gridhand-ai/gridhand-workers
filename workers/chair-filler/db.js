/**
 * GRIDHAND Chair Filler — Supabase Database Layer
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

// Exposed for direct queries in jobs.js (slot updates, campaign reads)
function __supabase() {
    return supabase;
}

// ─── Chair Connections ────────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('chair_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('chair_connections')
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
    defaultPostImage,
}) {
    const { error } = await supabase
        .from('chair_connections')
        .upsert({
            client_slug:           clientSlug,
            booking_system:        bookingSystem       || 'boulevard',
            boulevard_api_key:     boulevardApiKey     || null,
            boulevard_business_id: boulevardBusinessId || null,
            square_access_token:   squareAccessToken   || null,
            square_location_id:    squareLocationId    || null,
            owner_phone:           ownerPhone          || null,
            salon_name:            salonName           || clientSlug,
            booking_url:           bookingUrl          || null,
            default_post_image:    defaultPostImage    || null,
            updated_at:            new Date().toISOString(),
        }, { onConflict: 'client_slug' });

    if (error) throw error;
}

async function updateInstagramToken(clientSlug, {
    accessToken,
    instagramAccountId,
    instagramTokenExpiresAt,
}) {
    const { error } = await supabase
        .from('chair_connections')
        .update({
            instagram_access_token:    accessToken,
            instagram_account_id:      instagramAccountId,
            instagram_token_expires_at: instagramTokenExpiresAt,
            updated_at:                new Date().toISOString(),
        })
        .eq('client_slug', clientSlug);

    if (error) throw error;
}

// ─── Open Slots ───────────────────────────────────────────────────────────────

async function upsertSlot(clientSlug, {
    slotId,
    serviceType,
    stylistName,
    startTime,
    endTime,
    date,
}) {
    const { error } = await supabase
        .from('open_slots')
        .upsert({
            client_slug:  clientSlug,
            slot_id:      slotId,
            service_type: serviceType || null,
            stylist_name: stylistName || null,
            start_time:   startTime,
            end_time:     endTime     || null,
            date:         date,
            status:       'open',
        }, { onConflict: 'client_slug,slot_id' });

    if (error) throw error;
}

async function getOpenSlots(clientSlug) {
    const { data, error } = await supabase
        .from('open_slots')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'open')
        .order('start_time', { ascending: true });

    if (error) throw error;
    return data || [];
}

async function markSlotBooked(clientSlug, slotId) {
    const { error } = await supabase
        .from('open_slots')
        .update({
            status:    'booked',
            booked_at: new Date().toISOString(),
        })
        .eq('client_slug', clientSlug)
        .eq('slot_id', slotId);

    if (error) throw error;
}

// ─── Alert Log ────────────────────────────────────────────────────────────────

async function logAlert(clientSlug, { alertType, recipient, messageBody, slotId = null }) {
    const { error } = await supabase
        .from('chair_alerts')
        .insert({
            client_slug:  clientSlug,
            alert_type:   alertType,
            recipient,
            message_body: messageBody,
            slot_id:      slotId,
        });

    if (error) throw error;
}

async function getAlertHistory(clientSlug, alertType = null, limit = 50) {
    let query = supabase
        .from('chair_alerts')
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
    updateInstagramToken,
    upsertSlot,
    getOpenSlots,
    markSlotBooked,
    logAlert,
    getAlertHistory,
};
