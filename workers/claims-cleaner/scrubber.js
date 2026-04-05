/**
 * GRIDHAND AI — Claims Cleaner
 * Claims Scrubbing Engine
 *
 * The core intelligence. Hard-coded rules for 10 categories + Claude haiku
 * for complex case narratives when scrub score < 60.
 *
 * scrubClaim(claim, patientInfo, providerInfo)
 *   → { passed, errors[], warnings[], autoFixable[], autoFixed[], scrubScore }
 *
 * autoCorrectClaim(claim, errors)
 *   → correctedClaim (modifies a copy — original is never mutated)
 *
 * getComplexReviewNarrative(claim, errors)
 *   → string (plain-English explanation for billing staff)
 */

'use strict';

const dayjs = require('dayjs');
const Anthropic = require('@anthropic-ai/sdk');

// ============================================================
// CONSTANTS
// ============================================================

// Timely filing windows per payer category (days)
const TIMELY_FILING_LIMITS = {
    MEDICARE: 365,
    MEDICAID: 365,
    TRICARE: 365,
    BCBS: 180,
    AETNA: 180,
    CIGNA: 180,
    UNITED: 180,
    HUMANA: 180,
    DEFAULT: 90
};

// CPT codes that are mutually exclusive (cannot be billed on same claim without special circumstance)
const MUTUALLY_EXCLUSIVE_PAIRS = [
    ['99213', '99214'], // E&M — can only bill one level per encounter
    ['99203', '99204'],
    ['99204', '99205'],
    ['99213', '99215'],
    ['99202', '99203'],
    ['97010', '97012'], // Hot pack / traction — not typically billable same day same area
    ['27447', '27446'], // Knee replacement bilateral — one code covers both knees
    ['93000', '93010'], // ECG complete vs ECG interp only
    ['93005', '93010']  // ECG tracing vs ECG interp
];

// CPT codes that always require modifier 25 when billed on same day as E&M
const PROCEDURE_REQUIRES_25 = new Set([
    '11055', '11056', '11057', // Callus removal
    '11200', '11201',           // Skin tag removal
    '20600', '20604', '20605', '20606', '20610', // Joint injections
    '29515', '29530', '29540', // Splints/strapping
    '93000',                    // ECG
    '36415',                    // Venipuncture
    '87880', '87804', '87070'   // Rapid tests
]);

// E&M codes that trigger modifier-25 check
const EM_CODES = new Set([
    '99201','99202','99203','99204','99205', // New patient office
    '99211','99212','99213','99214','99215', // Established patient office
    '99221','99222','99223',                 // Hospital admission
    '99231','99232','99233',                 // Subsequent hospital
    '99281','99282','99283','99284','99285'  // ED
]);

// CPT codes that should be bundled into a parent code (not separately billable)
const BUNDLED_CODES = {
    '99213': ['36415'], // Venipuncture bundled into E&M — some payers
    '27447': ['27310', '27320', '27324'], // TKR includes arthrotomy etc
    '43239': ['43235', '43236'],           // EGD with biopsy includes EGD
    '45385': ['45378', '45380']            // Colonoscopy with polypectomy
};

// Valid ICD-10 pattern: Letter (A-Z) + 2 digits + optional .XX... pattern
const ICD10_REGEX = /^[A-Z]\d{2}(\.[A-Z0-9]{1,4})?$/i;

// Valid CPT: 5 digits
const CPT_REGEX = /^\d{5}$/;

// Valid modifier: 2 alphanumeric characters
const MODIFIER_REGEX = /^[A-Z0-9]{2}$/i;

// Valid NPI: 10 digits only
const NPI_REGEX = /^\d{10}$/;

// ============================================================
// MAIN SCRUB FUNCTION
// ============================================================

