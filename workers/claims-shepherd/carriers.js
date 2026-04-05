/**
 * GRIDHAND AI — Claims Shepherd
 * Carrier Claims Portal Integration
 *
 * Supports FNOL submission and status polling for major carriers.
 * Integration types:
 *   - 'api'          : Direct REST API integration
 *   - 'email'        : Email-based FNOL / status parsing
 *   - 'manual'       : Human-readable instructions only (no automation)
 */

'use strict';

const axios = require('axios');

// ============================================================
// CARRIER DIRECTORY
// Each entry defines the FNOL endpoint, status endpoint,
// required fields, and integration type.
// ============================================================

const CARRIER_DIRECTORY = {
    state_farm: {
        name: 'State Farm',
        integrationTypes: ['api', 'email'],
        fnolEmail: 'claims@statefarm.com',
        apiBase: 'https://api.statefarm.com/claims/v2',
        portalUrl: 'https://www.statefarm.com/claims',
        phoneNumber: '1-800-732-5246',
        supportsApiFileNumber: true,
        statusCheckInterval: 24   // hours
    },
    progressive: {
        name: 'Progressive',
        integrationTypes: ['api', 'email'],
        fnolEmail: 'fnol@progressive.com',
        apiBase: 'https://api.progressive.com/claims/v1',
        portalUrl: 'https://www.progressive.com/claims',
        phoneNumber: '1-800-776-4737',
        supportsApiFileNumber: true,
        statusCheckInterval: 12
    },
    allstate: {
        name: 'Allstate',
        integrationTypes: ['email', 'manual'],
        fnolEmail: 'fnol@allstate.com',
        portalUrl: 'https://www.allstate.com/claims',
        phoneNumber: '1-800-255-7828',
        supportsApiFileNumber: false,
        statusCheckInterval: 24
    },
    geico: {
        name: 'GEICO',
        integrationTypes: ['api'],
        apiBase: 'https://api.geico.com/claims/v1',
        portalUrl: 'https://www.geico.com/claims',
        phoneNumber: '1-800-841-3000',
        supportsApiFileNumber: true,
        statusCheckInterval: 12
    },
    nationwide: {
        name: 'Nationwide',
        integrationTypes: ['email', 'manual'],
        fnolEmail: 'claims@nationwide.com',
        portalUrl: 'https://www.nationwide.com/claims',
        phoneNumber: '1-800-421-3535',
        supportsApiFileNumber: false,
        statusCheckInterval: 24
    },
    travelers: {
        name: 'Travelers',
        integrationTypes: ['api', 'email'],
        fnolEmail: 'firstnotice@travelers.com',
        apiBase: 'https://api.travelers.com/claims/v1',
        portalUrl: 'https://www.travelers.com/claims',
        phoneNumber: '1-800-252-4633',
        supportsApiFileNumber: true,
        statusCheckInterval: 24
    },
    liberty_mutual: {
        name: 'Liberty Mutual',
        integrationTypes: ['email', 'manual'],
        fnolEmail: 'claims@libertymutual.com',
        portalUrl: 'https://www.libertymutual.com/claims',
        phoneNumber: '1-800-290-8711',
        supportsApiFileNumber: false,
        statusCheckInterval: 48
    },
    usaa: {
        name: 'USAA',
        integrationTypes: ['api'],
        apiBase: 'https://api.usaa.com/claims/v2',
        portalUrl: 'https://www.usaa.com/inet/ent_claims',
        phoneNumber: '1-800-531-8722',
        supportsApiFileNumber: true,
        statusCheckInterval: 12
    },
    farmers: {
        name: 'Farmers',
        integrationTypes: ['email', 'manual'],
        fnolEmail: 'report@farmers.com',
        portalUrl: 'https://www.farmers.com/claims',
        phoneNumber: '1-800-435-7764',
        supportsApiFileNumber: false,
        statusCheckInterval: 24
    },
    hartford: {
        name: 'The Hartford',
        integrationTypes: ['api', 'email'],
        fnolEmail: 'fnol@thehartford.com',
        apiBase: 'https://api.thehartford.com/claims/v1',
        portalUrl: 'https://www.thehartford.com/claims',
        phoneNumber: '1-800-553-0679',
        supportsApiFileNumber: true,
        statusCheckInterval: 24
    },
    chubb: {
        name: 'Chubb',
        integrationTypes: ['api', 'email'],
        fnolEmail: 'firstloss@chubb.com',
        apiBase: 'https://api.chubb.com/claims/v1',
        portalUrl: 'https://www.chubb.com/us-en/claims',
        phoneNumber: '1-800-252-4670',
        supportsApiFileNumber: true,
        statusCheckInterval: 24
    },
    erie: {
        name: 'Erie Insurance',
        integrationTypes: ['email', 'manual'],
        fnolEmail: 'claims@erieinsurance.com',
        portalUrl: 'https://www.erieinsurance.com/claims',
        phoneNumber: '1-800-367-3743',
        supportsApiFileNumber: false,
        statusCheckInterval: 48
    },
    safeco: {
        name: 'Safeco',
        integrationTypes: ['email', 'manual'],
        fnolEmail: 'claims@safeco.com',
        portalUrl: 'https://www.safeco.com/claims',
        phoneNumber: '1-800-332-3226',
        supportsApiFileNumber: false,
        statusCheckInterval: 48
    },
    american_family: {
        name: 'American Family',
        integrationTypes: ['email', 'manual'],
        fnolEmail: 'claims@amfam.com',
        portalUrl: 'https://www.amfam.com/claims',
        phoneNumber: '1-800-374-1111',
        supportsApiFileNumber: false,
        statusCheckInterval: 48
    },
    kemper: {
        name: 'Kemper',
        integrationTypes: ['manual'],
        portalUrl: 'https://www.kemper.com/claims',
        phoneNumber: '1-800-325-1088',
        supportsApiFileNumber: false,
        statusCheckInterval: 48
    }
};

