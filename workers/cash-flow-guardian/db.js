/**
 * GRIDHAND Cash Flow Guardian — Supabase Database Layer
 *
 * Thin wrapper around Supabase client for all DB operations.
 * All raw queries go here — jobs.js and quickbooks.js stay clean.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── QB Connections ───────────────────────────────────────────────────────────

async function getQBConnection(clientSlug) {
    const { data, error } = await supabase
        .from('qb_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('qb_connections')
        .select('client_slug');
    if (error) throw error;
    return data || [];
}

async function upsertQBConnection({ clientSlug, realmId, ownerPhone, accessToken, refreshToken, tokenType, expiresAt, scope }) {
    const { error } = await supabase
        .from('qb_connections')
        .upsert({
            client_slug:   clientSlug,
            realm_id:      realmId,
            owner_phone:   ownerPhone,
            access_token:  accessToken,
            refresh_token: refreshToken,
            token_type:    tokenType,
            expires_at:    expiresAt,
            scope,
            updated_at:    new Date().toISOString(),
        }, { onConflict: 'client_slug' });

    if (error) throw error;
}

async function updateQBTokens(clientSlug, { accessToken, refreshToken, expiresAt }) {
    const { error } = await supabase
        .from('qb_connections')
        .update({
            access_token:  accessToken,
            refresh_token: refreshToken,
            expires_at:    expiresAt,
            updated_at:    new Date().toISOString(),
        })
        .eq('client_slug', clientSlug);

    if (error) throw error;
}

// ─── Cash Flow Snapshots ──────────────────────────────────────────────────────

async function upsertSnapshot(clientSlug, snapshot) {
    const { error } = await supabase
        .from('cash_flow_snapshots')
        .upsert({
            client_slug:    clientSlug,
            snapshot_date:  snapshot.date,
            total_income:   snapshot.totalIncome,
            total_expenses: snapshot.totalExpenses,
            cash_balance:   snapshot.cashBalance,
            ar_balance:     snapshot.arBalance,
            ap_balance:     snapshot.apBalance,
            overdue_count:  snapshot.overdueCount,
            overdue_amount: snapshot.overdueAmount,
        }, { onConflict: 'client_slug,snapshot_date' });

    if (error) throw error;
}

async function getRecentSnapshots(clientSlug, days = 14) {
    const { data, error } = await supabase
        .from('cash_flow_snapshots')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('snapshot_date', { ascending: false })
        .limit(days);

    if (error) throw error;
    return (data || []).reverse(); // oldest first for analysis
}

async function getLatestSnapshot(clientSlug) {
    const { data, error } = await supabase
        .from('cash_flow_snapshots')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('snapshot_date', { ascending: false })
        .limit(1)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

// ─── Invoice Tracker ──────────────────────────────────────────────────────────

async function getInvoiceTracker(clientSlug, qbInvoiceId) {
    const { data, error } = await supabase
        .from('invoice_tracker')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('qb_invoice_id', qbInvoiceId)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getOpenTrackedInvoices(clientSlug) {
    const { data, error } = await supabase
        .from('invoice_tracker')
        .select('*')
        .eq('client_slug', clientSlug)
        .in('status', ['Open', 'Overdue']);

    if (error) throw error;
    return data || [];
}

async function upsertInvoiceTracker(clientSlug, inv) {
    const { error } = await supabase
        .from('invoice_tracker')
        .upsert({
            client_slug:        clientSlug,
            qb_invoice_id:      inv.id,
            invoice_number:     inv.invoiceNumber,
            customer_name:      inv.customerName,
            customer_phone:     inv.customerPhone || null,
            customer_email:     inv.emailAddress || null,
            amount:             inv.amount,
            balance_due:        inv.balanceDue,
            due_date:           inv.dueDate || null,
            status:             inv.status || 'Open',
            days_overdue:       inv.daysOverdue || 0,
            reminder_count:     inv.reminderCount || 0,
            last_reminder_sent: inv.lastReminderSent || null,
            updated_at:         new Date().toISOString(),
        }, { onConflict: 'client_slug,qb_invoice_id' });

    if (error) throw error;
}

async function markInvoicePaid(clientSlug, qbInvoiceId) {
    const { error } = await supabase
        .from('invoice_tracker')
        .update({
            status:               'Paid',
            balance_due:          0,
            payment_received_at:  new Date().toISOString(),
            updated_at:           new Date().toISOString(),
        })
        .eq('client_slug', clientSlug)
        .eq('qb_invoice_id', qbInvoiceId);

    if (error) throw error;
}

// ─── Alert Log ────────────────────────────────────────────────────────────────

async function logAlert(clientSlug, { alertType, recipient, messageBody, invoiceId = null }) {
    const { error } = await supabase
        .from('cash_flow_alerts')
        .insert({
            client_slug:  clientSlug,
            alert_type:   alertType,
            recipient,
            message_body: messageBody,
            invoice_id:   invoiceId,
        });

    if (error) throw error;
}

async function getAlertHistory(clientSlug, alertType = null, limit = 50) {
    let query = supabase
        .from('cash_flow_alerts')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (alertType) query = query.eq('alert_type', alertType);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

// ─── Forecasts ────────────────────────────────────────────────────────────────

async function saveForecast(clientSlug, forecast) {
    const { error } = await supabase
        .from('cash_flow_forecasts')
        .upsert({
            client_slug:         clientSlug,
            forecast_week_start: forecast.forecastWeekStart,
            expected_inflow:     forecast.expectedInflow,
            expected_outflow:    forecast.expectedOutflow,
            projected_balance:   forecast.projectedBalance,
        }, { onConflict: 'client_slug,forecast_week_start' });

    if (error) throw error;
}

module.exports = {
    getQBConnection,
    getAllConnectedClients,
    upsertQBConnection,
    updateQBTokens,
    upsertSnapshot,
    getRecentSnapshots,
    getLatestSnapshot,
    getInvoiceTracker,
    getOpenTrackedInvoices,
    upsertInvoiceTracker,
    markInvoicePaid,
    logAlert,
    getAlertHistory,
    saveForecast,
};
