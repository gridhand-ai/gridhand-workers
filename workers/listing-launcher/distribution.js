/**
 * GRIDHAND Listing Launcher — Social Media Distribution Layer
 *
 * Handles posting to Facebook, Instagram, and Twitter (X).
 * Tracks post performance metrics 24h after distribution.
 * All functions return { ok, data/postId/mediaId/tweetId, error }.
 *
 * Credentials are stored per-client in ll_clients:
 *   facebook_page_id, facebook_access_token
 *   instagram_account_id (linked to FB page)
 *   twitter_api_key, twitter_api_secret, twitter_access_token, twitter_access_secret
 */

'use strict';

const axios = require('axios');
const db    = require('./db');

const FB_BASE      = 'https://graph.facebook.com/v18.0';
const TWITTER_BASE = 'https://api.twitter.com/2';

// ─── Twitter OAuth 1.0a ───────────────────────────────────────────────────────

function buildTwitterOAuthHeader(method, url, params, credentials) {
    const crypto = require('crypto');

    const oauthParams = {
        oauth_consumer_key:     credentials.apiKey,
        oauth_nonce:            crypto.randomBytes(16).toString('hex'),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
        oauth_token:            credentials.accessToken,
        oauth_version:          '1.0',
    };

    const allParams = { ...params, ...oauthParams };
    const sortedParams = Object.keys(allParams).sort().map(k =>
        `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`
    ).join('&');

    const signatureBase = [
        method.toUpperCase(),
        encodeURIComponent(url),
        encodeURIComponent(sortedParams),
    ].join('&');

    const signingKey = `${encodeURIComponent(credentials.apiSecret)}&${encodeURIComponent(credentials.accessSecret)}`;
    const signature  = crypto.createHmac('sha1', signingKey).update(signatureBase).digest('base64');

    oauthParams.oauth_signature = signature;

    const headerParts = Object.keys(oauthParams).sort().map(k =>
        `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`
    );

    return `OAuth ${headerParts.join(', ')}`;
}

// ─── Facebook ─────────────────────────────────────────────────────────────────

/**
 * Post to a Facebook Page feed.
 * Returns { ok, postId, error }.
 */
async function postToFacebook(clientSlug, listing, content, imageUrl = null) {
    const client = await db.getClient(clientSlug);
    if (!client) return { ok: false, postId: null, error: `Client not found: ${clientSlug}` };
    if (!client.facebook_page_id || !client.facebook_access_token) {
        return { ok: false, postId: null, error: 'Facebook credentials not configured' };
    }

    try {
        let postId;

        if (imageUrl) {
            // Post with photo: first upload photo, then create post with photo attachment
            const photoResp = await axios.post(
                `${FB_BASE}/${client.facebook_page_id}/photos`,
                {
                    url:          imageUrl,
                    caption:      content,
                    access_token: client.facebook_access_token,
                    published:    true,
                },
                { timeout: 30000 }
            );
            postId = photoResp.data?.post_id || photoResp.data?.id;
        } else {
            // Text-only post
            const postResp = await axios.post(
                `${FB_BASE}/${client.facebook_page_id}/feed`,
                {
                    message:      content,
                    access_token: client.facebook_access_token,
                },
                { timeout: 15000 }
            );
            postId = postResp.data?.id;
        }

        if (!postId) throw new Error('No post ID returned from Facebook');

        console.log(`[Distribution] Facebook post created for ${clientSlug}: ${postId}`);
        return { ok: true, postId, error: null };
    } catch (err) {
        const message = err.response?.data?.error?.message || err.message;
        console.error(`[Distribution] Facebook post failed for ${clientSlug}: ${message}`);
        return { ok: false, postId: null, error: message };
    }
}

// ─── Instagram ────────────────────────────────────────────────────────────────

/**
 * Post to Instagram Business Account via Facebook Graph API.
 * Two-step: create media container → publish.
 * Returns { ok, mediaId, error }.
 */
