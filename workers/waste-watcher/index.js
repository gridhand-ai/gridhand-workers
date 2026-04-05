/**
 * GRIDHAND Waste Watcher — Main Express Server
 *
 * Connects to MarketMan/BlueCart (inventory) + Toast/Square (POS).
 * Tracks food inventory levels, predicts waste, alerts on expiring items,
 * suggests prep quantities, and generates waste cost reports.
 *
 * Routes:
 *   POST /webhook/marketman              → inventory update webhook
 *   POST /webhook/toast                  → Toast sales event webhook
 *   POST /webhook/square                 → Square sales event webhook
 *   POST /trigger/scan-inventory         → manually trigger inventory scan + briefing
 *   POST /trigger/daily-report           → manually trigger morning report
 *   POST /trigger/expiry-check           → manually trigger expiry check
 *   POST /trigger/weekly-waste-report    → manually trigger weekly waste report
 *   POST /trigger/sales-sync             → manually trigger POS sales sync
 *   GET  /clients/:clientSlug/inventory  → current inventory state from DB
 *   GET  /clients/:clientSlug/waste-report → waste predictions + cost report
 *   GET  /health                         → service health check
 *
 * Environment vars required:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   REDIS_URL          (Bull queue backend)
 *   GRIDHAND_API_KEY   (protects admin endpoints)
 *   PORT               (default: 3007)
 */

'use strict';

require('dotenv').config();

const express   = require('express');
const cron      = require('node-cron');
const dayjs     = require('dayjs');
const inventory = require('./inventory');
const pos       = require('./pos');
const pred      = require('./predictions');
const jobs      = require('./jobs');
const { createClient } = require('@supabase/supabase-js');

const app      = express();
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

app.use(express.json());

// ─── Auth Middleware ───────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
    const serverKey = process.env.GRIDHAND_API_KEY;
    if (!serverKey) return res.status(503).json({ error: 'GRIDHAND_API_KEY not configured' });
    const provided = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (provided !== serverKey) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ─── Health Check ──────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({
        worker:       'Waste Watcher',
        status:       'online',
        version:      '1.0.0',
        port:         process.env.PORT || 3007,
        timestamp:    new Date().toISOString(),
        integrations: ['MarketMan API v3', 'BlueCart API v1', 'Toast POS', 'Square POS', 'Twilio SMS', 'Supabase'],
        jobs: [
            'scan-inventory (6am daily)',
            'expiry-check (2pm daily)',
            'sales-sync (every 4h)',
            'weekly-waste-report (Sunday 7am)',
        ],
        crons: {
            morningBriefing:   '0 6 * * * America/Chicago',
            middayExpiryCheck: '0 14 * * * America/Chicago',
            salesSync:         '0 */4 * * * America/Chicago',
            weeklyReport:      '0 7 * * 0 America/Chicago',
        },
    });
});

// ─── Webhook: MarketMan ────────────────────────────────────────────────────────
// MarketMan can push inventory updates via webhook when counts change.

app.post('/webhook/marketman', requireApiKey, async (req, res) => {
    const payload = req.body;

    // MarketMan webhooks include a client identifier — map to clientSlug via DB
    const marketmanGuid = payload?.restaurant_guid || payload?.guid || null;

    res.status(200).json({ received: true });

    if (!marketmanGuid) {
        console.warn('[Webhook/MarketMan] No guid in payload — cannot route to client');
        return;
    }

    setImmediate(async () => {
        try {
            // Look up which client this guid belongs to
            const { data, error } = await supabase
                .from('watcher_connections')
                .select('client_slug')
                .eq('marketman_guid', marketmanGuid)
                .eq('active_inventory_system', 'marketman')
                .single();

            if (error || !data) {
                console.warn(`[Webhook/MarketMan] No client found for guid ${marketmanGuid}`);
                return;
            }

            const clientSlug = data.client_slug;
            console.log(`[Webhook/MarketMan] Inventory update received for ${clientSlug}`);

            // Queue an inventory scan to re-sync and re-evaluate
            await jobs.runScanInventory(clientSlug);
        } catch (err) {
            console.error(`[Webhook/MarketMan] Processing error: ${err.message}`);
        }
    });
});

// ─── Webhook: Toast ────────────────────────────────────────────────────────────
// Toast sends real-time order events when orders are placed/closed.

app.post('/webhook/toast', requireApiKey, async (req, res) => {
    const payload = req.body;

    res.status(200).json({ received: true });

    setImmediate(async () => {
        try {
            const restaurantGuid = payload?.restaurantGuid || null;
            if (!restaurantGuid) {
                console.warn('[Webhook/Toast] No restaurantGuid in payload');
                return;
            }

            const { data, error } = await supabase
                .from('watcher_connections')
                .select('client_slug')
                .eq('toast_restaurant_guid', restaurantGuid)
                .eq('active_pos_system', 'toast')
                .single();

            if (error || !data) {
                console.warn(`[Webhook/Toast] No client found for restaurant ${restaurantGuid}`);
                return;
            }

            const clientSlug = data.client_slug;
            const eventType  = payload?.eventType || 'unknown';
            console.log(`[Webhook/Toast] Event '${eventType}' for ${clientSlug}`);

            // On order completion events, sync today's sales
            if (['ORDER_COMPLETED', 'CHECK_CLOSED'].includes(eventType)) {
                await jobs.runSalesSync(clientSlug);
            }
        } catch (err) {
            console.error(`[Webhook/Toast] Processing error: ${err.message}`);
        }
    });
});

