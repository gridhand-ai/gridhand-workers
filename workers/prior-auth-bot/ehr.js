/**
 * GRIDHAND AI — Prior Auth Bot
 * EHR Integration — Epic FHIR R4 + Cerner FHIR R4
 *
 * OAuth 2.0 SMART on FHIR backend app credentials flow.
 * Normalizes FHIR resources to plain objects before returning.
 */

'use strict';

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// In-memory token cache: clientSlug -> { token, expiresAt }
const tokenCache = {};

// ============================================================
// AUTH — SMART on FHIR client_credentials
// ============================================================

/**
 * getAccessToken(clientSlug)
 * Fetch (or return cached) OAuth bearer token via SMART on FHIR
 * client_credentials flow.
 */
async function getAccessToken(clientSlug) {
    const cached = tokenCache[clientSlug];
    if (cached && cached.expiresAt > Date.now() + 30_000) {
        return cached.token;
    }

    const conn = await loadConnection(clientSlug);
    if (!conn) throw new Error(`No EHR connection found for ${clientSlug}`);

    // Determine token endpoint based on EHR type
    const tokenUrl = conn.ehr_type === 'cerner'
        ? `${conn.ehr_base_url}/oauth2/token`
        : `${conn.ehr_base_url}/oauth2/token`;

    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: conn.ehr_client_id,
        client_secret: conn.ehr_client_secret,
        scope: [
            'system/ServiceRequest.read',
            'system/Patient.read',
            'system/Coverage.read',
            'system/Condition.read',
            'system/Claim.write',
            'system/ClaimResponse.read'
        ].join(' ')
    });

    const response = await axios.post(tokenUrl, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const { access_token, expires_in } = response.data;
    tokenCache[clientSlug] = {
        token: access_token,
        expiresAt: Date.now() + (expires_in * 1000)
    };

    return access_token;
}

// ============================================================
// HELPERS
// ============================================================

