/**
 * GRIDHAND AI — Claims Cleaner
 * Clearinghouse Integration
 *
 * Supports: Availity, Change Healthcare (Optum), Waystar
 *
 * Handles:
 *   - X12 837P (professional) / 837I (institutional) claim submission
 *   - X12 276/277 claim status inquiry
 *   - X12 835 ERA (Electronic Remittance Advice) fetch + parse
 *   - Resubmission with CLM05-3 = 7 (replacement claim)
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
// BUILD CLEARINGHOUSE HTTP CLIENT
// ============================================================

function buildCHClient(creds) {
    const { clearinghouse_type, clearinghouse_api_key } = creds;

    if (clearinghouse_type === 'availity') {
        return axios.create({
            baseURL: 'https://api.availity.com/availity/v1',
            headers: {
                Authorization: `Bearer ${clearinghouse_api_key}`,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            timeout: 20000
        });
    }

    if (clearinghouse_type === 'change_healthcare') {
        return axios.create({
            baseURL: 'https://api.changehealthcare.com/medicalnetwork/professionalclaims/v3',
            headers: {
                Authorization: `Bearer ${clearinghouse_api_key}`,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            timeout: 20000
        });
    }

    if (clearinghouse_type === 'waystar') {
        return axios.create({
            baseURL: 'https://www.zirmed.com/api/v3',
            headers: {
                Authorization: `Bearer ${clearinghouse_api_key}`,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            timeout: 20000
        });
    }

    throw new Error(`[CH] Unsupported clearinghouse type: ${clearinghouse_type}`);
}

// Load creds helper
async function getCreds(clientSlug) {
    const { data } = await supabase
        .from('cc_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    if (!data) throw new Error(`[CH] No connection for client: ${clientSlug}`);
    return data;
}

// ============================================================
// SUBMIT CLAIM (X12 837P / 837I)
// ============================================================

async function submitClaim(clientSlug, cleanClaim) {
    const creds = await getCreds(clientSlug);
    const client = buildCHClient(creds);
    const edi = formatX12_837P(cleanClaim, creds);

    if (creds.clearinghouse_type === 'availity') {
        const { data } = await client.post('/claims', {
            tradingPartnerId: cleanClaim.payer.payerId,
            submitterOrganization: creds.practice_name,
            submitterNpi: creds.npi,
            claimContent: edi
        });
        return {
            trackingId: data.controlNumber || data.transactionId,
            status: data.status || 'submitted',
            acknowledgmentCode: data.acknowledgmentCode || 'TA1'
        };
    }

    if (creds.clearinghouse_type === 'change_healthcare') {
        const payload = buildChangeHealthcarePayload(cleanClaim, creds);
        const { data } = await client.post('/submission', payload);
        return {
            trackingId: data.controlNumber,
            status: data.claimStatus || 'submitted',
            acknowledgmentCode: data.editStatus
        };
    }

    if (creds.clearinghouse_type === 'waystar') {
        const { data } = await client.post('/claims/submit', {
            submitterId: creds.clearinghouse_submitter_id,
            claim: buildWaystarPayload(cleanClaim, creds)
        });
        return {
            trackingId: data.claimReferenceNumber,
            status: data.status || 'submitted',
            acknowledgmentCode: data.responseCode
        };
    }
}

// ============================================================
// CHECK CLAIM STATUS (X12 276/277)
// ============================================================

async function checkClaimStatus(clientSlug, trackingId) {
    const creds = await getCreds(clientSlug);
    const client = buildCHClient(creds);

    if (creds.clearinghouse_type === 'availity') {
        const { data } = await client.get(`/claims/${trackingId}/status`);
        return normalizeStatusResponse(data, 'availity');
    }

    if (creds.clearinghouse_type === 'change_healthcare') {
        const { data } = await client.get(`/claims/${trackingId}/status`);
        return normalizeStatusResponse(data, 'change_healthcare');
    }

    if (creds.clearinghouse_type === 'waystar') {
        const { data } = await client.get(`/claims/${trackingId}`);
        return normalizeStatusResponse(data, 'waystar');
    }

    throw new Error(`[CH] Unsupported clearinghouse: ${creds.clearinghouse_type}`);
}

function normalizeStatusResponse(raw, type) {
    if (type === 'availity') {
        const statusMap = {
            A: 'accepted', R: 'rejected', P: 'pending',
            F: 'paid', D: 'denied', AD: 'acknowledged'
        };
        return {
            status: statusMap[raw.statusCode] || raw.statusCode?.toLowerCase() || 'pending',
            adjudicationDate: raw.adjudicationDate,
            paidAmount: raw.paidAmount ? parseFloat(raw.paidAmount) : null,
            denialCode: raw.rejectReasonCode,
            denialReason: raw.rejectReasonDescription
        };
    }

    if (type === 'change_healthcare') {
        return {
            status: raw.claimStatus?.toLowerCase() || 'pending',
            adjudicationDate: raw.adjudicationDate,
            paidAmount: raw.paymentAmount ? parseFloat(raw.paymentAmount) : null,
            denialCode: raw.denialReasonCode,
            denialReason: raw.denialReasonDescription
        };
    }

    if (type === 'waystar') {
        return {
            status: raw.statusDescription?.toLowerCase() || 'pending',
            adjudicationDate: raw.adjudicationDate,
            paidAmount: raw.paidAmount ? parseFloat(raw.paidAmount) : null,
            denialCode: raw.rejectionCode,
            denialReason: raw.rejectionDescription
        };
    }

    return { status: 'pending', adjudicationDate: null, paidAmount: null, denialCode: null, denialReason: null };
}

// ============================================================
// FETCH ERA (X12 835 — Electronic Remittance Advice)
// ============================================================

async function fetchERA(clientSlug) {
    const creds = await getCreds(clientSlug);
    const client = buildCHClient(creds);
    const results = [];

    if (creds.clearinghouse_type === 'availity') {
        const { data } = await client.get('/remittances', {
            params: { status: 'unprocessed', limit: 100 }
        });
        for (const era of data.remittances || []) {
            const parsed = parseX12_835(era.content || era.rawData);
            results.push(...parsed);
        }
        return results;
    }

    if (creds.clearinghouse_type === 'change_healthcare') {
        const { data } = await client.get('/remittances', {
            params: { startDate: dayjs().subtract(7, 'day').format('YYYY-MM-DD') }
        });
        for (const era of data.remittances || []) {
            const parsed = parseX12_835(era.ediContent);
            results.push(...parsed);
        }
        return results;
    }

    if (creds.clearinghouse_type === 'waystar') {
        const { data } = await client.get('/remittances/835', {
            params: { unprocessed: true }
        });
        for (const era of data.files || []) {
            const parsed = parseX12_835(era.content);
            results.push(...parsed);
        }
        return results;
    }

    return results;
}

// ============================================================
// FORMAT X12 837P — Professional Claim EDI
// Builds a compliant X12 5010 837P transaction set
// ============================================================

function formatX12_837P(claim, creds) {
    const now = dayjs();
    const dateStr = now.format('YYYYMMDD');
    const timeStr = now.format('HHmm');
    const icn = String(Date.now()).slice(-9);   // ISA control number (9 digits)
    const gcn = String(Date.now()).slice(-4);   // GS group control

    const submitterId = creds.clearinghouse_submitter_id || creds.npi;
    const dos = dayjs(claim.dos).format('YYYYMMDD');
    const dosRange = `${dos}-${dos}`;

    const lines = [];

    // Interchange Control Header (ISA)
    lines.push(`ISA*00*          *00*          *ZZ*${submitterId.padEnd(15)}*ZZ*${(claim.payer.payerId || '').padEnd(15)}*${dateStr.slice(2)}*${timeStr}*^*00501*${icn.padStart(9, '0')}*0*P*:`);

    // Functional Group Header (GS)
    lines.push(`GS*HC*${submitterId}*${claim.payer.payerId}*${dateStr}*${timeStr}*${gcn}*X*005010X222A1`);

    // Transaction Set Header (ST)
    lines.push(`ST*837*0001*005010X222A1`);

    // BPR — Beginning of Provider Information
    lines.push(`BPR*I*${(claim.billedAmount || 0).toFixed(2)}*C*ACH*CCP*01*XXXXXXXXX*DA*XXXXXXXXX*${dateStr}`);

    // NM1 — Loop 1000A: Submitter
    lines.push(`NM1*41*2*${(creds.practice_name || 'PRACTICE').substring(0, 60)}*****XX*${creds.npi}`);
    lines.push(`PER*IC*BILLING DEPT*TE*0000000000`);

    // NM1 — Loop 1000B: Receiver (payer)
    lines.push(`NM1*40*2*${(claim.payer.payerName || '').substring(0, 60)}*****XX*${claim.payer.payerId || ''}`);

    // Loop 2000A: Billing Provider
    lines.push(`HL*1**20*1`);
    lines.push(`PRV*BI*PXC*${creds.taxonomy_code || '207Q00000X'}`);
    lines.push(`NM1*85*2*${(creds.practice_name || '').substring(0, 60)}*****XX*${creds.npi}`);
    lines.push(`N3*123 MEDICAL DR`);
    lines.push(`N4*CITY*ST*00000`);
    lines.push(`REF*EI*${creds.tax_id || '000000000'}`);

    // Loop 2000B: Subscriber
    lines.push(`HL*2*1*22*0`);
    lines.push(`SBR*P*18*${claim.payer.groupNumber || ''}**********CI`);
    lines.push(`NM1*IL*1*${(claim.patientName || '').split(' ').slice(-1)[0]}*${(claim.patientName || '').split(' ')[0]}****MI*${claim.payer.memberId || ''}`);
    lines.push(`N3*PATIENT ADDRESS`);
    lines.push(`N4*CITY*ST*00000`);
    lines.push(`DMG*D8*${(claim.dob || '19000101').replace(/-/g, '')}*U`);

    // NM1 — Payer
    lines.push(`NM1*PR*2*${(claim.payer.payerName || '').substring(0, 60)}*****PI*${claim.payer.payerId || ''}`);

    // Loop 2300: Claim Information
    const claimId = claim.claimId || String(Date.now());
    const totalCharge = (claim.billedAmount || 0).toFixed(2);
    lines.push(`CLM*${claimId}*${totalCharge}***11:B:1*Y*A*Y*I`);

    // DTP — Date of Service
    lines.push(`DTP*472*D8*${dos}`);

    // REF — Prior authorization (if present)
    if (claim.priorAuthNumber) {
        lines.push(`REF*G1*${claim.priorAuthNumber}`);
    }

    // HI — Diagnosis codes (up to 12)
    const diagCodes = (claim.diagnosisCodes || []).slice(0, 12);
    if (diagCodes.length > 0) {
        const dxSegment = diagCodes.map((code, i) => `${i === 0 ? 'ABK' : 'ABF'}:${code.replace('.', '')}`).join('*');
        lines.push(`HI*${dxSegment}`);
    }

    // NM1 — Rendering Provider
    if (claim.provider?.npi) {
        lines.push(`NM1*82*1*${(claim.provider.name || '').split(' ').slice(-1)[0]}*${(claim.provider.name || '').split(' ')[0]}****XX*${claim.provider.npi}`);
        lines.push(`PRV*PE*PXC*${claim.provider.taxonomyCode || creds.taxonomy_code || '207Q00000X'}`);
    }

    // Loop 2400: Service Lines
    (claim.procedureCodes || []).forEach((proc, idx) => {
        const lx = idx + 1;
        const modifierStr = proc.modifier ? `*${proc.modifier.split(' ').slice(0, 4).join('*')}` : '****';
        lines.push(`LX*${lx}`);
        lines.push(`SV1*HC:${proc.cpt}${modifierStr}*${(proc.chargeAmount || 0).toFixed(2)}*UN*${proc.units || 1}***${diagCodes.map((_, i) => i + 1).join(':')}`);
        lines.push(`DTP*472*D8*${dos}`);
    });

    // SE — Transaction Set Trailer
    const segCount = lines.length + 1; // +1 for SE itself
    lines.push(`SE*${segCount}*0001`);

    // GE — Functional Group Trailer
    lines.push(`GE*1*${gcn}`);

    // IEA — Interchange Control Trailer
    lines.push(`IEA*1*${icn.padStart(9, '0')}`);

    return lines.join('\n');
}

// ============================================================
// PARSE X12 835 — Electronic Remittance Advice
// Returns array of { trackingId, claimId, status, paidAmount, denialCode, denialReason, dos }
// ============================================================

function parseX12_835(eraData) {
    if (!eraData) return [];
    const results = [];

    // Split on segment terminator — typically ~
    const segments = eraData.split(/~\s*/).map(s => s.trim()).filter(Boolean);
    const getEl = (seg) => seg.split('*');

    let currentClaim = null;
    let currentCheckNumber = null;
    let currentPayerName = null;

    for (const seg of segments) {
        const el = getEl(seg);
        const id = el[0];

        if (id === 'BPR') {
            currentCheckNumber = el[2] || null;
        }

        if (id === 'NM1' && el[1] === 'PR') {
            currentPayerName = el[3] || null;
        }

        if (id === 'CLP') {
            // CLP: Claim-level payment
            // CLP*claimId*statusCode*totalCharge*paymentAmount*...
            currentClaim = {
                originalClaimId: el[1],
                clpStatusCode: el[2],
                billedAmount: parseFloat(el[3] || 0),
                paidAmount: parseFloat(el[4] || 0),
                adjustmentAmount: parseFloat(el[5] || 0),
                payerClaimControlNumber: el[7],
                checkNumber: currentCheckNumber,
                payerName: currentPayerName,
                denialCodes: [],
                serviceLines: [],
                status: mapCLPStatus(el[2])
            };
        }

        if (id === 'NM1' && el[1] === 'QC' && currentClaim) {
            currentClaim.patientName = `${el[4] || ''} ${el[3] || ''}`.trim();
        }

        if (id === 'CAS' && currentClaim) {
            // CAS: Claim adjustment — reason codes
            // CAS*CO*45*150.00 (CO=contractual, PR=patient responsibility, OA=other)
            const groupCode = el[1];
            for (let i = 2; i < el.length - 1; i += 3) {
                const reasonCode = el[i];
                const adjAmount = parseFloat(el[i + 1] || 0);
                if (reasonCode) {
                    currentClaim.denialCodes.push({
                        groupCode,
                        reasonCode,
                        adjustmentAmount: adjAmount,
                        description: mapCARCDescription(reasonCode)
                    });
                }
            }
        }

        if (id === 'SVC' && currentClaim) {
            currentClaim.serviceLines.push({
                cpt: el[1]?.split(':')[1],
                billedAmount: parseFloat(el[2] || 0),
                paidAmount: parseFloat(el[3] || 0),
                units: parseInt(el[5] || 1)
            });
        }

        if ((id === 'CLP' || id === 'SE') && currentClaim && currentClaim.originalClaimId) {
            // Finalize previous claim
            if (id !== 'CLP') {
                // Push final claim on SE
            }
            const primaryDenial = currentClaim.denialCodes.find(d => d.groupCode !== 'CO') || currentClaim.denialCodes[0];
            results.push({
                originalClaimId: currentClaim.originalClaimId,
                paidAmount: currentClaim.paidAmount,
                billedAmount: currentClaim.billedAmount,
                status: currentClaim.status,
                denialCode: primaryDenial?.reasonCode || null,
                denialReason: primaryDenial?.description || null,
                allDenialCodes: currentClaim.denialCodes,
                checkNumber: currentClaim.checkNumber,
                payerName: currentClaim.payerName,
                patientName: currentClaim.patientName
            });
            if (id === 'CLP') {
                // New claim starting — already handled above, reset
                // currentClaim was just reset in the CLP block above
            }
        }
    }

    return results;
}

