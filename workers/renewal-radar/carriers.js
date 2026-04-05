// ============================================================
// Multi-Carrier Quote Comparison Engine — Renewal Radar
//
// Pulls quotes from carrier APIs directly (supplementing EZLynx).
// Each carrier adapter is isolated — adding a new carrier is
// just adding a new entry to CARRIER_REGISTRY.
//
// Supported carriers:
//   Progressive, Travelers, Nationwide, Safeco, Hartford,
//   Allstate, Cincinnati, Employers, Markel, AmTrust
// ============================================================

'use strict';

const axios = require('axios');

// ─── Carrier Registry ────────────────────────────────────────
// Each entry defines how to query that carrier's rating API.
// Env vars are the fallback; per-client config takes priority.

const CARRIER_REGISTRY = {
    progressive: {
        name:       'Progressive',
        code:       'PROG',
        lobs:       ['auto', 'commercial_auto', 'home'],
        baseUrl:    process.env.PROGRESSIVE_API_URL || 'https://api.progressive.com/v2',
        authHeader: () => `Bearer ${process.env.PROGRESSIVE_API_KEY}`,
        getQuote:   getProgressiveQuote,
    },
    travelers: {
        name:       'Travelers',
        code:       'TRAV',
        lobs:       ['home', 'auto', 'commercial'],
        baseUrl:    process.env.TRAVELERS_API_URL || 'https://api.travelers.com/rating/v1',
        authHeader: () => `ApiKey ${process.env.TRAVELERS_API_KEY}`,
        getQuote:   getTravelersQuote,
    },
    nationwide: {
        name:       'Nationwide',
        code:       'NWIDE',
        lobs:       ['auto', 'home', 'life', 'commercial'],
        baseUrl:    process.env.NATIONWIDE_API_URL || 'https://api.nationwide.com/v1',
        authHeader: () => `Bearer ${process.env.NATIONWIDE_API_KEY}`,
        getQuote:   getNationwideQuote,
    },
    safeco: {
        name:       'Safeco (Liberty Mutual)',
        code:       'SAFE',
        lobs:       ['auto', 'home'],
        baseUrl:    process.env.SAFECO_API_URL || 'https://api.safeco.com/rating/v1',
        authHeader: () => `Bearer ${process.env.SAFECO_API_KEY}`,
        getQuote:   getSafecoQuote,
    },
    hartford: {
        name:       'The Hartford',
        code:       'HART',
        lobs:       ['commercial', 'workers_comp', 'auto'],
        baseUrl:    process.env.HARTFORD_API_URL || 'https://api.thehartford.com/v1',
        authHeader: () => `Bearer ${process.env.HARTFORD_API_KEY}`,
        getQuote:   getHartfordQuote,
    },
    cincinnati: {
        name:       'Cincinnati Financial',
        code:       'CIN',
        lobs:       ['home', 'commercial', 'auto'],
        baseUrl:    process.env.CINCINNATI_API_URL || 'https://api.cinfin.com/rating/v1',
        authHeader: () => `ApiKey ${process.env.CINCINNATI_API_KEY}`,
        getQuote:   getCincinnatiQuote,
    },
    employers: {
        name:       'Employers Holdings',
        code:       'EMPL',
        lobs:       ['workers_comp', 'commercial'],
        baseUrl:    process.env.EMPLOYERS_API_URL || 'https://api.employers.com/v1',
        authHeader: () => `Bearer ${process.env.EMPLOYERS_API_KEY}`,
        getQuote:   getEmployersQuote,
    },
    markel: {
        name:       'Markel',
        code:       'MRKL',
        lobs:       ['commercial', 'specialty', 'professional_liability'],
        baseUrl:    process.env.MARKEL_API_URL || 'https://api.markel.com/rating/v1',
        authHeader: () => `Bearer ${process.env.MARKEL_API_KEY}`,
        getQuote:   getMarkelQuote,
    },
};

// ─── Main Comparison Engine ──────────────────────────────────

/**
 * Pull quotes from all carriers that support this line of business.
 * Returns sorted array with best rate first.
 *
 * @param {Object} policy  — Normalized policy from ezlynx.js
 * @param {Object} options — { carriers: ['progressive', ...], timeout: 20000 }
 * @returns {ComparisonResult}
 */
