'use strict';

const Bull = require('bull');
const { config } = require('../config');
const db = require('../db/supabase');
const { sendSms } = require('../integrations/twilio-sms');
const { reviewRequestSms } = require('../utils/templates');

// ── Queue Setup ───────────────────────────────────────────────────────────────

const queue = new Bull('review-sms', {
  redis: config.redis.url,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60000 }, // 1-min, 2-min, 4-min backoff
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

// ── Job Processor ─────────────────────────────────────────────────────────────

queue.process(async (job) => {
  const { reviewRequestId, shopId, customerName, customerPhone, vehicle, googleReviewUrl, fromNumber } = job.data;

  console.log(`[ReviewRequest] Processing SMS job ${job.id} for request ${reviewRequestId}`);

  // Check if we've already sent (idempotency guard)
  const existing = await db.getClient()
    .from('review_requests')
    .select('sent_at, error')
    .eq('id', reviewRequestId)
    .single();

  if (existing.data?.sent_at) {
    console.log(`[ReviewRequest] Already sent for ${reviewRequestId} — skipping`);
    return { skipped: true };
  }

  // Extract first name for personalization
  const firstName = customerName ? customerName.split(' ')[0] : null;

  const body = reviewRequestSms(firstName, vehicle, googleReviewUrl);

  try {
    await sendSms({ to: customerPhone, body, from: fromNumber });
    await db.markReviewRequestSent(reviewRequestId);
    console.log(`[ReviewRequest] SMS sent and marked for request ${reviewRequestId}`);
    return { sent: true };
  } catch (err) {
    if (err.unsubscribed || err.invalidNumber) {
      // Don't retry these — mark as permanently failed
      await db.markReviewRequestFailed(reviewRequestId, err.message);
      return { failed: true, reason: err.message };
    }
    // Re-throw for Bull's retry logic
    await db.markReviewRequestFailed(reviewRequestId, err.message);
    throw err;
  }
});

queue.on('completed', (job, result) => {
  if (!result.skipped) {
    console.log(`[ReviewRequest] Job ${job.id} completed`);
  }
});

queue.on('failed', (job, err) => {
  console.error(`[ReviewRequest] Job ${job.id} failed after all attempts: ${err.message}`);
});

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Schedule a review request SMS to be sent after the configured delay.
 *
 * @param {object} shop  Shop record from Supabase
 * @param {object} params
 * @param {string} params.roId
 * @param {string} params.customerName
 * @param {string} params.customerPhone
 * @param {string} params.vehicle
 * @param {string} params.serviceSummary
 * @returns {Promise<void>}
 */
async function scheduleReviewRequest(shop, { roId, customerName, customerPhone, vehicle, serviceSummary }) {
  // Guard: valid phone required
  if (!customerPhone) {
    console.warn(`[ReviewRequest] No phone for RO ${roId} — skipping`);
    return;
  }

  // Guard: Google review URL must be set on the shop
  if (!shop.google_review_url) {
    console.warn(`[ReviewRequest] Shop ${shop.id} has no google_review_url — skipping`);
    return;
  }

  // Guard: daily rate limit
  const todayCount = await db.countTodayRequests(shop.id);
  if (todayCount >= config.settings.maxReviewRequestsPerDay) {
    console.warn(`[ReviewRequest] Daily limit reached for shop ${shop.id} — skipping RO ${roId}`);
    return;
  }

  // Guard: don't double-send for same RO
  const existing = await db.getReviewRequestByRoId(shop.id, roId);
  if (existing) {
    console.log(`[ReviewRequest] Request already exists for RO ${roId} — skipping`);
    return;
  }

  // Create the DB record first (so we have an ID for the job)
  const record = await db.createReviewRequest({
    shopId: shop.id,
    roId,
    customerName,
    customerPhone,
    vehicle,
    serviceSummary,
  });

  const delayMs = config.settings.reviewRequestDelayHours * 60 * 60 * 1000;

  const job = await queue.add(
    {
      reviewRequestId: record.id,
      shopId: shop.id,
      customerName,
      customerPhone,
      vehicle,
      googleReviewUrl: shop.google_review_url,
      fromNumber: shop.twilio_from_number || config.twilio.fromNumber,
    },
    { delay: delayMs }
  );

  // Store the job ID in the record for tracking
  await db.getClient()
    .from('review_requests')
    .update({ job_id: String(job.id) })
    .eq('id', record.id);

  const delayHours = config.settings.reviewRequestDelayHours;
  console.log(`[ReviewRequest] Scheduled SMS for ${customerPhone} in ${delayHours}h (job ${job.id}, request ${record.id})`);
}

/**
 * Get queue health metrics.
 */
async function getQueueStatus() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);
  return { waiting, active, completed, failed, delayed };
}

module.exports = { scheduleReviewRequest, getQueueStatus, queue };