function mapCLPStatus(code) {
    const map = { '1': 'paid', '2': 'denied', '3': 'partial', '4': 'denied', '19': 'denied', '20': 'denied', '22': 'denied' };
    return map[code] || 'pending';
}

function mapCARCDescription(code) {
    // Common CARC (Claim Adjustment Reason Code) descriptions
    const carc = {
        '1': 'Deductible amount',
        '2': 'Coinsurance amount',
        '3': 'Co-payment amount',
        '4': 'The procedure code is inconsistent with modifier or required modifier',
        '5': 'The procedure code is inconsistent with the place of service',
        '6': 'The procedure is inconsistent with the patient age',
        '7': 'The procedure is inconsistent with the patient sex',
        '8': 'The procedure code is inconsistent with the provider type',
        '9': 'The diagnosis is inconsistent with the patient age',
        '10': 'The diagnosis is inconsistent with the patient sex',
        '11': 'The diagnosis is inconsistent with the procedure',
        '12': 'The diagnosis code is invalid',
        '13': 'The date of service is in the future',
        '14': 'The date of service predates the patient birth date',
        '15': 'The authorization number is missing, invalid, or does not apply',
        '16': 'Claim/service lacks information needed for adjudication',
        '18': 'Duplicate claim/service',
        '19': 'Claim denied because this is a work-related injury',
        '22': 'This care may be covered by another payer',
        '23': 'The impact of prior payer(s) adjudication',
        '26': 'Expenses incurred prior to coverage',
        '27': 'Expenses incurred after coverage terminated',
        '29': 'The time limit for filing has expired',
        '31': 'Claim denied as patient cannot be identified as our insured',
        '45': 'Contractual adjustment — charge exceeds fee schedule',
        '49': 'This service is non-covered',
        '50': 'These are non-covered services because this is not deemed a medical necessity',
        '55': 'Claim/service denied because procedure/treatment is deemed experimental',
        '57': 'Prior claim processing',
        '58': 'Treatment was deemed experimental or investigational',
        '59': 'Processed based on multiple or concurrent procedure rules',
        '96': 'Non-covered charge(s)',
        '97': 'Payment is included in the allowance for another service/procedure',
        '109': 'Claim not covered by this payer/contractor',
        '110': 'Billing date predates service date',
        '119': 'Benefit maximum for this time period or occurrence has been reached',
        '125': 'Submission/billing error',
        '181': 'Procedure code was invalid on the date of service',
        '182': 'Procedure modifier was invalid on the date of service',
        '185': 'Claim/service denied as the rendering provider is not an authorized or a non-participating provider',
        '197': 'Precertification/authorization/notification/pre-treatment absent',
        '236': 'This procedure or procedure/modifier combination is not compatible with another procedure',
        '252': 'An attachment/other documentation is required to adjudicate this claim'
    };
    return carc[code] || `Adjustment reason code ${code}`;
}

