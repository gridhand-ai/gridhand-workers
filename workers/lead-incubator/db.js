/**
 * GRIDHAND Lead Incubator — Supabase Database Layer
 *
 * Thin wrapper around the Supabase client. All raw queries live here.
 * jobs.js, nurture.js, and followupboss.js stay clean of query logic.
 *
 * All functions throw on unexpected errors (non-PGRST116).
 * PGRST116 = "no rows found" — treated as null return, not an error.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Clients ──────────────────────────────────────────────────────────────────

async function getClientBySlug(clientSlug) {
    const { data, error } = await supabase
        .from('li_clients')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getClientById(clientId) {
    const { data, error } = await supabase
        .from('li_clients')
        .select('*')
        .eq('id', clientId)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getClientByFubTeamId(teamId) {
    if (!teamId) return null;

    const { data, error } = await supabase
        .from('li_clients')
        .select('*')
        .eq('fub_team_id', String(teamId))
        .eq('active', true)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllActiveClients() {
    const { data, error } = await supabase
        .from('li_clients')
        .select('*')
        .eq('active', true);

    if (error) throw error;
    return data || [];
}

// ─── Leads ────────────────────────────────────────────────────────────────────

/**
 * Upsert a lead record. Conflict key: (client_id, phone).
 * Returns the full lead record after upsert.
 */
