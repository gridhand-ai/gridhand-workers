/**
 * GRIDHAND Doc Chaser — Supabase Database Layer
 *
 * Thin wrapper around Supabase client for all DC table operations.
 * All raw queries live here — jobs.js, sms.js, and email.js stay clean.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── DC Clients ───────────────────────────────────────────────────────────────

async function getClient(clientSlug) {
    const { data, error } = await supabase
        .from('dc_clients')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllClients() {
    const { data, error } = await supabase
        .from('dc_clients')
        .select('*')
        .order('firm_name', { ascending: true });

    if (error) throw error;
    return data || [];
}

async function upsertClient(fields) {
    const {
        clientSlug, firmName, taxdomeApiKey, taxdomeFirmId,
        twilioSid, twilioToken, twilioNumber,
        emailHost, emailPort, emailUser, emailPass, emailFrom,
        ownerPhone, defaultReminderIntervalDays, maxReminders,
    } = fields;

    const { data, error } = await supabase
        .from('dc_clients')
        .upsert({
            client_slug:                     clientSlug,
            firm_name:                       firmName,
            taxdome_api_key:                 taxdomeApiKey              || null,
            taxdome_firm_id:                 taxdomeFirmId              || null,
            twilio_sid:                      twilioSid                  || null,
            twilio_token:                    twilioToken                || null,
            twilio_number:                   twilioNumber               || null,
            email_host:                      emailHost                  || null,
            email_port:                      emailPort                  || 587,
            email_user:                      emailUser                  || null,
            email_pass:                      emailPass                  || null,
            email_from:                      emailFrom                  || null,
            owner_phone:                     ownerPhone                 || null,
            default_reminder_interval_days:  defaultReminderIntervalDays || 3,
            max_reminders:                   maxReminders               || 4,
            updated_at:                      new Date().toISOString(),
        }, { onConflict: 'client_slug' })
        .select()
        .single();

    if (error) throw error;
    return data;
}

// ─── DC Document Requests ─────────────────────────────────────────────────────

async function getDocumentRequests(clientId, filters = {}) {
    let query = supabase
        .from('dc_document_requests')
        .select('*')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false });

    if (filters.status) {
        if (Array.isArray(filters.status)) {
            query = query.in('status', filters.status);
        } else {
            query = query.eq('status', filters.status);
        }
    }

    if (filters.overdue) {
        query = query.eq('status', 'overdue');
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

async function getDocumentRequest(requestId) {
    const { data, error } = await supabase
        .from('dc_document_requests')
        .select('*')
        .eq('id', requestId)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getPendingAndOverdueRequests(clientId) {
    const { data, error } = await supabase
        .from('dc_document_requests')
        .select('*')
        .eq('client_id', clientId)
        .in('status', ['pending', 'overdue'])
        .order('due_date', { ascending: true });

    if (error) throw error;
    return data || [];
}

/**
 * Upsert a document request by taxdome_request_id.
 * If taxdome_request_id is null, falls back to insert.
 */
async function upsertDocumentRequest(clientId, req) {
    const row = {
        client_id:           clientId,
        taxdome_client_id:   req.taxdomeClientId,
        taxdome_job_id:      req.taxdomeJobId      || null,
        taxdome_request_id:  req.taxdomeRequestId  || null,
        client_name:         req.clientName,
        client_email:        req.clientEmail        || null,
        client_phone:        req.clientPhone        || null,
        document_name:       req.documentName,
        document_type:       req.documentType       || null,
        due_date:            req.dueDate            || null,
        updated_at:          new Date().toISOString(),
    };

    if (req.taxdomeRequestId) {
        const { data, error } = await supabase
            .from('dc_document_requests')
            .upsert({ ...row, status: req.status || 'pending' }, { onConflict: 'taxdome_request_id' })
            .select()
            .single();

        if (error) throw error;
        return data;
    } else {
        // No TaxDome request ID — check for match on client+job+document_name
        const { data: existing } = await supabase
            .from('dc_document_requests')
            .select('id, status')
            .eq('client_id', clientId)
            .eq('taxdome_client_id', req.taxdomeClientId)
            .eq('document_name', req.documentName)
            .neq('status', 'received')
            .limit(1)
            .single();

        if (existing) {
            const { data, error } = await supabase
                .from('dc_document_requests')
                .update(row)
                .eq('id', existing.id)
                .select()
                .single();
            if (error) throw error;
            return data;
        }

        const { data, error } = await supabase
            .from('dc_document_requests')
            .insert({ ...row, status: req.status || 'pending' })
            .select()
            .single();

        if (error) throw error;
        return data;
    }
}