// ============================================================
// CARRIER API CLIENT
// For carriers that support REST API integration
// ============================================================

async function carrierApiRequest(method, url, apiKey, data) {
    try {
        const response = await axios({
            method,
            url,
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Source': 'GRIDHAND-ClaimsShepherd/1.0'
            },
            data: data || undefined,
            timeout: 20000
        });
        return { ok: true, data: response.data };
    } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data?.message || err.response?.data?.error || err.message;
        console.error(`[Carrier API] ${method} ${url} → ${status} ${msg}`);
        return { ok: false, error: msg, status, retryable: status >= 500 || status === 429 };
    }
}

// ============================================================
// FNOL SUBMISSION
// ============================================================

/**
 * Build a standardized FNOL payload from a claim record.
 * Each carrier maps this to their own field names via carrierMapper.
 */
function buildFNOLPayload(claim) {
    return {
        policyNumber: claim.policy_number,
        insuredName: claim.insured_name,
        insuredPhone: claim.insured_phone,
        insuredEmail: claim.insured_email || '',
        insuredAddress: claim.insured_address || '',
        lossDate: claim.loss_date,
        lossType: claim.loss_type,
        lossDescription: claim.loss_description,
        lossLocation: claim.loss_address || '',
        policeReportNumber: claim.police_report_num || '',
        estimatedDamage: claim.estimated_damage || 0,
        reportedBy: 'GridHand AI Claims Shepherd',
        reportedAt: new Date().toISOString()
    };
}

/**
 * Carrier-specific field mappers for API submissions
 */
