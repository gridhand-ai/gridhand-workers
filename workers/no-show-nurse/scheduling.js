/**
 * GRIDHAND No-Show Nurse — EHR Scheduling Integration
 *
 * Supports Epic FHIR R4 and Cerner FHIR R4 via SMART on FHIR client credentials.
 *
 * Functions:
 *   getAccessToken(clientSlug)                              — SMART on FHIR token
 *   getTodaysAppointments(clientSlug)                       — all appointments today
 *   getAppointmentsByDate(clientSlug, date)                 — appointments for a date
 *   detectNoShows(clientSlug)                               — find late/unresponded bookings
 *   markNoShow(clientSlug, appointmentId)                   — patch EHR status to noshow
 *   getAvailableSlots(clientSlug, dateRange, appointmentType) — open schedule slots
 *   bookAppointment(clientSlug, slotId, patientId, appointmentType) — book a slot
 *   getPatient(clientSlug, patientId)                       — patient demographics + phone
 *   cancelledSlotsToday(clientSlug)                         — recently cancelled openings
 */

'use strict';

const axios  = require('axios');
const dayjs  = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// In-memory token cache: { clientSlug: { token, expiresAt } }
const tokenCache = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('nsn_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    if (!data) throw new Error(`No NSN connection found for ${clientSlug}`);
    return data;
}

/**
 * Build a FHIR-compliant axios instance for a client with Bearer token attached.
 */
async function getFhirClient(clientSlug) {
    const token = await getAccessToken(clientSlug);
    const conn  = await getConnection(clientSlug);
    return axios.create({
        baseURL: conn.ehr_base_url.replace(/\/$/, ''),
        headers: {
            Authorization: `Bearer ${token}`,
            Accept:        'application/fhir+json',
            'Content-Type': 'application/fhir+json',
        },
        timeout: 15000,
    });
}

/**
 * Extract a patient phone number from a FHIR Patient resource telecom array.
 */
function extractPhone(patient) {
    if (!patient?.telecom) return null;
    const cell = patient.telecom.find(t => t.system === 'phone' && t.use === 'mobile');
    const home = patient.telecom.find(t => t.system === 'phone' && t.use === 'home');
    const any  = patient.telecom.find(t => t.system === 'phone');
    const raw = (cell || home || any)?.value;
    if (!raw) return null;
    // Normalize to E.164 (US assumed — strip non-digits, prepend +1)
    const digits = raw.replace(/\D/g, '');
    return digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits[0] === '1' ? `+${digits}` : raw;
}

/**
 * Extract display name from FHIR HumanName array.
 */
function extractName(resource) {
    if (!resource?.name?.length) return 'Patient';
    const n = resource.name[0];
    const given = (n.given || []).join(' ');
    return `${given} ${n.family || ''}`.trim() || 'Patient';
}

// ─── getAccessToken ───────────────────────────────────────────────────────────

/**
 * Obtain a SMART on FHIR client-credentials access token.
 * Caches until 60 seconds before expiry.
 */
async function getAccessToken(clientSlug) {
    const cached = tokenCache[clientSlug];
    if (cached && dayjs().isBefore(dayjs(cached.expiresAt).subtract(60, 'second'))) {
        return cached.token;
    }

    const conn = await getConnection(clientSlug);

    // Discover the token endpoint from the FHIR well-known/smart-configuration
    let tokenEndpoint;
    try {
        const wellKnown = await axios.get(
            `${conn.ehr_base_url.replace(/\/$/, '')}/.well-known/smart-configuration`,
            { timeout: 10000 }
        );
        tokenEndpoint = wellKnown.data.token_endpoint;
    } catch {
        // Fall back to standard SMART token endpoint path
        tokenEndpoint = conn.ehr_type === 'epic'
            ? `${conn.ehr_base_url}/oauth2/token`
            : `${conn.ehr_base_url}/token`;
    }

    const params = new URLSearchParams();
    params.set('grant_type',    'client_credentials');
    params.set('client_id',     conn.ehr_client_id);
    params.set('client_secret', conn.ehr_client_secret);
    params.set('scope',         'system/Appointment.read system/Appointment.write system/Patient.read system/Slot.read system/Slot.write');

    const resp = await axios.post(tokenEndpoint, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
    });

    const { access_token, expires_in = 3600 } = resp.data;
    tokenCache[clientSlug] = {
        token:     access_token,
        expiresAt: dayjs().add(expires_in, 'second').toISOString(),
    };

    console.log(`[Scheduling] Token refreshed for ${clientSlug} (expires in ${expires_in}s)`);
    return access_token;
}