async function updateRequestStatus(requestId, status) {
    const { data, error } = await supabase
        .from('dc_document_requests')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', requestId)
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function markRequestReceived(requestId) {
    return updateRequestStatus(requestId, 'received');
}

async function markRequestOverdue(requestId) {
    return updateRequestStatus(requestId, 'overdue');
}

/**
 * After a reminder is sent, increment reminder_count and stamp last_reminder_sent_at.
 */
async function incrementReminderCount(requestId) {
    const { data: current, error: fetchErr } = await supabase
        .from('dc_document_requests')
        .select('reminder_count')
        .eq('id', requestId)
        .single();

    if (fetchErr) throw fetchErr;

    const { error } = await supabase
        .from('dc_document_requests')
        .update({
            reminder_count:        (current?.reminder_count || 0) + 1,
            last_reminder_sent_at: new Date().toISOString(),
            updated_at:            new Date().toISOString(),
        })
        .eq('id', requestId);

    if (error) throw error;
}

/**
 * Mark requests received by taxdome_request_id (used during sync).
 */
async function markReceivedByTaxdomeId(clientId, taxdomeRequestId) {
    const { error } = await supabase
        .from('dc_document_requests')
        .update({ status: 'received', updated_at: new Date().toISOString() })
        .eq('client_id', clientId)
        .eq('taxdome_request_id', taxdomeRequestId)
        .neq('status', 'received');

    if (error) throw error;
}

/**
 * Auto-promote pending requests past their due_date to 'overdue'.
 */
async function promoteOverdueRequests(clientId) {
    const today = new Date().toISOString().slice(0, 10);

    const { error } = await supabase
        .from('dc_document_requests')
        .update({ status: 'overdue', updated_at: new Date().toISOString() })
        .eq('client_id', clientId)
        .eq('status', 'pending')
        .not('due_date', 'is', null)
        .lt('due_date', today);

    if (error) throw error;
}

// ─── DC Reminders ─────────────────────────────────────────────────────────────

async function logReminder(clientId, { requestId, channel, recipient, subject, body, status, errorMessage }) {
    const { error } = await supabase
        .from('dc_reminders')
        .insert({
            client_id:     clientId,
            request_id:    requestId,
            channel,
            recipient,
            subject:       subject || null,
            body,
            sent_at:       new Date().toISOString(),
            status:        status || 'sent',
            error_message: errorMessage || null,
        });

    if (error) throw error;
}

async function getRemindersForRequest(requestId) {
    const { data, error } = await supabase
        .from('dc_reminders')
        .select('*')
        .eq('request_id', requestId)
        .order('sent_at', { ascending: false });

    if (error) throw error;
    return data || [];
}

// ─── DC Weekly Reports ────────────────────────────────────────────────────────

async function saveWeeklyReport(clientId, { reportDate, totalRequests, receivedCount, pendingCount, overdueCount, reportData }) {
    const { data, error } = await supabase
        .from('dc_weekly_reports')
        .insert({
            client_id:      clientId,
            report_date:    reportDate,
            total_requests: totalRequests,
            received_count: receivedCount,
            pending_count:  pendingCount,
            overdue_count:  overdueCount,
            report_data:    reportData || null,
        })
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function getWeeklyReports(clientId, limit = 12) {
    const { data, error } = await supabase
        .from('dc_weekly_reports')
        .select('*')
        .eq('client_id', clientId)
        .order('report_date', { ascending: false })
        .limit(limit);

    if (error) throw error;
    return data || [];
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    // Clients
    getClient,
    getAllClients,
    upsertClient,

    // Document requests
    getDocumentRequests,
    getDocumentRequest,
    getPendingAndOverdueRequests,
    upsertDocumentRequest,
    updateRequestStatus,
    markRequestReceived,
    markRequestOverdue,
    incrementReminderCount,
    markReceivedByTaxdomeId,
    promoteOverdueRequests,

    // Reminders
    logReminder,
    getRemindersForRequest,

    // Weekly reports
    saveWeeklyReport,
    getWeeklyReports,
};