async function compareCarrierRates(policy, options = {}) {
    const lob = policy.lineOfBusiness?.toLowerCase();
    const requestedCarriers = options.carriers || getCompatibleCarriers(lob);
    const timeoutMs = options.timeout || 20000;

    console.log(`[Carriers] Pulling quotes for policy ${policy.policyNumber} (${lob}) from ${requestedCarriers.length} carriers`);

    // Fire all carrier requests in parallel with per-carrier timeout
    const quotePromises = requestedCarriers.map(carrierKey => {
        const carrier = CARRIER_REGISTRY[carrierKey];
        if (!carrier) {
            return Promise.resolve(errorQuote(carrierKey, 'Unknown carrier'));
        }

        return withTimeout(
            fetchCarrierQuote(carrier, policy),
            timeoutMs,
            `${carrier.name} timed out after ${timeoutMs}ms`
        ).catch(err => errorQuote(carrierKey, err.message, carrier.name));
    });

    const results = await Promise.allSettled(quotePromises);
    const quotes = results.map((r, i) =>
        r.status === 'fulfilled' ? r.value : errorQuote(requestedCarriers[i], r.reason?.message)
    );

    const successful = quotes.filter(q => q.status === 'success' && q.annualPremium > 0);
    const failed     = quotes.filter(q => q.status !== 'success');

    // Sort by annual premium ascending
    successful.sort((a, b) => a.annualPremium - b.annualPremium);

    const bestQuote  = successful[0] || null;
    const savings    = bestQuote && policy.annualPremium > 0
        ? policy.annualPremium - bestQuote.annualPremium
        : 0;

    console.log(`[Carriers] ${successful.length} quotes returned. Best: ${bestQuote?.carrier} at $${bestQuote?.annualPremium}/yr`);

    return {
        policyId:        policy.ezlynxPolicyId,
        policyNumber:    policy.policyNumber,
        currentCarrier:  policy.carrier,
        currentPremium:  policy.annualPremium,
        quotes:          successful,
        failed,
        bestQuote,
        savingsPotential:  Math.max(0, savings),
        hasBetterRate:     savings > 0,
        pulledAt:          new Date().toISOString(),
    };
}

/**
 * Return carrier keys that support the given line of business.
 */
function getCompatibleCarriers(lob) {
    return Object.entries(CARRIER_REGISTRY)
        .filter(([, c]) => !lob || c.lobs.includes(lob) || c.lobs.includes('commercial'))
        .map(([key]) => key);
}

// ─── Generic Quote Fetcher ────────────────────────────────────

async function fetchCarrierQuote(carrierDef, policy) {
    try {
        const quote = await carrierDef.getQuote(policy, carrierDef);
        return {
            carrier:       carrierDef.name,
            carrierCode:   carrierDef.code,
            carrierKey:    Object.keys(CARRIER_REGISTRY).find(k => CARRIER_REGISTRY[k] === carrierDef),
            status:        'success',
            annualPremium: parseFloat(quote.annualPremium || 0),
            monthlyPremium: parseFloat(quote.monthlyPremium || 0) || parseFloat(quote.annualPremium || 0) / 12,
            quoteNumber:   quote.quoteNumber || null,
            coverageMatch: quote.coverageMatch || 1.0,
            expiresAt:     quote.expiresAt || null,
            notes:         quote.notes || null,
            rawQuote:      quote,
        };
    } catch (err) {
        throw new Error(`${carrierDef.name}: ${err.message}`);
    }
}

// ─── Carrier-Specific Adapters ────────────────────────────────
// Each function receives the normalized policy and carrier def.
// Real implementations should map policy fields to carrier's schema.

async function getProgressiveQuote(policy, carrier) {
    const http = carrierHttp(carrier);
    const payload = buildStandardPayload(policy);
    const res = await http.post('/quotes/auto', payload);
    return {
        annualPremium: res.data.totalAnnualPremium,
        quoteNumber:   res.data.quoteId,
        coverageMatch: res.data.coverageMatchScore || 0.95,
        expiresAt:     res.data.quoteExpirationDate,
    };
}

async function getTravelersQuote(policy, carrier) {
    const http = carrierHttp(carrier);
    const lob = mapLOB(policy.lineOfBusiness, 'travelers');
    const res = await http.post(`/${lob}/rate`, buildStandardPayload(policy));
    return {
        annualPremium: res.data.premium?.annual,
        quoteNumber:   res.data.referenceId,
        coverageMatch: 0.97,
        expiresAt:     res.data.validUntil,
    };
}

async function getNationwideQuote(policy, carrier) {
    const http = carrierHttp(carrier);
    const res = await http.post('/quotes', {
        ...buildStandardPayload(policy),
        agencyCode: process.env.NATIONWIDE_AGENCY_CODE,
    });
    return {
        annualPremium: res.data.annualizedPremium,
        quoteNumber:   res.data.quoteNumber,
        coverageMatch: res.data.coverageScore || 0.93,
        expiresAt:     res.data.expiration,
    };
}

async function getSafecoQuote(policy, carrier) {
    const http = carrierHttp(carrier);
    const res = await http.post('/rate', buildStandardPayload(policy));
    return {
        annualPremium: res.data.totalPremium,
        quoteNumber:   res.data.quoteId,
        coverageMatch: 0.96,
        expiresAt:     res.data.quoteExpires,
    };
}

