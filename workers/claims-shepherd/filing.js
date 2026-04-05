/**
 * GRIDHAND AI — Claims Shepherd
 * FNOL Filing & Document Management
 *
 * Handles:
 *   - Auto-detection of new claims from SMS, email, and AMS data
 *   - FNOL filing workflow (build → submit → record)
 *   - Document collection requests and tracking
 *   - AI-powered claim parsing from unstructured text
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const carriers = require('./carriers');
const { AMSClient, normalizeHawksoftClaim, normalizeEpicClaim } = require('./ams');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ============================================================
// CLAIM DETECTION — Parse unstructured text into claim data
// ============================================================

const FNOL_KEYWORDS = [
    'accident', 'crash', 'hit', 'collision', 'fire', 'flood', 'theft', 'stolen',
    'break-in', 'vandalism', 'damage', 'totaled', 'injury', 'hurt', 'claim',
    'insurance', 'report', 'loss', 'incident', 'emergency'
];

/**
 * Detect if an incoming SMS is a claim report
 */
function isFNOLText(text) {
    const lower = text.toLowerCase();
    const matchCount = FNOL_KEYWORDS.filter(kw => lower.includes(kw)).length;
    return matchCount >= 2;
}

/**
 * Use Claude to parse claim details from unstructured text (SMS, email body, etc.)
 * Returns structured claim data or null if not parseable.
 */
async function parseClaimFromText(text, anthropicKey) {
    const client = new Anthropic({ apiKey: anthropicKey || process.env.ANTHROPIC_API_KEY });

    const prompt = `Extract insurance claim details from this message. Return ONLY a JSON object with these fields (use null for missing fields):

{
  "policy_number": string or null,
  "insured_name": string or null,
  "insured_phone": string or null,
  "loss_type": "auto" | "property" | "liability" | "workers_comp" | null,
  "loss_date": "YYYY-MM-DD" or null,
  "loss_description": string (summarize the incident),
  "loss_address": string or null,
  "police_report_num": string or null,
  "estimated_damage": number or null,
  "is_claim_report": boolean
}

Message: "${text}"

Return only the JSON, no other text.`;

    try {
        const response = await client.messages.create({
            model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
            max_tokens: 400,
            messages: [{ role: 'user', content: prompt }]
        });

        const raw = response.content[0]?.text?.trim();
        const parsed = JSON.parse(raw);
        return parsed;
    } catch (err) {
        console.error('[Filing] parseClaimFromText error:', err.message);
        return null;
    }
}

/**
 * Parse a claim from an incoming email (subject + body)
 */
async function parseClaimFromEmail(subject, body, anthropicKey) {
    const combined = `Subject: ${subject}\n\nBody:\n${body}`;
    return parseClaimFromText(combined, anthropicKey);
}

// ============================================================
// CLAIM CREATION
// ============================================================

/**
 * Generate a unique internal reference number
 * Format: CS-YYYYMMDD-XXXX
 */
function generateInternalRef() {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const suffix = Math.random().toString(36).substr(2, 4).toUpperCase();
    return `CS-${date}-${suffix}`;
}

/**
 * Create a new claim record in Supabase.
 * @param {string} clientId - UUID of the cs_client
 * @param {object} claimData - Normalized claim fields
 */
async function createClaim(clientId, claimData) {
    const internalRef = generateInternalRef();

    const { data, error } = await supabase
        .from('cs_claims')
        .insert({
            client_id: clientId,
            internal_ref: internalRef,
            status: 'detected',
            ...claimData
        })
        .select()
        .single();

    if (error) {
        console.error('[Filing] createClaim error:', error.message);
        return { ok: false, error: error.message };
    }

    await logEvent(data.id, clientId, 'status_change', {
        message: 'Claim detected and created',
        source: claimData.source
    }, null, 'detected');

    return { ok: true, claim: data };
}

/**
 * Find existing claim by policy number + loss date to avoid duplicates
 */
async function findExistingClaim(clientId, policyNumber, lossDate) {
    const { data } = await supabase
        .from('cs_claims')
        .select('*')
        .eq('client_id', clientId)
        .eq('policy_number', policyNumber)
        .eq('loss_date', lossDate)
        .not('status', 'in', '("closed","denied","paid")')
        .single();

    return data || null;
}

// ============================================================
// FNOL FILING WORKFLOW
// ============================================================

/**
 * Full FNOL filing workflow:
 * 1. Get carrier config from DB
 * 2. Submit FNOL via carriers.js
 * 3. Update claim record
 * 4. Log event
 * 5. Return result for notification
 */
