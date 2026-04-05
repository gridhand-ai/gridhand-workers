/**
 * GRIDHAND Refill Runner — eVetPractice API Integration
 *
 * Handles all communication with the eVetPractice Practice Management System
 * for prescription data retrieval.
 * conn: row from vet_refill_connections table
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
 * Get all active prescriptions from eVetPractice.
 *
 * Returns:
 * [
 *   {
 *     id:               'rx-001',
 *     patientId:        '12345',
 *     patientName:      'Buddy',
 *     ownerName:        'John Smith',
 *     ownerPhone:       '+14145551234',
 *     medicationName:   'Apoquel 16mg',
 *     lastFillDate:     '2026-01-15',
 *     daysSupply:       30,
 *     refillsRemaining: 3,
 *   }, ...
 * ]
 */
async function getActivePrescriptions(conn) {
    const client = makeClient(conn);

    try {
        const response = await client.get('/api/prescriptions', {
            params: { status: 'active', include: 'patient,owner', limit: 500 },
        });

        const raw = response.data?.prescriptions || response.data?.data || [];

        return raw.map((rx) => ({
            id:               String(rx.id || rx.prescription_id),
            patientId:        String(rx.patient?.id || rx.patient_id || ''),
            patientName:      rx.patient?.name || rx.patient_name || 'Unknown Pet',
            ownerName:        rx.patient?.owner?.name || rx.owner?.name || rx.owner_name || '',
            ownerPhone:       normalizePhone(rx.patient?.owner?.phone || rx.owner?.phone || rx.owner_phone || ''),
            medicationName:   rx.medication_name || rx.drug_name || rx.product_name || 'Unknown Medication',
            lastFillDate:     rx.last_filled_date || rx.dispense_date || rx.fill_date || null,
            daysSupply:       parseInt(rx.days_supply || rx.quantity_days || '30', 10),
            refillsRemaining: parseInt(rx.refills_remaining || rx.refills_left || '0', 10),
        }));
    } catch (err) {
        console.error(`[PMS] getActivePrescriptions failed: ${err.message}`);
        throw err;
    }
}

/**
 * Get detailed information for a single prescription.
 */
async function getPrescriptionDetails(conn, prescriptionId) {
    const client = makeClient(conn);

    try {
        const response = await client.get(`/api/prescriptions/${prescriptionId}`, {
            params: { include: 'patient,owner,fills' },
        });

        const rx = response.data?.prescription || response.data;

        return {
            id:               String(rx.id || rx.prescription_id),
            patientId:        String(rx.patient?.id || rx.patient_id || ''),
            patientName:      rx.patient?.name || rx.patient_name || 'Unknown Pet',
            ownerName:        rx.patient?.owner?.name || rx.owner?.name || '',
            ownerPhone:       normalizePhone(rx.patient?.owner?.phone || rx.owner?.phone || ''),
            medicationName:   rx.medication_name || rx.drug_name || 'Unknown Medication',
            lastFillDate:     rx.last_filled_date || rx.dispense_date || null,
            daysSupply:       parseInt(rx.days_supply || '30', 10),
            refillsRemaining: parseInt(rx.refills_remaining || '0', 10),
            fills:            rx.fills || [],
        };
    } catch (err) {
        console.error(`[PMS] getPrescriptionDetails(${prescriptionId}) failed: ${err.message}`);
        throw err;
    }
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Normalize phone to E.164 format (+1XXXXXXXXXX).
 */
function normalizePhone(phone) {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return phone;
}

module.exports = {
    getActivePrescriptions,
    getPrescriptionDetails,
};