async function scrubClaim(claim, patientInfo, providerInfo) {
    const errors = [];
    const warnings = [];
    const autoFixable = [];

    // Run all rule categories
    checkDemographics(claim, patientInfo, errors, warnings, autoFixable);
    checkProviderInfo(claim, providerInfo, errors, warnings, autoFixable);
    checkInsurance(claim, patientInfo, errors, warnings, autoFixable);
    checkDates(claim, errors, warnings, autoFixable);
    checkDiagnosisCodes(claim, errors, warnings, autoFixable);
    checkProcedureCodes(claim, errors, warnings, autoFixable);
    checkCodeCombinations(claim, errors, warnings, autoFixable);
    checkMedicalNecessity(claim, errors, warnings);
    checkBundling(claim, errors, warnings, autoFixable);

    // Scrub score: start at 100, deduct for errors (5 pts) and warnings (1 pt)
    const rawScore = 100 - (errors.length * 5) - (warnings.length * 1);
    const scrubScore = Math.max(0, rawScore);

    const passed = errors.length === 0;

    return {
        passed,
        errors,
        warnings,
        autoFixable,
        autoFixed: [], // populated by autoCorrectClaim
        scrubScore
    };
}

// ============================================================
// RULE CATEGORY 1 — DEMOGRAPHICS
// ============================================================

