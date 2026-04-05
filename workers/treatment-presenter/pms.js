/**
 * GRIDHAND AI — Treatment Presenter
 * Dental PMS Integration (Dentrix + Open Dental)
 *
 * Functions:
 *   getTreatmentPlans(clientSlug, status)       — get treatment plans by status
 *   getTreatmentPlanById(clientSlug, planId)    — full plan with procedures and fees
 *   getPatientById(clientSlug, patientId)       — patient contact info
 *   updatePlanStatus(clientSlug, planId, status) — mark accepted/declined in PMS
 *   getProcedureCodes()                         — ADA code → human readable lookup table
 */

'use strict';

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ============================================================
// ADA PROCEDURE CODE LOOKUP TABLE (30+ common codes)
// ============================================================

const PROCEDURE_CODES = {
    // Diagnostic
    'D0120': 'Periodic oral evaluation (routine check-up)',
    'D0140': 'Limited oral evaluation (problem-focused exam)',
    'D0150': 'Comprehensive oral evaluation (new patient exam)',
    'D0210': 'Complete series of X-rays (full mouth)',
    'D0220': 'Periapical X-ray (single tooth X-ray)',
    'D0230': 'Additional periapical X-ray',
    'D0240': 'Occlusal X-ray (biting surface X-ray)',
    'D0270': 'Bitewing X-ray (single)',
    'D0272': 'Bitewing X-rays (two images)',
    'D0274': 'Bitewing X-rays (four images)',
    'D0330': 'Panoramic X-ray (full jaw image)',
    'D0350': 'Oral/facial photo documentation',

    // Preventive
    'D1110': 'Adult teeth cleaning (prophylaxis)',
    'D1120': 'Child teeth cleaning (prophylaxis)',
    'D1206': 'Topical fluoride varnish',
    'D1208': 'Topical fluoride application',
    'D1351': 'Dental sealant (decay prevention coating)',
    'D1510': 'Space maintainer (fixed)',

    // Restorative — Fillings
    'D2140': 'Silver filling (1 surface)',
    'D2150': 'Silver filling (2 surfaces)',
    'D2160': 'Silver filling (3 surfaces)',
    'D2161': 'Silver filling (4+ surfaces)',
    'D2330': 'Tooth-colored filling (1 surface, front tooth)',
    'D2331': 'Tooth-colored filling (2 surfaces, front tooth)',
    'D2332': 'Tooth-colored filling (3 surfaces, front tooth)',
    'D2391': 'Tooth-colored filling (1 surface, back tooth)',
    'D2392': 'Tooth-colored filling (2 surfaces, back tooth)',
    'D2393': 'Tooth-colored filling (3 surfaces, back tooth)',
    'D2394': 'Tooth-colored filling (4+ surfaces, back tooth)',

    // Restorative — Crowns
    'D2710': 'Resin crown (temporary)',
    'D2712': 'Resin-based composite crown (CAD/CAM)',
    'D2720': 'Resin-veneer crown on metal base',
    'D2740': 'Porcelain crown (tooth-colored, no metal)',
    'D2750': 'Porcelain-fused-to-metal crown',
    'D2780': 'Cast high-noble metal crown (gold crown)',
    'D2930': 'Prefabricated stainless steel crown (child)',
    'D2950': 'Core build-up (foundation for crown)',
    'D2980': 'Crown repair (patch/fix existing crown)',

    // Endodontics (Root Canal)
    'D3310': 'Root canal treatment (front tooth)',
    'D3320': 'Root canal treatment (bicuspid/premolar)',
    'D3330': 'Root canal treatment (molar)',
    'D3346': 'Retreatment of root canal (front tooth)',
    'D3347': 'Retreatment of root canal (premolar)',
    'D3348': 'Retreatment of root canal (molar)',

    // Periodontics (Gum Treatment)
    'D4341': 'Deep cleaning — scaling and root planing (per quadrant, 4+ teeth)',
    'D4342': 'Deep cleaning — scaling and root planing (per quadrant, 1-3 teeth)',
    'D4355': 'Full mouth debridement (heavy buildup removal)',
    'D4910': 'Periodontal maintenance cleaning',

    // Oral Surgery (Extractions)
    'D7140': 'Simple extraction (erupted tooth)',
    'D7210': 'Surgical extraction (impacted/complex)',
    'D7220': 'Removal of impacted tooth (soft tissue)',
    'D7230': 'Removal of impacted tooth (partially bony)',
    'D7240': 'Removal of impacted tooth (fully bony — wisdom tooth)',

    // Prosthodontics
    'D5110': 'Complete upper denture',
    'D5120': 'Complete lower denture',
    'D5211': 'Partial upper denture (metal framework)',
    'D5212': 'Partial lower denture (metal framework)',
    'D5750': 'Denture reline (upper, lab processed)',
    'D6010': 'Dental implant (surgical placement)',
    'D6065': 'Implant crown (porcelain-fused-to-metal)',
    'D6066': 'Implant crown (gold alloy)',
    'D6067': 'Implant crown (all-porcelain)',

    // Other
    'D9110': 'Palliative treatment (emergency pain relief)',
    'D9930': 'Treatment of complications (post-surgical)',
    'D9940': 'Occlusal guard (night guard for grinding)',
    'D9951': 'Occlusal adjustment (limited)',
    'D9952': 'Occlusal adjustment (complete)'
};