async function postToInstagram(clientSlug, listing, content, imageUrl) {
    const client = await db.getClient(clientSlug);
    if (!client) return { ok: false, mediaId: null, error: `Client not found: ${clientSlug}` };
    if (!client.instagram_account_id || !client.facebook_access_token) {
        return { ok: false, mediaId: null, error: 'Instagram credentials not configured' };
    }

    if (!imageUrl) {
        return { ok: false, mediaId: null, error: 'Instagram requires an image URL' };
    }

    try {
        // Step 1: Create media container
        const containerResp = await axios.post(
            `${FB_BASE}/${client.instagram_account_id}/media`,
            {
                image_url:    imageUrl,
                caption:      content,
                access_token: client.facebook_access_token,
            },
            { timeout: 30000 }
        );

        const containerId = containerResp.data?.id;
        if (!containerId) throw new Error('No container ID returned from Instagram');

        // Step 2: Publish the container
        const publishResp = await axios.post(
            `${FB_BASE}/${client.instagram_account_id}/media_publish`,
            {
                creation_id:  containerId,
                access_token: client.facebook_access_token,
            },
            { timeout: 15000 }
        );

        const mediaId = publishResp.data?.id;
        if (!mediaId) throw new Error('No media ID returned from Instagram publish');

        console.log(`[Distribution] Instagram post published for ${clientSlug}: ${mediaId}`);
        return { ok: true, mediaId, error: null };
    } catch (err) {
        const message = err.response?.data?.error?.message || err.message;
        console.error(`[Distribution] Instagram post failed for ${clientSlug}: ${message}`);
        return { ok: false, mediaId: null, error: message };
    }
}

// ─── Twitter / X ──────────────────────────────────────────────────────────────

/**
 * Post to Twitter/X using v2 API with OAuth 1.0a.
 * Returns { ok, tweetId, error }.
 */
async function postToTwitter(clientSlug, listing, content) {
    const client = await db.getClient(clientSlug);
    if (!client) return { ok: false, tweetId: null, error: `Client not found: ${clientSlug}` };
    if (!client.twitter_api_key || !client.twitter_api_secret ||
        !client.twitter_access_token || !client.twitter_access_secret) {
        return { ok: false, tweetId: null, error: 'Twitter credentials not configured' };
    }

    const tweetUrl = `${TWITTER_BASE}/tweets`;
    const body     = { text: content };

    const credentials = {
        apiKey:        client.twitter_api_key,
        apiSecret:     client.twitter_api_secret,
        accessToken:   client.twitter_access_token,
        accessSecret:  client.twitter_access_secret,
    };

    const oauthHeader = buildTwitterOAuthHeader('POST', tweetUrl, {}, credentials);

    try {
        const resp = await axios.post(
            tweetUrl,
            body,
            {
                headers: {
                    Authorization:  oauthHeader,
                    'Content-Type': 'application/json',
                },
                timeout: 15000,
            }
        );

        const tweetId = resp.data?.data?.id;
        if (!tweetId) throw new Error('No tweet ID returned from Twitter');

        console.log(`[Distribution] Tweet posted for ${clientSlug}: ${tweetId}`);
        return { ok: true, tweetId, error: null };
    } catch (err) {
        const message = err.response?.data?.detail || err.response?.data?.title || err.message;
        console.error(`[Distribution] Twitter post failed for ${clientSlug}: ${message}`);
        return { ok: false, tweetId: null, error: message };
    }
}

// ─── Performance Tracking ─────────────────────────────────────────────────────

/**
 * Fetch engagement metrics for a previously published post.
 * Called 24 hours after distribution.
 */
