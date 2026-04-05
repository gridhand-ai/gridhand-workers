/**
 * GRIDHAND Maintenance Dispatcher — Supabase Database Layer
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const dayjs = require('dayjs');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Connections ──────────────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('md_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('md_connections')
        .select('client_slug');
    if (error) throw error;
    return data || [];
}

async function upsertConnection(conn) {
    const { error } = await supabase
        .from('md_connections')
        .upsert({ ...conn, updated_at: new Date().toISOString() }, { onConflict: 'client_slug' });
    if (error) throw error;
}

// ─── Vendors ──────────────────────────────────────────────────────────────────

async function upsertVendor(clientSlug, vendor) {
    const { data, error } = await supabase
        .from('md_vendors')
        .upsert({
            client_slug: clientSlug,
            name:        vendor.name,
            phone:       vendor.phone,
            email:       vendor.email || null,
            trade:       vendor.trade,
            rating:      vendor.rating || 5.0,
            active:      vendor.active !== false,
            notes:       vendor.notes || null,
            updated_at:  new Date().toISOString(),
        }, { onConflict: 'client_slug,phone' })
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function getBestVendorForTrade(clientSlug, trade) {
    // Get the best active vendor for a given trade, ranked by rating then jobs completed
    const { data, error } = await supabase
        .from('md_vendors')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('trade', trade)
        .eq('active', true)
        .order('rating', { ascending: false })
        .order('jobs_completed', { ascending: false })
        .limit(1)
        .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getVendors(clientSlug) {
    const { data, error } = await supabase
        .from('md_vendors')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('active', true)
        .order('trade');
    if (error) throw error;
    return data || [];
}

async function incrementVendorJobs(vendorId) {
    const { error } = await supabase.rpc('increment_vendor_jobs', { vendor_id: vendorId });
    // Fallback if RPC not available
    if (error) {
        const { data } = await supabase.from('md_vendors').select('jobs_completed').eq('id', vendorId).single();
        await supabase.from('md_vendors').update({ jobs_completed: (data?.jobs_completed || 0) + 1 }).eq('id', vendorId);
    }
}

// ─── Maintenance Requests ─────────────────────────────────────────────────────

async function createRequest(clientSlug, req) {
    const slaHours = { emergency: 4, urgent: 24, routine: 72 };
    const hours    = slaHours[req.priority || 'routine'];
    const slaDeadline = dayjs().add(hours, 'hour').toISOString();

    const { data, error } = await supabase
        .from('md_requests')
        .insert({
            client_slug:         clientSlug,
            appfolio_request_id: req.appfolioRequestId || null,
            property_address:    req.propertyAddress || null,
            unit_number:         req.unitNumber || null,
            tenant_name:         req.tenantName || null,
            tenant_phone:        req.tenantPhone || null,
            category:            req.category || 'general',
            priority:            req.priority || 'routine',
            description:         req.description,
            status:              'new',
            sla_deadline:        slaDeadline,
        })
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function updateRequest(requestId, updates) {
    const { error } = await supabase
        .from('md_requests')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', requestId);
    if (error) throw error;
}

async function getRequest(requestId) {
    const { data, error } = await supabase
        .from('md_requests')
        .select('*')
        .eq('id', requestId)
        .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getOpenRequests(clientSlug) {
    const { data, error } = await supabase
        .from('md_requests')
        .select('*')
        .eq('client_slug', clientSlug)
        .not('status', 'in', '("completed","cancelled")')
        .order('priority', { ascending: true })   // emergency first
        .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
}

async function getSLABreachingRequests(clientSlug) {
    const now = new Date().toISOString();
    const { data, error } = await supabase
        .from('md_requests')
        .select('*')
        .eq('client_slug', clientSlug)
        .lt('sla_deadline', now)
        .eq('sla_breached', false)
        .not('status', 'in', '("completed","cancelled")');
    if (error) throw error;
    return data || [];
}

// ─── Alert Log ────────────────────────────────────────────────────────────────

async function logAlert(clientSlug, { alertType, recipient, messageBody, requestId = null }) {
    const { error } = await supabase
        .from('md_alerts')
        .insert({ client_slug: clientSlug, alert_type: alertType, recipient, message_body: messageBody, request_id: requestId });
    if (error) throw error;
}

async function getAlertHistory(clientSlug, alertType = null, limit = 50) {
    let query = supabase
        .from('md_alerts')
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
    upsertVendor,
    getBestVendorForTrade,
    getVendors,
    incrementVendorJobs,
    createRequest,
    updateRequest,
    getRequest,
    getOpenRequests,
    getSLABreachingRequests,
    logAlert,
    getAlertHistory,
};
