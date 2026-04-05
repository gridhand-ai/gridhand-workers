/**
 * GRIDHAND AI — Recall Commander
 * Dental PMS Integration — Dentrix G6+ REST API & Open Dental REST API
 *
 * Supports two PMS types detected via rc_connections.pms_type:
 *   dentrix      — Dentrix G6+ Henry Schein REST API (api.henryschein.com)
 *   open_dental  — Open Dental self-hosted or cloud REST API
 *
 * Sandbox mode: set DENTAL_SANDBOX=true in env to return fixture data
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const SANDBOX = process.env.DENTAL_SANDBOX === 'true';

// ============================================================
// CREDENTIALS
// ============================================================

/**
 * Fetch connection config for a practice.
 * Returns the full rc_connections row or null.
 */
async function getCredentials(clientSlug) {
    const { data, error } = await supabase
        .from('rc_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('active', true)
        .single();

    if (error || !data) {
        console.error(`[Dentrix] No active connection found for ${clientSlug}:`, error?.message);
        return null;
    }
    return data;
}

// ============================================================
// HTTP CLIENT FACTORY
// ============================================================

/**
 * Build a pre-configured axios instance for the correct PMS API.
 */
function buildApiClient(conn) {
    if (conn.pms_type === 'dentrix') {
        return axios.create({
            baseURL: conn.api_base_url || 'https://api.dentrixenterprise.com/v1',
            headers: {
                'Authorization': `Bearer ${conn.api_key}`,
                'X-Api-Secret': conn.api_secret || '',
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 15000
        });
    }

    // Open Dental uses BasicAuth with a developer API key header
    return axios.create({
        baseURL: conn.api_base_url || 'https://api.opendental.com/api/v1',
        headers: {
            'Authorization': conn.api_key || '',
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        timeout: 15000
    });
}

// ============================================================
// PATIENT FETCHING
// ============================================================

/**
 * Fetch all active patients from the PMS.
 * Returns array of normalized patient objects.
 */
async function getPatients(clientSlug) {
    if (SANDBOX) return _sandboxPatients(clientSlug);

    const conn = await getCredentials(clientSlug);
    if (!conn) return [];

    const client = buildApiClient(conn);

    if (conn.pms_type === 'dentrix') {
        return _dentrixGetPatients(client, conn);
    }
    return _openDentalGetPatients(client, conn);
}

async function _dentrixGetPatients(client, conn) {
    const patients = [];
    let page = 1;
    const pageSize = 200;

    while (true) {
        let resp;
        try {
            resp = await client.get('/patients', {
                params: {
                    status: 'active',
                    page,
                    pageSize
                }
            });
        } catch (err) {
            console.error(`[Dentrix] getPatients page ${page} error:`, err.message);
            break;
        }

        const raw = resp.data?.patients || resp.data?.data || [];
        for (const p of raw) {
            patients.push(_normalizeDentrixPatient(p));
        }

        // Dentrix returns hasNextPage or totalPages in meta
        const meta = resp.data?.meta || resp.data?.pagination || {};
        const totalPages = meta.totalPages || meta.total_pages || 1;
        if (page >= totalPages || raw.length < pageSize) break;
        page++;
    }

    return patients;
}

async function _openDentalGetPatients(client, conn) {
    const patients = [];
    let offset = 0;
    const limit = 200;

    while (true) {
        let resp;
        try {
            resp = await client.get('/patients', {
                params: {
                    Offset: offset,
                    Limit: limit,
                    PatStatus: 'Patient' // Open Dental active patient status
                }
            });
        } catch (err) {
            console.error(`[OpenDental] getPatients offset ${offset} error:`, err.message);
            break;
        }

        const raw = Array.isArray(resp.data) ? resp.data : (resp.data?.patients || []);
        for (const p of raw) {
            patients.push(_normalizeOpenDentalPatient(p));
        }

        if (raw.length < limit) break;
        offset += limit;
    }

    return patients;
}

// ============================================================
// RECALL DUE PATIENTS
// ============================================================

/**
 * Returns patients overdue for hygiene or exam recall.
 * Hygiene: last prophy/cleaning was more than (interval) months ago.
 * Exam: last comprehensive/periodic exam was more than (interval) months ago.
 */
async function getRecallDuePatients(clientSlug) {
    if (SANDBOX) return _sandboxRecallDue(clientSlug);

    const conn = await getCredentials(clientSlug);
    if (!conn) return [];

    const client = buildApiClient(conn);
    const hygieneInterval = conn.recall_hygiene_interval_months || 6;
    const examInterval = conn.recall_exam_interval_months || 12;

    const hygieneCutoff = dayjs().subtract(hygieneInterval, 'month').toDate();
    const examCutoff = dayjs().subtract(examInterval, 'month').toDate();

    if (conn.pms_type === 'dentrix') {
        return _dentrixGetRecallDue(client, hygieneCutoff, examCutoff, hygieneInterval, examInterval);
    }
    return _openDentalGetRecallDue(client, hygieneCutoff, examCutoff, hygieneInterval, examInterval);
}

async function _dentrixGetRecallDue(client, hygieneCutoff, examCutoff, hygieneMonths, examMonths) {
    const results = [];

    // Dentrix recall endpoint returns patients with overdue recall dates
    // We query by recall type and cutoff date
    const recallTypes = [
        { dentrixType: 'PROPHY', ourType: 'hygiene', cutoff: hygieneCutoff, intervalMonths: hygieneMonths },
        { dentrixType: 'EXAM',   ourType: 'exam',    cutoff: examCutoff,    intervalMonths: examMonths }
    ];

    for (const rt of recallTypes) {
        let page = 1;
        while (true) {
            let resp;
            try {
                resp = await client.get('/recall', {
                    params: {
                        recallType: rt.dentrixType,
                        dueBefore: dayjs(rt.cutoff).format('YYYY-MM-DD'),
                        status: 'active',
                        page,
                        pageSize: 200
                    }
                });
            } catch (err) {
                console.error(`[Dentrix] getRecallDue (${rt.dentrixType}) page ${page} error:`, err.message);
                break;
            }

            const raw = resp.data?.patients || resp.data?.data || [];
            for (const p of raw) {
                const patient = _normalizeDentrixPatient(p);
                const lastVisit = p.lastRecallDate || p.lastVisitDate || null;
                const daysOverdue = lastVisit
                    ? Math.floor((Date.now() - new Date(lastVisit).getTime()) / 86400000) - (rt.intervalMonths * 30)
                    : 365;

                if (patient.phone) {
                    results.push({
                        ...patient,
                        recall_type: rt.ourType,
                        last_visit_date: lastVisit ? dayjs(lastVisit).format('YYYY-MM-DD') : null,
                        days_overdue: Math.max(0, daysOverdue)
                    });
                }
            }

            const meta = resp.data?.meta || resp.data?.pagination || {};
            const totalPages = meta.totalPages || 1;
            if (page >= totalPages || raw.length < 200) break;
            page++;
        }
    }

    return results;
}

async function _openDentalGetRecallDue(client, hygieneCutoff, examCutoff, hygieneMonths, examMonths) {
    const results = [];

    // Open Dental: query recall table for overdue entries
    // RecallTypes: 1 = prophylaxis/hygiene, 2 = periodic exam in many configurations
    const recallTypes = [
        { odRecallType: 1, ourType: 'hygiene', cutoff: hygieneCutoff, intervalMonths: hygieneMonths },
        { odRecallType: 2, ourType: 'exam',    cutoff: examCutoff,    intervalMonths: examMonths }
    ];

    for (const rt of recallTypes) {
        let offset = 0;
        while (true) {
            let resp;
            try {
                resp = await client.get('/recalls', {
                    params: {
                        RecallTypeNum: rt.odRecallType,
                        DateDueEnd: dayjs(rt.cutoff).format('YYYY-MM-DD'),
                        Offset: offset,
                        Limit: 200
                    }
                });
            } catch (err) {
                console.error(`[OpenDental] getRecallDue (type ${rt.odRecallType}) error:`, err.message);
                break;
            }

            const raw = Array.isArray(resp.data) ? resp.data : [];

            for (const r of raw) {
                // Fetch patient details for each recall record
                let patientResp;
                try {
                    patientResp = await client.get(`/patients/${r.PatNum}`);
                } catch (_) { continue; }

                const patient = _normalizeOpenDentalPatient(patientResp.data);
                if (!patient.phone) continue;

                const lastVisit = r.DateDue ? dayjs(r.DateDue).subtract(rt.intervalMonths, 'month').format('YYYY-MM-DD') : null;
                const daysOverdue = r.DateDue
                    ? Math.floor((Date.now() - new Date(r.DateDue).getTime()) / 86400000)
                    : 365;

                results.push({
                    ...patient,
                    recall_type: rt.ourType,
                    last_visit_date: lastVisit,
                    days_overdue: Math.max(0, daysOverdue)
                });
            }

            if (raw.length < 200) break;
            offset += 200;
        }
    }

    return results;
}

// ============================================================
// INDIVIDUAL PATIENT LOOKUP
// ============================================================

/**
 * Fetch a single patient by PMS patient ID.
 */
async function getPatientById(clientSlug, patientId) {
    if (SANDBOX) return _sandboxPatients(clientSlug).find(p => p.patient_id === patientId) || null;

    const conn = await getCredentials(clientSlug);
    if (!conn) return null;

    const client = buildApiClient(conn);

    try {
        if (conn.pms_type === 'dentrix') {
            const resp = await client.get(`/patients/${patientId}`);
            return _normalizeDentrixPatient(resp.data);
        } else {
            const resp = await client.get(`/patients/${patientId}`);
            return _normalizeOpenDentalPatient(resp.data);
        }
    } catch (err) {
        console.error(`[Dentrix] getPatientById(${patientId}) error:`, err.message);
        return null;
    }
}

// ============================================================
// UPDATE RECALL STATUS
// ============================================================

/**
 * Push recall status update back to the PMS.
 * status: 'contacted' | 'scheduled' | 'declined'
 */
async function updateRecallStatus(clientSlug, patientId, status) {
    if (SANDBOX) {
        console.log(`[Dentrix SANDBOX] updateRecallStatus: patient=${patientId} status=${status}`);
        return { ok: true };
    }

    const conn = await getCredentials(clientSlug);
    if (!conn) return { ok: false, error: 'No connection found' };

    const client = buildApiClient(conn);

    // Map internal status to PMS-specific values
    const dentrixStatusMap = {
        contacted: 'RECALL_CONTACTED',
        scheduled: 'SCHEDULED',
        declined:  'DECLINED'
    };
    const openDentalStatusMap = {
        contacted: 2,  // RecallStatus: 2 = Contacted
        scheduled: 3,  // 3 = Scheduled
        declined:  4   // 4 = Declined
    };

    try {
        if (conn.pms_type === 'dentrix') {
            await client.patch(`/patients/${patientId}/recall`, {
                recallStatus: dentrixStatusMap[status] || status,
                updatedAt: new Date().toISOString()
            });
        } else {
            await client.put(`/recalls/${patientId}`, {
                RecallStatus: openDentalStatusMap[status] || 0
            });
        }
        return { ok: true };
    } catch (err) {
        console.error(`[Dentrix] updateRecallStatus error:`, err.message);
        return { ok: false, error: err.message };
    }
}

// ============================================================
// NORMALIZERS
// ============================================================

function _normalizeDentrixPatient(p) {
    return {
        patient_id:   String(p.patientId || p.id || p.PatientId || ''),
        patient_name: [p.firstName || p.first_name, p.lastName || p.last_name].filter(Boolean).join(' ').trim()
                      || p.preferredName || p.name || '',
        phone:        _normalizePhone(p.mobilePhone || p.cellPhone || p.homePhone || p.phone || ''),
        email:        p.email || p.emailAddress || null,
        birth_date:   p.birthDate || p.dateOfBirth || null,
        pms_type:     'dentrix'
    };
}

function _normalizeOpenDentalPatient(p) {
    return {
        patient_id:   String(p.PatNum || p.patNum || p.id || ''),
        patient_name: [p.FName || p.fname, p.LName || p.lname].filter(Boolean).join(' ').trim()
                      || p.Preferred || '',
        phone:        _normalizePhone(p.WirelessPhone || p.HmPhone || p.WkPhone || ''),
        email:        p.Email || p.email || null,
        birth_date:   p.Birthdate || p.birthdate || null,
        pms_type:     'open_dental'
    };
}

function _normalizePhone(raw) {
    if (!raw) return '';
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
    return digits.length >= 10 ? `+${digits}` : '';
}

// ============================================================
// SANDBOX FIXTURES
// ============================================================

function _sandboxPatients(clientSlug) {
    return [
        { patient_id: 'pt_001', patient_name: 'Sarah Johnson',  phone: '+14145550101', email: 'sarah@example.com',  birth_date: '1985-04-12', pms_type: 'dentrix' },
        { patient_id: 'pt_002', patient_name: 'Marcus Rivera',  phone: '+14145550102', email: 'marcus@example.com', birth_date: '1978-09-25', pms_type: 'dentrix' },
        { patient_id: 'pt_003', patient_name: 'Linda Chen',     phone: '+14145550103', email: null,                 birth_date: '1992-01-30', pms_type: 'dentrix' },
        { patient_id: 'pt_004', patient_name: 'James Kowalski', phone: '+14145550104', email: null,                 birth_date: '1965-07-08', pms_type: 'dentrix' },
        { patient_id: 'pt_005', patient_name: 'Aisha Williams', phone: '+14145550105', email: 'aisha@example.com',  birth_date: '1990-11-14', pms_type: 'dentrix' }
    ];
}

function _sandboxRecallDue(clientSlug) {
    return [
        { patient_id: 'pt_001', patient_name: 'Sarah Johnson',  phone: '+14145550101', email: 'sarah@example.com',  recall_type: 'hygiene', last_visit_date: '2025-07-15', days_overdue: 48,  pms_type: 'dentrix' },
        { patient_id: 'pt_002', patient_name: 'Marcus Rivera',  phone: '+14145550102', email: 'marcus@example.com', recall_type: 'hygiene', last_visit_date: '2025-06-01', days_overdue: 92,  pms_type: 'dentrix' },
        { patient_id: 'pt_003', patient_name: 'Linda Chen',     phone: '+14145550103', email: null,                 recall_type: 'exam',    last_visit_date: '2024-12-10', days_overdue: 120, pms_type: 'dentrix' },
        { patient_id: 'pt_004', patient_name: 'James Kowalski', phone: '+14145550104', email: null,                 recall_type: 'hygiene', last_visit_date: '2025-05-20', days_overdue: 104, pms_type: 'dentrix' },
        { patient_id: 'pt_005', patient_name: 'Aisha Williams', phone: '+14145550105', email: 'aisha@example.com',  recall_type: 'exam',    last_visit_date: '2025-01-05', days_overdue: 60,  pms_type: 'dentrix' }
    ];
}

module.exports = {
    getCredentials,
    getPatients,
    getRecallDuePatients,
    getPatientById,
    updateRecallStatus
};
