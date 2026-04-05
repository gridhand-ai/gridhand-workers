/**
 * GRIDHAND Chair Filler — Booking System API
 *
 * Supports both Boulevard and Square based on conn.booking_system.
 * Exports a unified interface — callers never need to know which system is live.
 */

'use strict';

const axios  = require('axios');
const dayjs  = require('dayjs');

const BOULEVARD_API_BASE = 'https://dashboard.boulevard.io/api/2020-01';
const SQUARE_API_BASE    = 'https://connect.squareup.com/v2';

// ─── Boulevard ────────────────────────────────────────────────────────────────

/**
 * Get unbooked appointment slots for today and tomorrow from Boulevard.
 * Returns [{ id, serviceType, stylistName, startTime, endTime, date }]
 */
async function getOpenSlotsBoulevard(conn) {
    const today    = dayjs().format('YYYY-MM-DD');
    const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');

    const slots = [];

    for (const date of [today, tomorrow]) {
        const response = await axios.get(`${BOULEVARD_API_BASE}/businesses/${conn.boulevard_business_id}/appointments`, {
            headers: {
                'Authorization': `Basic ${Buffer.from(`${conn.boulevard_api_key}:`).toString('base64')}`,
                'Accept':        'application/json',
            },
            params: {
                start_date: date,
                end_date:   date,
                state:      'unbooked',
                per_page:   100,
            },
        });

        const appts = response.data.data || response.data.appointments || [];

        for (const appt of appts) {
            const service = (appt.services || appt.appointment_services || [])[0] || {};
            const staff   = appt.staff_member || appt.provider || {};

            slots.push({
                id:          appt.id,
                serviceType: service.name  || service.service_name || 'Service',
                stylistName: staff.name    || staff.display_name   || null,
                startTime:   appt.start_at || appt.start_time,
                endTime:     appt.end_at   || appt.end_time   || null,
                date,
            });
        }
    }

    return slots;
}

/**
 * Get clients from Boulevard who have historically booked a specific service type.
 * Returns [{ id, name, phone, last_visit_date, last_service_type, last_reminder_sent, opted_out }]
 */
async function getClientsByServiceBoulevard(conn, serviceType) {
    const supabase = require('./db').__supabase();
    // Query the local salon_clients table synced from rebook-reminder worker
    // Fall back to empty array if table not available in this worker's schema
    try {
        const { data, error } = await supabase
            .from('salon_clients')
            .select('id, name, phone, last_service_type, last_reminder_sent, opted_out')
            .eq('client_slug', conn.client_slug)
            .ilike('last_service_type', `%${serviceType}%`)
            .eq('opted_out', false)
            .not('phone', 'is', null);

        if (error) throw error;
        return data || [];
    } catch {
        // If salon_clients table isn't populated, fetch from Boulevard directly
        const response = await axios.get(`${BOULEVARD_API_BASE}/businesses/${conn.boulevard_business_id}/clients`, {
            headers: {
                'Authorization': `Basic ${Buffer.from(`${conn.boulevard_api_key}:`).toString('base64')}`,
                'Accept':        'application/json',
            },
            params: { per_page: 100 },
        });

        const clients = response.data.data || response.data.clients || [];

        return clients
            .filter(c => (c.mobile_phone || c.phone))
            .map(c => ({
                id:    c.id,
                name:  c.name || `${c.first_name || ''} ${c.last_name || ''}`.trim(),
                phone: c.mobile_phone || c.phone,
                last_service_type:  null,
                last_reminder_sent: null,
                opted_out:          false,
            }));
    }
}

// ─── Square ───────────────────────────────────────────────────────────────────

/**
 * Get unbooked bookings for today and tomorrow from Square Appointments.
 * Returns [{ id, serviceType, stylistName, startTime, endTime, date }]
 */
async function getOpenSlotsSquare(conn) {
    const today    = dayjs().startOf('day').toISOString();
    const endDay   = dayjs().add(2, 'day').startOf('day').toISOString();

    const slots = [];

    const response = await axios.get(`${SQUARE_API_BASE}/bookings`, {
        headers: {
            'Authorization':  `Bearer ${conn.square_access_token}`,
            'Square-Version': '2024-01-18',
        },
        params: {
            location_id:  conn.square_location_id,
            start_at_min: today,
            start_at_max: endDay,
            limit:        100,
        },
    });

    const bookings = response.data.bookings || [];

    for (const booking of bookings) {
        // Only include open / no-shows (i.e., not already confirmed with a customer)
        if (booking.status === 'CANCELLED_BY_SELLER' || booking.customer_id) continue;

        const segment = (booking.appointment_segments || [])[0] || {};
        const start   = dayjs(booking.start_at);

        slots.push({
            id:          booking.id,
            serviceType: segment.team_member_id_filter || 'Service',
            stylistName: null, // would require separate team member lookup
            startTime:   booking.start_at,
            endTime:     null,
            date:        start.format('YYYY-MM-DD'),
        });
    }

    return slots;
}

/**
 * Get clients from Square who usually book this service type.
 */
async function getClientsByServiceSquare(conn, serviceType) {
    const supabase = require('./db').__supabase();
    try {
        const { data, error } = await supabase
            .from('salon_clients')
            .select('id, name, phone, last_service_type, last_reminder_sent, opted_out')
            .eq('client_slug', conn.client_slug)
            .ilike('last_service_type', `%${serviceType}%`)
            .eq('opted_out', false)
            .not('phone', 'is', null);

        if (error) throw error;
        return data || [];
    } catch {
        // Fallback: all customers with a phone number
        const response = await axios.get(`${SQUARE_API_BASE}/customers`, {
            headers: {
                'Authorization':  `Bearer ${conn.square_access_token}`,
                'Square-Version': '2024-01-18',
            },
            params: { limit: 100 },
        });

        const customers = response.data.customers || [];

        return customers
            .filter(c => c.phone_number)
            .map(c => ({
                id:    c.id,
                name:  `${c.given_name || ''} ${c.family_name || ''}`.trim() || c.id,
                phone: c.phone_number,
                last_service_type:  null,
                last_reminder_sent: null,
                opted_out:          false,
            }));
    }
}

// ─── Unified Interface ────────────────────────────────────────────────────────

/**
 * Get open slots for today and tomorrow.
 * Routes to Boulevard or Square based on conn.booking_system.
 */
async function getOpenSlots(conn) {
    if (conn.booking_system === 'square') {
        return getOpenSlotsSquare(conn);
    }
    return getOpenSlotsBoulevard(conn);
}

/**
 * Get clients who usually book a given service type.
 * Routes to Boulevard or Square based on conn.booking_system.
 */
async function getClientsByService(conn, serviceType) {
    if (conn.booking_system === 'square') {
        return getClientsByServiceSquare(conn, serviceType);
    }
    return getClientsByServiceBoulevard(conn, serviceType);
}

module.exports = {
    getOpenSlots,
    getClientsByService,
    // Exposed individually for testing
    getOpenSlotsBoulevard,
    getOpenSlotsSquare,
    getClientsByServiceBoulevard,
    getClientsByServiceSquare,
};
