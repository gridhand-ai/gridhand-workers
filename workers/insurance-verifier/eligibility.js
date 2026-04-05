/**
 * GRIDHAND AI — Insurance Verifier
 * Eligibility Verification Engine
 *
 * Supported providers:
 *   - Vyne Dental    — REST/JSON API
 *   - DentalXChange  — ANSI X12 270/271 EDI (wrapped in their REST API)
 *
 * Exports:
 *   verifyEligibility(clientSlug, patientInfo, insuranceInfo, procedures)
 *   calculatePatientPortion(coverageDetails, procedures)
 *   checkForFlags(coverageDetails, appointmentDate)
 *   formatCostEstimateMessage(conn, patient, appointmentDate, estimate)
 *   sendVerificationToStaff(conn, results)
 */

'use strict';

const axios = require('axios');
const twilio = require('twilio');
const dayjs = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// ============================================================
// ADA CODE CLASSIFICATION
// Determines coverage tier for patient portion calculation
// ============================================================

// Preventive: typically 100% covered (cleanings, exams, X-rays)
const PREVENTIVE_CODES = new Set([
    'D0120', 'D0140', 'D0150', 'D0180',  // Exams
    'D0210', 'D0220', 'D0230', 'D0240', 'D0250', 'D0270', 'D0272', 'D0274', 'D0277', // X-rays
    'D0330', 'D0340', 'D0350',            // Panoramic/ceph
    'D1110', 'D1120', 'D1206', 'D1208',  // Cleanings / fluoride
    'D1351', 'D1352', 'D1353',            // Sealants
    'D0330'                               // CBCT (often basic but some plans preventive)
]);

// Basic: typically 80% covered (fillings, simple extractions, periodontal)
const BASIC_CODES_PREFIX = ['D2', 'D3', 'D4', 'D7110', 'D7120', 'D7130', 'D7140'];

// Major: typically 50% covered (crowns, bridges, implants, oral surgery)
const MAJOR_CODES_PREFIX = ['D5', 'D6', 'D8', 'D7200', 'D7210', 'D7220', 'D7230', 'D7240', 'D7250'];

function classifyCode(adaCode) {
    if (!adaCode) return 'basic';
    const code = adaCode.toUpperCase().trim();

    if (PREVENTIVE_CODES.has(code)) return 'preventive';

    for (const prefix of MAJOR_CODES_PREFIX) {
        if (code.startsWith(prefix)) return 'major';
    }

    for (const prefix of BASIC_CODES_PREFIX) {
        if (code.startsWith(prefix)) return 'basic';
    }

    return 'basic'; // Default: basic if unknown
}

// ============================================================
// VYNE DENTAL API
// POST /api/v2/eligibility — JSON request/response
// ============================================================

