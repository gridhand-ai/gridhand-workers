/**
 * GRIDHAND Vaccine Reminder — eVetPractice API Integration
 *
 * Handles all communication with the eVetPractice Practice Management System.
 * conn: row from vet_connections table ({ evet_base_url, evet_api_key, ... })
 */

'use strict';

const axios = require('axios');

/**
 * Build an authenticated Axios instance for a given practice connection.
 */
function makeClient(conn) {
    return axios.create({
        baseURL: conn.evet_base_url,
        headers: {
            'Authorization': `Bearer ${conn.evet_api_key}`,
            'Content-Type':  'application/json',
            'Accept':        'application/json',
        },
        timeout: 15000,
    });
}

/**
 * Get all active patients with their vaccine records.
 *
 * Returns:
 * [
 *   {
 *     id:         '12345',
 *     name:       'Buddy',
 *     species:    'Canine',
 *     breed:      'Golden Retriever',
 *     ownerName:  'John Smith',
 *     ownerPhone: '+14145551234',
 *     ownerEmail: 'john@example.com',
 *     vaccines: [
 *       { name: 'Rabies', lastAdministered: '2023-03-01', dueDate: '2024-03-01' },
 *       { name: 'DHPP',   lastAdministered: '2023-03-01', dueDate: '2024-03-01' },
 *     ]
 *   }, ...
 * ]
 */
async function getPatients(conn) {
    const client = makeClient(conn);

    try {
        const response = await client.get('/api/patients', {
            params: { status: 'active', include: 'vaccines,owner', limit: 500 },
        });

        const raw = response.data?.patients || response.data?.data || [];

        return raw.map((p) => ({
            id:         String(p.id || p.patient_id),
            name:       p.name || p.patient_name || 'Unknown Pet',
            species:    p.species || '',
            breed:      p.breed || '',
            ownerName:  p.owner?.name  || p.owner_name  || '',
            ownerPhone: normalizePhone(p.owner?.phone || p.owner_phone || ''),
            ownerEmail: p.owner?.email || p.owner_email || '',
            vaccines:   mapVaccines(p.vaccines || p.vaccine_records || []),
        }));
    } catch (err) {
        console.error(`[PMS] getPatients failed: ${err.message}`);
        throw err;
    }
}

/**
 * Get detailed vaccine history for a single patient.
 *
 * Returns array of vaccine records with full history.
 */
async function getPatientVaccines(conn, patientId) {
    const client = makeClient(conn);

    try {
        const response = await client.get(`/api/patients/${patientId}/vaccines`);
        const raw = response.data?.vaccines || response.data?.data || [];
        return mapVaccines(raw);
    } catch (err) {
        console.error(`[PMS] getPatientVaccines(${patientId}) failed: ${err.message}`);
        throw err;
    }
}

/**
 * Create an appointment request in eVetPractice.
 *
 * { patientId, serviceType, requestedDate }
 * Returns { appointmentId, scheduledDate, status }
 */
async function scheduleAppointment(conn, { patientId, serviceType, requestedDate }) {
    const client = makeClient(conn);

    try {
        const response = await client.post('/api/appointments', {
            patient_id:     patientId,
            service_type:   serviceType || 'Vaccine Administration',
            requested_date: requestedDate || null,
            status:         'pending',
            source:         'gridhand_vaccine_reminder',
        });

        const appt = response.data?.appointment || response.data;
        return {
            appointmentId:  String(appt.id || appt.appointment_id || ''),
            scheduledDate:  appt.scheduled_date || appt.requested_date || null,
            status:         appt.status || 'pending',
        };
    } catch (err) {
        console.error(`[PMS] scheduleAppointment(${patientId}) failed: ${err.message}`);
        throw err;
    }
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Normalize vaccine records from eVetPractice's varying response shapes.
 */
function mapVaccines(rawVaccines) {
    return rawVaccines.map((v) => ({
        name:             v.vaccine_name || v.name || v.product_name || 'Unknown Vaccine',
        lastAdministered: v.administered_date || v.last_administered || v.given_date || null,
        dueDate:          v.due_date || v.expiration_date || v.next_due || null,
    })).filter(v => v.dueDate); // only care about vaccines with a due date
}

/**
 * Normalize a phone number to E.164 format (+1XXXXXXXXXX).
 * Handles common formats: (414) 555-1234, 414-555-1234, 4145551234
 */
function normalizePhone(phone) {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return phone; // return as-is if we can't normalize
}

module.exports = {
    getPatients,
    getPatientVaccines,
    scheduleAppointment,
};
