/**
 * GRIDHAND Reconciliation Bot — Supabase Database Layer
 *
 * Thin wrapper around Supabase client for all DB operations.
 * All raw queries go here — jobs.js, quickbooks.js, xero.js, plaid.js stay clean.
 *
 * Tables:
 *   rb_clients              — accounting firm / business config
 *   rb_transactions         — normalized transactions from all sources
 *   rb_reconciliation_runs  — monthly reconciliation snapshots
 *   rb_discrepancies        — flagged discrepancies
 *   rb_alerts               — SMS alert log
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── rb_clients ────────────────────────────────────────────────────────────────

async function getClient(clientSlug) {
    const { data, error } = await supabase
        .from('rb_clients')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllClients() {
    const { data, error } = await supabase
        .from('rb_clients')
        .select('*')
        .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
}

async function upsertClient(params) {
    const { error } = await supabase
        .from('rb_clients')
        .upsert({
            client_slug:         params.clientSlug,
            business_name:       params.businessName,
            accounting_platform: params.accountingPlatform,
            owner_phone:         params.ownerPhone || null,
            twilio_sid:          params.twilioSid || null,
            twilio_token:        params.twilioToken || null,
            twilio_number:       params.twilioNumber || null,
            updated_at:          new Date().toISOString(),
        }, { onConflict: 'client_slug' });

    if (error) throw error;
}

async function updateQboTokens(clientSlug, { accessToken, refreshToken, expiresAt, realmId }) {
    const update = {
        qbo_access_token:  accessToken,
        qbo_refresh_token: refreshToken,
        qbo_expires_at:    expiresAt,
        updated_at:        new Date().toISOString(),
    };
    if (realmId) update.qbo_realm_id = realmId;

    const { error } = await supabase
        .from('rb_clients')
        .update(update)
        .eq('client_slug', clientSlug);
    if (error) throw error;
}

async function updateXeroTokens(clientSlug, { accessToken, refreshToken, expiresAt, tenantId }) {
    const update = {
        xero_access_token:  accessToken,
        xero_refresh_token: refreshToken,
        xero_expires_at:    expiresAt,
        updated_at:         new Date().toISOString(),
    };
    if (tenantId) update.xero_tenant_id = tenantId;

    const { error } = await supabase
        .from('rb_clients')
        .update(update)
        .eq('client_slug', clientSlug);
    if (error) throw error;
}

async function updatePlaidTokens(clientSlug, { accessToken, itemId }) {
    const { error } = await supabase
        .from('rb_clients')
        .update({
            plaid_access_token: accessToken,
            plaid_item_id:      itemId,
            updated_at:         new Date().toISOString(),
        })
        .eq('client_slug', clientSlug);
    if (error) throw error;
}

// ─── rb_transactions ───────────────────────────────────────────────────────────

/**
 * Upsert a batch of normalized transactions.
 * Conflict on (client_id, source, source_transaction_id).
 */
async function upsertTransactions(clientId, transactions) {
    if (!transactions.length) return;

    const rows = transactions.map(t => ({
        client_id:              clientId,
        source:                 t.source,
        source_transaction_id:  t.source_transaction_id,
        date:                   t.date,
        amount:                 t.amount,
        description:            t.description || null,
        merchant_name:          t.merchant_name || null,
        category:               t.category || 'Uncategorized',
        category_confidence:    t.category_confidence || 0,
        account_id:             t.account_id || null,
        account_name:           t.account_name || null,
        currency:               t.currency || 'USD',
        updated_at:             new Date().toISOString(),
    }));

    const { error } = await supabase
        .from('rb_transactions')
        .upsert(rows, { onConflict: 'client_id,source,source_transaction_id' });
    if (error) throw error;
}

async function getTransactions(clientId, { source, reconciled, days, limit = 500 } = {}) {
    let query = supabase
        .from('rb_transactions')
        .select('*')
        .eq('client_id', clientId)
        .order('date', { ascending: false })
        .limit(limit);

    if (source)            query = query.eq('source', source);
    if (reconciled != null) query = query.eq('is_reconciled', reconciled === 'true' || reconciled === true);
    if (days) {
        const since = new Date(Date.now() - parseInt(days) * 86400000).toISOString().split('T')[0];
        query = query.gte('date', since);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

async function getTransactionsByPeriod(clientId, source, startDate, endDate) {
    const { data, error } = await supabase
        .from('rb_transactions')
        .select('*')
        .eq('client_id', clientId)
        .eq('source', source)
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: true });
    if (error) throw error;
    return data || [];
}

