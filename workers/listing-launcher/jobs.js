/**
 * GRIDHAND Listing Launcher — Bull Queue Job Definitions
 *
 * Queues (all prefixed 'll:'):
 *  - ll:generate-content      → Generate all content for a new/updated listing
 *  - ll:distribute-listing    → Post to configured social platforms
 *  - ll:track-performance     → Fetch engagement metrics 24h post-distribution
 *  - ll:price-drop-campaign   → Re-distribute + notify leads when price drops
 *  - ll:weekly-performance    → Weekly SMS report to agent (Mondays 8am Chicago)
 *  - ll:new-listing-alert     → SMS agent when a new listing is detected from MLS
 *
 * Crons are started from index.js, not here.
 * Job dispatchers (runXxx) are called by index.js cron handlers and /trigger endpoints.
 */

'use strict';

const Bull       = require('bull');
const dayjs      = require('dayjs');
const db         = require('./db');
const mls        = require('./mls');
const content    = require('./content');
const dist       = require('./distribution');
const twilioLib  = require('../../lib/twilio-client');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const generateContentQueue   = new Bull('ll:generate-content',    REDIS_URL);
const distributeQueue        = new Bull('ll:distribute-listing',  REDIS_URL);
const trackPerformanceQueue  = new Bull('ll:track-performance',   REDIS_URL);
const priceDropQueue         = new Bull('ll:price-drop-campaign', REDIS_URL);
const weeklyPerformanceQueue = new Bull('ll:weekly-performance',  REDIS_URL);
const newListingAlertQueue   = new Bull('ll:new-listing-alert',   REDIS_URL);

// ─── SMS Helper — routes through lib/twilio-client.js for TCPA + opt-out compliance ──

async function sendSms(toPhone, body, clientSlug, messageType, listingId = null) {
    const from = process.env.TWILIO_FROM_NUMBER;
    if (!from) throw new Error('TWILIO_FROM_NUMBER not set');

    await twilioLib.sendSMS({
        from,
        to:             toPhone,
        body,
        clientSlug:     clientSlug || null,
        clientTimezone: 'America/Chicago',
    });
    await db.logSms(clientSlug, { toPhone, messageBody: body, messageType, listingId });
}

// ─── Job: Generate Content ────────────────────────────────────────────────────

generateContentQueue.process(async (job) => {
    const { listingId, clientSlug } = job.data;
    console.log(`[GenerateContent] Starting for listing ${listingId} (${clientSlug})`);

    const [listing, client] = await Promise.all([
        db.getListing(listingId),
        db.getClient(clientSlug),
    ]);

    if (!listing) throw new Error(`Listing not found: ${listingId}`);
    if (!client)  throw new Error(`Client not found: ${clientSlug}`);

    // Generate all content in parallel
    const [mlsDesc, fbPost, igResult, twitterPost, canvaResult] = await Promise.all([
        content.generateListingDescription(listing),
        content.generateFacebookPost(listing),
        content.generateInstagramCaption(listing),
        content.generateTwitterPost(listing),
        content.generateCanvaDesign(listing),
    ]);

    // Save all generated content to DB
    await db.upsertContent(listingId, client.id, {
        mlsDescription:  mlsDesc,
        facebookPost:    fbPost,
        instagramCaption: igResult.formatted || igResult.caption || igResult,
        twitterPost,
        canvaDesignUrl:  canvaResult.designUrl || null,
    });

    // SMS agent that content is ready
    if (client.agent_phone) {
        const addr = `${listing.address}, ${listing.city}`;
        await sendSms(
            client.agent_phone,
            `GRIDHAND: Content ready for ${addr} (${listing.beds}bd/${listing.baths}ba at $${(listing.price / 1000).toFixed(0)}k). Review and approve in your dashboard.`,
            clientSlug,
            'content_ready',
            listingId
        );
    }

    console.log(`[GenerateContent] Done for listing ${listingId}`);
    return { listingId, clientSlug, contentGenerated: true };
});

// ─── Job: Distribute Listing ──────────────────────────────────────────────────

