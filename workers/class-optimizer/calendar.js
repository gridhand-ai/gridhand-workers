/**
 * GRIDHAND Class Optimizer — Google Calendar API Integration
 *
 * Uses a per-client service account JSON to manage calendar events.
 * Service accounts must have domain-wide delegation or be invited to the calendar.
 *
 * All public functions return { ok: true, data } or { ok: false, error }.
 */

'use strict';

const { google } = require('googleapis');
const dayjs = require('dayjs');

// ─── Auth Helper ──────────────────────────────────────────────────────────────

/**
 * Build an authorized Google Calendar client from a service account JSON string.
 *
 * @param {string} serviceAccountJson - Raw JSON string of the service account key file
 * @returns {{ auth, calendar }} - Authorized auth client and calendar API instance
 */
function getCalendar(serviceAccountJson) {
    const key = typeof serviceAccountJson === 'string'
        ? JSON.parse(serviceAccountJson)
        : serviceAccountJson;

    const auth = new google.auth.GoogleAuth({
        credentials: key,
        scopes: ['https://www.googleapis.com/auth/calendar'],
    });

    const calendar = google.calendar({ version: 'v3', auth });
    return { auth, calendar };
}

// ─── Event Operations ─────────────────────────────────────────────────────────

/**
 * Create a calendar event for a class session.
 *
 * @param {string} calendarId          - Google Calendar ID (email address or 'primary')
 * @param {string} serviceAccountJson  - Service account JSON string
 * @param {object} classData           - Class details
 *   @param {string} classData.className
 *   @param {string} classData.instructorName
 *   @param {string} classData.startDatetime     - ISO datetime string
 *   @param {string} classData.endDatetime       - ISO datetime string
 *   @param {string} [classData.description]
 *   @param {string} [classData.location]
 *   @param {number} [classData.maxCapacity]
 * @returns {{ ok: boolean, data?: { eventId: string }, error?: string }}
 */
async function createClassEvent(calendarId, serviceAccountJson, classData) {
    try {
        const { calendar } = getCalendar(serviceAccountJson);

        const title = classData.instructorName
            ? `${classData.instructorName} — ${classData.className}`
            : classData.className;

        const description = [
            classData.description || '',
            classData.maxCapacity ? `Max capacity: ${classData.maxCapacity}` : '',
        ].filter(Boolean).join('\n');

        const event = {
            summary:     title,
            description: description || undefined,
            location:    classData.location || undefined,
            start: {
                dateTime: classData.startDatetime,
                timeZone: 'America/Chicago',
            },
            end: {
                dateTime: classData.endDatetime,
                timeZone: 'America/Chicago',
            },
        };

        const response = await calendar.events.insert({
            calendarId,
            resource: event,
        });

        return { ok: true, data: { eventId: response.data.id, event: response.data } };
    } catch (err) {
        console.error(`[Calendar] createClassEvent failed: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

/**
 * Delete a calendar event (used when a class is cancelled).
 *
 * @param {string} calendarId         - Google Calendar ID
 * @param {string} serviceAccountJson - Service account JSON string
 * @param {string} eventId            - Google Calendar event ID
 * @returns {{ ok: boolean, error?: string }}
 */
async function deleteEvent(calendarId, serviceAccountJson, eventId) {
    try {
        const { calendar } = getCalendar(serviceAccountJson);

        await calendar.events.delete({
            calendarId,
            eventId,
        });

        return { ok: true, data: { deleted: true, eventId } };
    } catch (err) {
        // 404 means already deleted — treat as success
        if (err.code === 404 || err.status === 404) {
            return { ok: true, data: { deleted: true, eventId, alreadyGone: true } };
        }
        console.error(`[Calendar] deleteEvent ${eventId} failed: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

/**
 * Update an existing calendar event (reschedule, rename, etc.).
 *
 * @param {string} calendarId         - Google Calendar ID
 * @param {string} serviceAccountJson - Service account JSON string
 * @param {string} eventId            - Google Calendar event ID
 * @param {object} updates            - Partial event fields to update
 *   @param {string} [updates.summary]
 *   @param {string} [updates.description]
 *   @param {string} [updates.startDatetime]
 *   @param {string} [updates.endDatetime]
 *   @param {string} [updates.location]
 * @returns {{ ok: boolean, data?: object, error?: string }}
 */
async function updateEvent(calendarId, serviceAccountJson, eventId, updates) {
    try {
        const { calendar } = getCalendar(serviceAccountJson);

        // First fetch the existing event to merge
        const existing = await calendar.events.get({ calendarId, eventId });
        const patch = { ...existing.data };

        if (updates.summary)       patch.summary     = updates.summary;
        if (updates.description)   patch.description = updates.description;
        if (updates.location)      patch.location    = updates.location;

        if (updates.startDatetime) {
            patch.start = { dateTime: updates.startDatetime, timeZone: 'America/Chicago' };
        }
        if (updates.endDatetime) {
            patch.end = { dateTime: updates.endDatetime, timeZone: 'America/Chicago' };
        }

        const response = await calendar.events.update({
            calendarId,
            eventId,
            resource: patch,
        });

        return { ok: true, data: response.data };
    } catch (err) {
        console.error(`[Calendar] updateEvent ${eventId} failed: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

/**
 * List upcoming events on the calendar for the next N days.
 *
 * @param {string} calendarId         - Google Calendar ID
 * @param {string} serviceAccountJson - Service account JSON string
 * @param {number} days               - How many days ahead to look (default: 7)
 * @returns {{ ok: boolean, data?: { events: Array }, error?: string }}
 */
async function listUpcomingEvents(calendarId, serviceAccountJson, days = 7) {
    try {
        const { calendar } = getCalendar(serviceAccountJson);

        const timeMin = dayjs().toISOString();
        const timeMax = dayjs().add(days, 'day').toISOString();

        const response = await calendar.events.list({
            calendarId,
            timeMin,
            timeMax,
            singleEvents:  true,
            orderBy:       'startTime',
            maxResults:    250,
        });

        return { ok: true, data: { events: response.data.items || [] } };
    } catch (err) {
        console.error(`[Calendar] listUpcomingEvents failed: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

module.exports = {
    getCalendar,
    createClassEvent,
    deleteEvent,
    updateEvent,
    listUpcomingEvents,
};