async function vyneVerifyEligibility(conn, patientInfo, insuranceInfo) {
    const client = axios.create({
        baseURL: 'https://api.vynedental.com',
        headers: {
            'Authorization': `Bearer ${conn.eligibility_api_key}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        timeout: 30000
    });

    const payload = {
        renderingNpi: conn.eligibility_npi,
        subscriber: {
            memberId: insuranceInfo.memberId,
            groupNumber: insuranceInfo.groupNumber || '',
            firstName: insuranceInfo.subscriberName
                ? insuranceInfo.subscriberName.split(' ')[0]
                : patientInfo.firstName,
            lastName: insuranceInfo.subscriberName
                ? insuranceInfo.subscriberName.split(' ').slice(1).join(' ') || patientInfo.lastName
                : patientInfo.lastName,
            dateOfBirth: insuranceInfo.subscriberDob || patientInfo.dob,
            relationship: insuranceInfo.relationToSubscriber || 'self'
        },
        patient: {
            firstName: patientInfo.firstName,
            lastName: patientInfo.lastName,
            dateOfBirth: patientInfo.dob
        },
        serviceDate: patientInfo.appointmentDate,
        serviceType: '35' // Dental care service type code
    };

    const { data } = await client.post('/api/v2/eligibility', payload);

    // Normalize Vyne response
    const ben = data.benefits || {};
    const ded = ben.deductible || {};
    const max = ben.annualMaximum || {};

    return {
        eligible: data.eligible === true || data.status === 'active',
        coverageStatus: data.coverageStatus || data.status,
        effectiveDate: ben.effectiveDate || null,
        terminationDate: ben.terminationDate || null,
        deductibleTotal: parseFloat(ded.individual || 0),
        deductibleMet: parseFloat(ded.metAmount || 0),
        deductibleRemaining: parseFloat(ded.remaining || (ded.individual || 0) - (ded.metAmount || 0)),
        annualMaxTotal: parseFloat(max.individual || 0),
        annualMaxUsed: parseFloat(max.used || 0),
        annualMaxRemaining: parseFloat(max.remaining || (max.individual || 0) - (max.used || 0)),
        preventiveCoverage: parseFloat(ben.preventivePercent || ben.preventive || 100),
        basicCoverage: parseFloat(ben.basicPercent || ben.basic || 80),
        majorCoverage: parseFloat(ben.majorPercent || ben.major || 50),
        waitingPeriods: ben.waitingPeriods || [],
        frequencyLimitations: ben.frequencyLimitations || [],
        inNetwork: data.inNetwork !== false,
        rawResponse: data
    };
}

// ============================================================
// DENTALXCHANGE — 270/271 EDI wrapper
// DentalXChange exposes a REST endpoint that accepts JSON
// and returns parsed 271 benefit response
// ============================================================

async function dentalxchangeVerifyEligibility(conn, patientInfo, insuranceInfo) {
    const client = axios.create({
        baseURL: 'https://api.dentalxchange.com',
        headers: {
            'Authorization': `Basic ${conn.eligibility_api_key}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        timeout: 30000
    });

    const payload = {
        tradingPartnerId: insuranceInfo.payerId || '',
        npi: conn.eligibility_npi,
        memberId: insuranceInfo.memberId,
        groupNumber: insuranceInfo.groupNumber || '',
        firstName: patientInfo.firstName,
        lastName: patientInfo.lastName,
        dateOfBirth: patientInfo.dob,
        serviceDate: patientInfo.appointmentDate,
        subscriberFirstName: insuranceInfo.subscriberName
            ? insuranceInfo.subscriberName.split(' ')[0]
            : patientInfo.firstName,
        subscriberLastName: insuranceInfo.subscriberName
            ? insuranceInfo.subscriberName.split(' ').slice(1).join(' ') || patientInfo.lastName
            : patientInfo.lastName,
        subscriberDateOfBirth: insuranceInfo.subscriberDob || patientInfo.dob,
        relationship: insuranceInfo.relationToSubscriber || 'self'
    };

    const { data } = await client.post('/eligibility/v2/inquiry', payload);

    // Normalize DentalXChange 271 response
    const coverage = data.coverageInformation || {};
    const benefits = data.benefits || [];

    const findBenefit = (type, info) => benefits.find(
        b => b.benefitType === type && (!info || b.benefitInformation === info)
    );

    const dedBen = findBenefit('C', 'DY');  // Individual deductible
    const maxBen = findBenefit('F', 'DY');  // Annual maximum

    const deductibleTotal = parseFloat(dedBen?.monetaryAmount || 0);
    const deductibleMet = parseFloat(dedBen?.spendDown || 0);
    const annualMaxTotal = parseFloat(maxBen?.monetaryAmount || 0);
    const annualMaxUsed = parseFloat(maxBen?.spendDown || 0);

    return {
        eligible: coverage.coverageStatus === 'active' || data.eligibleFlag === 'Y',
        coverageStatus: coverage.coverageStatus || 'unknown',
        effectiveDate: coverage.benefitBeginDate || null,
        terminationDate: coverage.benefitEndDate || null,
        deductibleTotal,
        deductibleMet,
        deductibleRemaining: Math.max(0, deductibleTotal - deductibleMet),
        annualMaxTotal,
        annualMaxUsed,
        annualMaxRemaining: Math.max(0, annualMaxTotal - annualMaxUsed),
        preventiveCoverage: parseFloat(findBenefit('PC')?.percent || 100),
        basicCoverage: parseFloat(findBenefit('BC')?.percent || 80),
        majorCoverage: parseFloat(findBenefit('MC')?.percent || 50),
        waitingPeriods: benefits.filter(b => b.waitingPeriod) || [],
        frequencyLimitations: benefits.filter(b => b.timePeriodType) || [],
        inNetwork: coverage.planNetworkType !== 'OON',
        rawResponse: data
    };
}

// ============================================================
// MAIN: verifyEligibility
// ============================================================

/**
 * Verify insurance eligibility for a patient appointment.
 *
 * @param {string} clientSlug
 * @param {object} patientInfo — { firstName, lastName, dob, appointmentDate }
 * @param {object} insuranceInfo — { carrier, memberId, groupNumber, subscriberName, subscriberDob, relationToSubscriber, payerId }
 * @param {Array}  procedures — [{ adaCode, description, fee }]
 * @returns {object} { eligible, deductibleRemaining, maxRemaining, coveragePercent, estimatedPatientPortion, flags, rawResponse }
 */
async function verifyEligibility(clientSlug, patientInfo, insuranceInfo, procedures = []) {
    const { data: conn } = await supabase
        .from('iv_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (!conn) throw new Error(`No connection found for client: ${clientSlug}`);

    let coverage;
    try {
        if (conn.eligibility_provider === 'vyne') {
            coverage = await vyneVerifyEligibility(conn, patientInfo, insuranceInfo);
        } else if (conn.eligibility_provider === 'dentalxchange') {
            coverage = await dentalxchangeVerifyEligibility(conn, patientInfo, insuranceInfo);
        } else {
            throw new Error(`Unsupported eligibility provider: ${conn.eligibility_provider}`);
        }
    } catch (err) {
        return {
            eligible: null,
            deductibleRemaining: null,
            maxRemaining: null,
            coveragePercent: null,
            estimatedPatientPortion: null,
            flags: [{ type: 'api_error', description: `Eligibility API error: ${err.message}` }],
            rawResponse: { error: err.message }
        };
    }

    const patientPortion = calculatePatientPortion(coverage, procedures);
    const flags = checkForFlags(coverage, patientInfo.appointmentDate);

    // Average coverage percent across procedure mix (for display)
    let coveragePercent = coverage.basicCoverage; // Default
    if (procedures.length > 0) {
        const total = procedures.reduce((sum, p) => {
            const tier = classifyCode(p.adaCode);
            const pct = tier === 'preventive' ? coverage.preventiveCoverage
                      : tier === 'major'      ? coverage.majorCoverage
                      :                         coverage.basicCoverage;
            return sum + pct;
        }, 0);
        coveragePercent = total / procedures.length;
    }

    return {
        eligible: coverage.eligible,
        deductibleRemaining: coverage.deductibleRemaining,
        maxRemaining: coverage.annualMaxRemaining,
        coveragePercent: parseFloat(coveragePercent.toFixed(1)),
        estimatedPatientPortion: patientPortion,
        flags,
        rawResponse: coverage.rawResponse
    };
}

// ============================================================
// CALCULATE PATIENT PORTION
// ============================================================

/**
 * Estimate what the patient will owe based on procedures and coverage.
 */
function calculatePatientPortion(coverageDetails, procedures) {
    if (!procedures || procedures.length === 0) return null;
    if (!coverageDetails.eligible) return null;

    let insurancePays = 0;
    let totalFee = 0;

    for (const proc of procedures) {
        const fee = parseFloat(proc.fee || 0);
        if (fee <= 0) continue;

        totalFee += fee;
        const tier = classifyCode(proc.adaCode);

        let pct;
        if (tier === 'preventive') pct = coverageDetails.preventiveCoverage / 100;
        else if (tier === 'major')  pct = coverageDetails.majorCoverage / 100;
        else                        pct = coverageDetails.basicCoverage / 100;

        // In-network vs out-of-network adjustment
        if (!coverageDetails.inNetwork) pct = Math.max(0, pct - 0.20);

        insurancePays += fee * pct;
    }

    if (totalFee === 0) return null;

    // Apply deductible — patient pays remaining deductible first before insurance kicks in
    const deductible = Math.min(
        coverageDetails.deductibleRemaining || 0,
        totalFee
    );
    // Deductible reduces what insurance covers
    const adjustedInsurancePays = Math.max(0, insurancePays - deductible);
    let patientPortion = totalFee - adjustedInsurancePays;

    // Cap by annual max remaining — if max is nearly exhausted, patient owes more
    if (coverageDetails.annualMaxRemaining !== null && coverageDetails.annualMaxRemaining >= 0) {
        const maxCanPay = Math.min(adjustedInsurancePays, coverageDetails.annualMaxRemaining);
        patientPortion = totalFee - maxCanPay;
    }

    return parseFloat(Math.max(0, patientPortion).toFixed(2));
}

// ============================================================
// CHECK FOR FLAGS
// ============================================================

/**
 * Detect coverage issues that require staff attention.
 * Returns array of { type, description }
 */
function checkForFlags(coverageDetails, appointmentDate) {
    const flags = [];

    // 1. Inactive / terminated coverage
    if (!coverageDetails.eligible) {
        flags.push({
            type: 'inactive_coverage',
            description: `Coverage is inactive or terminated (status: ${coverageDetails.coverageStatus || 'unknown'})`
        });
    }

    // 2. Coverage terminated before appointment date
    if (coverageDetails.terminationDate && appointmentDate) {
        if (dayjs(appointmentDate).isAfter(dayjs(coverageDetails.terminationDate))) {
            flags.push({
                type: 'coverage_expired',
                description: `Coverage terminates on ${coverageDetails.terminationDate}, appointment is ${appointmentDate}`
            });
        }
    }

    // 3. Missing deductible info (couldn't determine)
    if (coverageDetails.eligible && coverageDetails.deductibleTotal === 0 && coverageDetails.deductibleRemaining === 0) {
        flags.push({
            type: 'missing_deductible_info',
            description: 'Deductible information not returned — verify manually'
        });
    }

    // 4. Active waiting periods
    if (coverageDetails.waitingPeriods && coverageDetails.waitingPeriods.length > 0) {
        flags.push({
            type: 'waiting_period_active',
            description: `Waiting period(s) active: ${coverageDetails.waitingPeriods.map(w => w.serviceType || w.benefitInformation || JSON.stringify(w)).join('; ')}`
        });
    }

    // 5. Frequency limitations (e.g., 2 cleanings/year already used)
    if (coverageDetails.frequencyLimitations && coverageDetails.frequencyLimitations.length > 0) {
        for (const limit of coverageDetails.frequencyLimitations) {
            if (limit.quantityUsed >= limit.quantityAllowed) {
                flags.push({
                    type: 'frequency_limit_exceeded',
                    description: `Frequency limit reached for ${limit.serviceDescription || limit.benefitInformation || 'procedure'} (${limit.quantityUsed}/${limit.quantityAllowed} used)`
                });
            }
        }
    }

    // 6. Annual max nearly exhausted (< $200 remaining)
    if (
        coverageDetails.annualMaxRemaining !== null &&
        coverageDetails.annualMaxRemaining >= 0 &&
        coverageDetails.annualMaxRemaining < 200
    ) {
        flags.push({
            type: 'annual_max_low',
            description: `Annual maximum nearly exhausted — only $${coverageDetails.annualMaxRemaining.toFixed(2)} remaining`
        });
    }

    // 7. Subscriber info mismatch detection
    // (Handled upstream by callers when subscriber name was empty or mismatched)
    if (!coverageDetails.eligible && coverageDetails.coverageStatus === 'subscriber_not_found') {
        flags.push({
            type: 'subscriber_mismatch',
            description: 'Subscriber not found — verify member ID, DOB, and name with patient'
        });
    }

    return flags;
}

// ============================================================
// FORMAT COST ESTIMATE SMS
// ============================================================

/**
 * Build the patient-facing cost estimate text message.
 */
function formatCostEstimateMessage(conn, patient, appointmentDate, estimate) {
    const formattedDate = dayjs(appointmentDate).format('MMM D');
    const practiceName = conn.practice_name || 'our office';
    const practicePhone = conn.front_desk_phone || conn.owner_phone || '';

    const patientName = patient.firstName || patient.patientName?.split(' ')[0] || 'there';

    if (!estimate.eligible) {
        return `Hi ${patientName}! We checked your insurance for your ${formattedDate} appointment at ${practiceName} and couldn't confirm active coverage. Please call us before your visit: ${practicePhone}`;
    }

    const insuranceAmt = estimate.estimatedPatientPortion !== null
        ? (estimate.totalFee - estimate.estimatedPatientPortion).toFixed(2)
        : null;

    const patientAmt = estimate.estimatedPatientPortion !== null
        ? `~$${estimate.estimatedPatientPortion.toFixed(2)}`
        : 'to be determined';

    let msg = `Hi ${patientName}! Here's your cost estimate for your ${formattedDate} appt at ${practiceName}: `;

    if (insuranceAmt !== null) {
        msg += `Insurance covers approximately $${insuranceAmt}, your portion is ${patientAmt}. `;
    } else {
        msg += `Your estimated portion is ${patientAmt}. `;
    }

    if (estimate.flags && estimate.flags.length > 0) {
        msg += `Note: Our team may reach out about your coverage details. `;
    }

    msg += `Questions? Reply or call ${practicePhone}`;

    return msg;
}

// ============================================================
// SEND VERIFICATION SUMMARY TO STAFF
// ============================================================

/**
 * Send a verification summary SMS to the front desk.
 */
async function sendVerificationToStaff(conn, results) {
    if (!conn.notify_staff_on_flag) return;
    if (!conn.front_desk_phone && !conn.owner_phone) return;

    const to = conn.front_desk_phone || conn.owner_phone;
    const flagged = results.filter(r => r.flags && r.flags.length > 0);
    const inactive = results.filter(r => !r.eligible);

    if (flagged.length === 0 && inactive.length === 0) return; // No issues — no need to ping staff

    const total = results.length;
    let msg = `[GRIDHAND] Insurance Verification Summary — ${total} appt(s) checked.\n`;

    if (inactive.length > 0) {
        msg += `❌ ${inactive.length} INACTIVE/UNVERIFIED:\n`;
        for (const r of inactive.slice(0, 5)) {
            msg += `  • ${r.patientName || r.patientId} (${r.appointmentDate})\n`;
        }
    }

    if (flagged.length > 0) {
        msg += `⚠️ ${flagged.length} FLAGGED:\n`;
        for (const r of flagged.slice(0, 5)) {
            const flagTypes = r.flags.map(f => f.type).join(', ');
            msg += `  • ${r.patientName || r.patientId}: ${flagTypes}\n`;
        }
    }

    msg += `Log in to GRIDHAND for full details.`;

    try {
        await twilioClient.messages.create({
            body: msg.slice(0, 1600),
            from: process.env.TWILIO_FROM_NUMBER,
            to
        });
    } catch (err) {
        console.error(`[Eligibility] Failed to send staff summary to ${to}:`, err.message);
    }
}

module.exports = {
    verifyEligibility,
    calculatePatientPortion,
    checkForFlags,
    formatCostEstimateMessage,
    sendVerificationToStaff
};
