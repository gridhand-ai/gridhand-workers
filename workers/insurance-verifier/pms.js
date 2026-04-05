/**
 * GRIDHAND AI — Insurance Verifier
 * PMS Integration (Practice Management Software)
 *
 * Supported systems:
 *   - Dentrix G6+  (REST API via Dentrix Enterprise Server)
 *   - Open Dental  (REST API, v21.1+)
 *
 * All functions return normalized data with consistent field names
 * regardless of which PMS is connected.
 */

'use strict';

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const dayjs = require('dayjs');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ============================================================
// CONNECTION LOADER
// ============================================================

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('iv_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error || !data) throw new Error(`No connection found for client: ${clientSlug}`);
    return data;
}

function buildPMSClient(conn) {
    return axios.create({
        baseURL: conn.pms_api_base_url,
        headers: {
            'Authorization': `Bearer ${conn.pms_api_key}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        timeout: 15000
    });
}

// ============================================================
// DENTRIX HELPERS
// Dentrix G6+ uses a local Enterprise REST API (DentrixConnect)
// Base URL is typically http://[server]:8800/api/v1
// ============================================================

async function dentrixGetUpcomingAppointments(client, daysAhead) {
    const today = dayjs().format('YYYY-MM-DD');
    const until = dayjs().add(daysAhead, 'day').format('YYYY-MM-DD');

    const { data } = await client.get('/appointments', {
        params: {
            startDate: today,
            endDate: until,
            status: 'scheduled',
            includePatient: true,
            includeInsurance: true
        }
    });

    return (data.appointments || []).map(appt => ({
        appointmentId: String(appt.appointmentId),
        patientId: String(appt.patientId),
        patientName: `${appt.patient?.firstName || ''} ${appt.patient?.lastName || ''}`.trim(),
        patientPhone: appt.patient?.mobilePhone || appt.patient?.homePhone || null,
        patientDob: appt.patient?.dateOfBirth || null,
        appointmentDate: appt.appointmentDate,
        appointmentTime: appt.appointmentTime,
        providerId: String(appt.providerId || ''),
        insurance: appt.insurance
            ? {
                carrier: appt.insurance.carrierName || null,
                memberId: appt.insurance.memberId || appt.insurance.subscriberId || null,
                groupNumber: appt.insurance.groupNumber || null,
                subscriberName: appt.insurance.subscriberName || null,
                subscriberDob: appt.insurance.subscriberDob || null,
                relationToSubscriber: appt.insurance.relationship || 'self'
            }
            : null
    }));
}

async function dentrixGetPatientInsurance(client, patientId) {
    const { data } = await client.get(`/patients/${patientId}/insurance`);
    const ins = data.primaryInsurance || data.insurance || {};

    return {
        carrier: ins.carrierName || null,
        memberId: ins.memberId || ins.subscriberId || null,
        groupNumber: ins.groupNumber || null,
        subscriberName: ins.subscriberName || null,
        subscriberDob: ins.subscriberDob || null,
        relationToSubscriber: ins.relationship || 'self',
        payerId: ins.payerId || null
    };
}

async function dentrixGetAppointmentProcedures(client, appointmentId) {
    const { data } = await client.get(`/appointments/${appointmentId}/procedures`);

    return (data.procedures || []).map(proc => ({
        adaCode: proc.procedureCode || proc.adaCode,
        description: proc.procedureDescription || proc.description || '',
        fee: proc.fee || null,
        toothNumber: proc.toothNumber || null
    }));
}

async function dentrixUpdateVerificationStatus(client, appointmentId, status, notes) {
    await client.patch(`/appointments/${appointmentId}`, {
        verificationStatus: status,
        verificationNotes: notes,
        verificationDate: new Date().toISOString()
    });
}

// ============================================================
// OPEN DENTAL HELPERS
// Open Dental REST API — http://[server]:30222/api/v1
// Auth: Bearer token via /auth endpoint
// ============================================================

async function openDentalGetUpcomingAppointments(client, daysAhead) {
    const today = dayjs().format('YYYY-MM-DD');
    const until = dayjs().add(daysAhead, 'day').format('YYYY-MM-DD');

    const { data } = await client.get('/appointments', {
        params: {
            DateStart: today,
            DateEnd: until,
            AptStatus: 1 // 1 = Scheduled
        }
    });

    const appointments = data.appointments || data || [];

    // Open Dental returns basic appt data; we enrich with patient + ins calls
    const enriched = await Promise.all(
        appointments.map(async (appt) => {
            let patientInfo = {};
            let insuranceInfo = null;

            try {
                const { data: pt } = await client.get(`/patients/${appt.PatNum}`);
                patientInfo = {
                    patientName: `${pt.FName || ''} ${pt.LName || ''}`.trim(),
                    patientPhone: pt.WirelessPhone || pt.HmPhone || null,
                    patientDob: pt.Birthdate || null
                };

                const { data: insData } = await client.get(`/patients/${appt.PatNum}/insurances`);
                const primary = (insData.insurances || insData || [])
                    .find(i => i.Ordinal === 1 || i.IsPrimary);

                if (primary) {
                    insuranceInfo = {
                        carrier: primary.CarrierName || null,
                        memberId: primary.SubscriberID || null,
                        groupNumber: primary.GroupNum || null,
                        subscriberName: primary.SubscriberName || null,
                        subscriberDob: primary.SubscriberBirthdate || null,
                        relationToSubscriber: primary.Relationship || 'self',
                        payerId: primary.ElectID || null
                    };
                }
            } catch (_) { /* Non-critical — proceed without enrichment */ }

            return {
                appointmentId: String(appt.AptNum),
                patientId: String(appt.PatNum),
                ...patientInfo,
                appointmentDate: appt.AptDateTime?.slice(0, 10) || null,
                appointmentTime: appt.AptDateTime?.slice(11, 16) || null,
                providerId: String(appt.ProvNum || ''),
                insurance: insuranceInfo
            };
        })
    );

    return enriched;
}

async function openDentalGetPatientInsurance(client, patientId) {
    const { data } = await client.get(`/patients/${patientId}/insurances`);
    const insurances = data.insurances || data || [];
    const primary = insurances.find(i => i.Ordinal === 1 || i.IsPrimary) || insurances[0];

    if (!primary) return null;

    return {
        carrier: primary.CarrierName || null,
        memberId: primary.SubscriberID || null,
        groupNumber: primary.GroupNum || null,
        subscriberName: primary.SubscriberName || null,
        subscriberDob: primary.SubscriberBirthdate || null,
        relationToSubscriber: primary.Relationship || 'self',
        payerId: primary.ElectID || null
    };
}

async function openDentalGetAppointmentProcedures(client, appointmentId) {
    const { data } = await client.get(`/appointments/${appointmentId}/procedures`);
    const procs = data.procedures || data || [];

    return procs.map(proc => ({
        adaCode: proc.ProcCode || proc.CodeNum,
        description: proc.Descript || proc.Description || '',
        fee: proc.ProcFee || null,
        toothNumber: proc.ToothNum || null
    }));
}

async function openDentalUpdateVerificationStatus(client, appointmentId, status, notes) {
    // Open Dental uses appointment notes field for verification status
    await client.put(`/appointments/${appointmentId}`, {
        Note: `[IV:${status.toUpperCase()}] ${notes} — ${new Date().toISOString()}`
    });
}

// ============================================================
// PUBLIC API — normalized interface
// ============================================================

/**
 * Get all upcoming appointments within the next N days,
 * including patient name, phone, DOB, and insurance info.
 */
async function getUpcomingAppointments(clientSlug, daysAhead = 3) {
    const conn = await getConnection(clientSlug);
    const client = buildPMSClient(conn);

    if (conn.pms_type === 'dentrix') {
        return dentrixGetUpcomingAppointments(client, daysAhead);
    }
    if (conn.pms_type === 'open_dental') {
        return openDentalGetUpcomingAppointments(client, daysAhead);
    }

    throw new Error(`Unsupported PMS type: ${conn.pms_type}`);
}

/**
 * Get insurance details for a specific patient from PMS.
 * Returns: { carrier, memberId, groupNumber, subscriberName, subscriberDob, relationToSubscriber, payerId }
 */
async function getPatientInsurance(clientSlug, patientId) {
    const conn = await getConnection(clientSlug);
    const client = buildPMSClient(conn);

    if (conn.pms_type === 'dentrix') {
        return dentrixGetPatientInsurance(client, patientId);
    }
    if (conn.pms_type === 'open_dental') {
        return openDentalGetPatientInsurance(client, patientId);
    }

    throw new Error(`Unsupported PMS type: ${conn.pms_type}`);
}

/**
 * Get procedures planned for an appointment.
 * Returns: [{ adaCode, description, fee, toothNumber }]
 */
async function getAppointmentProcedures(clientSlug, appointmentId) {
    const conn = await getConnection(clientSlug);
    const client = buildPMSClient(conn);

    if (conn.pms_type === 'dentrix') {
        return dentrixGetAppointmentProcedures(client, appointmentId);
    }
    if (conn.pms_type === 'open_dental') {
        return openDentalGetAppointmentProcedures(client, appointmentId);
    }

    throw new Error(`Unsupported PMS type: ${conn.pms_type}`);
}

/**
 * Write verification result back to the PMS appointment record.
 */
async function updateVerificationStatus(clientSlug, appointmentId, status, notes) {
    const conn = await getConnection(clientSlug);
    const client = buildPMSClient(conn);

    if (conn.pms_type === 'dentrix') {
        return dentrixUpdateVerificationStatus(client, appointmentId, status, notes);
    }
    if (conn.pms_type === 'open_dental') {
        return openDentalUpdateVerificationStatus(client, appointmentId, status, notes);
    }

    throw new Error(`Unsupported PMS type: ${conn.pms_type}`);
}

module.exports = {
    getUpcomingAppointments,
    getPatientInsurance,
    getAppointmentProcedures,
    updateVerificationStatus
};
