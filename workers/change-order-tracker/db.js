/**
 * GRIDHAND Change Order Tracker — Supabase Database Layer
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Connections ──────────────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('cot_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('cot_connections')
        .select('client_slug');
    if (error) throw error;
    return data || [];
}

async function upsertConnection(conn) {
    const { error } = await supabase
        .from('cot_connections')
        .upsert({ ...conn, updated_at: new Date().toISOString() }, { onConflict: 'client_slug' });
    if (error) throw error;
}

async function updateProcoreTokens(clientSlug, { accessToken, refreshToken, expiresAt }) {
    const { error } = await supabase
        .from('cot_connections')
        .update({
            procore_access_token:  accessToken,
            procore_refresh_token: refreshToken,
            procore_expires_at:    expiresAt,
            updated_at:            new Date().toISOString(),
        })
        .eq('client_slug', clientSlug);
    if (error) throw error;
}

async function updateQBTokens(clientSlug, { accessToken, refreshToken, expiresAt }) {
    const { error } = await supabase
        .from('cot_connections')
        .update({
            qb_access_token:  accessToken,
            qb_refresh_token: refreshToken,
            qb_expires_at:    expiresAt,
            updated_at:       new Date().toISOString(),
        })
        .eq('client_slug', clientSlug);
    if (error) throw error;
}

// ─── Change Orders ────────────────────────────────────────────────────────────

async function upsertChangeOrder(clientSlug, co) {
    const { error } = await supabase
        .from('cot_change_orders')
        .upsert({
            client_slug:          clientSlug,
            procore_co_id:        co.procoreCoId,
            procore_project_id:   co.projectId,
            project_name:         co.projectName,
            co_number:            co.coNumber,
            title:                co.title,
            description:          co.description,
            status:               co.status,
            original_amount:      co.originalAmount,
            approved_amount:      co.approvedAmount,
            markup_amount:        co.markupAmount,
            qb_invoice_id:        co.qbInvoiceId || null,
            qb_synced_at:         co.qbSyncedAt || null,
            client_summary:       co.clientSummary || null,
            procore_created_at:   co.procoreCreatedAt || null,
            procore_updated_at:   co.procoreUpdatedAt || null,
            last_synced_at:       new Date().toISOString(),
            updated_at:           new Date().toISOString(),
        }, { onConflict: 'client_slug,procore_co_id' });
    if (error) throw error;
}

async function getChangeOrder(clientSlug, procoreCoId) {
    const { data, error } = await supabase
        .from('cot_change_orders')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('procore_co_id', procoreCoId)
        .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getChangeOrdersByProject(clientSlug, projectId) {
    const { data, error } = await supabase
        .from('cot_change_orders')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('procore_project_id', projectId)
        .order('procore_created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

async function markQBSynced(clientSlug, procoreCoId, qbInvoiceId) {
    const { error } = await supabase
        .from('cot_change_orders')
        .update({ qb_invoice_id: qbInvoiceId, qb_synced_at: new Date().toISOString() })
        .eq('client_slug', clientSlug)
        .eq('procore_co_id', procoreCoId);
    if (error) throw error;
}

// ─── Project Summaries ────────────────────────────────────────────────────────

async function upsertProjectSummary(clientSlug, summary) {
    const { error } = await supabase
        .from('cot_project_summaries')
        .upsert({
            client_slug:          clientSlug,
            procore_project_id:   summary.projectId,
            project_name:         summary.projectName,
            original_contract:    summary.originalContract,
            approved_cos_total:   summary.approvedTotal,
            pending_cos_total:    summary.pendingTotal,
            co_count_approved:    summary.approvedCount,
            co_count_pending:     summary.pendingCount,
            last_updated:         new Date().toISOString(),
        }, { onConflict: 'client_slug,procore_project_id' });
    if (error) throw error;
}

async function getProjectSummaries(clientSlug) {
    const { data, error } = await supabase
        .from('cot_project_summaries')
        .select('*')
        .eq('client_slug', clientSlug);
    if (error) throw error;
    return data || [];
}

// ─── Alert Log ────────────────────────────────────────────────────────────────

async function logAlert(clientSlug, { alertType, recipient, messageBody, coId = null, projectId = null }) {
    const { error } = await supabase
        .from('cot_alerts')
        .insert({ client_slug: clientSlug, alert_type: alertType, recipient, message_body: messageBody, co_id: coId, project_id: projectId });
    if (error) throw error;
}

async function getAlertHistory(clientSlug, alertType = null, limit = 50) {
    let query = supabase
        .from('cot_alerts')
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
    updateProcoreTokens,
    updateQBTokens,
    upsertChangeOrder,
    getChangeOrder,
    getChangeOrdersByProject,
    markQBSynced,
    upsertProjectSummary,
    getProjectSummaries,
    logAlert,
    getAlertHistory,
};