async function loadConnection(clientSlug) {
    const { data } = await supabase
        .from('pab_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    return data;
}

async function fhirGet(clientSlug, path, params = {}) {
    const conn = await loadConnection(clientSlug);
    const token = await getAccessToken(clientSlug);
    const baseUrl = conn.ehr_base_url.replace(/\/$/, '');

    const response = await axios.get(`${baseUrl}/api/FHIR/R4${path}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/fhir+json'
        },
        params
    });
    return response.data;
}

async function fhirPost(clientSlug, path, body) {
    const conn = await loadConnection(clientSlug);
    const token = await getAccessToken(clientSlug);
    const baseUrl = conn.ehr_base_url.replace(/\/$/, '');

    const response = await axios.post(`${baseUrl}/api/FHIR/R4${path}`, body, {
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/fhir+json',
            Accept: 'application/fhir+json'
        }
    });
    return response.data;
}

/**
 * Paginate through a FHIR Bundle following bundle.link rel=next
 */
async function fetchAllPages(clientSlug, firstBundle) {
    const resources = extractBundleEntries(firstBundle);
    let bundle = firstBundle;

    while (true) {
        const nextLink = (bundle.link || []).find(l => l.relation === 'next');
        if (!nextLink) break;

        const token = await getAccessToken(clientSlug);
        const response = await axios.get(nextLink.url, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/fhir+json'
            }
        });
        bundle = response.data;
        resources.push(...extractBundleEntries(bundle));
    }

    return resources;
}

function extractBundleEntries(bundle) {
    if (!bundle || !bundle.entry) return [];
    return bundle.entry.map(e => e.resource).filter(Boolean);
}

// ============================================================
// NORMALIZERS — FHIR to plain objects
// ============================================================

function normalizePatient(resource) {
    const name = resource.name?.[0] || {};
    const given = (name.given || []).join(' ');
    const family = name.family || '';
    const phones = (resource.telecom || []).filter(t => t.system === 'phone');
    const addr = resource.address?.[0] || {};

    return {
        id: resource.id,
        fhirId: resource.id,
        name: `${given} ${family}`.trim(),
        dob: resource.birthDate,
        gender: resource.gender,
        phone: phones[0]?.value || null,
        address: [addr.line?.join(' '), addr.city, addr.state, addr.postalCode]
            .filter(Boolean).join(', '),
        mrn: (resource.identifier || []).find(i =>
            i.type?.coding?.some(c => c.code === 'MR'))?.value || null
    };
}

function normalizeCoverage(resource) {
    const payer = resource.payor?.[0];
    return {
        id: resource.id,
        fhirId: resource.id,
        status: resource.status,
        payerReference: payer?.reference || null,
        payerName: payer?.display || null,
        memberId: (resource.identifier || []).find(i =>
            i.type?.coding?.some(c => c.code === 'MB'))?.value
            || resource.subscriberId || null,
        groupNumber: resource.class?.find(c =>
            c.type?.coding?.some(cod => cod.code === 'group'))?.value || null,
        groupName: resource.class?.find(c =>
            c.type?.coding?.some(cod => cod.code === 'group'))?.name || null,
        planName: resource.class?.find(c =>
            c.type?.coding?.some(cod => cod.code === 'plan'))?.name || null,
        subscriberId: resource.subscriberId || null,
        periodStart: resource.period?.start || null,
        periodEnd: resource.period?.end || null
    };
}

function normalizeCondition(resource) {
    const coding = resource.code?.coding?.[0] || {};
    return {
        id: resource.id,
        fhirId: resource.id,
        code: coding.code || null,
        system: coding.system || null,
        display: coding.display || resource.code?.text || null,
        status: resource.clinicalStatus?.coding?.[0]?.code || null,
        onsetDate: resource.onsetDateTime || resource.onsetPeriod?.start || null
    };
}

function normalizeServiceRequest(resource) {
    const coding = resource.code?.coding?.[0] || {};
    return {
        id: resource.id,
        fhirId: resource.id,
        status: resource.status,
        intent: resource.intent,
        patientId: resource.subject?.reference?.split('/').pop() || null,
        procedureCode: coding.code || null,
        procedureSystem: coding.system || null,
        procedureDisplay: coding.display || resource.code?.text || null,
        authoredOn: resource.authoredOn || null,
        priority: resource.priority || 'routine',
        notes: (resource.note || []).map(n => n.text).join('\n') || null,
        // Some EHRs flag auth required here
        authRequired: (resource.extension || []).find(e =>
            e.url?.includes('prior-authorization-required'))?.valueBoolean || false
    };
}

// ============================================================
// CORE FHIR OPERATIONS
// ============================================================

/**
 * getPendingOrders(clientSlug)
 * Fetch ServiceRequest resources with status=active that may need auth.
 */
async function getPendingOrders(clientSlug) {
    const bundle = await fhirGet(clientSlug, '/ServiceRequest', {
        status: 'active',
        intent: 'order',
        _count: 100
    });
    const resources = await fetchAllPages(clientSlug, bundle);
    return resources.map(normalizeServiceRequest);
}

/**
 * getPatient(clientSlug, patientId)
 */
async function getPatient(clientSlug, patientId) {
    const resource = await fhirGet(clientSlug, `/Patient/${patientId}`);
    return normalizePatient(resource);
}

/**
 * getCoverage(clientSlug, patientId)
 * Returns the active coverage record for a patient.
 */
async function getCoverage(clientSlug, patientId) {
    const bundle = await fhirGet(clientSlug, '/Coverage', {
        patient: patientId,
        status: 'active',
        _count: 10
    });
    const resources = extractBundleEntries(bundle);
    if (!resources.length) return null;
    // Return most recent active coverage
    return normalizeCoverage(resources[0]);
}

/**
 * getConditions(clientSlug, patientId)
 * Returns active diagnosis codes for a patient.
 */
async function getConditions(clientSlug, patientId) {
    const bundle = await fhirGet(clientSlug, '/Condition', {
        patient: patientId,
        'clinical-status': 'active',
        _count: 50
    });
    const resources = await fetchAllPages(clientSlug, bundle);
    return resources.map(normalizeCondition);
}

/**
 * createClaim(clientSlug, authData)
 * Submit a FHIR Claim resource with use='preauthorization'.
 *
 * authData: { patientId, patientName, memberId, groupNumber, payerReference,
 *             procedureCodes, diagnosisCodes, npi, requestDate, urgency, clinicalNotes }
 */
async function createClaim(clientSlug, authData) {
    const conn = await loadConnection(clientSlug);

    const priorityMap = { routine: 'normal', urgent: 'stat', emergent: 'stat' };

    const diagnoses = (authData.diagnosisCodes || []).map((code, i) => ({
        sequence: i + 1,
        diagnosisCodeableConcept: {
            coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code }]
        },
        type: [{ coding: [{ code: 'principal' }] }]
    }));

    const items = (authData.procedureCodes || []).map((code, i) => ({
        sequence: i + 1,
        diagnosisSequence: diagnoses.map((_, di) => di + 1),
        productOrService: {
            coding: [{ system: 'http://www.ama-assn.org/go/cpt', code }]
        },
        servicedDate: authData.requestDate || new Date().toISOString().slice(0, 10)
    }));

    const claimResource = {
        resourceType: 'Claim',
        status: 'active',
        use: 'preauthorization',
        priority: { coding: [{ code: priorityMap[authData.urgency] || 'normal' }] },
        patient: { reference: `Patient/${authData.patientId}` },
        created: new Date().toISOString(),
        insurer: authData.payerReference
            ? { reference: authData.payerReference }
            : { display: authData.payerName || 'Unknown Payer' },
        provider: {
            identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: conn.npi }
        },
        insurance: [{
            sequence: 1,
            focal: true,
            coverage: { reference: `Coverage/${authData.coverageFhirId || 'unknown'}` },
            identifier: authData.memberId ? { value: authData.memberId } : undefined
        }],
        diagnosis: diagnoses,
        item: items,
        ...(authData.clinicalNotes ? {
            supportingInfo: [{
                sequence: 1,
                category: { coding: [{ code: 'info' }] },
                valueString: authData.clinicalNotes
            }]
        } : {})
    };

    const result = await fhirPost(clientSlug, '/Claim', claimResource);
    return {
        fhirClaimId: result.id,
        status: result.status,
        resource: result
    };
}

/**
 * updateClaimResponse(clientSlug, orderId, authNumber, status)
 * Write auth result back to EHR as a Task or extension on the order.
 * Uses a FHIR Task resource as a note on the ServiceRequest.
 */
async function updateClaimResponse(clientSlug, orderId, authNumber, status) {
    const taskResource = {
        resourceType: 'Task',
        status: status === 'approved' ? 'completed' : 'failed',
        intent: 'order',
        code: {
            coding: [{ code: 'prior-auth-result', display: 'Prior Authorization Result' }]
        },
        focus: { reference: `ServiceRequest/${orderId}` },
        authoredOn: new Date().toISOString(),
        lastModified: new Date().toISOString(),
        note: [{
            text: `Prior authorization ${status}. Auth number: ${authNumber || 'N/A'}`
        }],
        ...(authNumber ? {
            output: [{
                type: { coding: [{ code: 'auth-number' }] },
                valueString: authNumber
            }]
        } : {})
    };

    const result = await fhirPost(clientSlug, '/Task', taskResource);
    return { ok: true, taskId: result.id };
}

module.exports = {
    getAccessToken,
    getPendingOrders,
    getPatient,
    getCoverage,
    getConditions,
    createClaim,
    updateClaimResponse
};
