'use strict';

const { GoogleAuth } = require('google-auth-library');
const fetch = require('node-fetch');
const { config } = require('../config');

// Google My Business API base
// NOTE: The reviews API is still served via the v4 mybusiness endpoint (not yet migrated)
const GBP_BASE = 'https://mybusiness.googleapis.com/v4';

let _auth = null;

/**
 * Initialize and return a Google OAuth2 client authenticated as the service account.
 * Supports both a file path and an inline base64-encoded JSON credential.
 */
async function getAuthClient() {
  if (_auth) return _auth;

  let credentials;

  if (config.google.serviceAccountKeyJson) {
    // Inline base64 JSON (preferred for deployment environments)
    const raw = Buffer.from(config.google.serviceAccountKeyJson, 'base64').toString('utf8');
    credentials = JSON.parse(raw);
  } else if (config.google.serviceAccountKeyPath) {
    credentials = require(require('path').resolve(config.google.serviceAccountKeyPath));
  } else {
    throw new Error(
      'Google credentials not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY_JSON or GOOGLE_SERVICE_ACCOUNT_KEY_PATH.'
    );
  }

  const auth = new GoogleAuth({
    credentials,
    scopes: config.google.scopes,
  });

  _auth = auth;
  return _auth;
}

/**
 * Get a fresh access token string for direct HTTP calls.
 */
async function getAccessToken() {
  const auth = await getAuthClient();
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  return tokenResponse.token;
}

/**
 * Authenticated GET to GBP API.
 */
async function gbpGet(path, params = {}) {
  const token = await getAccessToken();
  const url = new URL(`${GBP_BASE}/${path}`);
  Object.entries(params).forEach(([k, v]) => v !== undefined && url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GBP API error ${res.status} on GET ${path}: ${body}`);
  }
  return res.json();
}

/**
 * Authenticated PUT to GBP API (for posting review replies).
 */
async function gbpPut(path, body) {
  const token = await getAccessToken();
  const res = await fetch(`${GBP_BASE}/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GBP API error ${res.status} on PUT ${path}: ${text}`);
  }
  // 200 with the reply object, or 204 no content
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Reviews ───────────────────────────────────────────────────────────────────

/**
 * List reviews for a location.
 *
 * @param {string} locationName  Full resource name, e.g. "accounts/123/locations/456"
 * @param {object} options
 * @param {number} options.pageSize  Max reviews to return (default 50)
 * @param {string} options.orderBy  Sort order (default "updateTime desc")
 * @returns {Promise<Array>}  Array of normalized review objects
 */
async function listReviews(locationName, { pageSize = 50, orderBy = 'updateTime desc' } = {}) {
  // locationName is e.g. "accounts/123/locations/456"
  // API path: {locationName}/reviews
  const path = `${locationName}/reviews`;

  let allReviews = [];
  let nextPageToken;

  do {
    const data = await gbpGet(path, {
      pageSize,
      orderBy,
      pageToken: nextPageToken,
    });

    const reviews = data.reviews || [];
    allReviews = allReviews.concat(reviews.map(normalizeReview));
    nextPageToken = data.nextPageToken;

    // Only paginate on the first call (we just want the latest batch)
    break;
  } while (nextPageToken);

  return allReviews;
}

/**
 * Post a reply to a review.
 *
 * @param {string} reviewName  Full review resource name, e.g. "accounts/123/locations/456/reviews/789"
 * @param {string} replyText  The reply body text
 * @returns {Promise<object>}
 */
async function replyToReview(reviewName, replyText) {
  // PUT {reviewName}/reply  with body: { comment: "..." }
  const path = `${reviewName}/reply`;
  const result = await gbpPut(path, { comment: replyText });
  console.log(`[GoogleBusiness] Replied to review ${reviewName}`);
  return result;
}

// ── Normalization ─────────────────────────────────────────────────────────────

function normalizeReview(r) {
  // r.starRating is "ONE", "TWO", "THREE", "FOUR", "FIVE"
  const ratingMap = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  const rating = ratingMap[r.starRating] || 0;

  const reviewer = r.reviewer || {};

  return {
    id: r.reviewId,
    name: r.name, // Full resource name e.g. "accounts/.../locations/.../reviews/..."
    reviewerName: reviewer.displayName || null,
    reviewerProfilePhoto: reviewer.profilePhotoUrl || null,
    rating,
    reviewText: r.comment || null,
    publishedAt: r.createTime || null,
    updatedAt: r.updateTime || null,
    hasReply: !!(r.reviewReply && r.reviewReply.comment),
    replyText: r.reviewReply ? r.reviewReply.comment : null,
    raw: r,
  };
}

module.exports = {
  listReviews,
  replyToReview,
};
