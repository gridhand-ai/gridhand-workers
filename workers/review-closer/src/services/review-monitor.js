'use strict';

const { listReviews, replyToReview } = require('../integrations/google-business');
const { sendSms } = require('../integrations/twilio-sms');
const db = require('../db/supabase');
const { positiveReviewReply, lowStarOwnerAlert } = require('../utils/templates');

// Track last check time per shop to avoid re-processing old reviews
const lastCheckTimes = new Map();

/**
 * Check for new Google reviews for a single shop.
 * Called on the cron interval for every active shop.
 *
 * @param {object} shop  Shop record from Supabase
 * @returns {Promise<{ processed: number, responded: number, alerted: number }>}
 */
async function checkNewReviews(shop) {
  if (!shop.google_location_id) {
    // Shop not configured for Google monitoring — silent skip
    return { processed: 0, responded: 0, alerted: 0 };
  }

  console.log(`[ReviewMonitor] Checking reviews for shop ${shop.name} (${shop.id})`);

  let reviews;
  try {
    reviews = await listReviews(shop.google_location_id, { pageSize: 50 });
  } catch (err) {
    console.error(`[ReviewMonitor] Failed to fetch reviews for shop ${shop.id}: ${err.message}`);
    return { processed: 0, responded: 0, alerted: 0 };
  }

  const lastCheck = lastCheckTimes.get(shop.id) || new Date(0);
  let processed = 0;
  let responded = 0;
  let alerted = 0;

  for (const review of reviews) {
    // Skip if we've already stored this review
    const alreadySeen = await db.reviewExists(shop.id, review.id);
    if (alreadySeen) continue;

    // Only process reviews newer than our last check
    const reviewDate = review.publishedAt ? new Date(review.publishedAt) : null;
    if (reviewDate && reviewDate <= lastCheck) continue;

    console.log(`[ReviewMonitor] New review — shop: ${shop.id}, rating: ${review.rating}, reviewer: ${review.reviewerName}`);

    // Store in DB
    const record = await db.createReviewRecord({
      shopId: shop.id,
      reviewId: review.id,
      reviewerName: review.reviewerName,
      rating: review.rating,
      reviewText: review.reviewText,
      reviewUrl: null,
      publishedAt: review.publishedAt,
    });

    // Try to link review back to a review request (by matching phone — best effort)
    // Google doesn't give us the customer's phone, so we can't auto-link reliably.
    // Leaving this hook here for future enrichment.

    processed++;

    if (review.rating >= 4) {
      await handlePositiveReview(shop, review, record);
      responded++;
    } else {
      await handleNegativeReview(shop, review, record);
      alerted++;
    }
  }

  lastCheckTimes.set(shop.id, new Date());

  if (processed > 0) {
    console.log(`[ReviewMonitor] Shop ${shop.id}: processed=${processed} responded=${responded} alerted=${alerted}`);
  }

  return { processed, responded, alerted };
}

// ── Positive Review (4–5 stars) ───────────────────────────────────────────────

async function handlePositiveReview(shop, review, record) {
  // Don't reply if Google already has a reply on this review
  if (review.hasReply) {
    console.log(`[ReviewMonitor] Review ${review.id} already has a reply — skipping`);
    await db.markReviewResponded(record.id, review.replyText);
    return;
  }

  const replyText = positiveReviewReply(review.rating, review.reviewerName, shop.name);

  try {
    await replyToReview(review.name, replyText);
    await db.markReviewResponded(record.id, replyText);
    console.log(`[ReviewMonitor] Auto-replied to ${review.rating}★ review from ${review.reviewerName || 'anonymous'}`);
  } catch (err) {
    console.error(`[ReviewMonitor] Failed to reply to review ${review.id}: ${err.message}`);
    // Don't rethrow — continue processing other reviews
  }
}

// ── Negative Review (1–3 stars) ───────────────────────────────────────────────

async function handleNegativeReview(shop, review, record) {
  if (!shop.owner_phone) {
    console.warn(`[ReviewMonitor] Shop ${shop.id} has no owner_phone — cannot alert`);
    return;
  }

  const alertBody = lowStarOwnerAlert({
    ownerName: shop.owner_name,
    reviewerName: review.reviewerName,
    rating: review.rating,
    reviewText: review.reviewText,
  });

  try {
    await sendSms({
      to: shop.owner_phone,
      body: alertBody,
    });
    await db.markOwnerAlerted(record.id);
    console.log(`[ReviewMonitor] Owner alerted for ${review.rating}★ review on shop ${shop.id}`);
  } catch (err) {
    console.error(`[ReviewMonitor] Failed to alert owner for review ${review.id}: ${err.message}`);
    // Don't rethrow — continue processing
  }
}

/**
 * Run the monitor for all active shops.
 * Called by the cron job in index.js.
 *
 * @returns {Promise<object>}  Aggregate stats across all shops
 */
async function runMonitorForAllShops() {
  let shops;
  try {
    shops = await db.getAllActiveShops();
  } catch (err) {
    console.error(`[ReviewMonitor] Failed to load active shops: ${err.message}`);
    return;
  }

  const total = { processed: 0, responded: 0, alerted: 0 };

  for (const shop of shops) {
    try {
      const result = await checkNewReviews(shop);
      total.processed += result.processed;
      total.responded += result.responded;
      total.alerted += result.alerted;
    } catch (err) {
      console.error(`[ReviewMonitor] Unhandled error for shop ${shop.id}: ${err.message}`);
    }
  }

  return total;
}

module.exports = { checkNewReviews, runMonitorForAllShops };
