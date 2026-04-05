/**
 * GRIDHAND Listing Launcher — Main Express Server
 *
 * Standalone microservice for real estate listing content creation and distribution.
 * Runs on PORT 3006.
 *
 * Routes:
 *   GET  /                                        → health check
 *   POST /webhooks/mls                            → MLS listing webhook (new/price/status)
 *   POST /trigger/generate-content               → generate description + social posts
 *   POST /trigger/distribute                     → post to social platforms
 *   POST /trigger/performance-report             → weekly listing performance report
 *   POST /trigger/price-drop-alert               → price drop campaign
 *   GET  /listings/:clientSlug                   → list client listings (status, limit, offset)
 *   GET  /listings/:clientSlug/:listingId        → listing detail + content + distribution log
 *   GET  /performance/:clientSlug                → performance metrics summary
 *
 * Environment vars required:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   ANTHROPIC_API_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   REDIS_URL
 *   GRIDHAND_API_KEY
 *   CANVA_API_TOKEN, CANVA_LISTING_TEMPLATE_ID   (optional — Canva graphics)
 *   PORT                                          (default: 3006)
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cron    = require('node-cron');
const jobs    = require('./jobs');
const db      = require('./db');

const app = express();
app.use(express.json());

// ─── Auth Middleware ───────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
    const serverKey = process.env.GRIDHAND_API_KEY;
    if (!serverKey) return res.status(503).json({ error: 'GRIDHAND_API_KEY not configured' });
    const provided = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (provided !== serverKey) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.json({
        worker:  'Listing Launcher',
        version: '1.0.0',
        status:  'online',
        jobs: [
            'generate-content',
            'distribute-listing',
            'track-performance',
            'price-drop-campaign',
            'weekly-performance',
            'new-listing-alert',
        ],
        integrations: ['MLS', 'Canva', 'Facebook', 'Instagram', 'Twitter', 'Twilio'],
    });
});

// ─── MLS Webhook ──────────────────────────────────────────────────────────────

/**
 * Receives MLS push webhooks for new listings, price changes, and status changes.
 * Sends fast ACK, processes async.
 */
app.post('/webhooks/mls', async (req, res) => {
    // Fast ACK — MLS APIs expect < 2s response
    res.status(200).json({ received: true });

    setImmediate(async () => {
        try {
            const payload = req.body;

            // Normalize webhook payload — different MLS providers use different formats
            // MLS Grid pushes: { EventType, ResourceName, ResourceRecordKey, OriginatingSystemName, ... }
            const eventType   = payload.EventType    || payload.event_type    || payload.type || 'Unknown';
            const listingKey  = payload.ResourceRecordKey || payload.listing_key || payload.ListingKey;
            const clientSlug  = payload.client_slug  || payload.clientSlug;

            if (!listingKey || !clientSlug) {
                console.warn('[Webhook/MLS] Missing listingKey or clientSlug in payload:', JSON.stringify(payload).substring(0, 200));
                return;
            }

            console.log(`[Webhook/MLS] Event: ${eventType} | Key: ${listingKey} | Client: ${clientSlug}`);

            const mls        = require('./mls');
            const mlsResult  = await mls.getListing(clientSlug, listingKey);

            if (!mlsResult.ok) {
                console.error(`[Webhook/MLS] Failed to fetch listing ${listingKey}: ${mlsResult.error}`);
                return;
            }

            const listing    = mlsResult.data;
            const client     = await db.getClient(clientSlug);
            if (!client) {
                console.error(`[Webhook/MLS] Client not found: ${clientSlug}`);
                return;
            }

            const existing = await db.getListingByMlsKey(client.id, listingKey);

            if (!existing) {
                // New listing
                const saved = await db.upsertListing(clientSlug, { ...listing, clientId: client.id });
                await jobs.runNewListingAlert(saved.id, clientSlug);
            } else {
                // Check for price change
                if (listing.price < existing.price) {
                    await db.upsertListing(clientSlug, { ...listing, clientId: client.id });
                    await jobs.runPriceDrop(existing.id, clientSlug, existing.price, listing.price);
                } else if (listing.status !== existing.status) {
                    // Status change (Active → Pending, etc.) — update DB, no campaign needed
                    await db.upsertListing(clientSlug, { ...listing, clientId: client.id });
                    console.log(`[Webhook/MLS] Status change for ${listing.address}: ${existing.status} → ${listing.status}`);
                } else {
                    // General update
                    await db.upsertListing(clientSlug, { ...listing, clientId: client.id });
                }
            }
        } catch (err) {
            console.error(`[Webhook/MLS] Processing error: ${err.message}`);
        }
    });
});

// ─── Manual Trigger Endpoints ─────────────────────────────────────────────────