async function fileFNOL(claim, clientConfig) {
    console.log(`[Filing] Filing FNOL for claim ${claim.internal_ref} — Carrier: ${claim.carrier_code}`);

    // Get carrier config for this client
    const { data: carrierConfig } = await supabase
        .from('cs_carrier_configs')
        .select('*')
        .eq('client_id', clientConfig.id)
        .eq('carrier_code', claim.carrier_code)
        .single();

    // Update status to fnol_pending
    await updateClaimStatus(claim.id, clientConfig.id, 'fnol_pending', 'Filing FNOL');

    // Submit to carrier
    const result = await carriers.submitFNOL(claim, carrierConfig);

    if (result.ok) {
        const updates = {
            status: 'fnol_filed',
            fnol_filed_at: new Date().toISOString()
        };

        if (result.claimNumber) {
            updates.claim_number = result.claimNumber;
        }

        if (result.portalUrl) {
            updates.carrier_claim_url = result.portalUrl;
        }

        const { error } = await supabase
            .from('cs_claims')
            .update(updates)
            .eq('id', claim.id);

        if (!error) {
            await logEvent(claim.id, clientConfig.id, 'fnol_filed', {
                method: result.method,
                claimNumber: result.claimNumber,
                note: result.note || ''
            }, 'fnol_pending', 'fnol_filed');
        }
    } else {
        await logEvent(claim.id, clientConfig.id, 'api_error', {
            error: result.error,
            carrier: claim.carrier_code
        });
    }

    return result;
}

/**
 * AMS sync — detect new claims from AMS and create records for untracked ones
 */
async function syncFromAMS(clientConfig) {
    const amsClient = new AMSClient(clientConfig);
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // last 48h

    const result = await amsClient.listRecentClaims(since);
    if (!result.ok) return { ok: false, error: result.error };

    const rawClaims = result.data?.claims || result.data?.items || result.data || [];
    let newCount = 0;

    for (const raw of rawClaims) {
        const normalized = clientConfig.ams_type === 'hawksoft'
            ? normalizeHawksoftClaim(raw)
            : normalizeEpicClaim(raw);

        if (!normalized.policy_number || !normalized.loss_date) continue;

        // Check if we already have this claim
        const existing = await findExistingClaim(clientConfig.id, normalized.policy_number, normalized.loss_date);
        if (existing) continue;

        const createResult = await createClaim(clientConfig.id, normalized);
        if (createResult.ok) newCount++;
    }

    console.log(`[Filing] AMS sync complete — ${newCount} new claims detected`);
    return { ok: true, newClaims: newCount };
}

// ============================================================
// DOCUMENT MANAGEMENT
// ============================================================

const DOCUMENT_REQUIREMENTS = {
    auto: ['photos', 'police_report', 'repair_estimate'],
    property: ['photos', 'police_report', 'repair_estimate', 'proof_of_ownership'],
    liability: ['photos', 'police_report', 'witness_statement', 'medical_records'],
    workers_comp: ['medical_records', 'signed_form', 'police_report']
};

/**
 * Determine which documents are needed for a claim type
 */
function getRequiredDocuments(lossType) {
    return DOCUMENT_REQUIREMENTS[lossType] || ['photos', 'police_report'];
}

/**
 * Create document request records in DB
 */
async function createDocumentRequests(claimId, clientId, lossType) {
    const requiredDocs = getRequiredDocuments(lossType);

    const docRecords = requiredDocs.map(docType => ({
        claim_id: claimId,
        client_id: clientId,
        doc_type: docType,
        doc_name: formatDocName(docType),
        status: 'requested'
    }));

    const { data, error } = await supabase
        .from('cs_claim_documents')
        .insert(docRecords)
        .select();

    if (error) {
        console.error('[Filing] createDocumentRequests error:', error.message);
        return { ok: false, error: error.message };
    }

    return { ok: true, documents: data };
}

function formatDocName(docType) {
    const names = {
        photos: 'Damage Photos',
        police_report: 'Police Report',
        repair_estimate: 'Repair/Damage Estimate',
        medical_records: 'Medical Records',
        receipts: 'Receipts/Invoices',
        witness_statement: 'Witness Statement',
        signed_form: 'Signed Authorization Form',
        proof_of_ownership: 'Proof of Ownership',
        other: 'Supporting Documents'
    };
    return names[docType] || docType;
}

/**
 * Build an SMS message requesting specific documents from the insured
 */
function buildDocumentRequestSMS(claim, missingDocs, agencyName) {
    const docList = missingDocs.map(d => `• ${formatDocName(d)}`).join('\n');
    return `Hi ${claim.insured_name.split(' ')[0]}, this is ${agencyName} regarding your claim (${claim.carrier_name}).

To keep your claim moving, we still need:
${docList}

Please reply with photos or info, or call us if you have questions. Claim ref: ${claim.internal_ref}`;
}

/**
 * Mark a document as received and record the file URL
 */
async function markDocumentReceived(claimId, docType, fileUrl) {
    const { data, error } = await supabase
        .from('cs_claim_documents')
        .update({
            status: 'received',
            received_at: new Date().toISOString(),
            file_url: fileUrl
        })
        .eq('claim_id', claimId)
        .eq('doc_type', docType)
        .eq('status', 'requested')
        .select()
        .single();

    if (error) {
        console.error('[Filing] markDocumentReceived error:', error.message);
        return { ok: false, error: error.message };
    }

    await logEvent(claimId, null, 'document_received', {
        docType,
        fileUrl
    });

    return { ok: true, document: data };
}

