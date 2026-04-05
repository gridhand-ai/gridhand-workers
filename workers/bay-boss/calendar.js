// Google Calendar API v3 Client
// Auth: OAuth2 (service account or user OAuth)
// Reads/writes tech schedules for the shop
//
// ENV VARS (or per-client config):
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REDIRECT_URI
//   GOOGLE_REFRESH_TOKEN       — long-lived token for server-side access
//   GOOGLE_SERVICE_ACCOUNT_KEY — JSON key file path for service account auth

const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

// ─── Auth: OAuth2 with refresh token ─────────────────────────────────────────
function getOAuth2Client(config = {}) {
    const clientId     = config.googleClientId     || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri  = config.googleRedirectUri  || process.env.GOOGLE_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';
    const refreshToken = config.googleRefreshToken || process.env.GOOGLE_REFRESH_TOKEN;

    if (!clientId || !clientSecret) {
        throw new Error('Google OAuth credentials missing. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
    }

    const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

    if (refreshToken) {
        auth.setCredentials({ refresh_token: refreshToken });
    }

    return auth;
}

// ─── Auth: Service account (preferred for server-side) ────────────────────────
function getServiceAccountAuth(keyFilePath) {
    const path = keyFilePath || process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!path) throw new Error('Google service account key path missing. Set GOOGLE_SERVICE_ACCOUNT_KEY.');

    return new google.auth.GoogleAuth({
        keyFile: path,
        scopes: SCOPES,
    });
}

// ─── Get calendar client ──────────────────────────────────────────────────────
function getCalendarClient(calendarConfig = {}) {
    let auth;
    if (calendarConfig.serviceAccountKey || process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
        auth = getServiceAccountAuth(calendarConfig.serviceAccountKey);
    } else {
        auth = getOAuth2Client(calendarConfig);
    }

    return google.calendar({ version: 'v3', auth });
}

// ─── List Events ──────────────────────────────────────────────────────────────
// Get all events from a calendar for a given day
async function listEvents(calendarConfig, calendarId, date = null) {
    const calendar = getCalendarClient(calendarConfig);
    const targetDate = date || new Date().toISOString().split('T')[0];

    const timeMin = new Date(`${targetDate}T00:00:00`).toISOString();
    const timeMax = new Date(`${targetDate}T23:59:59`).toISOString();

    try {
        const res = await calendar.events.list({
            calendarId: calendarId || 'primary',
            timeMin,
            timeMax,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 250,
        });

        const events = res.data.items || [];
        console.log(`[Calendar] Fetched ${events.length} events for ${targetDate} from calendar ${calendarId}`);
        return events;
    } catch (e) {
        console.error(`[Calendar] listEvents error: ${e.message}`);
        throw new Error(`Google Calendar error: ${e.message}`);
    }
}

// ─── Get Tech Schedule ────────────────────────────────────────────────────────
// Reads a technician's calendar to determine their availability
async function getTechSchedule(calendarConfig, techCalendarId, date = null) {
    const events = await listEvents(calendarConfig, techCalendarId, date);

    const schedule = events.map(event => ({
        id:        event.id,
        title:     event.summary || 'Busy',
        start:     event.start?.dateTime || event.start?.date,
        end:       event.end?.dateTime || event.end?.date,
        allDay:    !event.start?.dateTime,
        status:    event.status, // 'confirmed', 'tentative', 'cancelled'
        notes:     event.description || '',
        colorId:   event.colorId,
    }));

    // Calculate busy minutes for the day
    let busyMinutes = 0;
    for (const e of schedule) {
        if (e.start && e.end && !e.allDay && e.status !== 'cancelled') {
            const start = new Date(e.start);
            const end   = new Date(e.end);
            busyMinutes += Math.max(0, (end - start) / 60000);
        }
    }

    return {
        calendarId: techCalendarId,
        date: date || new Date().toISOString().split('T')[0],
        events: schedule,
        busyHours: parseFloat((busyMinutes / 60).toFixed(1)),
        availableHours: parseFloat((Math.max(0, 8 - busyMinutes / 60)).toFixed(1)),
    };
}

// ─── Create Schedule Event ────────────────────────────────────────────────────
// Write a job assignment to a tech's calendar
async function createEvent(calendarConfig, calendarId, eventData) {
    const calendar = getCalendarClient(calendarConfig);

    const {
        title,
        description = '',
        startDateTime,
        endDateTime,
        colorId = '5', // banana yellow — visible on shop calendar
        attendees = [],
    } = eventData;

    const event = {
        summary:     title,
        description,
        start:  { dateTime: startDateTime, timeZone: calendarConfig.timezone || 'America/Chicago' },
        end:    { dateTime: endDateTime,   timeZone: calendarConfig.timezone || 'America/Chicago' },
        colorId,
        attendees: attendees.map(email => ({ email })),
        reminders: { useDefault: false },
    };

    try {
        const res = await calendar.events.insert({
            calendarId: calendarId || 'primary',
            resource:   event,
        });

        console.log(`[Calendar] Created event "${title}" on ${calendarId} (ID: ${res.data.id})`);
        return res.data;
    } catch (e) {
        console.error(`[Calendar] createEvent error: ${e.message}`);
        throw new Error(`Failed to create calendar event: ${e.message}`);
    }
}

