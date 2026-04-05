/**
 * GRIDHAND Sub-Scheduler — Google Calendar API Integration
 *
 * Mirrors Buildertrend scheduled items to Google Calendar.
 * Uses OAuth 2.0 with offline access.
 */

'use strict';

const { google } = require('googleapis');
const db = require('./db');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

function getOAuthClient() {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

function getAuthorizationUrl(state) {
    const oAuth2Client = getOAuthClient();
    return oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope:       SCOPES,
        state,
        prompt:      'consent',
    });
}

async function exchangeCode(clientSlug, code) {
    const oAuth2Client = getOAuthClient();
    const { tokens } = await oAuth2Client.getToken(code);
    const expiresAt = new Date(tokens.expiry_date).toISOString();

    await db.updateGoogleTokens(clientSlug, {
        accessToken:  tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
    });

    return tokens.access_token;
}

async function getAuthedClient(clientSlug) {
    const conn = await db.getConnection(clientSlug);
    if (!conn?.google_access_token) throw new Error(`No Google Calendar connection for ${clientSlug}`);

    const oAuth2Client = getOAuthClient();
    oAuth2Client.setCredentials({
        access_token:  conn.google_access_token,
        refresh_token: conn.google_refresh_token,
        expiry_date:   conn.google_expires_at ? new Date(conn.google_expires_at).getTime() : undefined,
    });

    // Auto-refresh handler
    oAuth2Client.on('tokens', async (tokens) => {
        if (tokens.access_token) {
            await db.updateGoogleTokens(clientSlug, {
                accessToken:  tokens.access_token,
                refreshToken: tokens.refresh_token || conn.google_refresh_token,
                expiresAt:    new Date(tokens.expiry_date).toISOString(),
            });
        }
    });

    return oAuth2Client;
}

// ─── Calendar Operations ──────────────────────────────────────────────────────

/**
 * Create or update a Google Calendar event for a scheduled item.
 * Returns the Google event ID.
 */
async function upsertCalendarEvent(clientSlug, calendarId, sched, existingEventId = null) {
    const auth     = await getAuthedClient(clientSlug);
    const calendar = google.calendar({ version: 'v3', auth });

    const startDateTime = sched.startTime
        ? `${sched.startDate}T${sched.startTime}:00`
        : sched.startDate;
    const isAllDay = !sched.startTime;

    const event = {
        summary:     `[Sub] ${sched.title}${sched.subName ? ` — ${sched.subName}` : ''}`,
        description: [
            `Project: ${sched.projectName || 'N/A'}`,
            `Sub: ${sched.subName || 'TBD'}`,
            sched.trade ? `Trade: ${sched.trade}` : null,
            sched.subPhone ? `Phone: ${sched.subPhone}` : null,
        ].filter(Boolean).join('\n'),
        start: isAllDay ? { date: sched.startDate } : { dateTime: startDateTime, timeZone: 'America/Chicago' },
        end:   isAllDay
            ? { date: sched.endDate || sched.startDate }
            : { dateTime: `${sched.endDate || sched.startDate}T${sched.startTime}:00`, timeZone: 'America/Chicago' },
        reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 60 * 24 }] },
    };

    try {
        if (existingEventId) {
            const result = await calendar.events.update({
                calendarId, eventId: existingEventId, resource: event,
            });
            return result.data.id;
        } else {
            const result = await calendar.events.insert({ calendarId, resource: event });
            return result.data.id;
        }
    } catch (err) {
        console.warn(`[Calendar] Event upsert failed for ${sched.title}: ${err.message}`);
        return existingEventId || null;
    }
}

module.exports = {
    getAuthorizationUrl,
    exchangeCode,
    upsertCalendarEvent,
};
