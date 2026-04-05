/**
 * GRIDHAND Parts Prophet — Main Express Server
 *
 * Standalone microservice for auto/trades shops.
 * Scans tomorrow's Tekmetric schedule, identifies required parts,
 * compares prices across WorldPac and AutoZone, then auto-orders
 * or sends an SMS recommendation to the shop owner.
 *
 * Routes:
 *   GET  /                                  → health check
 *   GET  /parts/:clientSlug                 → parts needed for a given date
 *   GET  /orders/:clientSlug                → recent parts orders
 *   GET  /alerts/:clientSlug                → recent alert log
 *   POST /connect                           → register shop credentials
 *   POST /trigger/schedule-scan             → manually scan schedule for parts
 *   POST /trigger/price-compare             → manually run price comparison
 *   POST /trigger/pre-order                 → manually trigger pre-order / recommendation
 *   POST /trigger/all                       → trigger any job for all clients
 *
 * Environment vars required:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   REDIS_URL                  (Bull queue backend)
 *   GRIDHAND_API_KEY           (protects admin endpoints)
 *   PORT                       (default: 3012)
 */

'use strict';

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
    const provided = (req.headers['authorization'] || '').replace('Bearer ', '');
    if (provided !== serverKey) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.json({
        worker:  'Parts Prophet',
        status:  'online',
        version: '1.0.0',
        jobs: ['schedule-scan', 'price-compare', 'pre-order'],
        integrations: ['Tekmetric API', 'WorldPac SpeedDial API', 'AutoZone Pro API', 'Twilio SMS', 'Supabase'],
    });
});

// ─── Connect a Shop ───────────────────────────────────────────────────────────

app.post('/connect', requireApiKey, async (req, res) => {
    const { clientSlug, tekmetricShopId, tekmetricApiKey, worldpacAccountId, worldpacApiKey,
            autozoneAccountId, autozoneApiKey, ownerPhone, shopName, preferredSupplier,
            autoOrderEnabled, orderCutoffHour } = req.body;

    if (!clientSlug || !tekmetricShopId || !tekmetricApiKey) {
        return res.status(400).json({ error: 'clientSlug, tekmetricShopId, and tekmetricApiKey are required' });
    }

    try {
        await db.upsertConnection({
            client_slug:         clientSlug,
            tekmetric_shop_id:   tekmetricShopId,
            tekmetric_api_key:   tekmetricApiKey,
            worldpac_account_id: worldpacAccountId || null,
            worldpac_api_key:    worldpacApiKey || null,
            autozone_account_id: autozoneAccountId || null,
            autozone_api_key:    autozoneApiKey || null,
            owner_phone:         ownerPhone || null,
            shop_name:           shopName || clientSlug,
            preferred_supplier:  preferredSupplier || 'worldpac',
            auto_order_enabled:  autoOrderEnabled || false,
            order_cutoff_hour:   orderCutoffHour || 16,
        });

        res.json({ success: true, clientSlug, message: `${shopName || clientSlug} connected. Parts Prophet will scan tomorrow's schedule daily at 2pm.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

app.get('/parts/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { date } = req.query;

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No connection for ${clientSlug}` });

        const targetDate = date || require('dayjs')().add(1, 'day').format('YYYY-MM-DD');
        const parts = await db.getPendingParts(clientSlug, targetDate);

        res.json({ clientSlug, targetDate, total: parts.length, parts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/orders/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { limit = 30 } = req.query;

    try {
        const orders = await db.getRecentOrders(clientSlug, parseInt(limit));
        res.json({ clientSlug, total: orders.length, orders });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/alerts/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { type, limit = 50 } = req.query;

    try {
        const alerts = await db.getAlertHistory(clientSlug, type || null, parseInt(limit));
        res.json({ clientSlug, total: alerts.length, alerts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Manual Trigger Endpoints ─────────────────────────────────────────────────

app.post('/trigger/schedule-scan', requireApiKey, async (req, res) => {
    const { clientSlug, targetDate } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runScheduleScan(clientSlug, targetDate || null);
        res.json({ success: true, jobId: job.id, clientSlug, targetDate });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/price-compare', requireApiKey, async (req, res) => {
    const { clientSlug, targetDate } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runPriceCompare(clientSlug, targetDate || null);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/pre-order', requireApiKey, async (req, res) => {
    const { clientSlug, targetDate } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runPreOrder(clientSlug, targetDate || null);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/all', requireApiKey, async (req, res) => {
    const { job } = req.body;

    const jobMap = {
        'schedule-scan': jobs.runScheduleScan,
        'price-compare': jobs.runPriceCompare,
        'pre-order':     jobs.runPreOrder,
    };

    if (!jobMap[job]) return res.status(400).json({ error: `Unknown job: ${job}` });

    try {
        const results = await jobs.runForAllClients(jobMap[job]);
        res.json({ success: true, queued: results.length, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Cron Schedules ────────────────────────────────────────────────────────────

// Schedule scan — 2:00pm daily (pull tomorrow's jobs)
cron.schedule('0 14 * * *', async () => {
    console.log('[Cron] Running schedule scan for all clients...');
    await jobs.runForAllClients(jobs.runScheduleScan);
}, { timezone: 'America/Chicago' });

// Price compare — 2:30pm daily (quote all pending parts)
cron.schedule('30 14 * * *', async () => {
    console.log('[Cron] Running price compare for all clients...');
    await jobs.runForAllClients(jobs.runPriceCompare);
}, { timezone: 'America/Chicago' });

// Pre-order — 3:00pm daily (order or send recommendation)
cron.schedule('0 15 * * *', async () => {
    console.log('[Cron] Running pre-order for all clients...');
    await jobs.runForAllClients(jobs.runPreOrder);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3012;
app.listen(PORT, () => {
    console.log(`[PartsProphet] Online — port ${PORT}`);
    console.log(`[PartsProphet] Crons: schedule-scan @ 2pm | price-compare @ 2:30pm | pre-order @ 3pm`);
});
