/**
 * GRIDHAND Plan of Care Tracker — WebPT / Jane App API Integration
 *
 * Supports both WebPT (REST API v1) and Jane App (REST API v2).
 * The EHR type is determined by conn.ehr_type ('webpt' | 'jane').
 *
 * WebPT docs:  https://webpt.com/api
 * Jane App docs: https://jane.app/api
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');
const db    = require('./db');

const WEBPT_BASE = 'https://api.webpt.com/v1';
const JANE_BASE  = 'https://jane.app/api/v2';

// ─── Shared Auth Header Builder ───────────────────────────────────────────────

function buildHeaders(conn) {
    if (conn.ehr_type === 'jane') {
        return {
            'Authorization': `Bearer ${conn.access_token}`,
            'Content-Type':  'application/json',
            'Accept':        'application/json',
        };
    }
    // WebPT uses API key + location header
    return {
        'X-API-Key':      conn.api_key,
        'X-Location-ID':  conn.location_id,
        'Content-Type':   'application/json',
        'Accept':         'application/json',
    };
}

// ─── WebPT: Fetch Upcoming Appointments ──────────────────────────────────────

async function getUpcomingAppointments(clientSlug, conn, daysAhead = 2) {
    const startDate = dayjs().format('YYYY-MM-DD');
    const endDate   = dayjs().add(daysAhead, 'day').format('YYYY-MM-DD');

    try {
        if (conn.ehr_type === 'jane') {
            return await getJaneUpcomingAppointments(conn, startDate, endDate);
        }
        return await getWebPTUpcomingAppointments(conn, startDate, endDate);
    } catch (err) {
        console.error(`[WebPT] getUpcomingAppointments error for ${clientSlug}: ${err.message}`);
        throw err;
    }
}

async function getWebPTUpcomingAppointments(conn, startDate, endDate) {
    const { data } = await axios.get(`${WEBPT_BASE}/appointments`, {
        headers: buildHeaders(conn),
        params: {
            start_date: startDate,
            end_date:   endDate,
            status:     'scheduled',
            per_page:   200,
        },
    });

    return (data.appointments || []).map(appt => ({
        ehrAppointmentId: String(appt.id),
        ehrPatientId:     String(appt.patient_id),
        patientName:      `${appt.patient?.first_name || ''} ${appt.patient?.last_name || ''}`.trim(),
        patientPhone:     appt.patient?.cell_phone || appt.patient?.home_phone || null,
        visitDate:        appt.appointment_date,
        visitTime:        appt.start_time,
        visitType:        appt.appointment_type || 'follow_up',
        providerName:     appt.therapist?.full_name || null,
        status:           'scheduled',
    }));
}

async function getJaneUpcomingAppointments(conn, startDate, endDate) {
    const { data } = await axios.get(`${JANE_BASE}/appointments`, {
        headers: buildHeaders(conn),
        params: {
            'date[gte]': startDate,
            'date[lte]': endDate,
            status:      'booked',
            per_page:    200,
        },
    });

    return (data.appointments || []).map(appt => ({
        ehrAppointmentId: String(appt.id),
        ehrPatientId:     String(appt.patient_id),
        patientName:      appt.patient?.full_name || 'Unknown',
        patientPhone:     appt.patient?.mobile_phone || appt.patient?.home_phone || null,
        visitDate:        appt.date,
        visitTime:        appt.start_at,
        visitType:        appt.treatment_type || 'follow_up',
        providerName:     appt.staff?.full_name || null,
        status:           'scheduled',
    }));
}

// ─── Fetch Active Treatment Plans ─────────────────────────────────────────────

async function getActiveTreatmentPlans(clientSlug, conn) {
    try {
        if (conn.ehr_type === 'jane') {
            return await getJaneTreatmentPlans(conn);
        }
        return await getWebPTTreatmentPlans(conn);
    } catch (err) {
        console.error(`[WebPT] getActiveTreatmentPlans error for ${clientSlug}: ${err.message}`);
        throw err;
    }
}

async function getWebPTTreatmentPlans(conn) {
    const { data } = await axios.get(`${WEBPT_BASE}/cases`, {
        headers: buildHeaders(conn),
        params: { status: 'active', per_page: 500 },
    });

    return (data.cases || []).map(c => ({
        ehrPatientId:      String(c.patient_id),
        patientName:       `${c.patient?.first_name || ''} ${c.patient?.last_name || ''}`.trim(),
        patientPhone:      c.patient?.cell_phone || c.patient?.home_phone || null,
        patientEmail:      c.patient?.email || null,
        diagnosisCode:     c.primary_diagnosis_code || null,
        diagnosisLabel:    c.primary_diagnosis_description || null,
        totalVisits:       c.authorized_visits || null,
        visitsCompleted:   c.visits_used || 0,
        frequencyPerWeek:  c.frequency_per_week || null,
        planStartDate:     c.start_date || null,
        planEndDate:       c.end_date || null,
        lastVisitDate:     c.last_visit_date || null,
        nextScheduledDate: c.next_appointment_date || null,
        status:            'active',
    }));
}

async function getJaneTreatmentPlans(conn) {
    const { data } = await axios.get(`${JANE_BASE}/patients`, {
        headers: buildHeaders(conn),
        params: { status: 'active', per_page: 500 },
    });

    return (data.patients || []).map(p => ({
        ehrPatientId:      String(p.id),
        patientName:       p.full_name || 'Unknown',
        patientPhone:      p.mobile_phone || p.home_phone || null,
        patientEmail:      p.email || null,
        diagnosisCode:     p.primary_diagnosis?.code || null,
        diagnosisLabel:    p.primary_diagnosis?.description || null,
        totalVisits:       p.treatment_plan?.total_visits || null,
        visitsCompleted:   p.treatment_plan?.visits_completed || 0,
        frequencyPerWeek:  p.treatment_plan?.frequency_per_week || null,
        planStartDate:     p.treatment_plan?.start_date || null,
        planEndDate:       p.treatment_plan?.end_date || null,
        lastVisitDate:     p.last_appointment_date || null,
        nextScheduledDate: p.next_appointment_date || null,
        status:            'active',
    }));
}

// ─── Fetch Recent Visit History ───────────────────────────────────────────────

async function getRecentVisits(clientSlug, conn, daysBack = 7) {
    const startDate = dayjs().subtract(daysBack, 'day').format('YYYY-MM-DD');
    const endDate   = dayjs().format('YYYY-MM-DD');

    try {
        if (conn.ehr_type === 'jane') {
            const { data } = await axios.get(`${JANE_BASE}/appointments`, {
                headers: buildHeaders(conn),
                params: { 'date[gte]': startDate, 'date[lte]': endDate, status: 'completed', per_page: 500 },
            });
            return (data.appointments || []).map(appt => ({
                ehrAppointmentId: String(appt.id),
                ehrPatientId:     String(appt.patient_id),
                visitDate:        appt.date,
                visitType:        appt.treatment_type || 'follow_up',
                status:           'completed',
                providerName:     appt.staff?.full_name || null,
            }));
        }

        const { data } = await axios.get(`${WEBPT_BASE}/appointments`, {
            headers: buildHeaders(conn),
            params: { start_date: startDate, end_date: endDate, status: 'completed', per_page: 500 },
        });
        return (data.appointments || []).map(appt => ({
            ehrAppointmentId: String(appt.id),
            ehrPatientId:     String(appt.patient_id),
            visitDate:        appt.appointment_date,
            visitType:        appt.appointment_type || 'follow_up',
            status:           'completed',
            providerName:     appt.therapist?.full_name || null,
        }));
    } catch (err) {
        console.error(`[WebPT] getRecentVisits error for ${clientSlug}: ${err.message}`);
        throw err;
    }
}

module.exports = {
    getUpcomingAppointments,
    getActiveTreatmentPlans,
    getRecentVisits,
};
