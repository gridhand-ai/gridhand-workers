/**
 * GRIDHAND Rebook Reminder — Booking System API
 *
 * Supports both Boulevard and Square based on conn.booking_system.
 * Exports a unified interface — callers never need to know which system is live.
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');

const BOULEVARD_API_BASE = 'https://dashboard.boulevard.io/api/2020-01';
const SQUARE_API_BASE    = 'https://connect.squareup.com/v2';

// ─── Boulevard ────────────────────────────────────────────────────────────────

/**
 * Fetch completed appointments for the past N days from Boulevard.
 * Returns [{ id, clientId, clientName, clientPhone, serviceType, completedAt }]
 */
async function getRecentAppointmentsBoulevard(conn, days = 90) {
    const startDate = dayjs().subtract(days, 'day').format('YYYY-MM-DD');
    const endDate   = dayjs().format('YYYY-MM-DD');

    const appointments = [];
    let page = 1;

    while (true) {
        const response = await axios.get(`${BOULEVARD_API_BASE}/businesses/${conn.boulevard_business_id}/appointments`, {
            headers: {
                'Authorization': `Basic ${Buffer.from(`${conn.boulevard_api_key}:`).toString('base64')}`,
                'Accept':        'application/json',
            },
            params: {
                start_date: startDate,
                end_date:   endDate,
                state:      'completed',
                page,
                per_page:   100,
            },
        });

        const data = response.data;
        const appts = data.data || data.appointments || [];

        if (appts.length === 0) break;

        for (const appt of appts) {
            const client  = appt.client || {};
            const service = (appt.services || appt.appointment_services || [])[0] || {};

            appointments.push({
                id:          appt.id,
                clientId:    client.id       || appt.client_id,
                clientName:  client.name     || `${client.first_name || ''} ${client.last_name || ''}`.trim(),
                clientPhone: client.mobile_phone || client.phone || null,
                serviceType: service.name || service.service_name || 'Service',
                completedAt: appt.end_at   || appt.completed_at || appt.start_at,
            });
        }

        // Stop if we got a full page (pagination complete when less than per_page returned)
        if (appts.length < 100) break;
        page++;
    }

    return appointments;
}

/**
 * Fetch all clients from Boulevard (paginated).
 */
async function getClientsBoulevard(conn) {
    const clients = [];
    let page = 1;

    while (true) {
        const response = await axios.get(`${BOULEVARD_API_BASE}/businesses/${conn.boulevard_business_id}/clients`, {
            headers: {
                'Authorization': `Basic ${Buffer.from(`${conn.boulevard_api_key}:`).toString('base64')}`,
                'Accept':        'application/json',
            },
            params: { page, per_page: 100 },
        });

        const data = response.data;
        const page_clients = data.data || data.clients || [];

        if (page_clients.length === 0) break;

        for (const c of page_clients) {
            clients.push({
                id:    c.id,
                name:  c.name || `${c.first_name || ''} ${c.last_name || ''}`.trim(),
                phone: c.mobile_phone || c.phone || null,
                email: c.email        || null,
            });
        }

        if (page_clients.length < 100) break;
        page++;
    }

    return clients;
}

/**
 * Create a booking request on Boulevard.
 */
async function createAppointmentBoulevard(conn, { clientId, serviceType, requestedDate }) {
    const response = await axios.post(
        `${BOULEVARD_API_BASE}/businesses/${conn.boulevard_business_id}/appointments`,
        {
            client_id:      clientId,
            service:        serviceType,
            requested_date: requestedDate,
        },
        {
            headers: {
                'Authorization': `Basic ${Buffer.from(`${conn.boulevard_api_key}:`).toString('base64')}`,
                'Content-Type':  'application/json',
            },
        }
    );

    return response.data;
}

// ─── Square ───────────────────────────────────────────────────────────────────

/**
 * Fetch completed bookings for the past N days from Square Appointments.
 * Returns [{ id, clientId, clientName, clientPhone, serviceType, completedAt }]
 */
async function getRecentAppointmentsSquare(conn, days = 90) {
    const startAt = dayjs().subtract(days, 'day').toISOString();
    const endAt   = dayjs().toISOString();

    const appointments = [];
    let cursor = null;

    while (true) {
        const params = {
            location_id:   conn.square_location_id,
            start_at_min:  startAt,
            start_at_max:  endAt,
            limit:         100,
        };
        if (cursor) params.cursor = cursor;

        const response = await axios.get(`${SQUARE_API_BASE}/bookings`, {
            headers: {
                'Authorization': `Bearer ${conn.square_access_token}`,
                'Square-Version': '2024-01-18',
                'Accept':         'application/json',
            },
            params,
        });

        const data     = response.data;
        const bookings = data.bookings || [];

        for (const booking of bookings) {
            if (booking.status !== 'COMPLETED' && booking.status !== 'ACCEPTED') continue;

            const apptSegment = (booking.appointment_segments || [])[0] || {};

            appointments.push({
                id:          booking.id,
                clientId:    booking.customer_id,
                clientName:  booking.customer_note || booking.customer_id, // name fetched separately
                clientPhone: null, // Square requires separate /customers lookup
                serviceType: apptSegment.service_variation_version
                    ? apptSegment.service_variation_version
                    : (apptSegment.any_team_member ? 'Service' : 'Service'),
                completedAt: booking.updated_at || booking.start_at,
            });
        }

        cursor = data.cursor || null;
        if (!cursor || bookings.length < 100) break;
    }

    return appointments;
}

/**
 * Fetch customers from Square.
 */
async function getCustomersSquare(conn) {
    const customers = [];
    let cursor = null;

    while (true) {
        const params = { limit: 100 };
        if (cursor) params.cursor = cursor;

        const response = await axios.get(`${SQUARE_API_BASE}/customers`, {
            headers: {
                'Authorization':  `Bearer ${conn.square_access_token}`,
                'Square-Version': '2024-01-18',
            },
            params,
        });

        const data      = response.data;
        const page_cust = data.customers || [];

        for (const c of page_cust) {
            customers.push({
                id:    c.id,
                name:  `${c.given_name || ''} ${c.family_name || ''}`.trim() || c.id,
                phone: c.phone_number || null,
                email: c.email_address || null,
            });
        }

        cursor = data.cursor || null;
        if (!cursor || page_cust.length < 100) break;
    }

    return customers;
}

// ─── Unified Interface ────────────────────────────────────────────────────────

/**
 * Get recent appointments — routes to Boulevard or Square based on conn.booking_system.
 * Returns [{ id, clientId, clientName, clientPhone, serviceType, completedAt }]
 */
async function getRecentAppointments(conn, days = 90) {
    if (conn.booking_system === 'square') {
        return getRecentAppointmentsSquare(conn, days);
    }
    return getRecentAppointmentsBoulevard(conn, days);
}

/**
 * Get all clients — routes to Boulevard or Square based on conn.booking_system.
 */
async function getClients(conn) {
    if (conn.booking_system === 'square') {
        return getCustomersSquare(conn);
    }
    return getClientsBoulevard(conn);
}

module.exports = {
    getRecentAppointments,
    getClients,
    // Exposed individually for testing
    getRecentAppointmentsBoulevard,
    getRecentAppointmentsSquare,
    getClientsBoulevard,
    getCustomersSquare,
    createAppointmentBoulevard,
};
