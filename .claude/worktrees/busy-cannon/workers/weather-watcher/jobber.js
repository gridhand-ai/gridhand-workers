/**
 * GRIDHAND Weather Watcher — Jobber API Integration
 *
 * Jobber uses GraphQL for its API.
 * API base: https://api.getjobber.com/api/graphql
 *
 * Handles:
 *  - OAuth 2.0 authorization + token exchange
 *  - Token refresh (Jobber access tokens expire in 2 hours)
 *  - Fetching tomorrow's scheduled visits/jobs
 *  - Rescheduling a job to a new date
 *  - Looking up client phone numbers
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');
const db    = require('./db');

// ─── Jobber API Constants ──────────────────────────────────────────────────────

const JOBBER_API_BASE  = 'https://api.getjobber.com/api/graphql';
const JOBBER_TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getClientCredentials() {
    const clientId     = process.env.JOBBER_CLIENT_ID;
    const clientSecret = process.env.JOBBER_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('JOBBER_CLIENT_ID and JOBBER_CLIENT_SECRET must be set in environment');
    }
    return { clientId, clientSecret };
}

// ─── OAuth 2.0 ────────────────────────────────────────────────────────────────

/**
 * Exchange authorization code for access + refresh tokens.
 * Called in the OAuth callback handler.
 */
async function exchangeCode({ code, clientSlug, ownerPhone }) {
    const { clientId, clientSecret } = getClientCredentials();
    const redirectUri = process.env.JOBBER_REDIRECT_URI;

    const response = await axios.post(
        JOBBER_TOKEN_URL,
        new URLSearchParams({
            grant_type:    'authorization_code',
            client_id:     clientId,
            client_secret: clientSecret,
            code,
            redirect_uri:  redirectUri,
        }).toString(),
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept':       'application/json',
            },
        }
    );

    const tokens    = response.data;
    const expiresAt = dayjs().add(tokens.expires_in || 7200, 'second').toISOString();

    await db.upsertConnection({
        clientSlug,
        ownerPhone,
        accessToken:  tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
    });

    console.log(`[Jobber] Tokens saved for ${clientSlug}`);
    return { clientSlug };
}

/**
 * Refresh access token using stored refresh token.
 */
