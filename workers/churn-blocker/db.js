/**
 * GRIDHAND Churn Blocker — Supabase Database Layer
 *
 * All raw queries are here. jobs.js and mindbody.js stay clean.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const dayjs            = require('dayjs');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── cb_clients ───────────────────────────────────────────────────────────────

/**
 * Fetch a single client config by slug.
 * Returns null if not found (PGRST116 = no rows).
 */
async function getClient(clientSlug) {
    const { data, error } = await supabase
        .from('cb_clients')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('is_active', true)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

/**
 * Fetch all active client configs.
 */
async function getAllClients() {
    const { data, error } = await supabase
        .from('cb_clients')
        .select('*')
        .eq('is_active', true)
        .order('client_slug', { ascending: true });

    if (error) throw error;
    return data || [];
}

/**
 * Create or update a client config row.
 */
async function upsertClient(config) {
    const { data, error } = await supabase
        .from('cb_clients')
        .upsert({
            client_slug:                config.clientSlug,
            business_name:              config.businessName,
            mindbody_site_id:           config.mindbodySiteId,
            mindbody_api_key:           config.mindbodyApiKey,
            twilio_sid:                 config.twilioSid   || null,
            twilio_token:               config.twilioToken || null,
            twilio_number:              config.twilioNumber || null,
            owner_phone:                config.ownerPhone,
            inactivity_threshold_days:  config.inactivityThresholdDays || 7,
            is_active:                  true,
            updated_at:                 new Date().toISOString(),
        }, { onConflict: 'client_slug' })
        .select()
        .single();

    if (error) throw error;
    return data;
}

// ─── cb_members ───────────────────────────────────────────────────────────────

/**
 * Upsert a member record from Mindbody sync.
 * @param {string} clientId  - cb_clients.id (UUID)
 * @param {object} memberData
 */
async function upsertMember(clientId, memberData) {
    const { data, error } = await supabase
        .from('cb_members')
        .upsert({
            client_id:          clientId,
            mindbody_client_id: String(memberData.clientId || memberData.mindbodyClientId),
            first_name:         memberData.firstName  || null,
            last_name:          memberData.lastName   || null,
            email:              memberData.email      || null,
            phone:              memberData.phone      || null,
            last_visit_date:    memberData.lastVisitDate || null,
            visit_count_30d:    memberData.visitCount30d  || 0,
            is_active:          memberData.isActive !== false,
            updated_at:         new Date().toISOString(),
        }, { onConflict: 'client_id,mindbody_client_id' })
        .select()
        .single();

    if (error) throw error;
    return data;
}

/**
 * Fetch members who haven't visited in >= thresholdDays AND are active.
 * Also returns the computed days_since_visit for each member.
 */
async function getInactiveMembers(clientId, thresholdDays = 7) {
    const cutoffDate = dayjs().subtract(thresholdDays, 'day').format('YYYY-MM-DD');

    const { data, error } = await supabase
        .from('cb_members')
        .select('*')
        .eq('client_id', clientId)
        .eq('is_active', true)
        .not('phone', 'is', null)
        .or(`last_visit_date.lt.${cutoffDate},last_visit_date.is.null`)
        .order('last_visit_date', { ascending: true, nullsFirst: false });

    if (error) throw error;

    const today = dayjs();
    return (data || []).map(m => ({
        ...m,
        days_since_visit: m.last_visit_date
            ? today.diff(dayjs(m.last_visit_date), 'day')
            : thresholdDays, // null visit date → treat as threshold
    }));
}

/**
 * Fetch member IDs that were alerted within the last N hours.
 * Used to prevent re-spamming the same member.
 */
async function getMembersAlertedRecently(clientId, hours = 48) {
    const since = dayjs().subtract(hours, 'hour').toISOString();

    const { data, error } = await supabase
        .from('cb_churn_alerts')
        .select('member_id')
        .eq('client_id', clientId)
        .gte('sent_at', since);

    if (error) throw error;
    return new Set((data || []).map(row => row.member_id));
}

/**
 * Fetch a member by phone number (used for inbound SMS matching).
 */
async function getMemberByPhone(clientId, phone) {
    const { data, error } = await supabase
        .from('cb_members')
        .select('*')
        .eq('client_id', clientId)
        .eq('phone', phone)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

// ─── cb_churn_alerts ──────────────────────────────────────────────────────────

/**
 * Insert a churn alert log entry.
 * @param {string} clientId  - cb_clients.id (UUID)
 * @param {string} memberId  - cb_members.id (UUID)
 * @param {object} data
 */
async function logAlert(clientId, memberId, data) {
    const { error } = await supabase
        .from('cb_churn_alerts')
        .insert({
            client_id:       clientId,
            member_id:       memberId,
            days_since_visit: data.daysSinceVisit,
            message_body:    data.messageBody,
            sent_at:         data.sentAt || new Date().toISOString(),
            twilio_sid:      data.twilioSid || null,
            status:          data.status || 'sent',
        });

    if (error) throw error;
}

/**
 * Fetch recent churn alerts for a client.
 */
async function getRecentAlerts(clientId, limit = 100) {
    const { data, error } = await supabase
        .from('cb_churn_alerts')
        .select(`
            *,
            cb_members ( first_name, last_name, phone, email )
        `)
        .eq('client_id', clientId)
        .order('sent_at', { ascending: false })
        .limit(limit);

    if (error) throw error;
    return data || [];
}

// ─── cb_reengagement_responses ────────────────────────────────────────────────

/**
 * Log an inbound SMS response from a member.
 */
async function logResponse({ clientId, memberId, phoneNumber, body, receivedAt }) {
    const { error } = await supabase
        .from('cb_reengagement_responses')
        .insert({
            client_id:    clientId   || null,
            member_id:    memberId   || null,
            phone_number: phoneNumber,
            body,
            received_at:  receivedAt || new Date().toISOString(),
        });

    if (error) throw error;
}

module.exports = {
    // clients
    getClient,
    getAllClients,
    upsertClient,
    // members
    upsertMember,
    getInactiveMembers,
    getMembersAlertedRecently,
    getMemberByPhone,
    // alerts
    logAlert,
    getRecentAlerts,
    // responses
    logResponse,
};