// ============================================================
// HELPER: get connection config from DB
// ============================================================

async function _getConn(clientSlug) {
    const { data } = await supabase
        .from('tp_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    return data || null;
}

// ============================================================
// HELPER: build axios client for PMS API
// ============================================================

function _buildClient(conn) {
    return axios.create({
        baseURL: conn.pms_api_base_url,
        headers: {
            'Authorization': `Bearer ${conn.pms_api_key}`,
            'Content-Type':  'application/json',
            'Accept':        'application/json'
        },
        timeout: 15000
    });
}

// ============================================================
// getTreatmentPlans
// Returns treatment plans from PMS, filtered by status.
// status: 'accepted' | 'pending' | 'rejected' | 'all'
// ============================================================

async function getTreatmentPlans(clientSlug, status = 'pending') {
    const conn = await _getConn(clientSlug);
    if (!conn) throw new Error(`No connection found for client_slug: ${clientSlug}`);

    const client = _buildClient(conn);

    if (conn.pms_type === 'dentrix') {
        return _dentrixGetTreatmentPlans(client, status);
    } else if (conn.pms_type === 'open_dental') {
        return _openDentalGetTreatmentPlans(client, status);
    } else {
        throw new Error(`Unsupported pms_type: ${conn.pms_type}`);
    }
}

async function _dentrixGetTreatmentPlans(client, status) {
    // Dentrix G6+ API: GET /api/treatment-plans?status={status}
    const params = status !== 'all' ? { status } : {};
    const { data } = await client.get('/api/treatment-plans', { params });

    return (data.treatmentPlans || data || []).map(plan => ({
        plan_id:      String(plan.treatmentPlanId || plan.id),
        patient_id:   String(plan.patientId),
        patient_name: plan.patientName || `${plan.firstName || ''} ${plan.lastName || ''}`.trim(),
        status:       (plan.status || 'pending').toLowerCase(),
        total_fee:    parseFloat(plan.totalFee || 0),
        created_date: plan.createdDate || plan.createDate || null,
        procedures:   (plan.procedures || []).map(_normalizeDentrixProcedure)
    }));
}

async function _openDentalGetTreatmentPlans(client, status) {
    // Open Dental REST API: GET /api/v1/tpprocs?status={status}
    const params = status !== 'all' ? { status } : {};
    const { data } = await client.get('/api/v1/tpprocs', { params });

    return (data || []).map(plan => ({
        plan_id:      String(plan.TreatPlanNum || plan.id),
        patient_id:   String(plan.PatNum),
        patient_name: plan.PatientName || '',
        status:       (plan.TPStatus || 'pending').toLowerCase(),
        total_fee:    parseFloat(plan.TotalFee || 0),
        created_date: plan.DateTP || null,
        procedures:   (plan.Procedures || []).map(_normalizeOpenDentalProcedure)
    }));
}

// ============================================================
// getTreatmentPlanById
// Returns full plan detail: procedures, fees, insurance estimates
// ============================================================

async function getTreatmentPlanById(clientSlug, planId) {
    const conn = await _getConn(clientSlug);
    if (!conn) throw new Error(`No connection found for client_slug: ${clientSlug}`);

    const client = _buildClient(conn);

    if (conn.pms_type === 'dentrix') {
        return _dentrixGetPlanById(client, planId);
    } else if (conn.pms_type === 'open_dental') {
        return _openDentalGetPlanById(client, planId);
    } else {
        throw new Error(`Unsupported pms_type: ${conn.pms_type}`);
    }
}

async function _dentrixGetPlanById(client, planId) {
    const { data } = await client.get(`/api/treatment-plans/${planId}`);

    const plan = data.treatmentPlan || data;
    const procedures = (plan.procedures || []).map(_normalizeDentrixProcedure);
    const totals = _calcTotals(procedures);

    return {
        plan_id:                String(plan.treatmentPlanId || plan.id),
        patient_id:             String(plan.patientId),
        patient_name:           plan.patientName || '',
        status:                 (plan.status || 'pending').toLowerCase(),
        procedures,
        total_fee:              totals.total_fee,
        total_insurance_est:    totals.total_insurance_est,
        total_patient_portion:  totals.total_patient_portion,
        created_date:           plan.createdDate || null,
        notes:                  plan.notes || null
    };
}

async function _openDentalGetPlanById(client, planId) {
    const { data } = await client.get(`/api/v1/tpprocs/${planId}`);

    const procedures = (data.Procedures || []).map(_normalizeOpenDentalProcedure);
    const totals = _calcTotals(procedures);

    return {
        plan_id:                String(data.TreatPlanNum || data.id),
        patient_id:             String(data.PatNum),
        patient_name:           data.PatientName || '',
        status:                 (data.TPStatus || 'pending').toLowerCase(),
        procedures,
        total_fee:              totals.total_fee,
        total_insurance_est:    totals.total_insurance_est,
        total_patient_portion:  totals.total_patient_portion,
        created_date:           data.DateTP || null,
        notes:                  data.Note || null
    };
}

// ============================================================
// getPatientById
// Returns patient contact info for SMS delivery
// ============================================================

async function getPatientById(clientSlug, patientId) {
    const conn = await _getConn(clientSlug);
    if (!conn) throw new Error(`No connection found for client_slug: ${clientSlug}`);

    const client = _buildClient(conn);

    if (conn.pms_type === 'dentrix') {
        const { data } = await client.get(`/api/patients/${patientId}`);
        const p = data.patient || data;
        return {
            patient_id:    String(p.patientId || p.id),
            first_name:    p.firstName || '',
            last_name:     p.lastName || '',
            full_name:     `${p.firstName || ''} ${p.lastName || ''}`.trim(),
            phone:         _normalizePhone(p.mobilePhone || p.homePhone || p.phone || ''),
            email:         p.email || null,
            date_of_birth: p.dateOfBirth || null
        };
    } else if (conn.pms_type === 'open_dental') {
        const { data } = await client.get(`/api/v1/patients/${patientId}`);
        return {
            patient_id:    String(data.PatNum),
            first_name:    data.FName || '',
            last_name:     data.LName || '',
            full_name:     `${data.FName || ''} ${data.LName || ''}`.trim(),
            phone:         _normalizePhone(data.WirelessPhone || data.HmPhone || ''),
            email:         data.Email || null,
            date_of_birth: data.Birthdate || null
        };
    } else {
        throw new Error(`Unsupported pms_type: ${conn.pms_type}`);
    }
}

// ============================================================
// updatePlanStatus
// Mark a treatment plan accepted/declined back in the PMS
// ============================================================

async function updatePlanStatus(clientSlug, planId, status) {
    const conn = await _getConn(clientSlug);
    if (!conn) throw new Error(`No connection found for client_slug: ${clientSlug}`);

    const client = _buildClient(conn);

    if (conn.pms_type === 'dentrix') {
        await client.patch(`/api/treatment-plans/${planId}`, {
            status: status === 'accepted' ? 'Accepted' : 'Rejected'
        });
    } else if (conn.pms_type === 'open_dental') {
        await client.put(`/api/v1/tpprocs/${planId}`, {
            TPStatus: status === 'accepted' ? 'Accepted' : 'Rejected'
        });
    } else {
        throw new Error(`Unsupported pms_type: ${conn.pms_type}`);
    }

    return { ok: true, planId, status };
}

// ============================================================
// getProcedureCodes
// Returns the static ADA code lookup table
// ============================================================

function getProcedureCodes() {
    return PROCEDURE_CODES;
}

// ============================================================
// INTERNAL NORMALIZERS
// ============================================================

function _normalizeDentrixProcedure(proc) {
    const adaCode     = proc.procedureCode || proc.adaCode || '';
    const description = PROCEDURE_CODES[adaCode] || proc.procedureDescription || proc.description || adaCode;
    const fee         = parseFloat(proc.fee || proc.procedureFee || 0);
    const insEst      = parseFloat(proc.insuranceEstimate || proc.insurancePortion || 0);
    return {
        ada_code:       adaCode,
        description,
        fee,
        insurance_est:  insEst,
        patient_portion: parseFloat((fee - insEst).toFixed(2)),
        tooth:          proc.tooth || proc.toothNumber || null,
        surface:        proc.surface || null
    };
}

function _normalizeOpenDentalProcedure(proc) {
    const adaCode     = proc.ProcCode || proc.ProcNum || '';
    const description = PROCEDURE_CODES[adaCode] || proc.Descript || proc.ProcDesc || adaCode;
    const fee         = parseFloat(proc.ProcFee || proc.Fee || 0);
    const insEst      = parseFloat(proc.InsPayEst || proc.InsEst || 0);
    return {
        ada_code:       adaCode,
        description,
        fee,
        insurance_est:  insEst,
        patient_portion: parseFloat((fee - insEst).toFixed(2)),
        tooth:          proc.ToothNum || null,
        surface:        proc.Surf || null
    };
}

function _calcTotals(procedures) {
    return procedures.reduce((acc, p) => {
        acc.total_fee              += p.fee;
        acc.total_insurance_est    += p.insurance_est;
        acc.total_patient_portion  += p.patient_portion;
        return acc;
    }, { total_fee: 0, total_insurance_est: 0, total_patient_portion: 0 });
}

function _normalizePhone(raw) {
    if (!raw) return null;
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return raw;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    getTreatmentPlans,
    getTreatmentPlanById,
    getPatientById,
    updatePlanStatus,
    getProcedureCodes,
    PROCEDURE_CODES
};
