/**
 * GRIDHAND Lease Renewal Agent — Supabase Database Layer
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
        .from('lra_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('lra_connections')
        .select('client_slug');
    if (error) throw error;
    return data || [];
}

async function upsertConnection(conn) {
    const { error } = await supabase
        .from('lra_connections')
        .upsert({ ...conn, updated_at: new Date().toISOString() }, { onConflict: 'client_slug' });
    if (error) throw error;
}

async function updateDocuSignTokens(clientSlug, { accessToken, refreshToken, expiresAt }) {
    const { error } = await supabase
        .from('lra_connections')
        .update({ docusign_access_token: accessToken, docusign_refresh_token: refreshToken, docusign_expires_at: expiresAt, updated_at: new Date().toISOString() })
        .eq('client_slug', clientSlug);
    if (error) throw error;
}

async function updateBuildiumTokens(clientSlug, { accessToken, expiresAt }) {
    const { error } = await supabase
        .from('lra_connections')
        .update({ buildium_access_token: accessToken, buildium_expires_at: expiresAt, updated_at: new Date().toISOString() })
        .eq('client_slug', clientSlug);
    if (error) throw error;
}

// ─── Renewals ─────────────────────────────────────────────────────────────────

async function upsertRenewal(clientSlug, renewal) {
    const { data, error } = await supabase
        .from('lra_renewals')
        .upsert({
            client_slug:      clientSlug,
            pms_lease_id:     renewal.pmsLeaseId,
            tenant_name:      renewal.tenantName,
            tenant_email:     renewal.tenantEmail || null,
            tenant_phone:     renewal.tenantPhone || null,
            property_address: renewal.propertyAddress || null,
            unit_number:      renewal.unitNumber || null,
            current_rent:     renewal.currentRent,
            lease_end_date:   renewal.leaseEndDate,
            offered_rent:     renewal.offeredRent || null,
            offered_term_months: renewal.offeredTermMonths || 12,
            new_lease_start:  renewal.newLeaseStart || null,
            new_lease_end:    renewal.newLeaseEnd || null,
            status:           renewal.status || 'pending',
            updated_at:       new Date().toISOString(),
        }, { onConflict: 'client_slug,pms_lease_id' })
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function getRenewal(clientSlug, pmsLeaseId) {
    const { data, error } = await supabase
        .from('lra_renewals')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('pms_lease_id', pmsLeaseId)
        .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getRenewalById(id) {
    const { data, error } = await supabase
        .from('lra_renewals')
        .select('*')
        .eq('id', id)
        .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function updateRenewal(id, updates) {
    const { error } = await supabase
        .from('lra_renewals')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id);
    if (error) throw error;
}

async function getExpiringLeases(clientSlug, withinDays = 60) {
    const today   = dayjs().format('YYYY-MM-DD');
    const cutoff  = dayjs().add(withinDays, 'day').format('YYYY-MM-DD');

    const { data, error } = await supabase
        .from('lra_renewals')
        .select('*')
        .eq('client_slug', clientSlug)
        .gte('lease_end_date', today)
        .lte('lease_end_date', cutoff)
        .in('status', ['pending', 'offer_sent', 'negotiating']);
    if (error) throw error;
    return data || [];
}

async function getPipelineByStatus(clientSlug, status = null) {
    let query = supabase
        .from('lra_renewals')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('lease_end_date', { ascending: true });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

// ─── Communications ───────────────────────────────────────────────────────────

async function logCommunication(clientSlug, renewalId, { channel, direction, recipient, subject, messageBody, status = 'sent' }) {
    const { error } = await supabase
        .from('lra_communications')
        .insert({ client_slug: clientSlug, renewal_id: renewalId, channel, direction, recipient, subject, message_body: messageBody, status });
    if (error) throw error;
}

async function getCommunications(renewalId) {
    const { data, error } = await supabase
        .from('lra_communications')
        .select('*')
        .eq('renewal_id', renewalId)
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

module.exports = {
    getConnection,
    getAllConnectedClients,
    upsertConnection,
    updateDocuSignTokens,
    updateBuildiumTokens,
    upsertRenewal,
    getRenewal,
    getRenewalById,
    updateRenewal,
    getExpiringLeases,
    getPipelineByStatus,
    logCommunication,
    getCommunications,
};