const FIELD_MAPPERS = {
    state_farm: (p) => ({
        PolicyNumber: p.policyNumber,
        LossDate: p.lossDate,
        LossDescription: p.lossDescription,
        LossType: p.lossType.toUpperCase(),
        LossLocation: p.lossLocation,
        InsuredContactPhone: p.insuredPhone,
        InsuredContactEmail: p.insuredEmail,
        PoliceReport: p.policeReportNumber,
        EstimatedAmount: p.estimatedDamage
    }),
    progressive: (p) => ({
        policy_number: p.policyNumber,
        loss_date: p.lossDate,
        loss_description: p.lossDescription,
        loss_type: p.lossType,
        insured_phone: p.insuredPhone,
        insured_email: p.insuredEmail,
        estimated_damage: p.estimatedDamage
    }),
    geico: (p) => ({
        policyNo: p.policyNumber,
        incidentDate: p.lossDate,
        incidentDescription: p.lossDescription,
        coverageType: p.lossType,
        contactPhone: p.insuredPhone,
        damageEstimate: p.estimatedDamage
    }),
    travelers: (p) => ({
        PolicyNumber: p.policyNumber,
        DateOfLoss: p.lossDate,
        CauseOfLoss: p.lossDescription,
        TypeOfLoss: p.lossType,
        ReportedPhone: p.insuredPhone,
        EstimatedLoss: p.estimatedDamage
    }),
    usaa: (p) => ({
        memberPolicyNumber: p.policyNumber,
        incidentDate: p.lossDate,
        description: p.lossDescription,
        lossType: p.lossType,
        contactPhone: p.insuredPhone,
        estimatedAmount: p.estimatedDamage
    }),
    hartford: (p) => ({
        PolicyNumber: p.policyNumber,
        LossDate: p.lossDate,
        Description: p.lossDescription,
        LossCategory: p.lossType,
        ContactPhone: p.insuredPhone,
        EstimatedDamage: p.estimatedDamage
    }),
    chubb: (p) => ({
        policyNumber: p.policyNumber,
        dateOfOccurrence: p.lossDate,
        descriptionOfLoss: p.lossDescription,
        typeOfClaim: p.lossType,
        reporterPhone: p.insuredPhone,
        estimatedLoss: p.estimatedDamage
    })
};

/**
 * Build FNOL email body for email-based carriers
 */
function buildFNOLEmail(claim, carrierInfo) {
    return {
        to: carrierInfo.fnolEmail,
        subject: `FNOL — Policy ${claim.policy_number} — ${claim.insured_name} — Loss Date ${claim.loss_date}`,
        body: `
FIRST NOTICE OF LOSS
Submitted by: GridHand AI Claims Shepherd
Submission Date: ${new Date().toLocaleDateString()}

━━━━━━━━━━━━━━━━━━━━━━━━━━
POLICY INFORMATION
━━━━━━━━━━━━━━━━━━━━━━━━━━
Policy Number:      ${claim.policy_number}
Carrier:            ${carrierInfo.name}
Loss Type:          ${claim.loss_type.replace(/_/g, ' ').toUpperCase()}

━━━━━━━━━━━━━━━━━━━━━━━━━━
INSURED INFORMATION
━━━━━━━━━━━━━━━━━━━━━━━━━━
Name:               ${claim.insured_name}
Phone:              ${claim.insured_phone}
Email:              ${claim.insured_email || 'N/A'}
Address:            ${claim.insured_address || 'N/A'}

━━━━━━━━━━━━━━━━━━━━━━━━━━
LOSS DETAILS
━━━━━━━━━━━━━━━━━━━━━━━━━━
Date of Loss:       ${claim.loss_date}
Loss Location:      ${claim.loss_address || 'See description'}
Police Report #:    ${claim.police_report_num || 'N/A'}
Estimated Damage:   ${claim.estimated_damage ? `$${claim.estimated_damage.toLocaleString()}` : 'Unknown'}

Description:
${claim.loss_description}

━━━━━━━━━━━━━━━━━━━━━━━━━━
Please confirm receipt and provide a claim number at your earliest convenience.
Questions: Contact the GridHand AI Claims Shepherd system or the insured directly.
━━━━━━━━━━━━━━━━━━━━━━━━━━
`.trim()
    };
}