distributeQueue.process(async (job) => {
    const { listingId, clientSlug, platforms } = job.data;
    console.log(`[Distribute] Starting for listing ${listingId} (${clientSlug}) → platforms: ${(platforms || []).join(', ')}`);

    const [listing, client, listingContent] = await Promise.all([
        db.getListing(listingId),
        db.getClient(clientSlug),
        db.getContent(listingId),
    ]);

    if (!listing)        throw new Error(`Listing not found: ${listingId}`);
    if (!client)         throw new Error(`Client not found: ${clientSlug}`);
    if (!listingContent) throw new Error(`No content found for listing ${listingId} — run generate-content first`);

    const targetPlatforms = platforms
        || client.enabled_platforms
        || ['facebook', 'instagram', 'twitter'];

    const imageUrl = listing.photos?.[0] || null;
    const results  = [];

    for (const platform of targetPlatforms) {
        let result;

        if (platform === 'facebook') {
            result = await dist.postToFacebook(
                clientSlug,
                listing,
                listingContent.facebook_post,
                imageUrl
            );
            if (result.ok) {
                await dist.logDistribution(clientSlug, listingId, 'facebook', result.postId, listingContent.facebook_post, imageUrl);
                // Schedule performance tracking in 24 hours
                await trackPerformanceQueue.add(
                    { listingId, clientSlug, platform: 'facebook', postId: result.postId },
                    { delay: 24 * 60 * 60 * 1000, attempts: 2 }
                );
            }
        } else if (platform === 'instagram') {
            result = await dist.postToInstagram(
                clientSlug,
                listing,
                listingContent.instagram_caption,
                imageUrl
            );
            if (result.ok) {
                await dist.logDistribution(clientSlug, listingId, 'instagram', result.mediaId, listingContent.instagram_caption, imageUrl);
                await trackPerformanceQueue.add(
                    { listingId, clientSlug, platform: 'instagram', postId: result.mediaId },
                    { delay: 24 * 60 * 60 * 1000, attempts: 2 }
                );
            }
        } else if (platform === 'twitter') {
            result = await dist.postToTwitter(
                clientSlug,
                listing,
                listingContent.twitter_post
            );
            if (result.ok) {
                const postId = result.tweetId;
                await dist.logDistribution(clientSlug, listingId, 'twitter', postId, listingContent.twitter_post, null);
                await trackPerformanceQueue.add(
                    { listingId, clientSlug, platform: 'twitter', postId },
                    { delay: 24 * 60 * 60 * 1000, attempts: 2 }
                );
            }
        }

        results.push({ platform, ok: result?.ok || false, error: result?.error || null });
        console.log(`[Distribute] ${platform}: ${result?.ok ? 'posted' : `failed — ${result?.error}`}`);
    }

    // SMS agent with distribution summary
    if (client.agent_phone) {
        const posted   = results.filter(r => r.ok).map(r => r.platform).join(', ');
        const failed   = results.filter(r => !r.ok).map(r => r.platform).join(', ');
        const addr     = `${listing.address}, ${listing.city}`;
        const summary  = failed
            ? `GRIDHAND: ${addr} posted to ${posted}. Failed: ${failed}.`
            : `GRIDHAND: ${addr} posted to ${posted}. Performance tracked in 24h.`;

        await sendSms(client.agent_phone, summary, clientSlug, 'distribution_summary', listingId);
    }

    console.log(`[Distribute] Done for listing ${listingId}`);
    return { listingId, clientSlug, results };
});

// ─── Job: Track Performance ───────────────────────────────────────────────────

