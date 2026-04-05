/**
 * GRIDHAND Doc Chaser — TaxDome REST API Integration
 *
 * Base URL: https://app.taxdome.com/api/v1
 * Auth:     Authorization: Bearer {apiKey}
 *
 * All functions return { ok: true, data } or { ok: false, error, status }
 */

'use strict';

const axios = require('axios');

const TAXDOME_BASE = 'https://app.taxdome.com/api/v1';

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

function headers(apiKey) {
    return {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
    };
}

async function taxdomeGet(apiKey, path, params = {}) {
    try {
        const resp = await axios.get(`${TAXDOME_BASE}${path}`, {
            headers: headers(apiKey),
            params,
        });
        return { ok: true, data: resp.data };
    } catch (err) {
        const status = err.response?.status;
        const message = err.response?.data?.message || err.message;
        console.error(`[TaxDome] GET ${path} failed (${status}): ${message}`);
        return { ok: false, error: message, status };
    }
}

async function taxdomePost(apiKey, path, body = {}) {
    try {
        const resp = await axios.post(`${TAXDOME_BASE}${path}`, body, {
            headers: headers(apiKey),
        });
        return { ok: true, data: resp.data };
    } catch (err) {
        const status = err.response?.status;
        const message = err.response?.data?.message || err.message;
        console.error(`[TaxDome] POST ${path} failed (${status}): ${message}`);
        return { ok: false, error: message, status };
    }
}

async function taxdomePatch(apiKey, path, body = {}) {
    try {
        const resp = await axios.patch(`${TAXDOME_BASE}${path}`, body, {
            headers: headers(apiKey),
        });
        return { ok: true, data: resp.data };
    } catch (err) {
        const status = err.response?.status;
        const message = err.response?.data?.message || err.message;
        console.error(`[TaxDome] PATCH ${path} failed (${status}): ${message}`);
        return { ok: false, error: message, status };
    }
}

// ─── Client Operations ────────────────────────────────────────────────────────

/**
 * List all clients for a firm.
 * Supports pagination via params: { page, per_page }
 */
async function getClients(apiKey, firmId, params = {}) {
    return taxdomeGet(apiKey, `/firms/${firmId}/clients`, params);
}

/**
 * Get a single client by ID.
 */
async function getClient(apiKey, clientId) {
    return taxdomeGet(apiKey, `/clients/${clientId}`);
}

// ─── Job Operations ───────────────────────────────────────────────────────────

/**
 * List jobs for the firm. Filter by status (e.g. 'active').
 */
async function getJobs(apiKey, params = {}) {
    return taxdomeGet(apiKey, '/jobs', params);
}

/**
 * Get document requests for a specific job.
 */
async function getJobDocumentRequests(apiKey, jobId) {
    return taxdomeGet(apiKey, `/jobs/${jobId}/document-requests`);
}

// ─── Aggregated: All Pending Document Requests ────────────────────────────────

/**
 * Aggregate all pending/outstanding document requests across all active jobs.
 *
 * Strategy:
 *  1. Fetch all active jobs for the firm
 *  2. For each job, fetch its document requests
 *  3. Filter to requests that are pending/outstanding (not yet uploaded)
 *  4. Enrich with client contact info
 *
 * Returns array of normalized request objects:
 * {
 *   taxdomeClientId, taxdomeJobId, taxdomeRequestId,
 *   clientName, clientEmail, clientPhone,
 *   documentName, documentType, dueDate, status
 * }
 */
async function getAllDocumentRequests(apiKey, firmId) {
    const results = [];

    // Fetch all active jobs
    const jobsResult = await getJobs(apiKey, { status: 'active', per_page: 200 });
    if (!jobsResult.ok) {
        console.error(`[TaxDome] Could not fetch jobs: ${jobsResult.error}`);
        return results;
    }

    const jobs = Array.isArray(jobsResult.data)
        ? jobsResult.data
        : (jobsResult.data?.data || jobsResult.data?.jobs || []);

    console.log(`[TaxDome] Found ${jobs.length} active jobs — checking document requests...`);

    for (const job of jobs) {
        const jobId = job.id || job.jobId;
        if (!jobId) continue;

        const reqResult = await getJobDocumentRequests(apiKey, jobId);
        if (!reqResult.ok) {
            console.warn(`[TaxDome] Could not fetch doc requests for job ${jobId}: ${reqResult.error}`);
            continue;
        }

        const requests = Array.isArray(reqResult.data)
            ? reqResult.data
            : (reqResult.data?.data || reqResult.data?.requests || []);

        for (const req of requests) {
            // Skip already-fulfilled requests
            const reqStatus = (req.status || '').toLowerCase();
            if (['fulfilled', 'completed', 'received', 'uploaded'].includes(reqStatus)) continue;

            // Normalize the request into our internal shape
            results.push({
                taxdomeClientId:  String(req.clientId  || req.client_id  || job.clientId || job.client_id || ''),
                taxdomeJobId:     String(jobId),
                taxdomeRequestId: String(req.id || req.requestId || req.request_id || ''),
                clientName:       req.clientName  || req.client_name  || job.clientName  || job.client_name  || 'Unknown',
                clientEmail:      req.clientEmail || req.client_email || job.clientEmail || job.client_email || null,
                clientPhone:      req.clientPhone || req.client_phone || job.clientPhone || job.client_phone || null,
                documentName:     req.name        || req.documentName || req.document_name || 'Document',
                documentType:     req.type        || req.documentType || req.document_type || null,
                dueDate:          req.dueDate     || req.due_date     || job.dueDate     || job.due_date     || null,
                status:           reqStatus       || 'pending',
            });
        }
    }

    console.log(`[TaxDome] Found ${results.length} outstanding document requests across all jobs`);
    return results;
}

// ─── Mark Document Received ───────────────────────────────────────────────────

/**
 * Mark a document request as fulfilled in TaxDome.
 */
async function markDocumentReceived(apiKey, requestId) {
    return taxdomePatch(apiKey, `/document-requests/${requestId}`, {
        status: 'fulfilled',
    });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    taxdomeGet,
    taxdomePost,
    taxdomePatch,
    getClients,
    getClient,
    getJobs,
    getJobDocumentRequests,
    getAllDocumentRequests,
    markDocumentReceived,
};