/**
 * Get all pending documents for a claim
 */
async function getPendingDocuments(claimId) {
    const { data } = await supabase
        .from('cs_claim_documents')
        .select('*')
        .eq('claim_id', claimId)
        .eq('status', 'requested');

    return data || [];
}

// ============================================================
// CLAIM STATUS UPDATES
// ============================================================

/**
 * Update claim status and log the transition
 */
async function updateClaimStatus(claimId, clientId, newStatus, reason, actor = 'system') {
    // Get current status first
    const { data: current } = await supabase
        .from('cs_claims')
        .select('status, needs_agent_action')
        .eq('id', claimId)
        .single();

    const prevStatus = current?.status;
    if (prevStatus === newStatus) return { ok: true, unchanged: true };

    const updates = { status: newStatus };
    if (newStatus === 'closed' || newStatus === 'paid' || newStatus === 'denied') {
        updates.resolved_at = new Date().toISOString();
    }

    const { error } = await supabase
        .from('cs_claims')
        .update(updates)
        .eq('id', claimId);

    if (error) {
        return { ok: false, error: error.message };
    }

    await logEvent(claimId, clientId, 'status_change', {
        reason: reason || 'Status updated',
        actor
    }, prevStatus, newStatus);

    return { ok: true, prevStatus, newStatus };
}

/**
 * Flag a claim as needing agent action
 */
async function flagForAgentAction(claimId, reason) {
    const { error } = await supabase
        .from('cs_claims')
        .update({ needs_agent_action: true, action_reason: reason })
        .eq('id', claimId);

    return { ok: !error };
}

/**
 * Clear agent action flag
 */
async function clearAgentAction(claimId) {
    const { error } = await supabase
        .from('cs_claims')
        .update({ needs_agent_action: false, action_reason: null })
        .eq('id', claimId);

    return { ok: !error };
}

// ============================================================
// EVENT LOGGING
// ============================================================

async function logEvent(claimId, clientId, eventType, eventData, prevStatus, newStatus, actor = 'system') {
    const record = {
        claim_id: claimId,
        event_type: eventType,
        event_data: eventData || {},
        actor
    };

    if (clientId) record.client_id = clientId;
    if (prevStatus) record.prev_status = prevStatus;
    if (newStatus) record.new_status = newStatus;

    const { error } = await supabase
        .from('cs_claim_events')
        .insert(record);

    if (error) {
        console.error('[Filing] logEvent error:', error.message);
    }
}

// ============================================================
// CLAIM QUERY HELPERS
// ============================================================

async function getClaimByRef(internalRef) {
    const { data } = await supabase
        .from('cs_claims')
        .select('*')
        .eq('internal_ref', internalRef)
        .single();
    return data;
}

async function getClaimsByClient(clientId, statusFilter) {
    let query = supabase.from('cs_claims').select('*').eq('client_id', clientId);
    if (statusFilter) {
        query = query.in('status', statusFilter);
    }
    const { data } = await query.order('created_at', { ascending: false });
    return data || [];
}

async function getOpenClaims(clientId) {
    const { data } = await supabase
        .from('cs_claims')
        .select('*')
        .eq('client_id', clientId)
        .not('status', 'in', '("closed","denied","paid")');
    return data || [];
}

async function getClaimsNeedingAction(clientId) {
    const { data } = await supabase
        .from('cs_claims')
        .select('*')
        .eq('client_id', clientId)
        .eq('needs_agent_action', true);
    return data || [];
}

async function getClaimsByPhone(clientId, phone) {
    const normalized = phone.replace(/\D/g, '');
    const { data } = await supabase
        .from('cs_claims')
        .select('*')
        .eq('client_id', clientId)
        .ilike('insured_phone', `%${normalized}%`)
        .not('status', 'in', '("closed","denied","paid")')
        .order('created_at', { ascending: false })
        .limit(1);
    return data?.[0] || null;
}

module.exports = {
    // Detection
    isFNOLText,
    parseClaimFromText,
    parseClaimFromEmail,
    // Claim CRUD
    createClaim,
    findExistingClaim,
    generateInternalRef,
    // FNOL workflow
    fileFNOL,
    syncFromAMS,
    // Document management
    getRequiredDocuments,
    createDocumentRequests,
    buildDocumentRequestSMS,
    markDocumentReceived,
    getPendingDocuments,
    formatDocName,
    // Status
    updateClaimStatus,
    flagForAgentAction,
    clearAgentAction,
    // Events
    logEvent,
    // Queries
    getClaimByRef,
    getClaimsByClient,
    getOpenClaims,
    getClaimsNeedingAction,
    getClaimsByPhone
};