async function markReconciled(transactionId, matchedTransactionId) {
    const { error } = await supabase
        .from('rb_transactions')
        .update({
            is_reconciled:          true,
            matched_transaction_id: matchedTransactionId,
            updated_at:             new Date().toISOString(),
        })
        .eq('id', transactionId);
    if (error) throw error;
}

async function flagDiscrepancy(transactionId, reason) {
    const { error } = await supabase
        .from('rb_transactions')
        .update({
            discrepancy_flag:   true,
            discrepancy_reason: reason,
            updated_at:         new Date().toISOString(),
        })
        .eq('id', transactionId);
    if (error) throw error;
}

async function getUncategorizedTransactions(clientId, limit = 200) {
    const { data, error } = await supabase
        .from('rb_transactions')
        .select('*')
        .eq('client_id', clientId)
        .eq('category', 'Uncategorized')
        .order('date', { ascending: false })
        .limit(limit);
    if (error) throw error;
    return data || [];
}

// ─── rb_reconciliation_runs ────────────────────────────────────────────────────

async function createReconciliationRun(clientId, periodStart, periodEnd) {
    const { data, error } = await supabase
        .from('rb_reconciliation_runs')
        .insert({
            client_id:    clientId,
            period_start: periodStart,
            period_end:   periodEnd,
            status:       'in_progress',
        })
        .select('id')
        .single();
    if (error) throw error;
    return data.id;
}

async function updateReconciliationRun(runId, updates) {
    const { error } = await supabase
        .from('rb_reconciliation_runs')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', runId);
    if (error) throw error;
}

async function getReconciliationRuns(clientId, limit = 12) {
    const { data, error } = await supabase
        .from('rb_reconciliation_runs')
        .select('*')
        .eq('client_id', clientId)
        .order('period_start', { ascending: false })
        .limit(limit);
    if (error) throw error;
    return data || [];
}

async function getReconciliationRun(runId) {
    const { data, error } = await supabase
        .from('rb_reconciliation_runs')
        .select('*')
        .eq('id', runId)
        .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

// ─── rb_discrepancies ──────────────────────────────────────────────────────────

async function insertDiscrepancy(params) {
    const { data, error } = await supabase
        .from('rb_discrepancies')
        .insert({
            client_id:        params.clientId,
            run_id:           params.runId,
            transaction_id:   params.transactionId || null,
            discrepancy_type: params.discrepancyType,
            description:      params.description || null,
            qbo_amount:       params.qboAmount || null,
            bank_amount:      params.bankAmount || null,
            status:           'open',
        })
        .select('id')
        .single();
    if (error) throw error;
    return data.id;
}

async function getDiscrepancies(clientId, status = 'open', limit = 100) {
    let query = supabase
        .from('rb_discrepancies')
        .select('*, rb_transactions(date, amount, description, source)')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

async function resolveDiscrepancy(discrepancyId, status) {
    const { error } = await supabase
        .from('rb_discrepancies')
        .update({
            status:      status, // 'resolved' or 'ignored'
            resolved_at: new Date().toISOString(),
            updated_at:  new Date().toISOString(),
        })
        .eq('id', discrepancyId);
    if (error) throw error;
}

async function getDiscrepanciesByRun(runId) {
    const { data, error } = await supabase
        .from('rb_discrepancies')
        .select('*')
        .eq('run_id', runId)
        .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
}

// ─── rb_alerts ─────────────────────────────────────────────────────────────────

async function logAlert(clientId, { alertType, recipient, messageBody, sentAt }) {
    const { error } = await supabase
        .from('rb_alerts')
        .insert({
            client_id:    clientId,
            alert_type:   alertType,
            recipient,
            message_body: messageBody,
            sent_at:      sentAt || new Date().toISOString(),
        });
    if (error) throw error;
}

async function getAlerts(clientId, limit = 50) {
    const { data, error } = await supabase
        .from('rb_alerts')
        .select('*')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw error;
    return data || [];
}

module.exports = {
    // Clients
    getClient,
    getAllClients,
    upsertClient,
    updateQboTokens,
    updateXeroTokens,
    updatePlaidTokens,

    // Transactions
    upsertTransactions,
    getTransactions,
    getTransactionsByPeriod,
    markReconciled,
    flagDiscrepancy,
    getUncategorizedTransactions,

    // Reconciliation runs
    createReconciliationRun,
    updateReconciliationRun,
    getReconciliationRuns,
    getReconciliationRun,

    // Discrepancies
    insertDiscrepancy,
    getDiscrepancies,
    resolveDiscrepancy,
    getDiscrepanciesByRun,

    // Alerts
    logAlert,
    getAlerts,
};