// ============================================================
// SUBMIT FNOL
// ============================================================

/**
 * Submit a First Notice of Loss to the appropriate carrier.
 * Returns { ok, claimNumber, method, details }
 */
async function submitFNOL(claim, carrierConfig) {
    const carrierCode = claim.carrier_code;
    const carrierDir = CARRIER_DIRECTORY[carrierCode];

    if (!carrierDir) {
        return {
            ok: false,
            method: 'manual',
            error: `Unknown carrier: ${carrierCode}`,
            manualInstructions: `Call carrier directly to file FNOL for policy ${claim.policy_number}`
        };
    }

    const fnolPayload = buildFNOLPayload(claim);

    // Try API first if available and configured
    if (
        carrierDir.integrationTypes.includes('api') &&
        carrierConfig?.api_key &&
        carrierDir.apiBase &&
        FIELD_MAPPERS[carrierCode]
    ) {
        const mapped = FIELD_MAPPERS[carrierCode](fnolPayload);
        const result = await carrierApiRequest(
            'POST',
            `${carrierDir.apiBase}/fnol`,
            carrierConfig.api_key,
            mapped
        );

        if (result.ok) {
            const claimNumber = result.data?.claimNumber || result.data?.claim_number ||
                                result.data?.ClaimNumber || result.data?.id;
            return {
                ok: true,
                method: 'api',
                claimNumber,
                portalUrl: `${carrierDir.apiBase}/claims/${claimNumber}`,
                raw: result.data
            };
        }

        // Fall through to email if API fails
        console.warn(`[Carrier] API FNOL failed for ${carrierCode}, falling back to email`);
    }

    // Email-based FNOL
    if (carrierDir.integrationTypes.includes('email') && carrierDir.fnolEmail) {
        const emailData = buildFNOLEmail(claim, carrierDir);
        // NOTE: Email send is handled by the calling layer (notifications.js)
        // We return the email data for it to send
        return {
            ok: true,
            method: 'email',
            claimNumber: null,   // Will be assigned by carrier response
            emailPayload: emailData,
            note: `FNOL emailed to ${carrierDir.fnolEmail}. Claim # pending carrier confirmation.`
        };
    }

    // Manual fallback
    return {
        ok: true,
        method: 'manual',
        claimNumber: null,
        carrierPhone: carrierDir.phoneNumber,
        portalUrl: carrierDir.portalUrl,
        note: `Manual FNOL required. Call ${carrierDir.phoneNumber} or visit ${carrierDir.portalUrl}`
    };
}

// ============================================================
// STATUS CHECK
// ============================================================

const STATUS_MAP = {
    // State Farm
    'RECEIVED': 'fnol_filed',
    'ACKNOWLEDGED': 'acknowledged',
    'ASSIGNED': 'assigned',
    'IN_REVIEW': 'investigating',
    'PENDING_DOCS': 'docs_requested',
    'DOCS_RECEIVED': 'docs_received',
    'APPRAISED': 'appraised',
    'SETTLEMENT_PENDING': 'negotiating',
    'APPROVED': 'approved',
    'PAID': 'paid',
    'CLOSED': 'closed',
    'DENIED': 'denied',
    // Progressive
    'received': 'fnol_filed',
    'assigned': 'assigned',
    'investigating': 'investigating',
    'pending_payment': 'approved',
    'paid': 'paid',
    'closed': 'closed',
    'denied': 'denied',
    // Generic
    'open': 'investigating',
    'active': 'investigating',
    'settled': 'paid',
    'complete': 'closed',
    'rejected': 'denied'
};

function normalizeCarrierStatus(raw) {
    if (!raw) return null;
    const key = String(raw).trim().toUpperCase();
    return STATUS_MAP[key] || STATUS_MAP[raw] || null;
}