// Generate content (description + all social posts) for a listing
app.post('/trigger/generate-content', requireApiKey, async (req, res) => {
    const { listing_id, client_id } = req.body;

    if (!listing_id) return res.status(400).json({ error: 'listing_id required' });

    // Resolve clientSlug from either client_id or directly if it's a slug
    let clientSlug = req.body.client_slug || req.body.clientSlug;
    if (!clientSlug && client_id) {
        // Look up slug by listing to avoid extra client lookup
        const listing = await db.getListing(listing_id);
        if (!listing) return res.status(404).json({ error: `Listing not found: ${listing_id}` });
    }

    if (!clientSlug) return res.status(400).json({ error: 'client_slug required' });

    try {
        const job = await jobs.runGenerateContent(listing_id, clientSlug);
        res.json({ ok: true, jobId: job.id, listingId: listing_id, clientSlug });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Distribute listing to social platforms
app.post('/trigger/distribute', requireApiKey, async (req, res) => {
    const { listing_id, client_slug, platforms } = req.body;

    if (!listing_id)  return res.status(400).json({ error: 'listing_id required' });
    if (!client_slug) return res.status(400).json({ error: 'client_slug required' });

    try {
        const job = await jobs.runDistribute(listing_id, client_slug, platforms || null);
        res.json({ ok: true, jobId: job.id, listingId: listing_id, clientSlug: client_slug, platforms });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Trigger weekly performance report for a client
app.post('/trigger/performance-report', requireApiKey, async (req, res) => {
    const { client_id, client_slug } = req.body;
    const slug = client_slug || client_id;

    if (!slug) return res.status(400).json({ error: 'client_slug required' });

    try {
        const job = await jobs.runWeeklyPerformance(slug);
        res.json({ ok: true, jobId: job.id, clientSlug: slug });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Trigger price drop campaign for a listing
app.post('/trigger/price-drop-alert', requireApiKey, async (req, res) => {
    const { listing_id, client_slug, old_price, new_price } = req.body;

    if (!listing_id)  return res.status(400).json({ error: 'listing_id required' });
    if (!client_slug) return res.status(400).json({ error: 'client_slug required' });

    try {
        // If prices not provided, fetch current from DB and use a 5% drop as simulation
        let oldPrice = old_price;
        let newPrice = new_price;

        if (!oldPrice || !newPrice) {
            const listing = await db.getListing(listing_id);
            if (!listing) return res.status(404).json({ error: `Listing not found: ${listing_id}` });
            oldPrice = listing.price;
            newPrice = new_price || Math.floor(listing.price * 0.95);
        }

        const job = await jobs.runPriceDrop(listing_id, client_slug, oldPrice, newPrice);
        res.json({ ok: true, jobId: job.id, listingId: listing_id, clientSlug: client_slug, oldPrice, newPrice });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

// List all listings for a client (with optional status filter + pagination)
app.get('/listings/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { status, limit = 20, offset = 0 } = req.query;

    try {
        const listings = await db.getListingsByClient(clientSlug, {
            status:  status || null,
            limit:   parseInt(limit),
            offset:  parseInt(offset),
        });

        res.json({
            ok:        true,
            clientSlug,
            total:     listings.length,
            listings,
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Listing detail: listing data + generated content + distribution log
app.get('/listings/:clientSlug/:listingId', requireApiKey, async (req, res) => {
    const { listingId } = req.params;

    try {
        const [listing, content, distLog] = await Promise.all([
            db.getListing(listingId),
            db.getContent(listingId),
            db.getDistributionLog(listingId),
        ]);

        if (!listing) return res.status(404).json({ ok: false, error: `Listing not found: ${listingId}` });

        const performance = await db.getPerformanceByListing(listingId);

        res.json({
            ok: true,
            listing,
            content:          content || null,
            distributionLog:  distLog,
            performance,
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Performance metrics summary for a client
app.get('/performance/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;

    try {
        const metrics = await db.getPerformanceByClient(clientSlug);

        // Aggregate totals
        const totals = metrics.reduce((acc, m) => {
            acc.views      += m.views       || 0;
            acc.likes      += m.likes       || 0;
            acc.comments   += m.comments    || 0;
            acc.shares     += m.shares      || 0;
            acc.linkClicks += m.link_clicks || 0;
            return acc;
        }, { views: 0, likes: 0, comments: 0, shares: 0, linkClicks: 0 });

        // Group by platform
        const byPlatform = {};
        for (const m of metrics) {
            if (!byPlatform[m.platform]) {
                byPlatform[m.platform] = { views: 0, likes: 0, comments: 0, shares: 0, linkClicks: 0 };
            }
            byPlatform[m.platform].views      += m.views       || 0;
            byPlatform[m.platform].likes      += m.likes       || 0;
            byPlatform[m.platform].comments   += m.comments    || 0;
            byPlatform[m.platform].shares     += m.shares      || 0;
            byPlatform[m.platform].linkClicks += m.link_clicks || 0;
        }

        res.json({
            ok: true,
            clientSlug,
            totals,
            byPlatform,
            records: metrics.length,
            metrics,
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Cron Schedules ────────────────────────────────────────────────────────────

// MLS sync — every 2 hours during business hours (7am–9pm)
cron.schedule('0 7-21/2 * * *', async () => {
    console.log('[Cron] Running MLS sync for all clients...');
    await jobs.runForAllClients(jobs.syncMlsListings);
}, { timezone: 'America/Chicago' });

// Weekly performance report — Mondays at 8:00am Chicago
cron.schedule('0 8 * * 1', async () => {
    console.log('[Cron] Running weekly performance reports for all clients...');
    await jobs.runForAllClients(jobs.runWeeklyPerformance);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3006;
app.listen(PORT, () => {
    console.log(`[ListingLauncher] Online — port ${PORT}`);
    console.log(`[ListingLauncher] Crons: MLS sync every 2h (7am–9pm) | weekly report Mon 8am Chicago`);
});