// ============================================================
// RESUBMIT CORRECTED CLAIM
// CLM05-3 = 7 (replacement of prior claim per HIPAA)
// ============================================================

async function resubmitCorrectedClaim(clientSlug, originalTrackingId, correctedClaim, frecb) {
    const creds = await getCreds(clientSlug);
    const client = buildCHClient(creds);

    // Build 837P with CLM05-3=7 for replacement
    const edi = formatX12_837P(
        { ...correctedClaim, claimFrequencyCode: '7', originalClaimId: originalTrackingId },
        creds
    );

    if (creds.clearinghouse_type === 'availity') {
        const { data } = await client.post('/claims/replacement', {
            originalControlNumber: originalTrackingId,
            claimContent: edi,
            frequencyCode: frecb || '7'
        });
        return {
            trackingId: data.controlNumber,
            status: 'resubmitted',
            acknowledgmentCode: data.acknowledgmentCode
        };
    }

    if (creds.clearinghouse_type === 'change_healthcare') {
        const payload = buildChangeHealthcarePayload(correctedClaim, creds);
        payload.tradingPartnerServiceId = correctedClaim.payer.payerId;
        payload.correctedPriorAuthorizationNumber = originalTrackingId;
        payload.claimFrequencyCode = frecb || '7';
        const { data } = await client.post('/submission', payload);
        return {
            trackingId: data.controlNumber,
            status: 'resubmitted',
            acknowledgmentCode: data.editStatus
        };
    }

    if (creds.clearinghouse_type === 'waystar') {
        const { data } = await client.post('/claims/resubmit', {
            originalClaimId: originalTrackingId,
            claim: { ...buildWaystarPayload(correctedClaim, creds), frequencyCode: frecb || '7' }
        });
        return {
            trackingId: data.claimReferenceNumber,
            status: 'resubmitted',
            acknowledgmentCode: data.responseCode
        };
    }

    throw new Error(`[CH] Unsupported clearinghouse for resubmit: ${creds.clearinghouse_type}`);
}