// ─── Update Event ─────────────────────────────────────────────────────────────
async function updateEvent(calendarConfig, calendarId, eventId, updates) {
    const calendar = getCalendarClient(calendarConfig);

    try {
        const res = await calendar.events.patch({
            calendarId: calendarId || 'primary',
            eventId,
            resource: updates,
        });

        console.log(`[Calendar] Updated event ${eventId} on ${calendarId}`);
        return res.data;
    } catch (e) {
        console.error(`[Calendar] updateEvent error: ${e.message}`);
        throw new Error(`Failed to update calendar event: ${e.message}`);
    }
}

// ─── Delete Event ─────────────────────────────────────────────────────────────
async function deleteEvent(calendarConfig, calendarId, eventId) {
    const calendar = getCalendarClient(calendarConfig);

    try {
        await calendar.events.delete({ calendarId, eventId });
        console.log(`[Calendar] Deleted event ${eventId} from ${calendarId}`);
        return true;
    } catch (e) {
        console.error(`[Calendar] deleteEvent error: ${e.message}`);
        return false;
    }
}

// ─── Block Off Time (PTO, lunch, unavailable) ─────────────────────────────────
async function blockTime(calendarConfig, calendarId, startDateTime, endDateTime, reason = 'Unavailable') {
    return createEvent(calendarConfig, calendarId, {
        title:         reason,
        description:   'Auto-blocked by GRIDHAND Bay Boss',
        startDateTime,
        endDateTime,
        colorId:       '11', // tomato red
    });
}

// ─── Sync Job Assignment to Calendar ─────────────────────────────────────────
// Given a repair order assignment, write it to the tech's calendar
async function syncJobToCalendar(calendarConfig, techCalendarId, job) {
    const {
        repairOrderId,
        customerName,
        vehicleInfo,
        serviceType,
        estimatedHours = 1,
        startDateTime,
    } = job;

    const endDate = new Date(startDateTime);
    endDate.setMinutes(endDate.getMinutes() + estimatedHours * 60);

    const title = `RO #${repairOrderId} — ${serviceType || 'Service'}`;
    const description = [
        `Customer: ${customerName || 'Unknown'}`,
        `Vehicle: ${vehicleInfo || 'TBD'}`,
        `Service: ${serviceType || 'TBD'}`,
        `Est. Time: ${estimatedHours}h`,
        `RO #: ${repairOrderId}`,
        ``,
        `Auto-scheduled by GRIDHAND Bay Boss`,
    ].join('\n');

    return createEvent(calendarConfig, techCalendarId, {
        title,
        description,
        startDateTime,
        endDateTime: endDate.toISOString(),
        colorId: '2', // sage green — assigned job
    });
}

// ─── List All Tech Schedules for a Day ────────────────────────────────────────
// Pass a map of { techId: calendarId }
async function getAllTechSchedules(calendarConfig, techCalendarMap, date = null) {
    const entries = Object.entries(techCalendarMap);
    const results = await Promise.allSettled(
        entries.map(([techId, calendarId]) =>
            getTechSchedule(calendarConfig, calendarId, date).then(s => ({ techId, ...s }))
        )
    );

    const schedules = {};
    for (let i = 0; i < entries.length; i++) {
        const [techId] = entries[i];
        if (results[i].status === 'fulfilled') {
            schedules[techId] = results[i].value;
        } else {
            console.error(`[Calendar] Failed to fetch schedule for tech ${techId}: ${results[i].reason}`);
            schedules[techId] = { error: results[i].reason?.message, techId };
        }
    }

    return schedules;
}

// ─── Generate OAuth URL (for initial setup) ───────────────────────────────────
function generateAuthUrl(config = {}) {
    const auth = getOAuth2Client(config);
    return auth.generateAuthUrl({
        access_type: 'offline',
        scope:       SCOPES,
        prompt:      'consent',
    });
}

// ─── Exchange auth code for tokens (one-time setup) ───────────────────────────
async function exchangeCodeForTokens(code, config = {}) {
    const auth = getOAuth2Client(config);
    const { tokens } = await auth.getToken(code);
    console.log('[Calendar] Tokens received. Save your refresh_token:', tokens.refresh_token);
    return tokens;
}

module.exports = {
    listEvents,
    getTechSchedule,
    getAllTechSchedules,
    createEvent,
    updateEvent,
    deleteEvent,
    blockTime,
    syncJobToCalendar,
    generateAuthUrl,
    exchangeCodeForTokens,
};