async function trackPerformance(clientSlug, listingId, platform, postId) {
    const client = await db.getClient(clientSlug);
    if (!client) return { ok: false, data: null, error: `Client not found: ${clientSlug}` };

    try {
        let metrics = {};

        if (platform === 'facebook') {
            metrics = await fetchFacebookInsights(client, postId);
        } else if (platform === 'instagram') {
            metrics = await fetchInstagramInsights(client, postId);
        } else if (platform === 'twitter') {
            metrics = await fetchTwitterMetrics(client, postId);
        } else {
            return { ok: false, data: null, error: `Unknown platform: ${platform}` };
        }

        return { ok: true, data: metrics, error: null };
    } catch (err) {
        console.error(`[Distribution] Performance tracking failed for ${platform} post ${postId}: ${err.message}`);
        return { ok: false, data: null, error: err.message };
    }
}

async function fetchFacebookInsights(client, postId) {
    const resp = await axios.get(
        `${FB_BASE}/${postId}/insights`,
        {
            params: {
                metric:       'post_impressions_unique,post_reactions_by_type_total,post_clicks,post_shares',
                access_token: client.facebook_access_token,
            },
            timeout: 10000,
        }
    );

    const insightData = resp.data?.data || [];
    const findMetric  = (name) => insightData.find(m => m.name === name)?.values?.[0]?.value || 0;

    const reactions = findMetric('post_reactions_by_type_total');
    const likes     = typeof reactions === 'object'
        ? Object.values(reactions).reduce((sum, v) => sum + v, 0)
        : reactions;

    return {
        views:       findMetric('post_impressions_unique'),
        likes:       likes,
        comments:    0, // requires separate /comments call
        shares:      findMetric('post_shares'),
        linkClicks:  findMetric('post_clicks'),
        rawMetrics:  { insightData },
    };
}

async function fetchInstagramInsights(client, mediaId) {
    const resp = await axios.get(
        `${FB_BASE}/${mediaId}/insights`,
        {
            params: {
                metric:       'impressions,reach,likes,comments,shares,saved',
                access_token: client.facebook_access_token,
            },
            timeout: 10000,
        }
    );

    const insightData = resp.data?.data || [];
    const findMetric  = (name) => insightData.find(m => m.name === name)?.values?.[0]?.value || 0;

    return {
        views:       findMetric('reach'),
        likes:       findMetric('likes'),
        comments:    findMetric('comments'),
        shares:      findMetric('shares'),
        linkClicks:  findMetric('saved'), // "saved" is closest to link intent on IG
        rawMetrics:  { insightData },
    };
}

async function fetchTwitterMetrics(client, tweetId) {
    const tweetUrl = `${TWITTER_BASE}/tweets/${tweetId}`;
    const params   = { 'tweet.fields': 'public_metrics,non_public_metrics' };

    const credentials = {
        apiKey:        client.twitter_api_key,
        apiSecret:     client.twitter_api_secret,
        accessToken:   client.twitter_access_token,
        accessSecret:  client.twitter_access_secret,
    };

    const oauthHeader = buildTwitterOAuthHeader('GET', tweetUrl, params, credentials);

    const resp = await axios.get(
        tweetUrl,
        {
            headers:  { Authorization: oauthHeader },
            params,
            timeout:  10000,
        }
    );

    const pub    = resp.data?.data?.public_metrics     || {};
    const nonPub = resp.data?.data?.non_public_metrics || {};

    return {
        views:       pub.impression_count   || 0,
        likes:       pub.like_count         || 0,
        comments:    pub.reply_count        || 0,
        shares:      pub.retweet_count      || 0,
        linkClicks:  nonPub.url_link_clicks || pub.url_link_clicks || 0,
        rawMetrics:  resp.data?.data,
    };
}

// ─── Distribution Log ─────────────────────────────────────────────────────────

/**
 * Save distribution record to db and return the new record ID.
 */
async function logDistribution(clientSlug, listingId, platform, postId, content, imageUrl = null) {
    const client = await db.getClient(clientSlug);
    const clientId = client?.id;

    await db.logDistribution(listingId, clientId, { platform, postId, content, imageUrl });
    console.log(`[Distribution] Logged ${platform} post ${postId} for listing ${listingId}`);
}

module.exports = {
    postToFacebook,
    postToInstagram,
    postToTwitter,
    trackPerformance,
    logDistribution,
};