// ─── getTodaysAppointments ────────────────────────────────────────────────────

async function getTodaysAppointments(clientSlug) {
    return getAppointmentsByDate(clientSlug, dayjs().format('YYYY-MM-DD'));
}

// ─── getAppointmentsByDate ────────────────────────────────────────────────────

async function getAppointmentsByDate(clientSlug, date) {
    const client   = await getFhirClient(clientSlug);
    const start    = dayjs(date).startOf('day').toISOString();
    const end      = dayjs(date).endOf('day').toISOString();

    const resp = await client.get('/Appointment', {
        params: {
            date:    `ge${start}`,
            _count:  200,
            // some EHRs use 'end' param instead — include both
            'date-end': `le${end}`,
        },
    });

    const bundle = resp.data;
    if (!bundle?.entry) return [];

    return bundle.entry
        .map(e => e.resource)
        .filter(r => r?.resourceType === 'Appointment')
        .map(normalizeAppointment);
}

/**
 * Normalize a raw FHIR Appointment resource into a plain object.
 */
function normalizeAppointment(r) {
    const participant = r.participant || [];
    const patientPart = participant.find(p =>
        p.actor?.reference?.toLowerCase().includes('patient')
    );
    const practPart = participant.find(p =>
        p.actor?.reference?.toLowerCase().includes('practitioner')
    );

    return {
        id:              r.id,
        status:          r.status,                      // booked | arrived | fulfilled | cancelled | noshow
        start:           r.start,
        end:             r.end,
        appointmentType: r.appointmentType?.coding?.[0]?.display || r.serviceType?.[0]?.coding?.[0]?.display || null,
        patientRef:      patientPart?.actor?.reference || null,
        patientId:       patientPart?.actor?.reference?.split('/').pop() || null,
        providerRef:     practPart?.actor?.reference || null,
        providerName:    practPart?.actor?.display || null,
        slotRef:         r.slot?.[0]?.reference || null,
        slotId:          r.slot?.[0]?.reference?.split('/').pop() || null,
        rawStatus:       r.status,
    };
}

// ─── detectNoShows ────────────────────────────────────────────────────────────

/**
 * Scan today's appointments for no-shows:
 *   - status is still 'booked' (not arrived, fulfilled, cancelled, noshow)
 *   - appointment start time was >= threshold minutes ago
 *
 * Returns array of normalized appointment objects.
 */
async function detectNoShows(clientSlug) {
    const conn = await getConnection(clientSlug);
    const threshold = conn.no_show_threshold_minutes || 15;

    const appointments = await getTodaysAppointments(clientSlug);
    const now = dayjs();

    const noShows = appointments.filter(appt => {
        if (appt.status !== 'booked') return false;
        if (!appt.start) return false;
        const minutesPast = now.diff(dayjs(appt.start), 'minute');
        return minutesPast >= threshold;
    });

    console.log(`[Scheduling] detectNoShows for ${clientSlug}: ${noShows.length} of ${appointments.length} appointments flagged`);
    return noShows;
}

// ─── markNoShow ───────────────────────────────────────────────────────────────

/**
 * PATCH the EHR Appointment resource status to 'noshow'.
 */
async function markNoShow(clientSlug, appointmentId) {
    const client = await getFhirClient(clientSlug);

    // Fetch the full resource first so we can patch correctly
    const { data: appt } = await client.get(`/Appointment/${appointmentId}`);

    const patched = { ...appt, status: 'noshow' };

    await client.put(`/Appointment/${appointmentId}`, patched);

    console.log(`[Scheduling] Marked appointment ${appointmentId} as noshow for ${clientSlug}`);
    return true;
}