async function upsertLead(leadData) {
    const { data, error } = await supabase
        .from('li_leads')
        .upsert({
            ...leadData,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'client_id,phone' })
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function getLeadById(leadId) {
    const { data, error } = await supabase
        .from('li_leads')
        .select('*')
        .eq('id', leadId)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getLeadByPhone(phone) {
    // Normalize: strip non-digits, try E.164 and raw
    const normalized = phone.replace(/\D/g, '');

    const { data, error } = await supabase
        .from('li_leads')
        .select('*')
        .or(`phone.eq.${phone},phone.eq.+1${normalized},phone.eq.${normalized}`)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getLeads(clientId, { status = null, source = null, limit = 50, offset = 0 } = {}) {
    let query = supabase
        .from('li_leads')
        .select('*')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (source) query = query.eq('source', source);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

async function getActiveLeads(clientId) {
    const { data, error } = await supabase
        .from('li_leads')
        .select('*')
        .eq('client_id', clientId)
        .not('status', 'in', '("converted","unsubscribed")')
        .order('score', { ascending: false });

    if (error) throw error;
    return data || [];
}

/**
 * Get leads that have been contacted but drip hasn't started yet.
 * Used by the 9am drip check cron.
 */
async function getLeadsNeedingDripStart() {
    const { data, error } = await supabase
        .from('li_leads')
        .select('*')
        .eq('drip_active', false)
        .eq('drip_step', 0)
        .in('status', ['contacted', 'qualifying'])
        .neq('status', 'unsubscribed');

    if (error) throw error;
    return data || [];
}

/**
 * Get cold leads that haven't been contacted in N+ days.
 * Used by Monday re-engagement cron.
 */
async function getColdLeadsForReengagement(days = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const { data, error } = await supabase
        .from('li_leads')
        .select('*')
        .eq('tier', 'cold')
        .eq('drip_active', false)
        .not('status', 'in', '("converted","unsubscribed","scheduled")')
        .lt('last_contact', cutoff.toISOString());

    if (error) throw error;
    return data || [];
}

// ─── Lead Updates ─────────────────────────────────────────────────────────────

async function updateLeadStatus(leadId, status) {
    const { error } = await supabase
        .from('li_leads')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', leadId);

    if (error) throw error;
}

async function updateLeadQualification(leadId, { score, tier, ai_summary }) {
    const { error } = await supabase
        .from('li_leads')
        .update({
            score,
            tier,
            ai_summary,
            updated_at: new Date().toISOString(),
        })
        .eq('id', leadId);

    if (error) throw error;
}

async function updateLeadZillowData(leadId, zillowData) {
    const { error } = await supabase
        .from('li_leads')
        .update({ zillow_data: zillowData, updated_at: new Date().toISOString() })
        .eq('id', leadId);

    if (error) throw error;
}

async function updateLeadLastContact(leadId) {
    const { error } = await supabase
        .from('li_leads')
        .update({ last_contact: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', leadId);

    if (error) throw error;
}

async function updateLeadLastInbound(leadId) {
    const { error } = await supabase
        .from('li_leads')
        .update({ last_inbound: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', leadId);

    if (error) throw error;
}

async function updateLeadDripStep(leadId, step, active = true) {
    const { error } = await supabase
        .from('li_leads')
        .update({
            drip_step:   step,
            drip_active: active,
            updated_at:  new Date().toISOString(),
        })
        .eq('id', leadId);

    if (error) throw error;
}

async function updateLeadDripActive(leadId, active) {
    const { error } = await supabase
        .from('li_leads')
        .update({ drip_active: active, updated_at: new Date().toISOString() })
        .eq('id', leadId);

    if (error) throw error;
}

async function updateLeadShowingScheduled(leadId, scheduledAt) {
    const { error } = await supabase
        .from('li_leads')
        .update({
            showing_scheduled_at: scheduledAt,
            status:               'scheduled',
            updated_at:           new Date().toISOString(),
        })
        .eq('id', leadId);

    if (error) throw error;
}

// ─── Lead Stats ───────────────────────────────────────────────────────────────

async function getLeadStats(clientId) {
    const { data, error } = await supabase
        .from('li_leads')
        .select('status, tier')
        .eq('client_id', clientId);

    if (error) throw error;
    const leads = data || [];

    const stats = {
        total:      leads.length,
        new:        leads.filter(l => l.status === 'new').length,
        contacted:  leads.filter(l => l.status === 'contacted').length,
        qualifying: leads.filter(l => l.status === 'qualifying').length,
        qualified:  leads.filter(l => l.status === 'qualified').length,
        scheduled:  leads.filter(l => l.status === 'scheduled').length,
        converted:  leads.filter(l => l.status === 'converted').length,
        cold:       leads.filter(l => l.status === 'cold').length,
        hot:        leads.filter(l => l.tier === 'hot').length,
        warm:       leads.filter(l => l.tier === 'warm').length,
    };

    return stats;
}

// ─── Conversations ────────────────────────────────────────────────────────────

async function logConversation({ lead_id, client_id, direction, message, intent = null, twilio_sid = null }) {
    const { error } = await supabase
        .from('li_conversations')
        .insert({
            lead_id,
            client_id,
            direction,
            message,
            intent,
            twilio_sid,
        });

    if (error) throw error;
}

async function getLeadConversations(leadId, limit = 50) {
    const { data, error } = await supabase
        .from('li_conversations')
        .select('*')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: true })
        .limit(limit);

    if (error) throw error;
    return data || [];
}

// ─── Drip Log ─────────────────────────────────────────────────────────────────

async function logDripStep(leadId, step, message) {
    const { error } = await supabase
        .from('li_drip_log')
        .upsert({
            lead_id:  leadId,
            step,
            message,
            sent_at:  new Date().toISOString(),
        }, { onConflict: 'lead_id,step' });

    if (error) throw error;
}

async function checkDripStepSent(leadId, step) {
    const { data, error } = await supabase
        .from('li_drip_log')
        .select('id')
        .eq('lead_id', leadId)
        .eq('step', step)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return !!data;
}

async function getLeadDripLog(leadId) {
    const { data, error } = await supabase
        .from('li_drip_log')
        .select('*')
        .eq('lead_id', leadId)
        .order('step', { ascending: true });

    if (error) throw error;
    return data || [];
}

// ─── SMS Log ──────────────────────────────────────────────────────────────────

async function logSms({ client_id, lead_id, direction, to_number, from_number, body, twilio_sid }) {
    const { error } = await supabase
        .from('li_sms_log')
        .insert({
            client_id,
            lead_id,
            direction,
            to_number,
            from_number,
            body,
            twilio_sid,
        });

    if (error) throw error;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    // Clients
    getClientBySlug,
    getClientById,
    getClientByFubTeamId,
    getAllActiveClients,

    // Leads
    upsertLead,
    getLeadById,
    getLeadByPhone,
    getLeads,
    getActiveLeads,
    getLeadsNeedingDripStart,
    getColdLeadsForReengagement,

    // Lead updates
    updateLeadStatus,
    updateLeadQualification,
    updateLeadZillowData,
    updateLeadLastContact,
    updateLeadLastInbound,
    updateLeadDripStep,
    updateLeadDripActive,
    updateLeadShowingScheduled,

    // Stats
    getLeadStats,

    // Conversations
    logConversation,
    getLeadConversations,

    // Drip log
    logDripStep,
    checkDripStepSent,
    getLeadDripLog,

    // SMS log
    logSms,
};