trackPerformanceQueue.process(async (job) => {
    const { listingId, clientSlug, platform, postId } = job.data;
    console.log(`[TrackPerformance] Fetching ${platform} metrics for post ${postId}`);

    const result = await dist.trackPerformance(clientSlug, listingId, platform, postId);

    if (!result.ok) {
        console.error(`[TrackPerformance] Failed for ${platform} ${postId}: ${result.error}`);
        throw new Error(result.error);
    }

    // Find the distribution record to link metrics
    const distLog = await db.getDistributionLog(listingId);
    const distRecord = distLog.find(d => d.platform === platform && d.post_id === postId);

    if (distRecord) {
        await db.upsertPerformanceMetrics(listingId, distRecord.id, {
            platform,
            views:       result.data.views,
            likes:       result.data.likes,
            comments:    result.data.comments,
            shares:      result.data.shares,
            linkClicks:  result.data.linkClicks,
            rawMetrics:  result.data.rawMetrics,
        });
    }

    // Flag underperforming listings (< 50 views at 24h)
    if (result.data.views < 50) {
        const client = await db.getClient(clientSlug);
        if (client?.agent_phone) {
            const listing = await db.getListing(listingId);
            await sendSms(
                client.agent_phone,
                `GRIDHAND: ${listing?.address} is getting low engagement on ${platform} (${result.data.views} views). Consider a price drop alert or new photos.`,
                clientSlug,
                'low_engagement_alert',
                listingId
            );
        }
    }

    console.log(`[TrackPerformance] Done — ${platform} post ${postId}: ${result.data.views} views, ${result.data.likes} likes`);
    return { listingId, platform, postId, metrics: result.data };
});

// ─── Job: Price Drop Campaign ─────────────────────────────────────────────────

priceDropQueue.process(async (job) => {
    const { listingId, clientSlug, oldPrice, newPrice } = job.data;
    console.log(`[PriceDrop] Processing price drop for listing ${listingId}: ${oldPrice} → ${newPrice}`);

    const [listing, client] = await Promise.all([
        db.getListing(listingId),
        db.getClient(clientSlug),
    ]);

    if (!listing) throw new Error(`Listing not found: ${listingId}`);
    if (!client)  throw new Error(`Client not found: ${clientSlug}`);

    // Generate price-drop-specific content
    const alertContent = await content.generatePriceDropAlert(listing, oldPrice, newPrice);

    // Update listing price in DB
    await db.updateListingPrice(listingId, newPrice);

    // Update content record with new price-drop posts
    await db.upsertContent(listingId, client.id, {
        mlsDescription:   await content.generateListingDescription({ ...listing, price: newPrice }),
        facebookPost:     alertContent.facebook,
        instagramCaption: alertContent.instagram,
        twitterPost:      await content.generateTwitterPost({ ...listing, price: newPrice }),
    });

    // Re-distribute to all enabled platforms
    const platforms = client.enabled_platforms || ['facebook', 'instagram', 'twitter'];
    const imageUrl  = listing.photos?.[0] || null;
    const results   = [];

    for (const platform of platforms) {
        let result;

        if (platform === 'facebook') {
            result = await dist.postToFacebook(clientSlug, listing, alertContent.facebook, imageUrl);
            if (result.ok) await dist.logDistribution(clientSlug, listingId, 'facebook', result.postId, alertContent.facebook, imageUrl);
        } else if (platform === 'instagram') {
            result = await dist.postToInstagram(clientSlug, listing, alertContent.instagram, imageUrl);
            if (result.ok) await dist.logDistribution(clientSlug, listingId, 'instagram', result.mediaId, alertContent.instagram, imageUrl);
        } else if (platform === 'twitter') {
            result = await dist.postToTwitter(clientSlug, listing, await content.generateTwitterPost({ ...listing, price: newPrice }));
            if (result.ok) await dist.logDistribution(clientSlug, listingId, 'twitter', result.tweetId, null, null);
        }

        results.push({ platform, ok: result?.ok || false });
    }

    // SMS agent about the campaign
    if (client.agent_phone) {
        const drop    = oldPrice - newPrice;
        const dropPct = ((drop / oldPrice) * 100).toFixed(1);
        await sendSms(
            client.agent_phone,
            `GRIDHAND: Price drop campaign live for ${listing.address}. Reduced $${(drop / 1000).toFixed(0)}k (${dropPct}%). Posted to ${results.filter(r => r.ok).map(r => r.platform).join(', ')}.`,
            clientSlug,
            'price_drop_campaign',
            listingId
        );
    }

    console.log(`[PriceDrop] Done for listing ${listingId}`);
    return { listingId, clientSlug, oldPrice, newPrice, results };
});