// ─── getAvailableSlots ────────────────────────────────────────────────────────

/**
 * Query FHIR Slot resources for free slots in a date range.
 * @param {string} clientSlug
 * @param {{ start: string, end: string }} dateRange - ISO date strings
 * @param {string} [appointmentType]                 - filter by service type name (loose match)
 */
async function getAvailableSlots(clientSlug, dateRange, appointmentType) {
    const client = await getFhirClient(clientSlug);

    const params = {
        start:  `ge${dayjs(dateRange.start).toISOString()}`,
        end:    `le${dayjs(dateRange.end).toISOString()}`,
        status: 'free',
        _count: 100,
    };

    const resp = await client.get('/Slot', { params });
    const bundle = resp.data;
    if (!bundle?.entry) return [];

    let slots = bundle.entry
        .map(e => e.resource)
        .filter(r => r?.resourceType === 'Slot' && r.status === 'free');

    if (appointmentType) {
        const lcType = appointmentType.toLowerCase();
        slots = slots.filter(s => {
            const typeName = s.serviceType?.[0]?.coding?.[0]?.display || '';
            return typeName.toLowerCase().includes(lcType);
        });
    }

    return slots.map(s => ({
        id:              s.id,
        start:           s.start,
        end:             s.end,
        appointmentType: s.serviceType?.[0]?.coding?.[0]?.display || null,
        scheduleRef:     s.schedule?.reference || null,
    }));
}

// ─── bookAppointment ──────────────────────────────────────────────────────────

/**
 * Book a free Slot for a patient — creates a new FHIR Appointment resource.
 */
async function bookAppointment(clientSlug, slotId, patientId, appointmentType) {
    const client = await getFhirClient(clientSlug);

    // Fetch the slot so we know its times and schedule
    const { data: slot } = await client.get(`/Slot/${slotId}`);

    const appointmentResource = {
        resourceType: 'Appointment',
        status:       'booked',
        start:        slot.start,
        end:          slot.end,
        slot:         [{ reference: `Slot/${slotId}` }],
        ...(appointmentType && {
            serviceType: [{
                coding: [{ display: appointmentType }],
            }],
        }),
        participant: [
            {
                actor:  { reference: `Patient/${patientId}` },
                status: 'accepted',
            },
        ],
    };

    const { data: created } = await client.post('/Appointment', appointmentResource);

    // Mark the slot as busy
    try {
        await client.put(`/Slot/${slotId}`, { ...slot, status: 'busy' });
    } catch (e) {
        console.warn(`[Scheduling] Could not mark slot ${slotId} busy: ${e.message}`);
    }

    console.log(`[Scheduling] Booked appointment ${created.id} for patient ${patientId} in slot ${slotId}`);
    return normalizeAppointment(created);
}

// ─── getPatient ───────────────────────────────────────────────────────────────

/**
 * Fetch patient demographics from EHR.
 * Returns { id, name, phone, birthDate, gender }.
 */
async function getPatient(clientSlug, patientId) {
    const client = await getFhirClient(clientSlug);
    const { data: patient } = await client.get(`/Patient/${patientId}`);

    return {
        id:        patient.id,
        name:      extractName(patient),
        phone:     extractPhone(patient),
        birthDate: patient.birthDate || null,
        gender:    patient.gender || null,
    };
}

// ─── cancelledSlotsToday ──────────────────────────────────────────────────────

/**
 * Find today's appointments that were recently cancelled — these are open slots
 * that can be filled from the waitlist.
 */
async function cancelledSlotsToday(clientSlug) {
    const appointments = await getTodaysAppointments(clientSlug);
    const cancelled = appointments.filter(a => a.status === 'cancelled');
    console.log(`[Scheduling] cancelledSlotsToday for ${clientSlug}: ${cancelled.length} cancelled`);
    return cancelled;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    getAccessToken,
    getTodaysAppointments,
    getAppointmentsByDate,
    detectNoShows,
    markNoShow,
    getAvailableSlots,
    bookAppointment,
    getPatient,
    cancelledSlotsToday,
    getConnection,   // shared by other modules
};
