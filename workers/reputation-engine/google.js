/**
 * GRIDHAND Reputation Engine — Google Business Profile API Integration
 *
 * Fetches reviews and posts owner replies via the Google Business Profile API.
 *
 * Google Business Profile API docs:
 *   https://developers.google.com/my-business/reference/businessinformation/rest
 *   https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews
 *
 * OAuth 2.0 scopes required:
 *   https://www.googleapis.com/auth/business.manage
 */

'use strict';

const axios = require('axios');
const db    = require('./db');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_BASE      = 'https://mybusiness.googleapis.com/v4';

// ─── OAuth Token Management ───────────────────────────────────────────────────

async function getValidToken(clientSlug, conn) {
    const now = new Date();

    if (conn.google_token_expires_at && new Date(conn.google_token_expires_at) > now) {
        return conn.google_access_token;
    }

    // Refresh token
    const { data } = await axios.post(GOOGLE_TOKEN_URL, null, {
        params: {
            client_id:     process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            refresh_token: conn.google_refresh_token,
            grant_type:    'refresh_token',
        },
    });

    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
    await db.updateGoogleTokens(clientSlug, {
        accessToken:  data.access_token,
        refreshToken: conn.google_refresh_token, // refresh token doesn't change
        expiresAt,
    });

    return data.access_token;
}

// ─── OAuth Redirect URL Builder ───────────────────────────────────────────────

function buildAuthUrl(clientSlug, ownerPhone) {
    const state = Buffer.from(JSON.stringify({ clientSlug, ownerPhone, ts: Date.now() })).toString('base64');
    const params = new URLSearchParams({
        client_id:     process.env.GOOGLE_CLIENT_ID,
        redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
        response_type: 'code',
        scope:         'https://www.googleapis.com/auth/business.manage',
        access_type:   'offline',
        prompt:        'consent',
        state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCode({ code, clientSlug, ownerPhone }) {
    const { data } = await axios.post(GOOGLE_TOKEN_URL, null, {
        params: {
            client_id:     process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
            code,
            grant_type:    'authorization_code',
        },
    });

    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    await db.upsertConnection({
        client_slug:                 clientSlug,
        google_access_token:         data.access_token,
        google_refresh_token:        data.refresh_token,
        google_token_expires_at:     expiresAt,
        owner_phone:                 ownerPhone,
        business_name:               clientSlug, // Will be updated after first fetch
    });

    return data;
}

// ─── Fetch Reviews ────────────────────────────────────────────────────────────

async function getRecentReviews(clientSlug, conn) {
    if (!conn.google_place_id) {
        console.warn(`[Google] No place_id for ${clientSlug} — cannot fetch reviews`);
        return [];
    }

    try {
        const token = await getValidToken(clientSlug, conn);

        // Get account name first
        const { data: accountsData } = await axios.get(`${GOOGLE_BASE}/accounts`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });

        const account = accountsData.accounts?.[0];
        if (!account) return [];

        // Fetch reviews for the location
        const locationName = `${account.name}/locations/${conn.google_place_id}`;
        const { data } = await axios.get(`${GOOGLE_BASE}/${locationName}/reviews`, {
            headers: { 'Authorization': `Bearer ${token}` },
            params: { pageSize: 50 },
        });

        return (data.reviews || []).map(r => ({
            platform:          'google',
            platformReviewId:  r.reviewId,
            reviewerName:      r.reviewer?.displayName || 'Anonymous',
            reviewerPhotoUrl:  r.reviewer?.profilePhotoUrl || null,
            starRating:        convertStarRating(r.starRating),
            reviewText:        r.comment || null,
            reviewDate:        r.createTime || null,
            replyText:         r.reviewReply?.comment || null,
            repliedAt:         r.reviewReply?.updateTime || null,
            replyStatus:       r.reviewReply ? 'manually_responded' : 'pending',
        }));
    } catch (err) {
        console.error(`[Google] getRecentReviews error for ${clientSlug}: ${err.message}`);
        throw err;
    }
}

// ─── Post Reply ───────────────────────────────────────────────────────────────

async function postReply(clientSlug, conn, platformReviewId, replyText) {
    if (!conn.google_place_id) throw new Error('No Google place_id configured');

    const token = await getValidToken(clientSlug, conn);

    const { data: accountsData } = await axios.get(`${GOOGLE_BASE}/accounts`, {
        headers: { 'Authorization': `Bearer ${token}` },
    });

    const account = accountsData.accounts?.[0];
    if (!account) throw new Error('No Google Business account found');

    const reviewName = `${account.name}/locations/${conn.google_place_id}/reviews/${platformReviewId}`;

    await axios.put(`${GOOGLE_BASE}/${reviewName}/reply`, {
        comment: replyText,
    }, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type':  'application/json',
        },
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function convertStarRating(starString) {
    const map = {
        ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5,
        STAR_RATING_UNSPECIFIED: null,
    };
    return map[starString] ?? parseInt(starString) ?? null;
}

module.exports = {
    buildAuthUrl,
    exchangeCode,
    getRecentReviews,
    postReply,
};