// ─── Webhook: Square ──────────────────────────────────────────────────────────
// Square sends order events via webhook when orders are created/updated.

app.post('/webhook/square', requireApiKey, async (req, res) => {
    const payload = req.body;

    res.status(200).json({ received: true });

    setImmediate(async () => {
        try {
            const locationId = payload?.data?.object?.order?.location_id
                || payload?.merchant_id
                || null;

            if (!locationId) {
                console.warn('[Webhook/Square] No location_id in payload');
                return;
            }

            const { data, error } = await supabase
                .from('watcher_connections')
                .select('client_slug')
                .eq('square_location_id', locationId)
                .eq('active_pos_system', 'square')
                .single();

            if (error || !data) {
                console.warn(`[Webhook/Square] No client found for location ${locationId}`);
                return;
            }

            const clientSlug = data.client_slug;
            const eventType  = payload?.type || 'unknown';
            console.log(`[Webhook/Square] Event '${eventType}' for ${clientSlug}`);

            if (['order.created', 'order.updated', 'payment.completed'].includes(eventType)) {
                await jobs.runSalesSync(clientSlug);
            }
        } catch (err) {
            console.error(`[Webhook/Square] Processing error: ${err.message}`);
        }
    });
});

// ─── Manual Trigger: Scan Inventory ───────────────────────────────────────────

app.post('/trigger/scan-inventory', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runScanInventory(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug, queued: 'scan-inventory' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Manual Trigger: Daily Report ─────────────────────────────────────────────

app.post('/trigger/daily-report', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runScanInventory(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug, queued: 'daily-report (scan-inventory)' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Manual Trigger: Expiry Check ─────────────────────────────────────────────

app.post('/trigger/expiry-check', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runExpiryCheck(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug, queued: 'expiry-check' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Manual Trigger: Weekly Waste Report ──────────────────────────────────────

app.post('/trigger/weekly-waste-report', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runWeeklyWasteReport(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug, queued: 'weekly-waste-report' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Manual Trigger: Sales Sync ───────────────────────────────────────────────

app.post('/trigger/sales-sync', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runSalesSync(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug, queued: 'sales-sync' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Data: Current Inventory ───────────────────────────────────────────────────

app.get('/clients/:clientSlug/inventory', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;

    try {
        const [items, snapshots] = await Promise.all([
            inventory.getStoredInventory(clientSlug),
            inventory.getRecentSnapshots(clientSlug, 7),
        ]);

        const lowStock = inventory.detectLowStock(
            items.map(item => ({
                ...item,
                externalItemId: item.external_item_id,
                itemName:       item.item_name,
                currentQty:     parseFloat(item.current_qty),
                parLevel:       item.par_level ? parseFloat(item.par_level) : null,
                unitCost:       parseFloat(item.unit_cost),
                expiryDate:     item.expiry_date,
            }))
        );

        const expiringItems = inventory.detectExpiringItems(
            items.map(item => ({
                ...item,
                itemName:   item.item_name,
                currentQty: parseFloat(item.current_qty),
                expiryDate: item.expiry_date,
            }))
        );

        res.json({
            clientSlug,
            totalItems:      items.length,
            lowStockCount:   lowStock.length,
            expiringCount:   expiringItems.length,
            items,
            lowStockItems:   lowStock,
            expiringItems,
            recentSnapshots: snapshots,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Data: Waste Report ────────────────────────────────────────────────────────

app.get('/clients/:clientSlug/waste-report', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { period = 'week' } = req.query;

    const validPeriods = ['today', 'week', 'month'];
    if (!validPeriods.includes(period)) {
        return res.status(400).json({ error: `period must be one of: ${validPeriods.join(', ')}` });
    }

    try {
        const report = await pred.generateWasteReport(clientSlug, period);
        res.json(report);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Cron Schedules ────────────────────────────────────────────────────────────

// 6am daily — sync inventory, predict waste, send prep briefing
cron.schedule('0 6 * * *', async () => {
    console.log('[Cron] 6am — Running scan-inventory for all clients...');
    await jobs.runForAllClients(jobs.runScanInventory);
}, { timezone: 'America/Chicago' });

// 2pm daily — midday expiry check, alert on anything expiring today
cron.schedule('0 14 * * *', async () => {
    console.log('[Cron] 2pm — Running expiry-check for all clients...');
    await jobs.runForAllClients(jobs.runExpiryCheck);
}, { timezone: 'America/Chicago' });

// Every 4 hours — pull new sales data, update usage rates
cron.schedule('0 */4 * * *', async () => {
    console.log('[Cron] Every 4h — Running sales-sync for all clients...');
    await jobs.runForAllClients(jobs.runSalesSync);
}, { timezone: 'America/Chicago' });

// Sunday 7am — weekly waste cost report
cron.schedule('0 7 * * 0', async () => {
    console.log('[Cron] Sunday 7am — Running weekly-waste-report for all clients...');
    await jobs.runForAllClients(jobs.runWeeklyWasteReport);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3007;

app.listen(PORT, () => {
    console.log(`[WasteWatcher] Online — port ${PORT}`);
    console.log('[WasteWatcher] Integrations: MarketMan v3 | BlueCart v1 | Toast POS | Square POS | Twilio | Supabase');
    console.log('[WasteWatcher] Crons: scan-inventory @ 6am | expiry-check @ 2pm | sales-sync every 4h | weekly-report Sunday 7am');
});