async function refreshAccessToken(clientSlug) {
    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No Jobber connection found for ${clientSlug}`);

    const { clientId, clientSecret } = getClientCredentials();

    const response = await axios.post(
        JOBBER_TOKEN_URL,
        new URLSearchParams({
            grant_type:    'refresh_token',
            client_id:     clientId,
            client_secret: clientSecret,
            refresh_token: conn.refresh_token,
        }).toString(),
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept':       'application/json',
            },
        }
    );

    const tokens    = response.data;
    const expiresAt = dayjs().add(tokens.expires_in || 7200, 'second').toISOString();

    await db.updateTokens(clientSlug, {
        accessToken:  tokens.access_token,
        refreshToken: tokens.refresh_token || conn.refresh_token,
        expiresAt,
    });

    console.log(`[Jobber] Tokens refreshed for ${clientSlug}`);
    return tokens.access_token;
}

/**
 * Check if token is expiring within 5 minutes — refresh if so.
 */
async function refreshTokenIfNeeded(conn) {
    const expiresAt = dayjs(conn.expires_at);
    const nowPlus5  = dayjs().add(5, 'minute');

    if (expiresAt.isBefore(nowPlus5)) {
        return refreshAccessToken(conn.client_slug);
    }

    return conn.access_token;
}

// ─── GraphQL Helper ───────────────────────────────────────────────────────────

async function gql(accessToken, query, variables = {}) {
    try {
        const response = await axios.post(
            JOBBER_API_BASE,
            { query, variables },
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type':  'application/json',
                    'X-JOBBER-GRAPHQL-VERSION': '2024-01-19',
                },
            }
        );

        if (response.data.errors) {
            const msg = response.data.errors.map(e => e.message).join('; ');
            throw new Error(`Jobber GraphQL error: ${msg}`);
        }

        return response.data.data;
    } catch (err) {
        if (err.response?.data) {
            throw new Error(`Jobber API error: ${JSON.stringify(err.response.data)}`);
        }
        throw err;
    }
}

// ─── Data Fetchers ────────────────────────────────────────────────────────────

/**
 * Get all scheduled visits for tomorrow.
 * Returns normalized job objects including client phone and property coords when available.
 */
async function getTomorrowsJobs(clientSlug, conn) {
    const token    = await refreshTokenIfNeeded(conn);
    const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');

    const query = `
        query GetTomorrowsVisits($startAt: ISO8601DateTime!, $endAt: ISO8601DateTime!) {
            visits(filter: { startAt: { gte: $startAt }, endAt: { lte: $endAt } }, first: 200) {
                nodes {
                    id
                    title
                    startAt
                    duration
                    client {
                        id
                        name
                        phones {
                            number
                            primary
                        }
                    }
                    property {
                        address {
                            street
                            city
                            province
                            postalCode
                        }
                        mapCoords {
                            lat
                            lng
                        }
                    }
                    job {
                        id
                        jobNumber
                        title
                    }
                }
            }
        }
    `;

    const startAt = `${tomorrow}T00:00:00Z`;
    const endAt   = `${tomorrow}T23:59:59Z`;

    const data  = await gql(token, query, { startAt, endAt });
    const nodes = data?.visits?.nodes || [];

    return nodes.map(visit => {
        const addr   = visit.property?.address || {};
        const coords = visit.property?.mapCoords || {};

        // Prefer primary phone; fallback to first available
        const phones       = visit.client?.phones || [];
        const primaryPhone = phones.find(p => p.primary)?.number || phones[0]?.number || null;

        return {
            id:            visit.id,
            jobNumber:     visit.job?.jobNumber || null,
            clientId:      visit.client?.id || null,
            clientName:    visit.client?.name || 'Unknown Client',
            clientPhone:   primaryPhone,
            address:       [addr.street, addr.city, addr.province, addr.postalCode].filter(Boolean).join(', '),
            scheduledDate: tomorrow,
            scheduledStart: visit.startAt,
            estimatedDurationMinutes: Math.round((visit.duration || 3600) / 60),
            lat:           coords.lat ? parseFloat(coords.lat) : null,
            lon:           coords.lng ? parseFloat(coords.lng) : null,
        };
    });
}

/**
 * Look up a client's phone number directly from Jobber.
 * Used as fallback when the visit query didn't return a phone.
 */
async function getJobClientPhone(conn, clientId) {
    if (!clientId) return null;

    const token = await refreshTokenIfNeeded(conn);

    const query = `
        query GetClientPhone($id: EncodedId!) {
            client(id: $id) {
                phones {
                    number
                    primary
                }
            }
        }
    `;

    try {
        const data   = await gql(token, query, { id: clientId });
        const phones = data?.client?.phones || [];
        return phones.find(p => p.primary)?.number || phones[0]?.number || null;
    } catch {
        return null;
    }
}

/**
 * Reschedule a Jobber visit/job to a new start date.
 * Keeps the original time of day; only changes the date.
 */
async function rescheduleJob(conn, visitId, newDate) {
    const token = await refreshTokenIfNeeded(conn);

    // First, fetch the current visit to preserve the time component
    const fetchQuery = `
        query GetVisit($id: EncodedId!) {
            visit(id: $id) {
                id
                startAt
                duration
            }
        }
    `;

    const existing = await gql(token, fetchQuery, { id: visitId });
    const visit    = existing?.visit;

    if (!visit) throw new Error(`Visit ${visitId} not found in Jobber`);

    // Compute new ISO timestamp: replace date portion, keep time
    const originalStart = dayjs(visit.startAt);
    const newStart = dayjs(newDate)
        .hour(originalStart.hour())
        .minute(originalStart.minute())
        .second(0)
        .toISOString();

    const mutation = `
        mutation RescheduleVisit($visitId: EncodedId!, $startAt: ISO8601DateTime!) {
            visitEdit(visitId: $visitId, startAt: $startAt) {
                visit {
                    id
                    startAt
                }
                userErrors {
                    message
                    path
                }
            }
        }
    `;

    const result = await gql(token, mutation, { visitId, startAt: newStart });

    const userErrors = result?.visitEdit?.userErrors || [];
    if (userErrors.length) {
        throw new Error(`Jobber reschedule error: ${userErrors.map(e => e.message).join('; ')}`);
    }

    console.log(`[Jobber] Rescheduled visit ${visitId} to ${newDate}`);
    return result?.visitEdit?.visit;
}

module.exports = {
    exchangeCode,
    refreshAccessToken,
    refreshTokenIfNeeded,
    getTomorrowsJobs,
    getJobClientPhone,
    rescheduleJob,
};