async function getHartfordQuote(policy, carrier) {
    const http = carrierHttp(carrier);
    const res = await http.post('/commercial/quote', buildCommercialPayload(policy));
    return {
        annualPremium: res.data.annualPremium,
        quoteNumber:   res.data.quotationId,
        coverageMatch: 0.94,
        expiresAt:     res.data.quoteExpirationDate,
    };
}

async function getCincinnatiQuote(policy, carrier) {
    const http = carrierHttp(carrier);
    const res = await http.post('/rate/indication', buildStandardPayload(policy));
    return {
        annualPremium: res.data.indicatedPremium,
        quoteNumber:   res.data.submissionId,
        coverageMatch: 0.92,
        expiresAt:     res.data.validThrough,
    };
}

async function getEmployersQuote(policy, carrier) {
    const http = carrierHttp(carrier);
    const res = await http.post('/wc/quote', {
        ...buildStandardPayload(policy),
        payrollData: policy.coverageSummary?.payroll || {},
    });
    return {
        annualPremium: res.data.estimatedAnnualPremium,
        quoteNumber:   res.data.quoteRef,
        coverageMatch: 0.91,
    };
}

async function getMarkelQuote(policy, carrier) {
    const http = carrierHttp(carrier);
    const res = await http.post('/specialty/rate', buildStandardPayload(policy));
    return {
        annualPremium: res.data.totalPremium,
        quoteNumber:   res.data.quoteIdentifier,
        coverageMatch: 0.90,
        expiresAt:     res.data.expirationDate,
    };
}

// ─── Payload Builders ────────────────────────────────────────

function buildStandardPayload(policy) {
    return {
        insuredName:     policy.insuredName,
        policyNumber:    policy.policyNumber,
        effectiveDate:   policy.expirationDate,   // New policy starts on renewal date
        lineOfBusiness:  policy.lineOfBusiness,
        coverages:       policy.coverageSummary,
        currentPremium:  policy.annualPremium,
        currentCarrier:  policy.carrier,
    };
}

function buildCommercialPayload(policy) {
    return {
        ...buildStandardPayload(policy),
        businessInfo: {
            name:      policy.insuredName,
            industry:  policy.coverageSummary?.industry,
            employees: policy.coverageSummary?.employees,
            revenue:   policy.coverageSummary?.revenue,
        },
    };
}

function mapLOB(lob, carrier) {
    const map = {
        travelers: { auto: 'auto', home: 'homeowners', commercial: 'commercial', default: 'personal' },
    };
    return (map[carrier] || {})[lob] || (map[carrier] || {}).default || lob;
}

// ─── Helpers ─────────────────────────────────────────────────

function carrierHttp(carrier) {
    return axios.create({
        baseURL:  carrier.baseUrl,
        timeout:  15000,
        headers: {
            'Authorization': carrier.authHeader(),
            'Content-Type':  'application/json',
            'Accept':        'application/json',
        },
    });
}

function errorQuote(carrierKeyOrName, message, name = null) {
    return {
        carrier:       name || carrierKeyOrName,
        carrierKey:    carrierKeyOrName,
        status:        'failed',
        annualPremium: 0,
        errorMessage:  message,
        rawQuote:      null,
    };
}

function withTimeout(promise, ms, message) {
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(message)), ms)
    );
    return Promise.race([promise, timeout]);
}

/**
 * Format a comparison result into a human-readable summary.
 * Used in agent alerts and client outreach.
 */
function formatComparisonSummary(comparison) {
    const { currentCarrier, currentPremium, quotes, bestQuote, savingsPotential } = comparison;
    const lines = [
        `Current: ${currentCarrier} — $${currentPremium?.toFixed(2)}/yr`,
        '',
        'Top alternatives:',
    ];

    quotes.slice(0, 5).forEach((q, i) => {
        const diff = currentPremium - q.annualPremium;
        const sign = diff > 0 ? `▼ save $${Math.abs(diff).toFixed(0)}/yr` : `▲ +$${Math.abs(diff).toFixed(0)}/yr`;
        lines.push(`  ${i + 1}. ${q.carrier}: $${q.annualPremium.toFixed(2)}/yr (${sign})`);
    });

    if (savingsPotential > 0 && bestQuote) {
        lines.push('');
        lines.push(`Best rate: ${bestQuote.carrier} saves client $${savingsPotential.toFixed(2)}/yr`);
    }

    return lines.join('\n');
}

module.exports = {
    compareCarrierRates,
    getCompatibleCarriers,
    formatComparisonSummary,
    CARRIER_REGISTRY,
};