/**
 * Check claim status from carrier portal/API.
 * Returns { ok, status, subStatus, adjuster, raw }
 */
async function getClaimStatus(claim, carrierConfig) {
    const carrierCode = claim.carrier_code;
    const carrierDir = CARRIER_DIRECTORY[carrierCode];

    if (!claim.claim_number || !carrierDir) {
        return { ok: false, error: 'No claim number or unknown carrier — cannot check status' };
    }

    if (
        carrierDir.integrationTypes.includes('api') &&
        carrierConfig?.api_key &&
        carrierDir.apiBase
    ) {
        const result = await carrierApiRequest(
            'GET',
            `${carrierDir.apiBase}/claims/${claim.claim_number}`,
            carrierConfig.api_key
        );

        if (result.ok) {
            const raw = result.data;
            const rawStatus = raw.status || raw.Status || raw.claimStatus;
            const normalized = normalizeCarrierStatus(rawStatus);

            return {
                ok: true,
                status: normalized || claim.status,
                subStatus: raw.statusDescription || raw.subStatus || rawStatus,
                adjusterName: raw.adjusterName || raw.AdjusterName || null,
                adjusterPhone: raw.adjusterPhone || raw.AdjusterPhone || null,
                adjusterEmail: raw.adjusterEmail || raw.AdjusterEmail || null,
                raw
            };
        }
    }

    // For email/manual carriers, return current status (no automation possible)
    return {
        ok: false,
        error: `${carrierDir?.name || carrierCode} does not support automated status checks. Check ${carrierDir?.portalUrl || 'carrier portal'} manually.`,
        manualCheckUrl: carrierDir?.portalUrl,
        carrierPhone: carrierDir?.phoneNumber
    };
}

// ============================================================
// DOCUMENT UPLOAD
// ============================================================

/**
 * Upload a document to a carrier portal.
 * Returns { ok, carrierDocId }
 */
async function uploadDocument(claim, carrierConfig, document) {
    const carrierCode = claim.carrier_code;
    const carrierDir = CARRIER_DIRECTORY[carrierCode];

    if (!claim.claim_number || !carrierDir) {
        return { ok: false, error: 'No claim number or unknown carrier' };
    }

    if (
        carrierDir.integrationTypes.includes('api') &&
        carrierConfig?.api_key &&
        carrierDir.apiBase
    ) {
        const result = await carrierApiRequest(
            'POST',
            `${carrierDir.apiBase}/claims/${claim.claim_number}/documents`,
            carrierConfig.api_key,
            {
                documentType: document.doc_type,
                documentName: document.doc_name,
                fileUrl: document.file_url,
                uploadedAt: new Date().toISOString()
            }
        );

        if (result.ok) {
            return {
                ok: true,
                carrierDocId: result.data?.id || result.data?.documentId
            };
        }
    }

    return {
        ok: false,
        error: `${carrierDir?.name || carrierCode} does not support automated document uploads`,
        manualUploadUrl: carrierDir?.portalUrl
    };
}

// ============================================================
// UTILITY EXPORTS
// ============================================================

function getCarrierInfo(carrierCode) {
    return CARRIER_DIRECTORY[carrierCode] || null;
}

function listSupportedCarriers() {
    return Object.entries(CARRIER_DIRECTORY).map(([code, info]) => ({
        code,
        name: info.name,
        integrationTypes: info.integrationTypes,
        phoneNumber: info.phoneNumber
    }));
}

function getCarrierStatusCheckInterval(carrierCode) {
    return CARRIER_DIRECTORY[carrierCode]?.statusCheckInterval || 24;
}

module.exports = {
    submitFNOL,
    getClaimStatus,
    uploadDocument,
    getCarrierInfo,
    listSupportedCarriers,
    getCarrierStatusCheckInterval,
    normalizeCarrierStatus,
    buildFNOLPayload,
    CARRIER_DIRECTORY
};
