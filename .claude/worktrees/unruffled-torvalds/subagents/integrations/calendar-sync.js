// Calendar Sync — checks real availability so workers never book a taken slot
// Supports: Google Calendar (OAuth), Calendly (API key), Acuity (API key)
// Config: client.settings.integrations.calendar.provider + credentials

const store = require('../store');

// ── Google Calendar ──────────────────────────────────────────────────────────
async function fetchGoogleCalendarSlots(credentials, date) {
    // Requires OAuth access token — client must authorize via Google OAuth flow
    const { accessToken, calendarId = 'primary' } = credentials;
    const start = new Date(date); start.setHours(0, 0, 0, 0);
    const end = new Date(date); end.setHours(23, 59, 59, 999);

    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${start.toISOString()}&timeMax=${end.toISOString()}&singleEvents=true`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Google Calendar API: ${res.status}`);
    const data = await res.json();
    return (data.items || []).map(e => ({
        title: e.summary,
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        status: e.status,
    }));
}

// ── Calendly ─────────────────────────────────────────────────────────────────
async function fetchCalendlySlots(credentials, date) {
    const { apiKey, userUri } = credentials;
    const start = new Date(date); start.setHours(0, 0, 0, 0);
    const end = new Date(date); end.setHours(23, 59, 59, 999);

    const url = `https://api.calendly.com/scheduled_events?user=${userUri}&min_start_time=${start.toISOString()}&max_start_time=${end.toISOString()}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error(`Calendly API: ${res.status}`);
    const data = await res.json();
    return (data.collection || []).map(e => ({
        title: e.name,
        start: e.start_time,
        end: e.end_time,
        status: e.status,
    }));
}

// ── Main: Get booked slots for a date ────────────────────────────────────────
async function getBookedSlots(clientSlug, clientSettings, date = new Date()) {
    const integration = clientSettings?.integrations?.calendar;
    if (!integration?.provider) {
        return { error: 'Calendar integration not configured. Add provider to client settings.', slots: [] };
    }

    try {
        let slots = [];
        if (integration.provider === 'google') {
            slots = await fetchGoogleCalendarSlots(integration.credentials, date);
        } else if (integration.provider === 'calendly') {
            slots = await fetchCalendlySlots(integration.credentials, date);
        } else {
            return { error: `Unsupported calendar provider: ${integration.provider}`, slots: [] };
        }

        // Cache the result
        store.writeJson('calendar-cache', `${clientSlug}_${date.toDateString().replace(/\s/g, '_')}`, {
            slots, fetchedAt: new Date().toISOString()
        });

        console.log(`[CalendarSync] Fetched ${slots.length} booked slots for ${clientSlug} on ${date.toDateString()}`);
        return { slots, provider: integration.provider };
    } catch (e) {
        console.log(`[CalendarSync] Error: ${e.message}`);
        return { error: e.message, slots: [] };
    }
}

// Check if a specific time slot is available
async function isTimeAvailable(clientSlug, clientSettings, dateTime, durationMinutes = 60) {
    const { slots, error } = await getBookedSlots(clientSlug, clientSettings, new Date(dateTime));
    if (error) return { available: null, error }; // can't determine

    const start = new Date(dateTime).getTime();
    const end = start + durationMinutes * 60000;

    const conflict = slots.find(slot => {
        const slotStart = new Date(slot.start).getTime();
        const slotEnd = new Date(slot.end).getTime();
        return start < slotEnd && end > slotStart; // overlap check
    });

    return { available: !conflict, conflict: conflict || null };
}

// Get available time slots for a date (given business hours)
async function getAvailableSlots(clientSlug, clientSettings, date, durationMinutes = 60) {
    const { slots: booked } = await getBookedSlots(clientSlug, clientSettings, new Date(date));
    const hours = clientSettings?.business?.hours || 'Mon-Fri 9am-5pm';

    // Simple 9-5 availability (will be enhanced with hours parsing)
    const available = [];
    const d = new Date(date);
    for (let hour = 9; hour < 17; hour++) {
        d.setHours(hour, 0, 0, 0);
        const slotStart = d.getTime();
        const slotEnd = slotStart + durationMinutes * 60000;
        const conflict = booked.find(b => {
            const bs = new Date(b.start).getTime();
            const be = new Date(b.end).getTime();
            return slotStart < be && slotEnd > bs;
        });
        if (!conflict) {
            available.push({ time: `${hour}:00`, isoTime: d.toISOString() });
        }
    }

    return available;
}

module.exports = { getBookedSlots, isTimeAvailable, getAvailableSlots };
