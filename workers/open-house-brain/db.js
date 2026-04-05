/**
 * GRIDHAND Open House Brain — Supabase Database Layer
 *
 * Thin wrapper around Supabase client for all DB operations.
 * No business logic lives here — jobs.js, calendar.js, crm.js stay clean.
 */

'use strict';

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Clients ──────────────────────────────────────────────────────────────────

async function getClient(clientSlug) {
    const { data, error } = await supabase
        .from('oh_clients')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('active', true)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getClients() {
    const { data, error } = await supabase
        .from('oh_clients')
        .select('*')
        .eq('active', true)
        .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
}

// ─── Open Houses ──────────────────────────────────────────────────────────────

async function upsertOpenHouse(openHouse) {
    const record = {
        client_id:       openHouse.client_id,
        listing_id:      openHouse.listing_id || null,
        listing_address: openHouse.listing_address,
        date:            openHouse.date,
        start_time:      openHouse.start_time,
        end_time:        openHouse.end_time,
        google_event_id: openHouse.google_event_id || null,
        calendar_link:   openHouse.calendar_link || null,
        status:          openHouse.status || 'scheduled',
        visitor_count:   openHouse.visitor_count || 0,
        invites_sent:    openHouse.invites_sent || 0,
        notes:           openHouse.notes || null,
        updated_at:      new Date().toISOString(),
    };

    if (openHouse.id) {
        const { data, error } = await supabase
            .from('oh_open_houses')
            .update(record)
            .eq('id', openHouse.id)
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    const { data, error } = await supabase
        .from('oh_open_houses')
        .insert(record)
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function getOpenHouse(id) {
    const { data, error } = await supabase
        .from('oh_open_houses')
        .select('*, oh_clients(agent_name, agent_phone, timezone)')
        .eq('id', id)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getOpenHousesByClient(clientSlug) {
    // Resolve client_id from slug first
    const client = await getClient(clientSlug);
    if (!client) return [];

    const { data, error } = await supabase
        .from('oh_open_houses')
        .select('*')
        .eq('client_id', client.id)
        .order('date', { ascending: false })
        .order('start_time', { ascending: false });

    if (error) throw error;
    return data || [];
}

async function updateOpenHouseStatus(id, status) {
    const { data, error } = await supabase
        .from('oh_open_houses')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function incrementVisitorCount(openHouseId) {
    const { data: current } = await supabase
        .from('oh_open_houses')
        .select('visitor_count')
        .eq('id', openHouseId)
        .single();

    const count = (current?.visitor_count || 0) + 1;

    const { error } = await supabase
        .from('oh_open_houses')
        .update({ visitor_count: count, updated_at: new Date().toISOString() })
        .eq('id', openHouseId);

    if (error) throw error;
    return count;
}

async function incrementInvitesSent(openHouseId, count = 1) {
    const { data: current } = await supabase
        .from('oh_open_houses')
        .select('invites_sent')
        .eq('id', openHouseId)
        .single();

    const total = (current?.invites_sent || 0) + count;

    const { error } = await supabase
        .from('oh_open_houses')
        .update({ invites_sent: total, updated_at: new Date().toISOString() })
        .eq('id', openHouseId);

    if (error) throw error;
    return total;
}

// Get open houses ending in the last N minutes (for post-event follow-up trigger)
async function getRecentlyEndedOpenHouses(minutesAgo = 60) {
    const now = new Date();
    const cutoff = new Date(now.getTime() - minutesAgo * 60 * 1000);

    // We combine date+time manually since Supabase doesn't support time range directly
    const { data, error } = await supabase
        .from('oh_open_houses')
        .select('*, oh_clients(*)')
        .eq('status', 'scheduled')
        .lte('date', now.toISOString().split('T')[0]);

    if (error) throw error;

    // Filter in JS: date is today or past, and end_time is within window
    const results = (data || []).filter(oh => {
        const endDt = new Date(`${oh.date}T${oh.end_time}`);
        return endDt >= cutoff && endDt <= now;
    });

    return results;
}

// Get open houses scheduled for tomorrow (for day-before reminders)
async function getTomorrowOpenHouses() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const { data, error } = await supabase
        .from('oh_open_houses')
        .select('*, oh_clients(*)')
        .eq('date', tomorrowStr)
        .eq('status', 'scheduled');

    if (error) throw error;
    return data || [];
}

// ─── Visitors ─────────────────────────────────────────────────────────────────

async function registerVisitor(visitor) {
    const record = {
        open_house_id:   visitor.open_house_id,
        client_id:       visitor.client_id,
        name:            visitor.name,
        phone:           visitor.phone,
        email:           visitor.email || null,
        crm_contact_id:  visitor.crm_contact_id || null,
        interest_level:  visitor.interest_level || 'unknown',
        followup_status: 'pending',
        agent_notes:     visitor.notes || null,
        registered_at:   new Date().toISOString(),
    };

    const { data, error } = await supabase
        .from('oh_visitors')
        .insert(record)
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function getVisitor(id) {
    const { data, error } = await supabase
        .from('oh_visitors')
        .select('*')
        .eq('id', id)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getVisitorByPhone(phone, openHouseId) {
    const query = supabase
        .from('oh_visitors')
        .select('*')
        .eq('phone', phone);

    if (openHouseId) query.eq('open_house_id', openHouseId);

    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data || null;
}

async function getVisitorByPhoneAnyHouse(phone, clientId) {
    const { data, error } = await supabase
        .from('oh_visitors')
        .select('*, oh_open_houses(listing_address, date)')
        .eq('phone', phone)
        .eq('client_id', clientId)
        .order('registered_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    return data || null;
}

async function getVisitors(openHouseId) {
    const { data, error } = await supabase
        .from('oh_visitors')
        .select('*')
        .eq('open_house_id', openHouseId)
        .order('registered_at', { ascending: true });

    if (error) throw error;
    return data || [];
}

async function updateVisitor(id, updates) {
    const { data, error } = await supabase
        .from('oh_visitors')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();

    if (error) throw error;
    return data;
}

// Get visitors needing day-after follow-up (thankyou_sent, registered yesterday or earlier)
async function getVisitorsForDayAfterFollowup() {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - 12); // at least 12h since event

    const { data, error } = await supabase
        .from('oh_visitors')
        .select('*, oh_open_houses(listing_address, date, start_time, end_time, oh_clients(*))')
        .eq('followup_status', 'thankyou_sent')
        .lte('registered_at', cutoff.toISOString());

    if (error) throw error;
    return data || [];
}

// Get visitors needing week follow-up
async function getVisitorsForWeekFollowup() {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const cutoffEnd = new Date(weekAgo);
    cutoffEnd.setDate(cutoffEnd.getDate() + 1); // a 24h window around the 7-day mark

    const { data, error } = await supabase
        .from('oh_visitors')
        .select('*, oh_open_houses(listing_address, date, oh_clients(*))')
        .eq('followup_status', 'day_after_sent')
        .gte('registered_at', weekAgo.toISOString())
        .lte('registered_at', cutoffEnd.toISOString());

    if (error) throw error;
    return data || [];
}

// ─── Invites ──────────────────────────────────────────────────────────────────

async function logInvite(invite) {
    const { data, error } = await supabase
        .from('oh_invites')
        .insert({
            open_house_id:   invite.open_house_id,
            client_id:       invite.client_id,
            crm_contact_id:  invite.crm_contact_id || null,
            name:            invite.name || null,
            phone:           invite.phone,
            message:         invite.message || null,
            sent_at:         invite.sent_at || new Date().toISOString(),
            replied:         false,
        })
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function getInvites(openHouseId) {
    const { data, error } = await supabase
        .from('oh_invites')
        .select('*')
        .eq('open_house_id', openHouseId)
        .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
}

async function markInviteReplied(id, intent) {
    const { error } = await supabase
        .from('oh_invites')
        .update({ replied: true, reply_intent: intent })
        .eq('id', id);

    if (error) throw error;
}

// ─── Conversations ────────────────────────────────────────────────────────────

async function logConversation(conv) {
    const { data, error } = await supabase
        .from('oh_conversations')
        .insert({
            visitor_id:    conv.visitor_id,
            open_house_id: conv.open_house_id || null,
            client_id:     conv.client_id || null,
            direction:     conv.direction,
            message:       conv.message,
            intent:        conv.intent || null,
            twilio_sid:    conv.twilio_sid || null,
        })
        .select()
        .single();

    if (error) throw error;
    return data;
}

// ─── SMS Log ──────────────────────────────────────────────────────────────────

async function logSms(entry) {
    const { data, error } = await supabase
        .from('oh_sms_log')
        .insert({
            client_id:     entry.client_id || null,
            visitor_id:    entry.visitor_id || null,
            open_house_id: entry.open_house_id || null,
            direction:     entry.direction,
            to_number:     entry.to_number,
            from_number:   entry.from_number,
            body:          entry.body,
            twilio_sid:    entry.twilio_sid || null,
        })
        .select()
        .single();

    if (error) throw error;
    return data;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

async function getStats(clientSlug) {
    const client = await getClient(clientSlug);
    if (!client) return null;

    const { data: openHouses, error: ohErr } = await supabase
        .from('oh_open_houses')
        .select('id, visitor_count, invites_sent, status, date')
        .eq('client_id', client.id);

    if (ohErr) throw ohErr;

    const { data: visitors, error: vErr } = await supabase
        .from('oh_visitors')
        .select('interest_level, followup_status, crm_contact_id')
        .eq('client_id', client.id);

    if (vErr) throw vErr;

    const completed = (openHouses || []).filter(oh => oh.status === 'completed');
    const totalVisitors = (visitors || []).length;
    const highInterest = (visitors || []).filter(v => v.interest_level === 'high').length;
    const converted = (visitors || []).filter(v => v.followup_status === 'converted').length;
    const avgVisitorsPerEvent = completed.length > 0
        ? Math.round((visitors || []).length / completed.length)
        : 0;

    return {
        clientSlug,
        totalOpenHouses:     (openHouses || []).length,
        completedOpenHouses: completed.length,
        scheduledOpenHouses: (openHouses || []).filter(oh => oh.status === 'scheduled').length,
        totalVisitors,
        totalInvitesSent:    (openHouses || []).reduce((sum, oh) => sum + (oh.invites_sent || 0), 0),
        highInterestLeads:   highInterest,
        convertedLeads:      converted,
        conversionRate:      totalVisitors > 0 ? Math.round((converted / totalVisitors) * 100) : 0,
        avgVisitorsPerEvent,
    };
}

module.exports = {
    // Clients
    getClient,
    getClients,
    // Open Houses
    upsertOpenHouse,
    getOpenHouse,
    getOpenHousesByClient,
    updateOpenHouseStatus,
    incrementVisitorCount,
    incrementInvitesSent,
    getRecentlyEndedOpenHouses,
    getTomorrowOpenHouses,
    // Visitors
    registerVisitor,
    getVisitor,
    getVisitorByPhone,
    getVisitorByPhoneAnyHouse,
    getVisitors,
    updateVisitor,
    getVisitorsForDayAfterFollowup,
    getVisitorsForWeekFollowup,
    // Invites
    logInvite,
    getInvites,
    markInviteReplied,
    // Conversations
    logConversation,
    // SMS Log
    logSms,
    // Stats
    getStats,
};