// ─── Job: Weekly Performance Report ──────────────────────────────────────────

weeklyPerformanceQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[WeeklyPerformance] Running for ${clientSlug}`);

    const client = await db.getClient(clientSlug);
    if (!client)         throw new Error(`Client not found: ${clientSlug}`);
    if (!client.agent_phone) {
        console.warn(`[WeeklyPerformance] No agent_phone for ${clientSlug} — skipping SMS`);
        return { clientSlug, skipped: true };
    }

    // Get active listings + their performance for the week
    const metrics = await db.getPerformanceByClient(clientSlug);

    // Aggregate by listing
    const listingMap = {};
    for (const m of metrics) {
        const addr = m.ll_listings?.address || m.listing_id;
        const key  = m.listing_id;

        if (!listingMap[key]) {
            listingMap[key] = {
                address:    addr,
                city:       m.ll_listings?.city || '',
                price:      m.ll_listings?.price || 0,
                platform:   m.platform,
                views:      0,
                likes:      0,
                shares:     0,
                linkClicks: 0,
            };
        }

        listingMap[key].views      += m.views      || 0;
        listingMap[key].likes      += m.likes      || 0;
        listingMap[key].shares     += m.shares     || 0;
        listingMap[key].linkClicks += m.link_clicks || 0;
    }

    const listingsArray = Object.values(listingMap);

    if (listingsArray.length === 0) {
        await sendSms(
            client.agent_phone,
            `GRIDHAND Weekly Report: No active listing performance data this week. Add listings to get started.`,
            clientSlug,
            'weekly_performance'
        );
        return { clientSlug, listingsReported: 0 };
    }

    const reportText = await content.generateWeeklyReport(listingsArray);

    await sendSms(client.agent_phone, `GRIDHAND Weekly: ${reportText}`, clientSlug, 'weekly_performance');

    console.log(`[WeeklyPerformance] Done for ${clientSlug} — ${listingsArray.length} listings reported`);
    return { clientSlug, listingsReported: listingsArray.length };
});

// ─── Job: New Listing Alert ───────────────────────────────────────────────────

newListingAlertQueue.process(async (job) => {
    const { listingId, clientSlug } = job.data;
    console.log(`[NewListingAlert] Alerting agent for listing ${listingId} (${clientSlug})`);

    const [listing, client] = await Promise.all([
        db.getListing(listingId),
        db.getClient(clientSlug),
    ]);

    if (!listing) throw new Error(`Listing not found: ${listingId}`);
    if (!client)  throw new Error(`Client not found: ${clientSlug}`);

    if (client.agent_phone) {
        const price = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(listing.price);
        await sendSms(
            client.agent_phone,
            `GRIDHAND: New listing detected — ${listing.address}, ${listing.city} | ${listing.beds}bd/${listing.baths}ba | ${price} | MLS# ${listing.mls_number}. Content generation started.`,
            clientSlug,
            'new_listing_alert',
            listingId
        );
    }

    // Trigger content generation for the new listing
    await runGenerateContent(listingId, clientSlug);

    console.log(`[NewListingAlert] Done for listing ${listingId}`);
    return { listingId, clientSlug, alerted: !!client.agent_phone };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

const queues = [
    ['ll:generate-content',    generateContentQueue],
    ['ll:distribute-listing',  distributeQueue],
    ['ll:track-performance',   trackPerformanceQueue],
    ['ll:price-drop-campaign', priceDropQueue],
    ['ll:weekly-performance',  weeklyPerformanceQueue],
    ['ll:new-listing-alert',   newListingAlertQueue],
];

