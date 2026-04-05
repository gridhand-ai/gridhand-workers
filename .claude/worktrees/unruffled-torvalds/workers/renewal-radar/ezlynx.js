// ============================================================
// EZLynx API Integration — Renewal Radar
// Connects to EZLynx Rating Engine + AMS (Agency Mgmt System)
//
// Env vars (or per-client config):
//   EZLYNX_BASE_URL       — e.g. https://api.ezlynx.com/v1
//   EZLYNX_API_KEY        — API key from EZLynx portal
//   EZLYNX_AGENCY_ID      — Your agency's EZLynx ID
// ============================================================

'use strict';

const axios = require('axios');

const DEFAULT_BASE_URL = 'https://api.ezlynx.com/v1';
const RENEWAL_LOOKAHEAD_DAYS = 60;

// ─── Client Factory ─────────────────────────────────────────

function createClient(config = {}) {
    const baseURL   = config.baseUrl   || process.env.EZLYNX_BASE_URL   || DEFAULT_BASE_URL;
    const apiKey    = config.apiKey    || process.env.EZLYNX_API_KEY;
    const agencyId  = config.agencyId  || process.env.EZLYNX_AGENCY_ID;

    if (!apiKey)   throw new Error('[EZLynx] Missing API key. Set EZLYNX_API_KEY or pass config.apiKey.');
    if (!agencyId) throw new Error('[EZLynx] Missing agency ID. Set EZLYNX_AGENCY_ID or pass config.agencyId.');

    const http = axios.create({
        baseURL,
        timeout: 30000,
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'X-Agency-Id':   agencyId,
            'Content-Type':  'application/json',
            'Accept':        'application/json',
        },
    });

    // Request logger
    http.interceptors.request.use(req => {
        console.log(`[EZLynx] ${req.method?.toUpperCase()} ${req.baseURL}${req.url}`);
        return req;
    });

    // Response error handler
    http.interceptors.response.use(
        res => res,
        err => {
            const status = err.response?.status;
            const detail = err.response?.data?.message || err.message;
            console.error(`[EZLynx] Error ${status}: ${detail}`);
            throw new EZLynxError(`EZLynx API error ${status}: ${detail}`, status, err.response?.data);
        }
    );

    return http;
}

class EZLynxError extends Error {
    constructor(message, statusCode, data) {
        super(message);
        this.name = 'EZLynxError';
        this.statusCode = statusCode;
        this.data = data;
    }
}

// ─── Policy Methods ──────────────────────────────────────────

/**
 * Fetch all active policies for the agency.
 * Handles pagination automatically.
 * @returns {Policy[]}
 */
async function getPolicies(config = {}, { status = 'active', pageSize = 100 } = {}) {
    const http = createClient(config);
    const policies = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        const res = await http.get('/policies', {
            params: { status, page, pageSize }
        });

        const { data, pagination } = res.data;
        policies.push(...(data || []));

        if (pagination && page < pagination.totalPages) {
            page++;
        } else {
            hasMore = false;
        }
    }

    console.log(`[EZLynx] Fetched ${policies.length} ${status} policies`);
    return policies.map(normalizePolicy);
}

/**
 * Get a single policy with full coverage details.
 */
async function getPolicyDetails(config = {}, policyId) {
    const http = createClient(config);
    const res = await http.get(`/policies/${policyId}`);
    return normalizePolicy(res.data);
}

/**
 * Get all policies expiring within the next N days.
 * Uses EZLynx's built-in expiration filter.
 */
async function getUpcomingRenewals(config = {}, daysAhead = RENEWAL_LOOKAHEAD_DAYS) {
    const http = createClient(config);
    const today = new Date();
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() + daysAhead);

    const fromDate = formatDate(today);
    const toDate   = formatDate(cutoff);

    const policies = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        const res = await http.get('/policies', {
            params: {
                status: 'active',
                expirationFrom: fromDate,
                expirationTo: toDate,
                page,
                pageSize: 100,
            }
        });

        const { data, pagination } = res.data;
        policies.push(...(data || []));

        if (pagination && page < pagination.totalPages) {
            page++;
        } else {
            hasMore = false;
        }
    }

    console.log(`[EZLynx] Found ${policies.length} policies renewing in next ${daysAhead} days`);
    return policies.map(normalizePolicy);
}

/**
 * Get the current rated premium for a policy.
 * Uses EZLynx's Rating Engine API.
 */
async function getCurrentRate(config = {}, policyId) {
    const http = createClient(config);

    try {
        const res = await http.get(`/policies/${policyId}/rate`);
        return {
            policyId,
            annualPremium:  res.data.annualPremium  || null,
            monthlyPremium: res.data.monthlyPremium || null,
            ratedAt:        res.data.ratedAt        || new Date().toISOString(),
            carrier:        res.data.carrier        || null,
            coverages:      res.data.coverages      || [],
        };
    } catch (err) {
        console.warn(`[EZLynx] Could not fetch rate for policy ${policyId}: ${err.message}`);
        return { policyId, annualPremium: null, monthlyPremium: null, error: err.message };
    }
}

/**
 * Fetch the full application/risk data for a policy.
 * Used as input to carrier rating APIs.
 */
