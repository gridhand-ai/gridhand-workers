/**
 * GRIDHAND AI — Prior Auth Bot
 * Payer Portal Integration
 *
 * Supported payers:
 *   UnitedHealthcare  — UHC Provider Portal API
 *   Aetna             — Aetna Provider API
 *   Cigna             — Cigna for Health Care Professionals API
 *   Humana            — Humana Provider Portal
 *   BlueCross/BS      — Availity API (BCBS clearinghouse)
 *   Fallback          — X12 278 transaction via clearinghouse
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ============================================================
// PAYER REGISTRY
// ============================================================

const PAYER_REGISTRY = {
    UHC: {
        id: 'UHC',
        name: 'UnitedHealthcare',
        api_type: 'uhc',
        submission_url: 'https://api.uhcprovider.com/v1/prior-auth/submit',
        status_url: 'https://api.uhcprovider.com/v1/prior-auth/status',
        appeal_url: 'https://api.uhcprovider.com/v1/prior-auth/appeal',
        required_fields: ['memberId', 'groupNumber', 'npi', 'procedureCodes', 'diagnosisCodes'],
        avg_turnaround_hours: 72
    },
    AETNA: {
        id: 'AETNA',
        name: 'Aetna',
        api_type: 'aetna',
        submission_url: 'https://api.aetna.com/v1/provider/auth-requests',
        status_url: 'https://api.aetna.com/v1/provider/auth-requests',
        appeal_url: 'https://api.aetna.com/v1/provider/auth-requests/appeal',
        required_fields: ['memberId', 'npi', 'procedureCodes', 'diagnosisCodes'],
        avg_turnaround_hours: 48
    },
    CIGNA: {
        id: 'CIGNA',
        name: 'Cigna',
        api_type: 'cigna',
        submission_url: 'https://api.cigna.com/v1/authorizations',
        status_url: 'https://api.cigna.com/v1/authorizations',
        appeal_url: 'https://api.cigna.com/v1/authorizations/appeal',
        required_fields: ['memberId', 'npi', 'procedureCodes', 'diagnosisCodes', 'requestDate'],
        avg_turnaround_hours: 72
    },
    HUMANA: {
        id: 'HUMANA',
        name: 'Humana',
        api_type: 'humana',
        submission_url: 'https://api.humana.com/v1/provider/prior-auth',
        status_url: 'https://api.humana.com/v1/provider/prior-auth',
        appeal_url: 'https://api.humana.com/v1/provider/prior-auth/appeal',
        required_fields: ['memberId', 'npi', 'procedureCodes', 'diagnosisCodes'],
        avg_turnaround_hours: 96
    },
    BCBS_AVAILITY: {
        id: 'BCBS_AVAILITY',
        name: 'Blue Cross Blue Shield (Availity)',
        api_type: 'availity',
        submission_url: 'https://api.availity.com/availity/v1/coverages/auth',
        status_url: 'https://api.availity.com/availity/v1/coverages/auth',
        appeal_url: 'https://api.availity.com/availity/v1/coverages/auth/appeal',
        required_fields: ['memberId', 'npi', 'procedureCodes', 'diagnosisCodes'],
        avg_turnaround_hours: 72
    },
    ANTHEM: {
        id: 'ANTHEM',
        name: 'Anthem',
        api_type: 'availity',
        submission_url: 'https://api.availity.com/availity/v1/coverages/auth',
        status_url: 'https://api.availity.com/availity/v1/coverages/auth',
        appeal_url: 'https://api.availity.com/availity/v1/coverages/auth/appeal',
        required_fields: ['memberId', 'npi', 'procedureCodes', 'diagnosisCodes'],
        avg_turnaround_hours: 72
    },
    KAISER: {
        id: 'KAISER',
        name: 'Kaiser Permanente',
        api_type: 'x12',
        submission_url: null,
        status_url: null,
        appeal_url: null,
        required_fields: ['memberId', 'npi', 'procedureCodes', 'diagnosisCodes'],
        avg_turnaround_hours: 120
    },
    MEDICAID: {
        id: 'MEDICAID',
        name: 'Medicaid',
        api_type: 'x12',
        submission_url: null,
        status_url: null,
        appeal_url: null,
        required_fields: ['memberId', 'npi', 'procedureCodes', 'diagnosisCodes'],
        avg_turnaround_hours: 120
    },
    MEDICARE: {
        id: 'MEDICARE',
        name: 'Medicare',
        api_type: 'x12',
        submission_url: null,
        status_url: null,
        appeal_url: null,
        required_fields: ['memberId', 'npi', 'procedureCodes', 'diagnosisCodes'],
        avg_turnaround_hours: 72
    },
    MOLINA: {
        id: 'MOLINA',
        name: 'Molina Healthcare',
        api_type: 'x12',
        submission_url: null,
        status_url: null,
        appeal_url: null,
        required_fields: ['memberId', 'npi', 'procedureCodes', 'diagnosisCodes'],
        avg_turnaround_hours: 96
    }
};

// Procedure codes that always require prior auth
const AUTH_REQUIRED_CODES = new Set([
    // Surgery
    '27447', '27130', '22612', '63047', '29827', '29881', '29882', '29883',
    // Imaging
    '70553', '70551', '71275', '74177', '74178', '74183', '72141', '72148',
    // Cardiology
    '93306', '93307', '93308', '93320', '93325',
    // Oncology infusion
    '96413', '96415', '96416', '96417',
    // Durable medical equipment
    'E0601', 'E0570', 'K0606',
    // Home health
    'G0151', 'G0152', 'G0153', 'G0154',
    // Skilled nursing
    'S9123', 'S9124',
    // Physical/occupational therapy (extended)
    '97110', '97530', '97535',
    // Sleep study
    '95810', '95811',
    // Genetic testing
    '81162', '81215', '81216'
]);

// ============================================================
// PUBLIC API
// ============================================================

function getPayerById(payerId) {
    return PAYER_REGISTRY[payerId] || null;
}

function listPayers() {
    return Object.values(PAYER_REGISTRY).map(p => ({
        id: p.id,
        name: p.name,
        api_type: p.api_type,
        avg_turnaround_hours: p.avg_turnaround_hours
    }));
}

function isAuthRequired(procedureCode) {
    return AUTH_REQUIRED_CODES.has(procedureCode);
}

/**
 * Load payer credentials for a client from Supabase.
 * Payer API keys are stored in an env-prefixed pattern or per-client config.
 */
