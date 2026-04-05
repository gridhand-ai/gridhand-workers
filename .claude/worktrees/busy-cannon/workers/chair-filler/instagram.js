/**
 * GRIDHAND Chair Filler — Instagram Graph API
 *
 * Handles OAuth token exchange, refresh, and media publishing.
 * Uses the Instagram Graph API (requires a connected Facebook Business Page).
 *
 * Flow to post an image:
 *   1. createMediaContainer → returns containerId
 *   2. publishMedia → publishes containerId, returns postId
 *
 * createPost() wraps both steps.
 */

'use strict';

const axios = require('axios');

const INSTAGRAM_API_BASE = 'https://graph.instagram.com';
const FACEBOOK_API_BASE  = 'https://graph.facebook.com/v18.0';

// ─── OAuth ────────────────────────────────────────────────────────────────────

/**
 * Exchange a short-lived code for a long-lived access token.
 * Returns { access_token, token_type, expires_in }
 */
async function exchangeCode(code, redirectUri) {
    const appId     = process.env.INSTAGRAM_APP_ID;
    const appSecret = process.env.INSTAGRAM_APP_SECRET;

    if (!appId || !appSecret) {
        throw new Error('INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET must be set');
    }

    // Step 1: Exchange code for short-lived token (via Facebook endpoint)
    const shortLivedResponse = await axios.post(`${FACEBOOK_API_BASE}/oauth/access_token`, null, {
        params: {
            client_id:     appId,
            client_secret: appSecret,
            redirect_uri:  redirectUri,
            code,
        },
    });

    const shortToken = shortLivedResponse.data.access_token;

    // Step 2: Exchange short-lived token for long-lived token (60 days)
    const longLivedResponse = await axios.get(`${FACEBOOK_API_BASE}/oauth/access_token`, {
        params: {
            grant_type:        'fb_exchange_token',
            client_id:         appId,
            client_secret:     appSecret,
            fb_exchange_token: shortToken,
        },
    });

    return {
        access_token: longLivedResponse.data.access_token,
        token_type:   longLivedResponse.data.token_type   || 'bearer',
        expires_in:   longLivedResponse.data.expires_in   || 5184000, // ~60 days
    };
}

/**
 * Refresh a long-lived token before it expires.
 * Returns { access_token, token_type, expires_in }
 */
async function refreshLongLivedToken(token) {
    const appId     = process.env.INSTAGRAM_APP_ID;
    const appSecret = process.env.INSTAGRAM_APP_SECRET;

    if (!appId || !appSecret) {
        throw new Error('INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET must be set');
    }

    const response = await axios.get(`${INSTAGRAM_API_BASE}/refresh_access_token`, {
        params: {
            grant_type:   'ig_refresh_token',
            access_token: token,
        },
    });

    return {
        access_token: response.data.access_token,
        token_type:   'bearer',
        expires_in:   response.data.expires_in || 5184000,
    };
}

// ─── Account Info ─────────────────────────────────────────────────────────────

/**
 * Get basic account info (id, username) for the authenticated user.
 */
async function getAccountInfo(accessToken) {
    const response = await axios.get(`${INSTAGRAM_API_BASE}/me`, {
        params: {
            fields:       'id,username',
            access_token: accessToken,
        },
    });

    return {
        id:       response.data.id,
        username: response.data.username,
    };
}

// ─── Media Publishing ─────────────────────────────────────────────────────────

/**
 * Step 1 of posting: create a media container.
 * imageUrl must be a publicly accessible URL (HTTPS).
 * Returns containerId.
 */
async function createMediaContainer(accessToken, igUserId, { imageUrl, caption }) {
    if (!imageUrl) {
        throw new Error('imageUrl is required to create an Instagram media container');
    }

    const response = await axios.post(`${INSTAGRAM_API_BASE}/${igUserId}/media`, null, {
        params: {
            image_url:    imageUrl,
            caption:      caption || '',
            access_token: accessToken,
        },
    });

    const containerId = response.data.id;
    if (!containerId) {
        throw new Error(`createMediaContainer returned no id: ${JSON.stringify(response.data)}`);
    }

    return containerId;
}

/**
 * Step 2 of posting: publish a media container.
 * Returns the published post ID.
 */
async function publishMedia(accessToken, igUserId, containerId) {
    const response = await axios.post(`${INSTAGRAM_API_BASE}/${igUserId}/media_publish`, null, {
        params: {
            creation_id:  containerId,
            access_token: accessToken,
        },
    });

    const postId = response.data.id;
    if (!postId) {
        throw new Error(`publishMedia returned no id: ${JSON.stringify(response.data)}`);
    }

    return postId;
}

/**
 * Full post flow: container → publish → return postId.
 * conn must have instagram_access_token and instagram_account_id.
 *
 * If imageUrl is null/undefined, creates a text-only caption post
 * using a fallback carousel or text post (note: IG requires an image).
 * In that case, we skip posting and return null.
 */
async function createPost(conn, { caption, imageUrl }) {
    const { instagram_access_token: token, instagram_account_id: igUserId } = conn;

    if (!token || !igUserId) {
        throw new Error('Instagram access token and account ID are required');
    }

    if (!imageUrl) {
        console.warn(`[Instagram] No imageUrl provided for ${conn.client_slug} — skipping media post`);
        return null;
    }

    console.log(`[Instagram] Creating media container for ${conn.client_slug}...`);
    const containerId = await createMediaContainer(token, igUserId, { imageUrl, caption });

    // Brief pause — Instagram recommends a short wait between container creation and publish
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log(`[Instagram] Publishing container ${containerId} for ${conn.client_slug}...`);
    const postId = await publishMedia(token, igUserId, containerId);

    console.log(`[Instagram] Published post ${postId} for ${conn.client_slug}`);
    return postId;
}

module.exports = {
    exchangeCode,
    refreshLongLivedToken,
    getAccountInfo,
    createMediaContainer,
    publishMedia,
    createPost,
};