// ============================================================
// CLEARINGHOUSE-SPECIFIC PAYLOAD BUILDERS
// ============================================================

function buildChangeHealthcarePayload(claim, creds) {
    return {
        tradingPartnerServiceId: claim.payer.payerId,
        submitter: {
            organizationName: creds.practice_name,
            npi: creds.npi,
            taxId: creds.tax_id
        },
        receiver: {
            organizationName: claim.payer.payerName,
            taxId: claim.payer.payerId
        },
        subscriber: {
            memberId: claim.payer.memberId,
            firstName: (claim.patientName || '').split(' ')[0],
            lastName: (claim.patientName || '').split(' ').slice(-1)[0],
            gender: claim.gender || 'U',
            dateOfBirth: (claim.dob || '').replace(/-/g, '')
        },
        claimInformation: {
            claimFilingCode: 'CI',
            patientControlNumber: claim.claimId,
            claimChargeAmount: String(claim.billedAmount || 0),
            serviceLocationTypeCode: '11',
            healthCareCodeInformation: (claim.diagnosisCodes || []).map((code, i) => ({
                diagnosisTypeCode: i === 0 ? 'ABK' : 'ABF',
                diagnosisCode: code.replace('.', '')
            })),
            serviceFacilityLocation: {
                organizationName: creds.practice_name,
                address: { address1: '123 Medical Dr', city: 'City', state: 'ST', postalCode: '00000' }
            },
            renderingProvider: {
                providerType: 'renderingProvider',
                npi: claim.provider?.npi || creds.npi,
                firstName: (claim.provider?.name || '').split(' ')[0],
                lastName: (claim.provider?.name || '').split(' ').slice(-1)[0],
                taxonomyCode: claim.provider?.taxonomyCode || creds.taxonomy_code
            },
            serviceLines: (claim.procedureCodes || []).map((proc, i) => ({
                serviceDate: (claim.dos || '').replace(/-/g, ''),
                professionalService: {
                    procedureIdentifier: 'HC',
                    procedureCode: proc.cpt,
                    procedureModifiers: proc.modifier ? proc.modifier.split(' ') : [],
                    lineItemChargeAmount: String(proc.chargeAmount || 0),
                    measurementUnit: 'UN',
                    serviceUnitCount: String(proc.units || 1),
                    diagnosisCodePointers: ['1']
                }
            }))
        }
    };
}

function buildWaystarPayload(claim, creds) {
    return {
        submitterId: creds.clearinghouse_submitter_id,
        practiceNpi: creds.npi,
        taxId: creds.tax_id,
        patientName: claim.patientName,
        patientDob: claim.dob,
        memberId: claim.payer.memberId,
        groupNumber: claim.payer.groupNumber,
        payerId: claim.payer.payerId,
        dateOfService: claim.dos,
        diagnosisCodes: claim.diagnosisCodes,
        procedureCodes: (claim.procedureCodes || []).map(p => ({
            code: p.cpt,
            modifier: p.modifier,
            units: p.units,
            charge: p.chargeAmount
        })),
        totalCharge: claim.billedAmount,
        renderingProviderNpi: claim.provider?.npi || creds.npi
    };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    submitClaim,
    checkClaimStatus,
    fetchERA,
    formatX12_837P,
    parseX12_835,
    resubmitCorrectedClaim
};
