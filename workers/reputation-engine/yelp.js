/**
 * GRIDHAND Reputation Engine — Yelp Fusion API Integration
 *
 * Fetches business reviews via the Yelp Fusion API.
 * NOTE: Yelp's public API does not support posting owner responses.
 * Responses must be done via the Yelp for Business portal manually.
 *
 * Yelp Fusion API docs: https://docs.developer.yelp.com/reference/v3_business_reviews
 */

'use strict';

const axios = require('axios');

const YELP_BASE = 'https://api.yelp.com/v3';

function buildHeaders(conn) {
    return {
        'Authorization': `Bearer ${conn.yelp_api_key}`,
        'Accept':        'application/json',
    };
}

// ─── Fetch Reviews ────────────────────────────────────────────────────────────

async function getRecentReviews(clientSlug, conn) {
    if (!conn.yelp_business_id || !conn.yelp_api_key) {
        console.warn(`[Yelp] No business_id or api_key for ${clientSlug} — skipping Yelp`);
        return [];
    }

    try {
        const { data } = await axios.get(
            `${YELP_BASE}/businesses/${conn.yelp_business_id}/reviews`,
            {
                headers: buildHeaders(conn),
                params: { limit: 50, sort_by: 'date_desc' },
            }
        );

        return (data.reviews || []).map(r => ({
            platform:         'yelp',
            platformReviewId: r.id,
            reviewerName:     r.user?.name || 'Anonymous',
            reviewerPhotoUrl: r.user?.image_url || null,
            starRating:       r.rating,
            reviewText:       r.text || null,
            reviewDate:       r.time_created || null,
            replyText:        null,   // Yelp API v3 doesn't return owner replies
            repliedAt:        null,
            replyStatus:      'skipped',  // Can't auto-respond on Yelp
        }));
    } catch (err) {
        console.error(`[Yelp] getRecentReviews error for ${clientSlug}: ${err.message}`);
        throw err;
    }
}

// ─── Fetch Business Info ──────────────────────────────────────────────────────

async function getBusinessInfo(conn) {
    if (!conn.yelp_business_id || !conn.yelp_api_key) return null;

    try {
        const { data } = await axios.get(
            `${YELP_BASE}/businesses/${conn.yelp_business_id}`,
            { headers: buildHeaders(conn) }
        );

        return {
            name:        data.name,
            rating:      data.rating,
            reviewCount: data.review_count,
            url:         data.url,
        };
    } catch (err) {
        console.error(`[Yelp] getBusinessInfo error: ${err.message}`);
        return null;
    }
}

module.exports = {
    getRecentReviews,
    getBusinessInfo,
};