for (const [name, queue] of queues) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} job failed (id=${job.id}): ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} job completed (id=${job.id})`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runGenerateContent(listingId, clientSlug) {
    return generateContentQueue.add(
        { listingId, clientSlug },
        { attempts: 2, backoff: { type: 'exponential', delay: 30000 } }
    );
}

async function runDistribute(listingId, clientSlug, platforms = null) {
    return distributeQueue.add(
        { listingId, clientSlug, platforms },
        { attempts: 2, backoff: 60000 }
    );
}

async function runTrackPerformance(listingId, clientSlug, platform, postId, delayMs = 0) {
    return trackPerformanceQueue.add(
        { listingId, clientSlug, platform, postId },
        { delay: delayMs, attempts: 2, backoff: 60000 }
    );
}

async function runPriceDrop(listingId, clientSlug, oldPrice, newPrice) {
    return priceDropQueue.add(
        { listingId, clientSlug, oldPrice, newPrice },
        { attempts: 2, backoff: 60000 }
    );
}

async function runWeeklyPerformance(clientSlug) {
    return weeklyPerformanceQueue.add(
        { clientSlug },
        { attempts: 2, backoff: 60000 }
    );
}

async function runNewListingAlert(listingId, clientSlug) {
    return newListingAlertQueue.add(
        { listingId, clientSlug },
        { attempts: 2, backoff: 30000 }
    );
}

/**
 * Run a job function for all active clients.
 * jobFn receives clientSlug and returns a Bull job promise.
 */
async function runForAllClients(jobFn) {
    const clients = await db.getAllActiveClients();
    const results = [];

    for (const { client_slug } of clients) {
        try {
            const job = await jobFn(client_slug);
            results.push({ clientSlug: client_slug, jobId: job?.id });
        } catch (err) {
            console.error(`[Jobs] Failed to queue job for ${client_slug}: ${err.message}`);
            results.push({ clientSlug: client_slug, error: err.message });
        }
    }

    return results;
}

/**
 * Sync MLS listings for a single client.
 * Detects new listings and price changes, queues appropriate jobs.
 */
async function syncMlsListings(clientSlug) {
    console.log(`[MlsSync] Syncing listings for ${clientSlug}`);

    const client = await db.getClient(clientSlug);
    if (!client || !client.mls_token) {
        console.warn(`[MlsSync] No MLS token for ${clientSlug} — skipping`);
        return { clientSlug, skipped: true };
    }

    // Look back 2.5 hours to catch anything since last cron run (2h cadence)
    const since       = new Date(Date.now() - 2.5 * 60 * 60 * 1000);
    const mlsResult   = await mls.getRecentlyUpdated(clientSlug, since);

    if (!mlsResult.ok) {
        console.error(`[MlsSync] MLS API error for ${clientSlug}: ${mlsResult.error}`);
        return { clientSlug, error: mlsResult.error };
    }

    let newCount    = 0;
    let updatedCount = 0;

    for (const listing of mlsResult.data) {
        const existing = await db.getListingByMlsKey(client.id, listing.mlsKey);

        if (!existing) {
            // Brand new listing
            const saved = await db.upsertListing(clientSlug, { ...listing, clientId: client.id });
            await runNewListingAlert(saved.id, clientSlug);
            newCount++;
        } else {
            // Check for price change
            if (existing.price !== listing.price && listing.price < existing.price) {
                await runPriceDrop(existing.id, clientSlug, existing.price, listing.price);
                updatedCount++;
            } else {
                // General update (status change, etc.)
                await db.upsertListing(clientSlug, { ...listing, clientId: client.id });
                updatedCount++;
            }
        }
    }

    console.log(`[MlsSync] Done for ${clientSlug} — ${newCount} new, ${updatedCount} updated`);
    return { clientSlug, newCount, updatedCount };
}

module.exports = {
    runGenerateContent,
    runDistribute,
    runTrackPerformance,
    runPriceDrop,
    runWeeklyPerformance,
    runNewListingAlert,
    runForAllClients,
    syncMlsListings,
    generateContentQueue,
    distributeQueue,
    trackPerformanceQueue,
    priceDropQueue,
    weeklyPerformanceQueue,
    newListingAlertQueue,
};
