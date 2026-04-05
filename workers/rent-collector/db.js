/**
 * GRIDHAND Rent Collector — Supabase Database Layer
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
        .from('rc_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('rc_connections')
        .select('client_slug');
    if (error) throw error;
    return data || [];
}

async function upsertConnection(conn) {
    const { error } = await supabase
        .from('rc_connections')
        .upsert({ ...conn, updated_at: new Date().toISOString() }, { onConflict: 'client_slug' });
    if (error) throw error;
}

async function updateBuildiumTokens(clientSlug, { accessToken, refreshToken, expiresAt }) {
    const { error } = await supabase
        .from('rc_connections')
        .update({ buildium_access_token: accessToken, buildium_refresh_token: refreshToken, buildium_expires_at: expiresAt, updated_at: new Date().toISOString() })
        .eq('client_slug', clientSlug);
    if (error) throw error;
}

async function updateQBTokens(clientSlug, { accessToken, refreshToken, expiresAt }) {
    const { error } = await supabase
        .from('rc_connections')
        .update({ qb_access_token: accessToken, qb_refresh_token: refreshToken, qb_expires_at: expiresAt, updated_at: new Date().toISOString() })
        .eq('client_slug', clientSlug);
    if (error) throw error;
}

// ─── Rent Tracker ─────────────────────────────────────────────────────────────

async function upsertRentTracker(clientSlug, lease) {
    const { error } = await supabase
        .from('rc_rent_tracker')
        .upsert({
            client_slug:         clientSlug,
            buildium_lease_id:   lease.buildiumLeaseId,
            buildium_tenant_id:  lease.tenantId || null,
            property_address:    lease.propertyAddress || null,
            unit_number:         lease.unitNumber || null,
            tenant_name:         lease.tenantName,
            tenant_phone:        lease.tenantPhone || null,
            tenant_email:        lease.tenantEmail || null,
            rent_amount:         lease.rentAmount,
            due_day:             lease.dueDay || 1,
            current_month:       lease.currentMonth,
            amount_paid:         lease.amountPaid || 0,
            paid_at:             lease.paidAt || null,
            status:              lease.status || 'pending',
            qb_invoice_id:       lease.qbInvoiceId || null,
            updated_at:          new Date().toISOString(),
        }, { onConflict: 'client_slug,buildium_lease_id,current_month' });
    if (error) throw error;
}

async function getRentTracker(clientSlug, buildiumLeaseId, currentMonth) {
    const { data, error } = await supabase
        .from('rc_rent_tracker')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('buildium_lease_id', buildiumLeaseId)
        .eq('current_month', currentMonth)
        .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getCurrentMonthRent(clientSlug) {
    const month = dayjs().format('YYYY-MM');
    const { data, error } = await supabase
        .from('rc_rent_tracker')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('current_month', month);
    if (error) throw error;
    return data || [];
}

async function getUnpaidReminders(clientSlug) {
    const month = dayjs().format('YYYY-MM');
    const { data, error } = await supabase
        .from('rc_rent_tracker')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('current_month', month)
        .not('status', 'eq', 'paid')
        .not('tenant_phone', 'is', null);
    if (error) throw error;
    return data || [];
}

async function markReminderSent(clientSlug, buildiumLeaseId, currentMonth) {
    const { data: existing } = await supabase
        .from('rc_rent_tracker')
        .select('reminder_sent_count')
        .eq('client_slug', clientSlug)
        .eq('buildium_lease_id', buildiumLeaseId)
        .eq('current_month', currentMonth)
        .single();

    const { error } = await supabase
        .from('rc_rent_tracker')
        .update({
            reminder_sent_count: (existing?.reminder_sent_count || 0) + 1,
            last_reminder_sent:  new Date().toISOString(),
        })
        .eq('client_slug', clientSlug)
        .eq('buildium_lease_id', buildiumLeaseId)
        .eq('current_month', currentMonth);
    if (error) throw error;
}

async function markLateFeeIssued(clientSlug, buildiumLeaseId, currentMonth) {
    const { error } = await supabase
        .from('rc_rent_tracker')
        .update({ late_fee_issued: true, late_fee_issued_at: new Date().toISOString(), status: 'late_fee_issued' })
        .eq('client_slug', clientSlug)
        .eq('buildium_lease_id', buildiumLeaseId)
        .eq('current_month', currentMonth);
    if (error) throw error;
}

// ─── Owner Reports ────────────────────────────────────────────────────────────

async function upsertOwnerReport(clientSlug, report) {
    const { error } = await supabase
        .from('rc_owner_reports')
        .upsert({
            client_slug:       clientSlug,
            report_month:      report.month,
            total_expected:    report.totalExpected,
            total_collected:   report.totalCollected,
            total_outstanding: report.totalOutstanding,
            tenant_count:      report.tenantCount,
            paid_count:        report.paidCount,
            late_count:        report.lateCount,
            report_text:       report.reportText,
            sent_at:           new Date().toISOString(),
        }, { onConflict: 'client_slug,report_month' });
    if (error) throw error;
}

// ─── Alert Log ────────────────────────────────────────────────────────────────

async function logAlert(clientSlug, { alertType, recipient, messageBody, leaseId = null }) {
    const { error } = await supabase
        .from('rc_alerts')
        .insert({ client_slug: clientSlug, alert_type: alertType, recipient, message_body: messageBody, lease_id: leaseId });
    if (error) throw error;
}

async function getAlertHistory(clientSlug, alertType = null, limit = 50) {
    let query = supabase
        .from('rc_alerts')
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
    updateBuildiumTokens,
    updateQBTokens,
    upsertRentTracker,
    getRentTracker,
    getCurrentMonthRent,
    getUnpaidReminders,
    markReminderSent,
    markLateFeeIssued,
    upsertOwnerReport,
    logAlert,
    getAlertHistory,
};
