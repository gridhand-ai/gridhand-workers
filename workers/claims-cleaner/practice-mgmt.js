/**
 * GRIDHAND AI — Claims Cleaner
 * Practice Management System Integration
 *
 * Supports: athenahealth, eClinicalWorks (eCW), Kareo/Tebra
 *
 * All three PMS APIs are normalized to a single ClaimObject format:
 * {
 *   claimId, patientId, patientName, dob, dos, payer, memberId, groupNumber,
 *   provider: { npi, billingNpi, taxonomyCode, name, deaNumber },
 *   diagnosisCodes: ['J45.20', ...],
 *   procedureCodes: [{ cpt, modifier, units, chargeAmount }, ...],
 *   billedAmount, status, rawData
 * }
 */

'use strict';

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ============================================================
// CREDENTIALS
// ============================================================

async function getCredentials(clientSlug) {
    const { data, error } = await supabase
        .from('cc_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error || !data) {
        throw new Error(`[PMS] No connection found for client: ${clientSlug}`);
    }

    return data;
}

// ============================================================
// PMS ROUTING
// ============================================================

async function getPms(clientSlug) {
    const creds = await getCredentials(clientSlug);
    return creds.pms_type;
}

// Build the appropriate HTTP client for the PMS type
function buildPmsClient(creds) {
    const { pms_type, pms_api_key, pms_api_base_url } = creds;

    if (pms_type === 'athena') {
        return axios.create({
            baseURL: pms_api_base_url || 'https://api.athenahealth.com/v1',
            headers: {
                Authorization: `Bearer ${pms_api_key}`,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            timeout: 15000
        });
    }

    if (pms_type === 'ecw') {
        return axios.create({
            baseURL: pms_api_base_url || 'https://your-ecw-instance.eclinicalworks.com/fhir/r4',
            headers: {
                Authorization: `Bearer ${pms_api_key}`,
                'Content-Type': 'application/fhir+json',
                Accept: 'application/fhir+json'
            },
            timeout: 15000
        });
    }

    if (pms_type === 'kareo') {
        return axios.create({
            baseURL: pms_api_base_url || 'https://api.kareo.com/v2',
            headers: {
                'x-kareo-api-key': pms_api_key,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            timeout: 15000
        });
    }

    throw new Error(`[PMS] Unsupported PMS type: ${pms_type}`);
}

// ============================================================
// GET PENDING CLAIMS
// Returns claims in "ready to bill" status from each PMS
// ============================================================

async function getPendingClaims(clientSlug) {
    const creds = await getCredentials(clientSlug);
    const client = buildPmsClient(creds);

    if (creds.pms_type === 'athena') {
        const { data } = await client.get(`/${creds.pms_practice_id}/claims`, {
            params: { status: 'READYTOBILL', limit: 200 }
        });
        const claims = data.claims || [];
        return claims.map(c => normalizeAthenaClaim(c));
    }

    if (creds.pms_type === 'ecw') {
        // eCW FHIR: ClaimResponse in "active" status
        const { data } = await client.get('/Claim', {
            params: { status: 'active', _count: 200 }
        });
        const entries = data.entry || [];
        return entries.map(e => normalizeEcwClaim(e.resource));
    }

    if (creds.pms_type === 'kareo') {
        const { data } = await client.get('/claims', {
            params: { status: 'ReadyToBill', page_size: 200 }
        });
        const claims = data.data || [];
        return claims.map(c => normalizeKareoClaim(c));
    }

    return [];
}

// ============================================================
// GET CLAIM BY ID
// ============================================================

async function getClaimById(clientSlug, claimId) {
    const creds = await getCredentials(clientSlug);
    const client = buildPmsClient(creds);

    if (creds.pms_type === 'athena') {
        const { data } = await client.get(`/${creds.pms_practice_id}/claims/${claimId}`);
        return normalizeAthenaClaim(data);
    }

    if (creds.pms_type === 'ecw') {
        const { data } = await client.get(`/Claim/${claimId}`);
        return normalizeEcwClaim(data);
    }

    if (creds.pms_type === 'kareo') {
        const { data } = await client.get(`/claims/${claimId}`);
        return normalizeKareoClaim(data);
    }

    throw new Error(`[PMS] Cannot fetch claim: unsupported PMS type ${creds.pms_type}`);
}

// ============================================================
// GET PATIENT INFO
// ============================================================

async function getPatientInfo(clientSlug, patientId) {
    const creds = await getCredentials(clientSlug);
    const client = buildPmsClient(creds);

    if (creds.pms_type === 'athena') {
        const [patientRes, insRes] = await Promise.all([
            client.get(`/${creds.pms_practice_id}/patients/${patientId}`),
            client.get(`/${creds.pms_practice_id}/patients/${patientId}/insurances`)
        ]);
        return normalizeAthenaPatient(patientRes.data, insRes.data?.insurances?.[0]);
    }

    if (creds.pms_type === 'ecw') {
        const [patientRes, coverageRes] = await Promise.all([
            client.get(`/Patient/${patientId}`),
            client.get(`/Coverage?patient=${patientId}&status=active`)
        ]);
        return normalizeEcwPatient(patientRes.data, coverageRes.data?.entry?.[0]?.resource);
    }

    if (creds.pms_type === 'kareo') {
        const { data } = await client.get(`/patients/${patientId}`, {
            params: { include: 'insurances' }
        });
        return normalizeKareoPatient(data);
    }

    throw new Error(`[PMS] Cannot fetch patient: unsupported PMS type ${creds.pms_type}`);
}

// ============================================================
// GET PROVIDER INFO
// ============================================================

async function getProviderInfo(clientSlug, providerId) {
    const creds = await getCredentials(clientSlug);
    const client = buildPmsClient(creds);

    if (creds.pms_type === 'athena') {
        const { data } = await client.get(`/${creds.pms_practice_id}/providers/${providerId}`);
        return {
            providerId,
            name: `${data.firstname} ${data.lastname}`,
            npi: data.npi,
            billingNpi: data.billnpi || data.npi,
            taxonomyCode: data.specialtytaxonomycode,
            deaNumber: data.deanumber,
            specialty: data.specialtyname
        };
    }

    if (creds.pms_type === 'ecw') {
        const { data } = await client.get(`/Practitioner/${providerId}`);
        const npiIdentifier = (data.identifier || []).find(i => i.system === 'http://hl7.org/fhir/sid/us-npi');
        const taxIdentifier = (data.identifier || []).find(i => i.system.includes('taxonomy'));
        return {
            providerId,
            name: data.name?.[0]?.text || '',
            npi: npiIdentifier?.value,
            billingNpi: npiIdentifier?.value,
            taxonomyCode: taxIdentifier?.value,
            deaNumber: null,
            specialty: data.qualification?.[0]?.code?.text
        };
    }

    if (creds.pms_type === 'kareo') {
        const { data } = await client.get(`/providers/${providerId}`);
        return {
            providerId,
            name: `${data.first_name} ${data.last_name}`,
            npi: data.npi,
            billingNpi: data.billing_npi || data.npi,
            taxonomyCode: data.taxonomy_code,
            deaNumber: data.dea_number,
            specialty: data.specialty
        };
    }

    throw new Error(`[PMS] Cannot fetch provider: unsupported PMS type ${creds.pms_type}`);
}

// ============================================================
// UPDATE CLAIM STATUS
// ============================================================

async function updateClaimStatus(clientSlug, claimId, status, notes) {
    const creds = await getCredentials(clientSlug);
    const client = buildPmsClient(creds);

    if (creds.pms_type === 'athena') {
        await client.put(`/${creds.pms_practice_id}/claims/${claimId}`, {
            status,
            notes
        });
        return { ok: true };
    }

    if (creds.pms_type === 'ecw') {
        await client.patch(`/Claim/${claimId}`, {
            resourceType: 'Claim',
            status: status === 'submitted' ? 'active' : 'cancelled',
            note: [{ text: notes }]
        });
        return { ok: true };
    }

    if (creds.pms_type === 'kareo') {
        await client.patch(`/claims/${claimId}`, { status, notes });
        return { ok: true };
    }

    return { ok: false, error: 'Unsupported PMS type' };
}

// ============================================================
// SUBMIT CORRECTED CLAIM
// ============================================================

async function submitCorrectedClaim(clientSlug, claimId, corrections) {
    const creds = await getCredentials(clientSlug);
    const client = buildPmsClient(creds);

    if (creds.pms_type === 'athena') {
        const { data } = await client.post(`/${creds.pms_practice_id}/claims/${claimId}/resubmit`, {
            corrections
        });
        return { ok: true, newClaimId: data.claimid };
    }

    if (creds.pms_type === 'ecw') {
        // FHIR: create new Claim resource referencing original
        const correctedClaim = {
            resourceType: 'Claim',
            ...corrections,
            related: [{ claim: { reference: `Claim/${claimId}` }, relationship: { coding: [{ code: 'prior' }] } }]
        };
        const { data } = await client.post('/Claim', correctedClaim);
        return { ok: true, newClaimId: data.id };
    }

    if (creds.pms_type === 'kareo') {
        const { data } = await client.put(`/claims/${claimId}/correct`, corrections);
        return { ok: true, newClaimId: data.id };
    }

    return { ok: false, error: 'Unsupported PMS type' };
}

// ============================================================
// NORMALIZERS — convert each PMS format to ClaimObject
// ============================================================

function normalizeAthenaClaim(raw) {
    const procedures = (raw.chargeentries || []).map(e => ({
        cpt: e.procedurecode,
        modifier: (e.modifiers || []).join(' '),
        units: parseInt(e.procedurecount || 1),
        chargeAmount: parseFloat(e.chargeamount || 0)
    }));

    return {
        claimId: raw.claimid,
        patientId: raw.patientid,
        patientName: `${raw.firstname || ''} ${raw.lastname || ''}`.trim(),
        dob: raw.dob,
        dos: raw.servicedate,
        payer: {
            payerId: raw.insuranceid,
            payerName: raw.insurancename,
            memberId: raw.memberId || raw.insurancememberid,
            groupNumber: raw.insurancegroupnumber,
            coverageStartDate: raw.insurancestartdate
        },
        provider: {
            npi: raw.rendering_npi,
            billingNpi: raw.billing_npi,
            taxonomyCode: raw.taxonomycode,
            name: raw.providername,
            deaNumber: raw.deanumber
        },
        diagnosisCodes: (raw.diagnosiskeys || '').split(',').map(d => d.trim()).filter(Boolean),
        procedureCodes: procedures,
        billedAmount: procedures.reduce((s, p) => s + p.chargeAmount, 0),
        status: raw.claimstatus,
        rawData: raw
    };
}

function normalizeEcwClaim(raw) {
    // FHIR R4 Claim resource
    const procedures = (raw.item || []).map(item => ({
        cpt: item.productOrService?.coding?.[0]?.code,
        modifier: (item.modifier || []).map(m => m.coding?.[0]?.code).filter(Boolean).join(' '),
        units: item.quantity?.value || 1,
        chargeAmount: item.unitPrice?.value || 0
    }));

    const insurance = raw.insurance?.[0];
    const coverage = insurance?.coverage;

    return {
        claimId: raw.id,
        patientId: raw.patient?.reference?.replace('Patient/', ''),
        patientName: raw.patient?.display || '',
        dob: null, // fetched separately from Patient resource
        dos: raw.billablePeriod?.start,
        payer: {
            payerId: insurance?.identifier?.value,
            payerName: raw.insurer?.display,
            memberId: coverage?.reference,
            groupNumber: null,
            coverageStartDate: null
        },
        provider: {
            npi: raw.provider?.identifier?.[0]?.value,
            billingNpi: raw.provider?.identifier?.[0]?.value,
            taxonomyCode: null,
            name: raw.provider?.display,
            deaNumber: null
        },
        diagnosisCodes: (raw.diagnosis || []).map(d => d.diagnosisCodeableConcept?.coding?.[0]?.code).filter(Boolean),
        procedureCodes: procedures,
        billedAmount: raw.total?.value || procedures.reduce((s, p) => s + p.chargeAmount, 0),
        status: raw.status,
        rawData: raw
    };
}

function normalizeKareoClaim(raw) {
    const procedures = (raw.service_lines || []).map(s => ({
        cpt: s.procedure_code,
        modifier: [s.modifier1, s.modifier2].filter(Boolean).join(' '),
        units: parseInt(s.units || 1),
        chargeAmount: parseFloat(s.charge_amount || 0)
    }));

    return {
        claimId: raw.id,
        patientId: raw.patient_id,
        patientName: `${raw.patient_first_name || ''} ${raw.patient_last_name || ''}`.trim(),
        dob: raw.patient_dob,
        dos: raw.service_start_date,
        payer: {
            payerId: raw.insurance_plan_id,
            payerName: raw.insurance_plan_name,
            memberId: raw.insurance_member_id,
            groupNumber: raw.insurance_group_number,
            coverageStartDate: raw.insurance_coverage_start
        },
        provider: {
            npi: raw.rendering_provider_npi,
            billingNpi: raw.billing_provider_npi,
            taxonomyCode: raw.rendering_provider_taxonomy,
            name: raw.rendering_provider_name,
            deaNumber: raw.rendering_provider_dea
        },
        diagnosisCodes: [raw.diagnosis1, raw.diagnosis2, raw.diagnosis3, raw.diagnosis4]
            .filter(Boolean)
            .map(d => d.trim()),
        procedureCodes: procedures,
        billedAmount: parseFloat(raw.total_charge || 0),
        status: raw.claim_status,
        rawData: raw
    };
}

function normalizeAthenaPatient(raw, insurance) {
    return {
        patientId: raw.patientid,
        firstName: raw.firstname,
        lastName: raw.lastname,
        dob: raw.dob,
        gender: raw.sex,
        address: {
            line1: raw.address1,
            city: raw.city,
            state: raw.state,
            zip: raw.zip
        },
        phone: raw.mobilephone || raw.homephone,
        insurance: insurance ? {
            payerName: insurance.insurancename,
            memberId: insurance.insurancememberid,
            groupNumber: insurance.insurancegroupnumber,
            coverageStart: insurance.eligibilitylastchecked
        } : null
    };
}

function normalizeEcwPatient(raw, coverage) {
    const name = raw.name?.[0] || {};
    const addr = raw.address?.[0] || {};
    return {
        patientId: raw.id,
        firstName: name.given?.[0] || '',
        lastName: name.family || '',
        dob: raw.birthDate,
        gender: raw.gender,
        address: {
            line1: addr.line?.[0],
            city: addr.city,
            state: addr.state,
            zip: addr.postalCode
        },
        phone: raw.telecom?.find(t => t.system === 'phone')?.value,
        insurance: coverage ? {
            payerName: coverage.payor?.[0]?.display,
            memberId: coverage.subscriberId,
            groupNumber: coverage.class?.find(c => c.type?.coding?.[0]?.code === 'group')?.value,
            coverageStart: coverage.period?.start
        } : null
    };
}

function normalizeKareoPatient(raw) {
    const ins = raw.insurances?.[0] || {};
    return {
        patientId: raw.id,
        firstName: raw.first_name,
        lastName: raw.last_name,
        dob: raw.dob,
        gender: raw.gender,
        address: {
            line1: raw.address_line1,
            city: raw.city,
            state: raw.state,
            zip: raw.zip_code
        },
        phone: raw.mobile_phone || raw.home_phone,
        insurance: ins.plan_name ? {
            payerName: ins.plan_name,
            memberId: ins.member_id,
            groupNumber: ins.group_number,
            coverageStart: ins.coverage_start_date
        } : null
    };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    getCredentials,
    getPms,
    getPendingClaims,
    getClaimById,
    getPatientInfo,
    getProviderInfo,
    updateClaimStatus,
    submitCorrectedClaim
};