function checkDemographics(claim, patientInfo, errors, warnings, autoFixable) {
    const patient = patientInfo || {};

    // Patient name present
    if (!claim.patientName && !patient.firstName) {
        errors.push({ code: 'DEMO_001', field: 'patientName', message: 'Patient name is missing' });
    }

    // DOB present and valid
    const dob = claim.dob || patient.dob;
    if (!dob) {
        errors.push({ code: 'DEMO_002', field: 'dob', message: 'Patient date of birth is missing' });
    } else if (!dayjs(dob).isValid()) {
        errors.push({ code: 'DEMO_003', field: 'dob', message: `Patient DOB is invalid: ${dob}` });
        autoFixable.push({ code: 'DEMO_003', action: 'flag_for_manual', field: 'dob' });
    } else if (dayjs(dob).isAfter(dayjs())) {
        errors.push({ code: 'DEMO_004', field: 'dob', message: 'Patient DOB is in the future' });
    } else if (dayjs().diff(dayjs(dob), 'year') > 120) {
        warnings.push({ code: 'DEMO_005', field: 'dob', message: 'Patient age exceeds 120 years — verify DOB' });
    }

    // Address present (required by most payers)
    const addr = patient.address || {};
    if (!addr.line1 && !addr.city) {
        warnings.push({ code: 'DEMO_006', field: 'address', message: 'Patient address is missing — some payers require it' });
    }

    // Invalid characters in name
    if (claim.patientName && /[^A-Za-z\s\-']/.test(claim.patientName)) {
        warnings.push({ code: 'DEMO_007', field: 'patientName', message: 'Patient name contains special characters that may be rejected' });
        autoFixable.push({ code: 'DEMO_007', action: 'strip_invalid_chars', field: 'patientName' });
    }
}

// ============================================================
// RULE CATEGORY 2 — PROVIDER INFO
// ============================================================

function checkProviderInfo(claim, providerInfo, errors, warnings, autoFixable) {
    const provider = claim.provider || providerInfo || {};

    // NPI — 10 digits required
    if (!provider.npi) {
        errors.push({ code: 'PROV_001', field: 'provider.npi', message: 'Rendering provider NPI is missing' });
    } else if (!NPI_REGEX.test(provider.npi)) {
        errors.push({ code: 'PROV_002', field: 'provider.npi', message: `Rendering provider NPI is invalid: ${provider.npi} (must be 10 digits)` });
        autoFixable.push({ code: 'PROV_002', action: 'strip_npi_formatting', field: 'provider.npi' });
    }

    // Billing NPI — must be present and different from rendering when required
    if (provider.billingNpi && provider.npi && provider.billingNpi === provider.npi) {
        warnings.push({ code: 'PROV_003', field: 'provider.billingNpi', message: 'Billing NPI and rendering NPI are the same — verify if group billing NPI is needed' });
    }

    // Taxonomy code required by Medicare and most payers
    if (!provider.taxonomyCode) {
        warnings.push({ code: 'PROV_004', field: 'provider.taxonomyCode', message: 'Provider taxonomy code is missing — required by Medicare' });
    } else if (!/^\d{10}[A-Z]?$/.test(provider.taxonomyCode)) {
        warnings.push({ code: 'PROV_005', field: 'provider.taxonomyCode', message: `Provider taxonomy code format looks invalid: ${provider.taxonomyCode}` });
    }
}

// ============================================================
// RULE CATEGORY 3 — INSURANCE
// ============================================================

function checkInsurance(claim, patientInfo, errors, warnings, autoFixable) {
    const payer = claim.payer || {};
    const insurance = patientInfo?.insurance || {};

    // Member ID
    if (!payer.memberId && !insurance.memberId) {
        errors.push({ code: 'INS_001', field: 'payer.memberId', message: 'Insurance member ID is missing' });
    } else {
        const memberId = payer.memberId || insurance.memberId;
        // Strip whitespace / hyphens that some payers reject
        if (/\s/.test(memberId)) {
            warnings.push({ code: 'INS_002', field: 'payer.memberId', message: 'Member ID contains whitespace — may cause rejection' });
            autoFixable.push({ code: 'INS_002', action: 'strip_whitespace', field: 'payer.memberId' });
        }
    }

    // Group number — required by most commercial payers when applicable
    if (!payer.groupNumber && !insurance.groupNumber) {
        warnings.push({ code: 'INS_003', field: 'payer.groupNumber', message: 'Group number is missing — required by many commercial payers' });
    }

    // Payer ID required for electronic submission
    if (!payer.payerId) {
        errors.push({ code: 'INS_004', field: 'payer.payerId', message: 'Payer ID (EDI ID) is missing — required for clearinghouse submission' });
    }
}

// ============================================================
// RULE CATEGORY 4 — DATE CHECKS
// ============================================================

function checkDates(claim, errors, warnings, autoFixable) {
    if (!claim.dos) {
        errors.push({ code: 'DATE_001', field: 'dos', message: 'Date of service is missing' });
        return;
    }

    const dos = dayjs(claim.dos);
    if (!dos.isValid()) {
        errors.push({ code: 'DATE_002', field: 'dos', message: `Date of service is invalid: ${claim.dos}` });
        autoFixable.push({ code: 'DATE_002', action: 'parse_date_format', field: 'dos' });
        return;
    }

    // DOS in future
    if (dos.isAfter(dayjs(), 'day')) {
        errors.push({ code: 'DATE_003', field: 'dos', message: 'Date of service is in the future' });
    }

    // DOS before patient coverage start
    const coverageStart = claim.payer?.coverageStartDate || null;
    if (coverageStart && dos.isBefore(dayjs(coverageStart), 'day')) {
        errors.push({ code: 'DATE_004', field: 'dos', message: `Date of service (${claim.dos}) is before insurance coverage start date (${coverageStart})` });
    }

    // Timely filing check
    const payerName = (claim.payer?.payerName || '').toUpperCase();
    const limit = getTimelyFilingLimit(payerName);
    const daysSinceDos = dayjs().diff(dos, 'day');

    if (daysSinceDos > limit) {
        errors.push({
            code: 'DATE_005',
            field: 'dos',
            message: `Claim may be past timely filing limit. DOS is ${daysSinceDos} days ago; limit for this payer is ${limit} days.`
        });
    } else if (daysSinceDos > limit * 0.8) {
        warnings.push({
            code: 'DATE_006',
            field: 'dos',
            message: `Approaching timely filing deadline. ${limit - daysSinceDos} days remaining (limit: ${limit} days).`
        });
    }
}

function getTimelyFilingLimit(payerName) {
    if (payerName.includes('MEDICARE') || payerName.includes('CMS')) return TIMELY_FILING_LIMITS.MEDICARE;
    if (payerName.includes('MEDICAID')) return TIMELY_FILING_LIMITS.MEDICAID;
    if (payerName.includes('TRICARE') || payerName.includes('CHAMPUS')) return TIMELY_FILING_LIMITS.TRICARE;
    if (payerName.includes('BCBS') || payerName.includes('BLUE CROSS') || payerName.includes('BLUE SHIELD')) return TIMELY_FILING_LIMITS.BCBS;
    if (payerName.includes('AETNA')) return TIMELY_FILING_LIMITS.AETNA;
    if (payerName.includes('CIGNA')) return TIMELY_FILING_LIMITS.CIGNA;
    if (payerName.includes('UNITED') || payerName.includes('UHC') || payerName.includes('OPTUM')) return TIMELY_FILING_LIMITS.UNITED;
    if (payerName.includes('HUMANA')) return TIMELY_FILING_LIMITS.HUMANA;
    return TIMELY_FILING_LIMITS.DEFAULT;
}

// ============================================================
// RULE CATEGORY 5 — DIAGNOSIS CODES
// ============================================================

function checkDiagnosisCodes(claim, errors, warnings, autoFixable) {
    const codes = claim.diagnosisCodes || [];

    if (codes.length === 0) {
        errors.push({ code: 'DX_001', field: 'diagnosisCodes', message: 'No diagnosis codes present — at least one ICD-10 code is required' });
        return;
    }

    // Primary DX required as first code
    // (some systems send with all equal priority — primary should be first)

    codes.forEach((code, idx) => {
        if (!code) {
            errors.push({ code: 'DX_002', field: `diagnosisCodes[${idx}]`, message: `Diagnosis code at position ${idx + 1} is empty` });
            return;
        }

        const trimmed = code.trim();

        // Check for trailing characters / special chars
        if (trimmed !== code) {
            warnings.push({ code: 'DX_003', field: `diagnosisCodes[${idx}]`, message: `Diagnosis code "${code}" has leading/trailing whitespace` });
            autoFixable.push({ code: 'DX_003', action: 'trim_whitespace', field: `diagnosisCodes[${idx}]` });
        }

        // Validate ICD-10 format
        if (!ICD10_REGEX.test(trimmed)) {
            errors.push({ code: 'DX_004', field: `diagnosisCodes[${idx}]`, message: `Diagnosis code "${trimmed}" is not a valid ICD-10 format (expected: A00.0 or A000)` });
        }

        // Check for invalid trailing chars (period at end, double periods, etc.)
        if (/\.\.|\.$/i.test(trimmed)) {
            errors.push({ code: 'DX_005', field: `diagnosisCodes[${idx}]`, message: `Diagnosis code "${trimmed}" has invalid trailing characters` });
            autoFixable.push({ code: 'DX_005', action: 'strip_trailing_period', field: `diagnosisCodes[${idx}]` });
        }
    });

    // Warn on too many codes (most payers allow up to 12 on 837P)
    if (codes.length > 12) {
        warnings.push({ code: 'DX_006', field: 'diagnosisCodes', message: `${codes.length} diagnosis codes present — most payers accept a maximum of 12 on 837P` });
    }
}

// ============================================================
// RULE CATEGORY 6 — PROCEDURE CODES
// ============================================================

function checkProcedureCodes(claim, errors, warnings, autoFixable) {
    const procs = claim.procedureCodes || [];

    if (procs.length === 0) {
        errors.push({ code: 'CPT_001', field: 'procedureCodes', message: 'No procedure codes present — at least one CPT is required' });
        return;
    }

    procs.forEach((proc, idx) => {
        if (!proc.cpt) {
            errors.push({ code: 'CPT_002', field: `procedureCodes[${idx}].cpt`, message: `CPT code at position ${idx + 1} is missing` });
            return;
        }

        // CPT format: 5 digits
        if (!CPT_REGEX.test(proc.cpt)) {
            errors.push({ code: 'CPT_003', field: `procedureCodes[${idx}].cpt`, message: `CPT code "${proc.cpt}" is invalid — must be 5 digits` });
        }

        // Modifier format: 2 alphanumeric
        if (proc.modifier) {
            const mods = proc.modifier.trim().split(/\s+/);
            mods.forEach((mod, mIdx) => {
                if (mod && !MODIFIER_REGEX.test(mod)) {
                    errors.push({ code: 'CPT_004', field: `procedureCodes[${idx}].modifier`, message: `Modifier "${mod}" is invalid — must be 2 alphanumeric characters` });
                }
            });
        }

        // Units must be > 0
        if (!proc.units || parseInt(proc.units) <= 0) {
            errors.push({ code: 'CPT_005', field: `procedureCodes[${idx}].units`, message: `Units for CPT ${proc.cpt} must be greater than 0` });
            autoFixable.push({ code: 'CPT_005', action: 'set_units_to_one', field: `procedureCodes[${idx}].units` });
        }

        // Unusually high units — warn
        if (proc.units && parseInt(proc.units) > 12) {
            warnings.push({ code: 'CPT_006', field: `procedureCodes[${idx}].units`, message: `CPT ${proc.cpt} has ${proc.units} units — verify this is correct` });
        }

        // Charge amount should be > 0
        if (!proc.chargeAmount || parseFloat(proc.chargeAmount) <= 0) {
            errors.push({ code: 'CPT_007', field: `procedureCodes[${idx}].chargeAmount`, message: `Charge amount for CPT ${proc.cpt} must be greater than 0` });
        }
    });
}

// ============================================================
// RULE CATEGORY 7 — CODE COMBINATIONS
// ============================================================

function checkCodeCombinations(claim, errors, warnings, autoFixable) {
    const procs = claim.procedureCodes || [];
    const cptCodes = new Set(procs.map(p => p.cpt));

    // Check mutually exclusive pairs
    for (const [cpt1, cpt2] of MUTUALLY_EXCLUSIVE_PAIRS) {
        if (cptCodes.has(cpt1) && cptCodes.has(cpt2)) {
            errors.push({
                code: 'COMBO_001',
                field: 'procedureCodes',
                message: `CPT ${cpt1} and CPT ${cpt2} are mutually exclusive and cannot both be billed on the same claim`
            });
        }
    }

    // Check E&M + procedure on same day — requires modifier 25 on E&M
    const hasEM = procs.find(p => EM_CODES.has(p.cpt));
    if (hasEM) {
        for (const proc of procs) {
            if (!EM_CODES.has(proc.cpt) && PROCEDURE_REQUIRES_25.has(proc.cpt)) {
                // E&M is present, procedure that requires 25 is also present
                const emHas25 = hasEM.modifier && hasEM.modifier.includes('25');
                if (!emHas25) {
                    errors.push({
                        code: 'COMBO_002',
                        field: `procedureCodes[E&M modifier]`,
                        message: `E&M code ${hasEM.cpt} requires modifier 25 when billed on the same day as procedure ${proc.cpt}`
                    });
                    autoFixable.push({ code: 'COMBO_002', action: 'add_modifier_25', field: `procedureCodes[E&M].modifier`, cptTarget: hasEM.cpt });
                }
            }
        }

        // Multiple E&M codes — only one allowed per day per provider
        const emCodes = procs.filter(p => EM_CODES.has(p.cpt));
        if (emCodes.length > 1) {
            errors.push({
                code: 'COMBO_003',
                field: 'procedureCodes',
                message: `Multiple E&M codes found (${emCodes.map(e => e.cpt).join(', ')}) — only one E&M per encounter is allowed`
            });
        }
    }
}

// ============================================================
// RULE CATEGORY 8 — MEDICAL NECESSITY (high-level)
// ============================================================

function checkMedicalNecessity(claim, errors, warnings) {
    const diagCodes = claim.diagnosisCodes || [];
    const procs = claim.procedureCodes || [];

    if (diagCodes.length === 0 || procs.length === 0) return;

    // High-level category mismatch detection
    // If all diagnosis codes start with Z (screening / preventive) but
    // procedures include major surgical CPTs — flag for review
    const allPreventive = diagCodes.every(code => /^Z/i.test(code));
    const hasMajorSurgical = procs.some(p => {
        const cptNum = parseInt(p.cpt);
        return cptNum >= 10000 && cptNum <= 69999; // Surgery section of CPT
    });

    if (allPreventive && hasMajorSurgical) {
        warnings.push({
            code: 'MED_001',
            field: 'diagnosisCodes',
            message: 'All diagnosis codes are preventive/screening (Z-codes) but surgical procedure codes are present — verify medical necessity documentation'
        });
    }

    // Mental health procedure with non-mental-health DX
    const mentalHealthCPTs = new Set(['90832','90834','90837','90838','90839','90847','90853','90791']);
    const hasMentalHealthCPT = procs.some(p => mentalHealthCPTs.has(p.cpt));
    if (hasMentalHealthCPT) {
        const hasMentalDx = diagCodes.some(code => /^[FG]/i.test(code));
        if (!hasMentalDx) {
            warnings.push({
                code: 'MED_002',
                field: 'diagnosisCodes',
                message: 'Mental health procedure codes present but no mental health diagnosis (F or G codes) found'
            });
        }
    }

    // Radiology procedure without supporting DX
    const radiologyCPTs = procs.filter(p => {
        const n = parseInt(p.cpt);
        return n >= 70000 && n <= 79999;
    });
    if (radiologyCPTs.length > 0 && diagCodes.length === 1 && /^Z00/i.test(diagCodes[0])) {
        warnings.push({
            code: 'MED_003',
            field: 'diagnosisCodes',
            message: `Radiology procedure (${radiologyCPTs.map(p => p.cpt).join(', ')}) with only a routine exam diagnosis — payer may require a specific symptom or finding code`
        });
    }
}

// ============================================================
// RULE CATEGORY 9 — DUPLICATE DETECTION
// (Checked at the DB level in the calling code, but flagged here if raw claim data suggests it)
// ============================================================

// Note: True duplicate detection requires DB lookup (done in jobs.js / index.js).
// This function checks if the claim itself has duplicate service lines.

function checkBundling(claim, errors, warnings, autoFixable) {
    const procs = claim.procedureCodes || [];
    const cptCodes = procs.map(p => p.cpt);

    // Check for bundled code violations
    for (const [parentCpt, bundledSet] of Object.entries(BUNDLED_CODES)) {
        if (cptCodes.includes(parentCpt)) {
            for (const bundledCpt of bundledSet) {
                if (cptCodes.includes(bundledCpt)) {
                    errors.push({
                        code: 'BUNDLE_001',
                        field: 'procedureCodes',
                        message: `CPT ${bundledCpt} is bundled into CPT ${parentCpt} and should not be billed separately — payer will likely deny as inclusive procedure`
                    });
                    autoFixable.push({ code: 'BUNDLE_001', action: 'remove_bundled_code', field: 'procedureCodes', cptToRemove: bundledCpt });
                }
            }
        }
    }

    // Duplicate CPT codes on same claim (same CPT billed twice without good reason)
    const cptCounts = {};
    for (const cpt of cptCodes) {
        cptCounts[cpt] = (cptCounts[cpt] || 0) + 1;
    }
    for (const [cpt, count] of Object.entries(cptCounts)) {
        if (count > 1) {
            warnings.push({
                code: 'BUNDLE_002',
                field: 'procedureCodes',
                message: `CPT ${cpt} appears ${count} times on the same claim — verify this is correct (consider increasing units instead)`
            });
        }
    }
}

// ============================================================
// AUTO-CORRECT CLAIM
// Returns a new claim object with fixable issues corrected.
// Original is NOT mutated.
// ============================================================

function autoCorrectClaim(claim, errors) {
    const corrected = JSON.parse(JSON.stringify(claim)); // deep copy
    const corrections = [];

    for (const error of errors) {
        switch (error.code) {
            case 'DEMO_007':
                // Strip invalid characters from patient name
                if (corrected.patientName) {
                    const cleaned = corrected.patientName.replace(/[^A-Za-z\s\-']/g, '').trim();
                    if (cleaned !== corrected.patientName) {
                        corrections.push({ code: error.code, field: 'patientName', before: corrected.patientName, after: cleaned });
                        corrected.patientName = cleaned;
                    }
                }
                break;

            case 'PROV_002':
                // Strip non-digit chars from NPI
                if (corrected.provider?.npi) {
                    const cleanNpi = corrected.provider.npi.replace(/\D/g, '');
                    if (cleanNpi !== corrected.provider.npi) {
                        corrections.push({ code: error.code, field: 'provider.npi', before: corrected.provider.npi, after: cleanNpi });
                        corrected.provider.npi = cleanNpi;
                    }
                }
                break;

            case 'INS_002':
                // Strip whitespace from member ID
                if (corrected.payer?.memberId) {
                    const cleanId = corrected.payer.memberId.replace(/\s/g, '');
                    corrections.push({ code: error.code, field: 'payer.memberId', before: corrected.payer.memberId, after: cleanId });
                    corrected.payer.memberId = cleanId;
                }
                break;

            case 'DATE_002':
                // Attempt to parse and reformat date
                if (corrected.dos) {
                    const parsed = dayjs(corrected.dos);
                    if (parsed.isValid()) {
                        const formatted = parsed.format('YYYY-MM-DD');
                        corrections.push({ code: error.code, field: 'dos', before: corrected.dos, after: formatted });
                        corrected.dos = formatted;
                    }
                }
                break;

            case 'DX_003':
            case 'DX_005': {
                // Trim whitespace and strip trailing periods from dx codes
                if (corrected.diagnosisCodes) {
                    corrected.diagnosisCodes = corrected.diagnosisCodes.map(code => {
                        if (!code) return code;
                        const cleaned = code.trim().replace(/\.+$/, '').toUpperCase();
                        if (cleaned !== code) {
                            corrections.push({ code: error.code, field: 'diagnosisCodes', before: code, after: cleaned });
                        }
                        return cleaned;
                    });
                }
                break;
            }

            case 'CPT_005':
                // Set missing units to 1
                if (corrected.procedureCodes) {
                    corrected.procedureCodes = corrected.procedureCodes.map(proc => {
                        if (!proc.units || parseInt(proc.units) <= 0) {
                            corrections.push({ code: error.code, field: 'procedureCodes.units', before: proc.units, after: 1, cpt: proc.cpt });
                            return { ...proc, units: 1 };
                        }
                        return proc;
                    });
                }
                break;

            case 'COMBO_002':
                // Add modifier 25 to the E&M code
                if (corrected.procedureCodes && error.cptTarget) {
                    corrected.procedureCodes = corrected.procedureCodes.map(proc => {
                        if (EM_CODES.has(proc.cpt)) {
                            const currentMods = proc.modifier ? proc.modifier.trim() : '';
                            const has25 = currentMods.includes('25');
                            if (!has25) {
                                const newMod = currentMods ? `${currentMods} 25`.trim() : '25';
                                corrections.push({ code: error.code, field: 'procedureCodes.modifier', before: proc.modifier, after: newMod, cpt: proc.cpt });
                                return { ...proc, modifier: newMod };
                            }
                        }
                        return proc;
                    });
                } else if (corrected.procedureCodes) {
                    // No specific target — add to first E&M found
                    corrected.procedureCodes = corrected.procedureCodes.map(proc => {
                        if (EM_CODES.has(proc.cpt)) {
                            const currentMods = proc.modifier ? proc.modifier.trim() : '';
                            if (!currentMods.includes('25')) {
                                const newMod = currentMods ? `${currentMods} 25`.trim() : '25';
                                corrections.push({ code: error.code, field: 'procedureCodes.modifier', before: proc.modifier, after: newMod, cpt: proc.cpt });
                                return { ...proc, modifier: newMod };
                            }
                        }
                        return proc;
                    });
                }
                break;

            case 'BUNDLE_001':
                // Remove the bundled code
                if (corrected.procedureCodes && error.cptToRemove) {
                    const before = corrected.procedureCodes.length;
                    corrected.procedureCodes = corrected.procedureCodes.filter(p => p.cpt !== error.cptToRemove);
                    if (corrected.procedureCodes.length < before) {
                        corrections.push({ code: error.code, field: 'procedureCodes', action: `Removed bundled code ${error.cptToRemove}` });
                    }
                }
                break;
        }
    }

    return { corrected, corrections };
}

// ============================================================
// CLAUDE HAIKU — COMPLEX REVIEW NARRATIVE
// Used when scrub score < 60 to explain issues in plain English
// ============================================================

async function getComplexReviewNarrative(claim, errors, warnings) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return 'Manual review required — multiple claim errors detected.';

    const client = new Anthropic({ apiKey });

    const allIssues = [...errors, ...warnings].map(e => `- [${e.code}] ${e.message}`).join('\n');
    const claimSummary = `
Patient: ${claim.patientName || 'Unknown'}
DOS: ${claim.dos || 'Missing'}
Payer: ${claim.payer?.payerName || 'Unknown'}
Procedures: ${(claim.procedureCodes || []).map(p => p.cpt).join(', ') || 'None'}
Diagnoses: ${(claim.diagnosisCodes || []).join(', ') || 'None'}
`.trim();

    const prompt = `You are a medical billing expert reviewing a claim with multiple scrubbing errors. Explain the following issues in clear, plain English for a billing coordinator who needs to correct this claim before resubmission. Be specific and actionable. Keep your response under 200 words.

CLAIM SUMMARY:
${claimSummary}

ISSUES FOUND:
${allIssues}

Provide a concise explanation of what's wrong and what the billing staff needs to do to fix it.`;

    try {
        const msg = await client.messages.create({
            model: 'claude-haiku-4-5',
            max_tokens: 400,
            messages: [{ role: 'user', content: prompt }]
        });
        return msg.content[0]?.text || 'Review required — see error list.';
    } catch (err) {
        console.error('[Scrubber] Claude haiku error:', err.message);
        return `Review required — ${errors.length} error(s) and ${warnings.length} warning(s) detected. See error list for details.`;
    }
}

// ============================================================
// TIMELY FILING CALC (exported for use in index.js)
// ============================================================

function calculateTimelyFiling(payerName, dos) {
    const limit = getTimelyFilingLimit((payerName || '').toUpperCase());
    const daysSinceDos = dayjs().diff(dayjs(dos), 'day');
    return {
        limit,
        daysSinceDos,
        daysRemaining: Math.max(0, limit - daysSinceDos),
        expired: daysSinceDos > limit,
        nearingExpiration: daysSinceDos > limit * 0.8
    };
}

// ============================================================
// BUILD SCRUB REPORT
// ============================================================

function buildScrubReport(original, corrected, errors, warnings, autoFixed) {
    const hasAutoFixes = autoFixed && autoFixed.length > 0;
    const scrubScore = Math.max(0, 100 - (errors.length * 5) - (warnings.length * 1));

    return {
        timestamp: new Date().toISOString(),
        claimId: original.claimId,
        patientName: original.patientName,
        dos: original.dos,
        payer: original.payer?.payerName,
        scrubScore,
        passed: errors.length === 0,
        summary: {
            errorCount: errors.length,
            warningCount: warnings.length,
            autoFixCount: autoFixed?.length || 0
        },
        errors,
        warnings,
        autoCorrections: autoFixed || [],
        correctedClaim: hasAutoFixes ? corrected : null,
        recommendation: errors.length === 0
            ? 'CLEAN — Ready for submission'
            : hasAutoFixes
                ? 'AUTO-CORRECTED — Review corrections and resubmit'
                : 'MANUAL REVIEW REQUIRED — Errors require billing staff action'
    };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    scrubClaim,
    autoCorrectClaim,
    getComplexReviewNarrative,
    calculateTimelyFiling,
    buildScrubReport,
    getTimelyFilingLimit,
    TIMELY_FILING_LIMITS
};
