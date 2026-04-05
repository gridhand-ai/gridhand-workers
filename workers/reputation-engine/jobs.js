/**
 * GRIDHAND Reputation Engine — Bull Queue Job Definitions
 *
 * Jobs:
 *  - review-monitor   → Every 4 hours: fetch new reviews from Google + Yelp
 *  - alert-negatives  → After review-monitor: SMS manager on new negative reviews
 *  - auto-respond     → After review-monitor: post auto-replies to Google reviews
 *  - weekly-digest    → 8am Monday: send weekly reputation summary SMS
 *
 * All jobs are registered here. index.js schedules them via node-cron.
 */

'use strict';

const Bull    = require('bull');
const dayjs   = require('dayjs');
const google  = require('./google');
const yelp    = require('./yelp');
const reports = require('./reports');
const db      = require('./db');
const sms     = require('./sms');

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const reviewMonitorQueue = new Bull('reputation:review-monitor', REDIS_URL);
const alertNegativeQueue = new Bull('reputation:alert-negatives', REDIS_URL);
const autoRespondQueue   = new Bull('reputation:auto-respond',   REDIS_URL);
const weeklyDigestQueue  = new Bull('reputation:weekly-digest',  REDIS_URL);

// ─── Job: Review Monitor ──────────────────────────────────────────────────────

reviewMonitorQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[ReviewMonitor] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    let totalNew = 0;

    // Fetch Google reviews
    if (conn.google_place_id) {
        try {
            const googleReviews = await google.getRecentReviews(clientSlug, conn);
            for (const review of googleReviews) {
                await db.upsertReview(clientSlug, review);
            }
            totalNew += googleReviews.length;
            console.log(`[ReviewMonitor] Synced ${googleReviews.length} Google reviews for ${clientSlug}`);
        } catch (err) {
            console.error(`[ReviewMonitor] Google error for ${clientSlug}: ${err.message}`);
        }
    }

    // Fetch Yelp reviews
    if (conn.yelp_business_id && conn.yelp_api_key) {
        try {
            const yelpReviews = await yelp.getRecentReviews(clientSlug, conn);
            for (const review of yelpReviews) {
                await db.upsertReview(clientSlug, review);
            }
            totalNew += yelpReviews.length;
            console.log(`[ReviewMonitor] Synced ${yelpReviews.length} Yelp reviews for ${clientSlug}`);
        } catch (err) {
            console.error(`[ReviewMonitor] Yelp error for ${clientSlug}: ${err.message}`);
        }
    }

    console.log(`[ReviewMonitor] Done for ${clientSlug} — ${totalNew} reviews synced`);
    return { clientSlug, totalSynced: totalNew };
});

// ─── Job: Alert Negatives ─────────────────────────────────────────────────────

alertNegativeQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[AlertNegatives] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    if (!conn.alert_on_negative) {
        return { clientSlug, alerted: 0 };
    }

    const threshold = conn.negative_threshold || 3;
    const negatives = await db.getNegativeUnalerted(clientSlug, threshold);

    let alerted = 0;

    for (const review of negatives) {
        const alertMsg = reports.generateNegativeAlertSMS({
            review,
            businessName: conn.business_name || clientSlug,
        });

        await sms.sendToManager(conn, alertMsg, 'negative_review', {
            reviewId:   review.id,
            platform:   review.platform,
            starRating: review.star_rating,
        });

        await db.markAlertSent(review.id);
        alerted++;

        console.log(`[AlertNegatives] Alerted on ${review.star_rating}-star ${review.platform} review for ${clientSlug}`);
    }

    console.log(`[AlertNegatives] Done for ${clientSlug} — ${alerted} negative reviews alerted`);
    return { clientSlug, alerted };
});

// ─── Job: Auto-Respond ────────────────────────────────────────────────────────

autoRespondQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[AutoRespond] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    // Only auto-respond on Google (Yelp API doesn't allow owner replies)
    if (!conn.auto_respond_google || !conn.google_place_id) {
        console.log(`[AutoRespond] Auto-respond disabled for ${clientSlug} — skipping`);
        return { clientSlug, responded: 0 };
    }

    const unresponded = await db.getUnrespondedReviews(clientSlug);
    const googleReviews = unresponded.filter(r => r.platform === 'google');

    let responded = 0;

    for (const review of googleReviews) {
        try {
            const replyText = reports.generateAutoResponse({
                review,
                businessName: conn.business_name || clientSlug,
                signature:    conn.response_signature || null,
                tone:         conn.response_tone || 'professional',
            });

            await google.postReply(clientSlug, conn, review.platform_review_id, replyText);

            await db.markReplied(review.id, replyText, 'auto_responded');

            await db.saveResponse(clientSlug, {
                reviewId:           review.id,
                platform:           'google',
                platformReviewId:   review.platform_review_id,
                responseText:       replyText,
                responseType:       'auto',
                postedSuccessfully: true,
            });

            responded++;
            console.log(`[AutoRespond] Responded to ${review.star_rating}-star Google review for ${clientSlug}`);

            // Rate limit — don't hammer the Google API
            await new Promise(r => setTimeout(r, 1000));

        } catch (err) {
            console.error(`[AutoRespond] Failed to respond to review ${review.id}: ${err.message}`);

            await db.saveResponse(clientSlug, {
                reviewId:           review.id,
                platform:           'google',
                platformReviewId:   review.platform_review_id,
                responseText:       '',
                responseType:       'auto',
                postedSuccessfully: false,
                errorMessage:       err.message,
            });
        }
    }

    console.log(`[AutoRespond] Done for ${clientSlug} — ${responded} responses posted`);
    return { clientSlug, responded };
});

// ─── Job: Weekly Digest ───────────────────────────────────────────────────────

weeklyDigestQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[WeeklyDigest] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const [googleStats, yelpStats] = await Promise.all([
        conn.google_place_id ? db.getReviewStats(clientSlug, 'google') : null,
        conn.yelp_business_id ? db.getReviewStats(clientSlug, 'yelp') : null,
    ]);

    const digestMsg = reports.generateWeeklyDigest({
        googleStats,
        yelpStats,
        businessName: conn.business_name || clientSlug,
    });

    await sms.sendToManager(conn, digestMsg, 'weekly_digest');

    console.log(`[WeeklyDigest] Done for ${clientSlug}`);
    return { clientSlug };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['review-monitor', reviewMonitorQueue],
    ['alert-negatives', alertNegativeQueue],
    ['auto-respond',   autoRespondQueue],
    ['weekly-digest',  weeklyDigestQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} job failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} job completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runReviewMonitor(clientSlug) {
    return reviewMonitorQueue.add({ clientSlug }, { attempts: 3, backoff: 30000 });
}

async function runAlertNegatives(clientSlug) {
    return alertNegativeQueue.add({ clientSlug }, { attempts: 2, backoff: 30000 });
}

async function runAutoRespond(clientSlug) {
    return autoRespondQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runWeeklyDigest(clientSlug) {
    return weeklyDigestQueue.add({ clientSlug }, { attempts: 2, backoff: 30000 });
}

async function runForAllClients(jobFn) {
    const clients = await db.getAllConnectedClients();
    const results = [];
    for (const { client_slug } of clients) {
        try {
            const job = await jobFn(client_slug);
            results.push({ clientSlug: client_slug, jobId: job.id });
        } catch (err) {
            console.error(`[Jobs] Failed to queue job for ${client_slug}: ${err.message}`);
        }
    }
    return results;
}

module.exports = {
    runReviewMonitor,
    runAlertNegatives,
    runAutoRespond,
    runWeeklyDigest,
    runForAllClients,
    reviewMonitorQueue,
    alertNegativeQueue,
    autoRespondQueue,
    weeklyDigestQueue,
};
