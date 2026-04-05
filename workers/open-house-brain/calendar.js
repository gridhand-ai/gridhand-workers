/**
 * GRIDHAND Open House Brain — Google Calendar Integration
 *
 * OAuth2 with per-client refresh tokens stored in oh_clients.
 * All calendar operations scoped to the client's google_calendar_id.
 */

'use strict';

require('dotenv').config();

const axios = require('axios');
const dayjs = require('dayjs');
const db    = require('./db');

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';

// ─── Token Management ─────────────────────────────────────────────────────────

// In-memory access token cache { clientSlug: { token, expiresAt } }
const tokenCache = {};

async function getAccessToken(clientSlug) {
    const now = Date.now();

    // Return cached token if still valid (with 60s buffer)
    if (tokenCache[clientSlug] && tokenCache[clientSlug].expiresAt > now + 60000) {
        return tokenCache[clientSlug].token;
    }

    const client = await db.getClient(clientSlug);
    if (!client) throw new Error(`No client found for slug: ${clientSlug}`);
    if (!client.google_refresh_token) throw new Error(`No Google refresh token for ${clientSlug}`);

    const clientId     = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set');

    let resp;
    try {
        resp = await axios.post(TOKEN_URL, new URLSearchParams({
            client_id:     clientId,
            client_secret: clientSecret,
            refresh_token: client.google_refresh_token,
            grant_type:    'refresh_token',
        }).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 10000,
        });
    } catch (err) {
        const msg = err.response?.data?.error_description || err.message;
        throw new Error(`Google token refresh failed for ${clientSlug}: ${msg}`);
    }

    const { access_token, expires_in } = resp.data;
    tokenCache[clientSlug] = {
        token:     access_token,
        expiresAt: now + expires_in * 1000,
    };

    return access_token;
}

// ─── Core Request Helper ──────────────────────────────────────────────────────

async function calendarRequest(clientSlug, method, path, data = null) {
    try {
        const token = await getAccessToken(clientSlug);
        const client = await db.getClient(clientSlug);
        const calendarId = encodeURIComponent(client.google_calendar_id || 'primary');

        // Replace :calendarId placeholder if present in path
        const resolvedPath = path.replace(':calendarId', calendarId);

        const config = {
            method,
            url: `${CALENDAR_BASE}${resolvedPath}`,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            timeout: 15000,
        };

        if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
            config.data = data;
        }
        if (data && method === 'GET') {
            config.params = data;
        }

        const resp = await axios(config);
        return { ok: true, data: resp.data, error: null };
    } catch (err) {
        const error = err.response?.data?.error?.message || err.message;
        console.error(`[Calendar] ${method} ${path} failed for ${clientSlug}: ${error}`);
        return { ok: false, data: null, error };
    }
}

// ─── Event Operations ─────────────────────────────────────────────────────────

async function createEvent(clientSlug, eventData) {
    const client = await db.getClient(clientSlug);
    const calendarId = encodeURIComponent(client.google_calendar_id || 'primary');

    const result = await calendarRequest(
        clientSlug,
        'POST',
        `/calendars/${calendarId}/events`,
        eventData
    );

    if (!result.ok) return result;

    return {
        ok: true,
        data: {
            eventId:  result.data.id,
            htmlLink: result.data.htmlLink,
            event:    result.data,
        },
        error: null,
    };
}

async function updateEvent(clientSlug, eventId, updates) {
    const client = await db.getClient(clientSlug);
    const calendarId = encodeURIComponent(client.google_calendar_id || 'primary');

    return calendarRequest(
        clientSlug,
        'PATCH',
        `/calendars/${calendarId}/events/${eventId}`,
        updates
    );
}

async function deleteEvent(clientSlug, eventId) {
    const client = await db.getClient(clientSlug);
    const calendarId = encodeURIComponent(client.google_calendar_id || 'primary');

    return calendarRequest(
        clientSlug,
        'DELETE',
        `/calendars/${calendarId}/events/${eventId}`
    );
}

async function getUpcomingEvents(clientSlug, days = 7) {
    const client = await db.getClient(clientSlug);
    const calendarId = encodeURIComponent(client.google_calendar_id || 'primary');

    const timeMin = new Date().toISOString();
    const timeMax = dayjs().add(days, 'day').toISOString();

    const result = await calendarRequest(
        clientSlug,
        'GET',
        `/calendars/${calendarId}/events`,
        {
            timeMin,
            timeMax,
            singleEvents: true,
            orderBy:      'startTime',
            maxResults:   50,
            q:            'GRIDHAND',
        }
    );

    if (!result.ok) return result;

    return {
        ok:    true,
        data:  result.data.items || [],
        error: null,
    };
}

async function addEventReminder(clientSlug, eventId, minutesBefore = 60) {
    const client = await db.getClient(clientSlug);
    const calendarId = encodeURIComponent(client.google_calendar_id || 'primary');

    // First fetch the current event to preserve existing data
    const current = await calendarRequest(
        clientSlug,
        'GET',
        `/calendars/${calendarId}/events/${eventId}`
    );

    if (!current.ok) return current;

    const existingOverrides = current.data.reminders?.overrides || [];
    const merged = [
        ...existingOverrides,
        { method: 'popup', minutes: minutesBefore },
        { method: 'email', minutes: minutesBefore },
    ];

    return calendarRequest(
        clientSlug,
        'PATCH',
        `/calendars/${calendarId}/events/${eventId}`,
        {
            reminders: {
                useDefault: false,
                overrides:  merged,
            },
        }
    );
}

// ─── Event Formatter ──────────────────────────────────────────────────────────

function formatOpenHouseEvent(openHouse) {
    // openHouse: { listing_address, date, start_time, end_time, notes, listing_id }
    const dateStr  = openHouse.date; // YYYY-MM-DD
    const startISO = `${dateStr}T${openHouse.start_time}`;
    const endISO   = `${dateStr}T${openHouse.end_time}`;

    const description = [
        'GRIDHAND — Open House Event',
        '',
        `Property: ${openHouse.listing_address}`,
        openHouse.listing_id ? `Listing ID: ${openHouse.listing_id}` : null,
        '',
        openHouse.notes ? `Notes: ${openHouse.notes}` : null,
        '',
        'Managed by GRIDHAND Open House Brain',
    ]
        .filter(line => line !== null)
        .join('\n');

    return {
        summary:     `Open House — ${openHouse.listing_address}`,
        description,
        location:    openHouse.listing_address,
        start: {
            dateTime: startISO,
            timeZone: openHouse.timezone || 'America/Chicago',
        },
        end: {
            dateTime: endISO,
            timeZone: openHouse.timezone || 'America/Chicago',
        },
        reminders: {
            useDefault: false,
            overrides: [
                { method: 'popup', minutes: 60 },
                { method: 'email', minutes: 1440 }, // 24h before
            ],
        },
        colorId: '6', // Tangerine — stands out on calendar
    };
}

module.exports = {
    calendarRequest,
    createEvent,
    updateEvent,
    deleteEvent,
    getUpcomingEvents,
    addEventReminder,
    formatOpenHouseEvent,
};
