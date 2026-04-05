/**
 * GRIDHAND Transaction Tracker — Dotloop Integration
 *
 * Handles all communication with the Dotloop API v2.
 * OAuth bearer token is pulled per-client from tt_clients settings.
 * All functions return { ok, data, error } format.
 */

'use strict';

const axios  = require('axios');
const crypto = require('crypto');
const db     = require('./db');

const DOTLOOP_BASE = 'https://dotloop.com/public/api/v2';

// ─── Core Request Handler ─────────────────────────────────────────────────────

/**
 * Make an authenticated request to the Dotloop API.
 * Token is read from client settings on every call (supports token rotation).
 */
async function dotloopRequest(clientSlug, method, path, data = null) {
    const settings = await db.getClientSettings(clientSlug);
    if (!settings || !settings.dotloop_access_token) {
        return { ok: false, data: null, error: `No Dotloop token configured for ${clientSlug}` };
    }

    const url = `${DOTLOOP_BASE}${path}`;

    try {
        const response = await axios({
            method,
            url,
            data:    data || undefined,
            headers: {
                Authorization:  `Bearer ${settings.dotloop_access_token}`,
                'Content-Type': 'application/json',
                Accept:         'application/json',
            },
            timeout: 15000,
        });

        return { ok: true, data: response.data, error: null };
    } catch (err) {
        const status  = err.response?.status;
        const message = err.response?.data?.message || err.message;
        console.error(`[Dotloop] ${method} ${path} failed (${status}): ${message}`);
        return { ok: false, data: null, error: message };
    }
}

// ─── Loop Operations ──────────────────────────────────────────────────────────

/**
 * Get full loop details including all fields and metadata.
 */
async function getLoop(clientSlug, loopId) {
    return dotloopRequest(clientSlug, 'GET', `/loop-it/profile/me/loop/${loopId}`);
}

/**
 * Get all documents in a loop.
 */
async function getLoopDocuments(clientSlug, loopId) {
    return dotloopRequest(clientSlug, 'GET', `/loop-it/profile/me/loop/${loopId}/document`);
}

/**
 * Get a single document's details and status.
 */
async function getDocument(clientSlug, loopId, documentId) {
    return dotloopRequest(clientSlug, 'GET', `/loop-it/profile/me/loop/${loopId}/document/${documentId}`);
}

/**
 * Get all participants in a loop (buyers, sellers, agents, etc.)
 */
async function getLoopParticipants(clientSlug, loopId) {
    return dotloopRequest(clientSlug, 'GET', `/loop-it/profile/me/loop/${loopId}/participant`);
}

/**
 * Get all active loops for a client profile.
 */
async function getActiveLoops(clientSlug) {
    // Filter by active status — Dotloop uses loop status codes
    // Status 1 = Active, we also include Under Contract (2) and Pending Close (3)
    const result = await dotloopRequest(clientSlug, 'GET', `/loop-it/profile/me/loop?status=ACTIVE&loop_status=1`);
    if (!result.ok) return result;

    // Also fetch under contract loops
    const result2 = await dotloopRequest(clientSlug, 'GET', `/loop-it/profile/me/loop?status=ACTIVE&loop_status=2`);

    const loops1 = result.data?.data || [];
    const loops2 = result2.ok ? (result2.data?.data || []) : [];

    return { ok: true, data: [...loops1, ...loops2], error: null };
}

/**
 * Update loop metadata fields.
 */
async function updateLoopDetail(clientSlug, loopId, updates) {
    return dotloopRequest(clientSlug, 'PATCH', `/loop-it/profile/me/loop/${loopId}`, updates);
}

/**
 * Create an activity (note) on a loop.
 */
async function createActivity(clientSlug, loopId, note) {
    return dotloopRequest(clientSlug, 'POST', `/loop-it/profile/me/loop/${loopId}/activity`, {
        text: note,
    });
}