async function getPolicyRiskData(config = {}, policyId) {
    const http = createClient(config);
    const res = await http.get(`/policies/${policyId}/risk`);
    return res.data;
}

/**
 * Get customer/insured details by EZLynx customer ID.
 */
async function getCustomer(config = {}, customerId) {
    const http = createClient(config);
    const res = await http.get(`/customers/${customerId}`);
    return normalizeCustomer(res.data);
}

/**
 * Search customers by name or email.
 */
async function searchCustomers(config = {}, query) {
    const http = createClient(config);
    const res = await http.get('/customers/search', { params: { q: query } });
    return (res.data.data || []).map(normalizeCustomer);
}

// ─── Rate Comparison via EZLynx Rating Engine ─────────────────

/**
 * Submit a policy for comparative rating through EZLynx's
 * built-in multi-carrier rating engine. Returns quotes from
 * all carriers connected to the agency's EZLynx account.
 */
async function getComparativeRates(config = {}, policyId) {
    const http = createClient(config);

    // Step 1: Get the risk data to rate
    const riskData = await getPolicyRiskData(config, policyId);

    // Step 2: Submit rating request
    const res = await http.post('/rating/comparative', {
        policyId,
        riskData,
        requestId: `rr_${policyId}_${Date.now()}`,
    });

    const ratingJobId = res.data.jobId;
    console.log(`[EZLynx] Comparative rating job ${ratingJobId} submitted for policy ${policyId}`);

    // Step 3: Poll for results (EZLynx rating is async)
    return await pollRatingResults(http, ratingJobId);
}

async function pollRatingResults(http, jobId, maxAttempts = 12, intervalMs = 5000) {
    for (let i = 0; i < maxAttempts; i++) {
        await sleep(i === 0 ? 2000 : intervalMs);

        const res = await http.get(`/rating/jobs/${jobId}`);
        const { status, results, error } = res.data;

        if (status === 'completed') {
            console.log(`[EZLynx] Rating job ${jobId} completed with ${results?.length || 0} quotes`);
            return (results || []).map(normalizeCarrierQuote);
        }

        if (status === 'failed') {
            throw new EZLynxError(`EZLynx rating job failed: ${error}`, 500, res.data);
        }

        console.log(`[EZLynx] Rating job ${jobId} status: ${status} (attempt ${i + 1}/${maxAttempts})`);
    }

    throw new EZLynxError(`EZLynx rating job ${jobId} timed out`, 504, { jobId });
}

// ─── Normalizers ─────────────────────────────────────────────

function normalizePolicy(raw) {
    return {
        ezlynxPolicyId:   raw.id          || raw.policyId,
        ezlynxCustomerId: raw.customerId  || raw.accountId,
        policyNumber:     raw.policyNumber,
        carrier:          raw.carrier     || raw.carrierName,
        lineOfBusiness:   raw.lineOfBusiness || raw.lob || 'unknown',
        status:           raw.status?.toLowerCase() || 'active',
        insuredName:      raw.insuredName || raw.namedInsured || raw.customerName,
        insuredEmail:     raw.insuredEmail || raw.email,
        insuredPhone:     raw.insuredPhone || raw.phone,
        effectiveDate:    raw.effectiveDate || raw.inceptionDate,
        expirationDate:   raw.expirationDate || raw.renewalDate,
        annualPremium:    parseFloat(raw.annualPremium  || raw.premium || 0),
        monthlyPremium:   parseFloat(raw.monthlyPremium || 0) || parseFloat(raw.annualPremium || 0) / 12,
        coverageSummary: {
            deductible:     raw.deductible,
            liability:      raw.liability,
            comprehensive:  raw.comprehensive,
            collision:      raw.collision,
            endorsements:   raw.endorsements || [],
        },
        rawData: raw,
    };
}

function normalizeCustomer(raw) {
    return {
        customerId:  raw.id || raw.customerId,
        name:        raw.name || raw.fullName || `${raw.firstName || ''} ${raw.lastName || ''}`.trim(),
        email:       raw.email,
        phone:       raw.phone || raw.mobilePhone,
        address:     raw.address,
        rawData:     raw,
    };
}

function normalizeCarrierQuote(raw) {
    return {
        carrier:       raw.carrier || raw.carrierName,
        carrierCode:   raw.carrierCode,
        quoteNumber:   raw.quoteNumber,
        annualPremium: parseFloat(raw.annualPremium || raw.premium || 0),
        monthlyPremium: parseFloat(raw.monthlyPremium || 0) || parseFloat(raw.annualPremium || 0) / 12,
        status:        raw.status || 'success',
        errorMessage:  raw.error || raw.errorMessage,
        coverageMatch: raw.coverageMatch || 1.0,
        expiresAt:     raw.expiresAt || raw.quoteExpiration,
        rawQuote:      raw,
    };
}

// ─── Utilities ───────────────────────────────────────────────

function formatDate(date) {
    return date.toISOString().split('T')[0];
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Exports ─────────────────────────────────────────────────

module.exports = {
    getPolicies,
    getPolicyDetails,
    getUpcomingRenewals,
    getCurrentRate,
    getPolicyRiskData,
    getCustomer,
    searchCustomers,
    getComparativeRates,
    EZLynxError,
    RENEWAL_LOOKAHEAD_DAYS,
};
