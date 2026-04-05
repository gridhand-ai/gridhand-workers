/**
 * GRIDHAND Route Optimizer — Jobber API Integration
 *
 * Jobber uses GraphQL for its API.
 * API base: https://api.getjobber.com/api/graphql
 *
 * Handles:
 *  - OAuth 2.0 authorization + token exchange
 *  - Token refresh (Jobber access tokens expire in 2 hours)
 *  - Fetching today's scheduled visits/jobs with addresses and crew assignments
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
 * Returns the new access token.
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
 * Pass the raw conn object to avoid an extra DB call.
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
 * Get all scheduled visits/jobs for today.
 * Returns array of normalized job objects with address and crew info.
 */
async function getScheduledJobs(clientSlug, conn) {
    const token = await refreshTokenIfNeeded(conn);
    const today = dayjs().format('YYYY-MM-DD');

    const query = `
        query GetTodaysVisits($startAt: ISO8601DateTime!, $endAt: ISO8601DateTime!) {
            visits(filter: { startAt: { gte: $startAt }, endAt: { lte: $endAt } }, first: 200) {
                nodes {
                    id
                    title
                    startAt
                    duration
                    instructions
                    client {
                        id
                        name
                        phones {
                            number
                        }
                    }
                    property {
                        address {
                            street
                            city
                            province
                            postalCode
                            country
                        }
                    }
                    assignedTo {
                        edges {
                            node {
                                id
                                name
                                phone {
                                    number
                                }
                            }
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

    const startAt = `${today}T00:00:00Z`;
    const endAt   = `${today}T23:59:59Z`;

    const data  = await gql(token, query, { startAt, endAt });
    const nodes = data?.visits?.nodes || [];

    return nodes.map(visit => {
        const addr     = visit.property?.address || {};
        const address  = [addr.street, addr.city, addr.province, addr.postalCode]
            .filter(Boolean)
            .join(', ');

        // Jobber assigns multiple workers per visit — treat lead as first assigned
        const assignees   = visit.assignedTo?.edges?.map(e => e.node) || [];
        const lead        = assignees[0] || null;

        return {
            id:                    visit.id,
            jobNumber:             visit.job?.jobNumber || null,
            clientName:            visit.client?.name || 'Unknown Client',
            clientId:              visit.client?.id || null,
            address,
            scheduledStart:        visit.startAt,
            estimatedDurationMinutes: Math.round((visit.duration || 3600) / 60),
            crewId:                lead?.id || 'unassigned',
            crewName:              assignees.map(a => a.name).join(', ') || 'Unassigned',
            crewLeadPhone:         lead?.phone?.number || null,
        };
    });
}

module.exports = {
    exchangeCode,
    refreshAccessToken,
    refreshTokenIfNeeded,
    getScheduledJobs,
};