async function getPayerCredentials(clientSlug, payerId) {
    // Fall back to global env variables per payer
    const envPrefix = payerId.replace(/[^A-Z0-9]/g, '_');
    return {
        clientId: process.env[`PAYER_${envPrefix}_CLIENT_ID`] || null,
        clientSecret: process.env[`PAYER_${envPrefix}_CLIENT_SECRET`] || null,
        apiKey: process.env[`PAYER_${envPrefix}_API_KEY`] || null
    };
}

async function getBearerToken(payerId, clientSlug) {
    const payer = PAYER_REGISTRY[payerId];
    if (!payer) return null;

    const creds = await getPayerCredentials(clientSlug, payerId);
    if (!creds.clientId || !creds.clientSecret) return null;

    // Most payer APIs use OAuth2 client_credentials
    const tokenUrl = `https://api.${payer.name.toLowerCase().replace(/ /g, '')}.com/oauth2/token`;

    try {
        const response = await axios.post(tokenUrl,
            new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: creds.clientId,
                client_secret: creds.clientSecret,
                scope: 'prior-auth'
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        return response.data.access_token;
    } catch (err) {
        console.error(`[Payers] Token fetch failed for ${payerId}:`, err.message);
        return null;
    }
}

// ============================================================
// SUBMISSION
// ============================================================

/**
 * submitAuthRequest(clientSlug, payerId, authRequest)
 *
 * authRequest: {
 *   patientDOB, memberId, groupNumber, npi,
 *   procedureCodes, diagnosisCodes,
 *   requestDate, urgency, clinicalNotes
 * }
 *
 * Returns: { referenceNumber, status, estimatedDecisionDate }
 */
async function submitAuthRequest(clientSlug, payerId, authRequest) {
    const payer = getPayerById(payerId);
    if (!payer) {
        return { ok: false, error: `Unknown payer: ${payerId}` };
    }

    // X12 fallback for unsupported payers
    if (payer.api_type === 'x12' || !payer.submission_url) {
        return submitViaX12Clearinghouse(clientSlug, payerId, authRequest);
    }

    try {
        const token = await getBearerToken(payerId, clientSlug);
        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json'
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const payload = buildPayerPayload(payer.api_type, authRequest, clientSlug);
        const response = await axios.post(payer.submission_url, payload, { headers });

        return parseSubmissionResponse(payer.api_type, response.data, payer);
    } catch (err) {
        console.error(`[Payers] Submit error for ${payerId}:`, err.message);

        // If payer API fails, fall back to X12
        console.log(`[Payers] Falling back to X12 clearinghouse for ${payerId}`);
        return submitViaX12Clearinghouse(clientSlug, payerId, authRequest);
    }
}

function buildPayerPayload(apiType, authRequest, clientSlug) {
    const base = {
        memberId: authRequest.memberId,
        memberDateOfBirth: authRequest.patientDOB,
        groupNumber: authRequest.groupNumber,
        renderingNpi: authRequest.npi,
        procedureCodes: authRequest.procedureCodes,
        diagnosisCodes: authRequest.diagnosisCodes,
        serviceRequestDate: authRequest.requestDate || dayjs().format('YYYY-MM-DD'),
        urgency: authRequest.urgency || 'routine',
        clinicalNotes: authRequest.clinicalNotes
    };

    if (apiType === 'availity') {
        return {
            ...base,
            providerNpi: authRequest.npi,
            serviceTypeCode: '42',  // Home Health Care
            requestType: 'HS'       // Health Services Review
        };
    }

    if (apiType === 'uhc') {
        return {
            ...base,
            reviewType: authRequest.urgency === 'emergent' ? 'URGENT' : 'STANDARD',
            requestingProvider: { npi: authRequest.npi }
        };
    }

    return base;
}

function parseSubmissionResponse(apiType, data, payer) {
    const estimatedDate = dayjs().add(payer.avg_turnaround_hours, 'hour').format('YYYY-MM-DD');

    if (apiType === 'uhc') {
        return {
            ok: true,
            referenceNumber: data.priorAuthorizationNumber || data.referenceNumber,
            status: 'pending',
            estimatedDecisionDate: data.expectedDecisionDate || estimatedDate
        };
    }
    if (apiType === 'aetna') {
        return {
            ok: true,
            referenceNumber: data.authorizationId || data.requestId,
            status: mapPayerStatus(apiType, data.statusCode),
            estimatedDecisionDate: data.estimatedDecisionDate || estimatedDate
        };
    }
    if (apiType === 'availity') {
        return {
            ok: true,
            referenceNumber: data.requestId || data.id,
            status: mapPayerStatus(apiType, data.statusCode),
            estimatedDecisionDate: data.expectedDecisionDate || estimatedDate
        };
    }

    // Generic
    return {
        ok: true,
        referenceNumber: data.referenceNumber || data.requestId || data.id,
        status: 'pending',
        estimatedDecisionDate: estimatedDate
    };
}

// ============================================================
// STATUS CHECK
// ============================================================

/**
 * checkAuthStatus(clientSlug, payerId, referenceNumber)
 * Returns: { status, authNumber, denialReason, expirationDate }
 */
async function checkAuthStatus(clientSlug, payerId, referenceNumber) {
    const payer = getPayerById(payerId);
    if (!payer) return { ok: false, error: `Unknown payer: ${payerId}` };

    if (payer.api_type === 'x12' || !payer.status_url) {
        // X12 status check goes through clearinghouse — return pending until manual update
        return { ok: true, status: 'pending', authNumber: null, denialReason: null, expirationDate: null };
    }

    try {
        const token = await getBearerToken(payerId, clientSlug);
        const headers = { Accept: 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const response = await axios.get(`${payer.status_url}/${referenceNumber}`, { headers });
        return parseStatusResponse(payer.api_type, response.data);
    } catch (err) {
        console.error(`[Payers] Status check error for ${payerId}/${referenceNumber}:`, err.message);
        return { ok: false, error: err.message };
    }
}

function mapPayerStatus(apiType, rawStatus) {
    if (!rawStatus) return 'pending';
    const s = String(rawStatus).toUpperCase();

    const approvedCodes = ['APPROVED', 'AUTH_APPROVED', 'A1', 'A4', 'A3', 'CERTIFIED'];
    const deniedCodes = ['DENIED', 'AUTH_DENIED', 'A6', 'A5', 'NOT_CERTIFIED', 'NON_COVERED'];
    const moreCodes = ['PEND', 'PENDING_INFO', 'A7', 'MORE_INFO_NEEDED', 'ADDITIONAL_INFO'];
    const expiredCodes = ['EXPIRED', 'VOID', 'CANCELLED'];

    if (approvedCodes.some(c => s.includes(c))) return 'approved';
    if (deniedCodes.some(c => s.includes(c))) return 'denied';
    if (moreCodes.some(c => s.includes(c))) return 'more_info_needed';
    if (expiredCodes.some(c => s.includes(c))) return 'expired';
    return 'pending';
}

function parseStatusResponse(apiType, data) {
    const status = mapPayerStatus(apiType, data.statusCode || data.status || data.decision);

    return {
        ok: true,
        status,
        authNumber: data.authorizationNumber || data.authNumber || data.certificationNumber || null,
        denialReason: data.denialReason || data.statusDescription || data.message || null,
        expirationDate: data.expirationDate || data.endDate || null,
        additionalInfoRequested: data.additionalInfoRequested || data.pendingReason || null,
        rawStatus: data.statusCode || data.status
    };
}

// ============================================================
// APPEAL
// ============================================================

/**
 * submitAppeal(clientSlug, payerId, originalRefNumber, appealLetterText)
 */
async function submitAppeal(clientSlug, payerId, originalRefNumber, appealLetterText) {
    const payer = getPayerById(payerId);
    if (!payer) return { ok: false, error: `Unknown payer: ${payerId}` };

    if (payer.api_type === 'x12' || !payer.appeal_url) {
        // Log for manual submission
        console.log(`[Payers] X12 appeal for ${payerId}/${originalRefNumber} — manual required`);
        return {
            ok: true,
            method: 'manual',
            message: 'Appeal letter generated — manual submission required for this payer'
        };
    }

    try {
        const token = await getBearerToken(payerId, clientSlug);
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const payload = {
            originalReferenceNumber: originalRefNumber,
            appealType: 'clinical',
            appealLetterText,
            submittedAt: new Date().toISOString()
        };

        const response = await axios.post(payer.appeal_url, payload, { headers });

        return {
            ok: true,
            method: 'api',
            appealReferenceNumber: response.data.appealId || response.data.referenceNumber,
            status: 'submitted'
        };
    } catch (err) {
        console.error(`[Payers] Appeal error for ${payerId}/${originalRefNumber}:`, err.message);
        return { ok: false, error: err.message };
    }
}

// ============================================================
// X12 278 CLEARINGHOUSE FALLBACK
// ============================================================

/**
 * formatX12_278(authRequest)
 * Build an X12 278 Health Care Services Review — Request transaction.
 */
function formatX12_278(authRequest) {
    const today = dayjs().format('YYYYMMDD');
    const time = dayjs().format('HHmm');
    const controlNum = String(Date.now()).slice(-9);

    const procedureSegments = (authRequest.procedureCodes || []).map((code, i) => {
        const seq = i + 1;
        return [
            `UM*SC*I*${seq}***${code}:::CPT**Y`,
            `DTP*472*D8*${(authRequest.requestDate || today).replace(/-/g, '')}`
        ].join('\n');
    }).join('\n');

    const diagnosisSegments = (authRequest.diagnosisCodes || [])
        .map(code => `HI*ABK:${code}`)
        .join('\n');

    const x12 = [
        `ISA*00*          *00*          *ZZ*${(authRequest.npi || '').padEnd(15)}*ZZ*PAYERID         *${today}*${time}*^*00501*${controlNum}*0*P*:`,
        `GS*HI*${authRequest.npi || 'NPI'}*PAYER*${today}*${time}*1*X*005010X217`,
        `ST*278*0001*005010X217`,
        `BHT*0007*13*${controlNum}*${today}*${time}*RQ`,
        `HL*1**20*1`,
        `NM1*X3*2*${authRequest.payerName || 'PAYER'}*****PI*${authRequest.payerId || ''}`,
        `HL*2*1*21*1`,
        `NM1*1P*1*${authRequest.providerLastName || 'PROVIDER'}*${authRequest.providerFirstName || ''}***XX*${authRequest.npi || ''}`,
        `HL*3*2*22*1`,
        `NM1*QC*1*${authRequest.patientLastName || 'PATIENT'}*${authRequest.patientFirstName || ''}***MI*${authRequest.memberId || ''}`,
        `DMG*D8*${(authRequest.patientDOB || '').replace(/-/g, '')}*${authRequest.patientGender || 'U'}`,
        `HL*4*3*EV*0`,
        `UM*SC*I*****${authRequest.urgency === 'urgent' ? 'U' : 'E'}`,
        procedureSegments,
        diagnosisSegments,
        `SE*${15 + (authRequest.procedureCodes?.length || 0) * 2 + (authRequest.diagnosisCodes?.length || 0)}*0001`,
        `GE*1*1`,
        `IEA*1*${controlNum}`
    ].join('\n');

    return x12;
}

async function submitViaX12Clearinghouse(clientSlug, payerId, authRequest) {
    const x12 = formatX12_278(authRequest);
    const clearinghouseUrl = process.env.X12_CLEARINGHOUSE_URL;

    if (clearinghouseUrl) {
        try {
            const response = await axios.post(clearinghouseUrl, x12, {
                headers: {
                    'Content-Type': 'application/edi-x12',
                    Authorization: `Bearer ${process.env.X12_CLEARINGHOUSE_API_KEY}`
                }
            });
            return {
                ok: true,
                method: 'x12',
                referenceNumber: response.data?.referenceNumber || `X12-${Date.now()}`,
                status: 'pending',
                estimatedDecisionDate: dayjs().add(5, 'day').format('YYYY-MM-DD')
            };
        } catch (err) {
            console.error('[Payers] X12 clearinghouse error:', err.message);
        }
    }

    // No clearinghouse configured — return for manual handling
    return {
        ok: true,
        method: 'manual_x12',
        x12Transaction: x12,
        referenceNumber: `MANUAL-${Date.now()}`,
        status: 'pending',
        estimatedDecisionDate: dayjs().add(5, 'day').format('YYYY-MM-DD'),
        note: 'X12 clearinghouse not configured — manual submission required'
    };
}

module.exports = {
    getPayerById,
    listPayers,
    isAuthRequired,
    submitAuthRequest,
    checkAuthStatus,
    submitAppeal,
    formatX12_278,
    AUTH_REQUIRED_CODES
};