// ─── Milestone Parsing ────────────────────────────────────────────────────────

/**
 * Extract milestone dates from a Dotloop loop's detail fields.
 * Dotloop stores dates in the loop's `details` section under field keys.
 * Returns array of { name, date, completed, required }.
 */
function parseMilestones(loop) {
    const milestones = [];
    const details    = loop?.details || {};

    // Dotloop standard field mappings for residential transactions
    const fieldMap = [
        { key: 'offer_acceptance_date',      name: 'Offer Accepted',       required: true,  category: 'contract'  },
        { key: 'inspection_period_end',       name: 'Inspection Period',    required: true,  category: 'inspection' },
        { key: 'inspection_response_date',    name: 'Inspection Response',  required: false, category: 'inspection' },
        { key: 'loan_application_date',       name: 'Loan Application',     required: true,  category: 'financing' },
        { key: 'appraisal_ordered_date',      name: 'Appraisal Ordered',    required: false, category: 'financing' },
        { key: 'appraisal_received_date',     name: 'Appraisal Received',   required: false, category: 'financing' },
        { key: 'loan_approval_date',          name: 'Loan Approval',        required: true,  category: 'financing' },
        { key: 'title_search_date',           name: 'Title Search',         required: true,  category: 'title'     },
        { key: 'clear_to_close_date',         name: 'Clear to Close',       required: true,  category: 'closing'   },
        { key: 'final_walkthrough_date',      name: 'Final Walkthrough',    required: false, category: 'closing'   },
        { key: 'closing_date',                name: 'Closing',              required: true,  category: 'closing'   },
    ];

    // Parse from details fields (Dotloop returns detail values as array of field objects)
    const fieldValues = {};
    if (Array.isArray(details)) {
        for (const section of details) {
            if (Array.isArray(section.fields)) {
                for (const field of section.fields) {
                    if (field.key && field.value) {
                        fieldValues[field.key] = field.value;
                    }
                }
            }
        }
    }

    // Also check top-level loop fields
    const topLevel = {
        closing_date:            loop.closing_date || loop.closingDate,
        offer_acceptance_date:   loop.contractDate || loop.contract_date,
        inspection_period_end:   loop.inspectionPeriodEnd,
        loan_approval_date:      loop.loanApprovalDate,
    };

    for (const def of fieldMap) {
        const date = fieldValues[def.key] || topLevel[def.key] || null;
        milestones.push({
            name:      def.name,
            date:      date || null,
            completed: date ? new Date(date) < new Date() : false,
            required:  def.required,
            category:  def.category,
        });
    }

    return milestones;
}

// ─── Webhook Signature Verification ──────────────────────────────────────────

/**
 * Verify the X-Dotloop-Signature header using HMAC-SHA256.
 * @param {string|Buffer} body — raw request body
 * @param {string} sig — value of X-Dotloop-Signature header
 * @param {string} secret — webhook secret from client settings
 */
function verifyWebhookSignature(body, sig, secret) {
    if (!secret || !sig) return false;

    try {
        const rawBody = typeof body === 'string' ? body : body.toString('utf8');
        const expected = crypto
            .createHmac('sha256', secret)
            .update(rawBody)
            .digest('hex');

        // Use timingSafeEqual to prevent timing attacks
        const expectedBuf = Buffer.from(expected, 'hex');
        const sigBuf      = Buffer.from(sig.replace(/^sha256=/, ''), 'hex');

        if (expectedBuf.length !== sigBuf.length) return false;
        return crypto.timingSafeEqual(expectedBuf, sigBuf);
    } catch (err) {
        console.error('[Dotloop] Signature verification error:', err.message);
        return false;
    }
}

module.exports = {
    dotloopRequest,
    getLoop,
    getLoopDocuments,
    getDocument,
    getLoopParticipants,
    getActiveLoops,
    updateLoopDetail,
    createActivity,
    parseMilestones,
    verifyWebhookSignature,
};
