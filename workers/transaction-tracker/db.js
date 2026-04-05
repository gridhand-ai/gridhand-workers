/**
 * GRIDHAND Transaction Tracker — Supabase Database Layer
 *
 * Thin wrapper around Supabase client for all DB operations.
 * No business logic here — jobs.js, dotloop.js, and docusign.js stay clean.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Client Settings ──────────────────────────────────────────────────────────

async function getClientSettings(clientSlug) {
    const { data, error } = await supabase
        .from('tt_clients')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllActiveClients() {
    const { data, error } = await supabase
        .from('tt_clients')
        .select('client_slug')
        .eq('active', true);

    if (error) throw error;
    return data || [];
}

async function upsertClientSettings(settings) {
    const { error } = await supabase
        .from('tt_clients')
        .upsert({
            client_slug:          settings.clientSlug,
            agent_name:           settings.agentName,
            agent_phone:          settings.agentPhone,
            dotloop_access_token: settings.dotloopAccessToken || null,
            dotloop_webhook_secret: settings.dotloopWebhookSecret || null,
            docusign_account_id:  settings.docusignAccountId || null,
            docusign_access_token: settings.docusignAccessToken || null,
            docusign_webhook_key: settings.docusignWebhookKey || null,
            docusign_base_url:    settings.docusignBaseUrl || 'https://demo.docusign.net/restapi/v2.1',
            active:               settings.active !== false,
            updated_at:           new Date().toISOString(),
        }, { onConflict: 'client_slug' });

    if (error) throw error;
}

// ─── Transactions ─────────────────────────────────────────────────────────────

async function getTransaction(transactionId) {
    const { data, error } = await supabase
        .from('tt_transactions')
        .select('*')
        .eq('id', transactionId)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getTransactionByLoopId(clientSlug, dotloopLoopId) {
    const { data, error } = await supabase
        .from('tt_transactions')
        .select('*')
        .eq('client_id', clientSlug)
        .eq('dotloop_loop_id', dotloopLoopId)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getTransactionByEnvelopeId(clientSlug, envelopeId) {
    const { data, error } = await supabase
        .from('tt_transactions')
        .select('*')
        .eq('client_id', clientSlug)
        .eq('docusign_envelope_id', envelopeId)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function listTransactions(clientSlug, { status, limit = 50, offset = 0 } = {}) {
    let query = supabase
        .from('tt_transactions')
        .select('*')
        .eq('client_id', clientSlug)
        .order('closing_date', { ascending: true })
        .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

async function getActiveTransactions(clientSlug) {
    const { data, error } = await supabase
        .from('tt_transactions')
        .select('*')
        .eq('client_id', clientSlug)
        .in('status', ['active', 'under_contract', 'closing']);

    if (error) throw error;
    return data || [];
}

async function upsertTransaction(clientSlug, tx) {
    const { data, error } = await supabase
        .from('tt_transactions')
        .upsert({
            id:                   tx.id,
            client_id:            clientSlug,
            dotloop_loop_id:      tx.dotloopLoopId || null,
            docusign_envelope_id: tx.docusignEnvelopeId || null,
            address:              tx.address || null,
            mls_number:           tx.mlsNumber || null,
            type:                 tx.type || 'buy',
            status:               tx.status || 'active',
            closing_date:         tx.closingDate || null,
            contract_date:        tx.contractDate || null,
            list_price:           tx.listPrice || null,
            sale_price:           tx.salePrice || null,
            buyer_name:           tx.buyerName || null,
            buyer_phone:          tx.buyerPhone || null,
            seller_name:          tx.sellerName || null,
            seller_phone:         tx.sellerPhone || null,
            agent_notes:          tx.agentNotes || null,
            raw_data:             tx.rawData || null,
            risk_level:           tx.riskLevel || 'low',
            updated_at:           new Date().toISOString(),
        }, { onConflict: 'id' })
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function updateTransactionStatus(transactionId, status, riskLevel = null) {
    const updates = {
        status,
        updated_at: new Date().toISOString(),
    };
    if (riskLevel) updates.risk_level = riskLevel;

    const { error } = await supabase
        .from('tt_transactions')
        .update(updates)
        .eq('id', transactionId);

    if (error) throw error;
}

async function updateTransactionRisk(transactionId, riskLevel) {
    const { error } = await supabase
        .from('tt_transactions')
        .update({ risk_level: riskLevel, updated_at: new Date().toISOString() })
        .eq('id', transactionId);

    if (error) throw error;
}

// ─── Milestones ───────────────────────────────────────────────────────────────

async function getMilestones(transactionId) {
    const { data, error } = await supabase
        .from('tt_milestones')
        .select('*')
        .eq('transaction_id', transactionId)
        .order('due_date', { ascending: true });

    if (error) throw error;
    return data || [];
}

async function upsertMilestone(transactionId, milestone) {
    const { error } = await supabase
        .from('tt_milestones')
        .upsert({
            id:             milestone.id,
            transaction_id: transactionId,
            name:           milestone.name,
            due_date:       milestone.dueDate || null,
            completed_at:   milestone.completedAt || null,
            required:       milestone.required !== false,
            category:       milestone.category || 'contract',
        }, { onConflict: 'id' });

    if (error) throw error;
}

async function completeMilestone(milestoneId, completedAt = null) {
    const { error } = await supabase
        .from('tt_milestones')
        .update({
            completed_at: completedAt || new Date().toISOString(),
        })
        .eq('id', milestoneId);

    if (error) throw error;
}

// ─── Documents ────────────────────────────────────────────────────────────────

async function getDocuments(transactionId) {
    const { data, error } = await supabase
        .from('tt_documents')
        .select('*')
        .eq('transaction_id', transactionId)
        .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
}

async function upsertDocument(transactionId, doc) {
    const { error } = await supabase
        .from('tt_documents')
        .upsert({
            id:               doc.id,
            transaction_id:   transactionId,
            name:             doc.name,
            required:         doc.required !== false,
            uploaded_at:      doc.uploadedAt || null,
            docusign_status:  doc.docusignStatus || null,
            envelope_id:      doc.envelopeId || null,
            raw_data:         doc.rawData || null,
        }, { onConflict: 'id' });

    if (error) throw error;
}

async function updateDocumentStatus(documentId, status, envelopeId = null) {
    const updates = {
        docusign_status: status,
        uploaded_at:     new Date().toISOString(),
    };
    if (envelopeId) updates.envelope_id = envelopeId;

    const { error } = await supabase
        .from('tt_documents')
        .update(updates)
        .eq('id', documentId);

    if (error) throw error;
}

// ─── Participants ─────────────────────────────────────────────────────────────

async function getParticipants(transactionId) {
    const { data, error } = await supabase
        .from('tt_participants')
        .select('*')
        .eq('transaction_id', transactionId);

    if (error) throw error;
    return data || [];
}

async function upsertParticipant(transactionId, participant) {
    const { error } = await supabase
        .from('tt_participants')
        .upsert({
            id:             participant.id,
            transaction_id: transactionId,
            role:           participant.role,
            name:           participant.name || null,
            phone:          participant.phone || null,
            email:          participant.email || null,
        }, { onConflict: 'id' });

    if (error) throw error;
}

// ─── SMS Log ──────────────────────────────────────────────────────────────────

async function logSms(clientSlug, { transactionId, recipient, messageBody, messageType, twilioSid }) {
    const { error } = await supabase
        .from('tt_sms_log')
        .insert({
            client_id:      clientSlug,
            transaction_id: transactionId || null,
            recipient,
            message_body:   messageBody,
            message_type:   messageType,
            twilio_sid:     twilioSid || null,
        });

    if (error) throw error;
}

// ─── Pipeline Stats ───────────────────────────────────────────────────────────

async function getPipelineStats(clientSlug) {
    const { data, error } = await supabase
        .from('tt_transactions')
        .select('status, closing_date, contract_date, risk_level')
        .eq('client_id', clientSlug)
        .not('status', 'eq', 'cancelled');

    if (error) throw error;
    return data || [];
}

module.exports = {
    getClientSettings,
    getAllActiveClients,
    upsertClientSettings,
    getTransaction,
    getTransactionByLoopId,
    getTransactionByEnvelopeId,
    listTransactions,
    getActiveTransactions,
    upsertTransaction,
    updateTransactionStatus,
    updateTransactionRisk,
    getMilestones,
    upsertMilestone,
    completeMilestone,
    getDocuments,
    upsertDocument,
    updateDocumentStatus,
    getParticipants,
    upsertParticipant,
    logSms,
    getPipelineStats,
};
