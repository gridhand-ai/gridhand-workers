/**
 * GRIDHAND Change Order Tracker — Main Express Server
 *
 * Tracks every Procore change order, calculates cost impact,
 * auto-generates client-facing summaries, and syncs approved COs to QuickBooks.
 *
 * Routes:
 *   GET  /                                    → health check
 *   GET  /auth/procore?clientSlug=&ownerPhone= → start Procore OAuth
 *   GET  /auth/procore/callback               → Procore OAuth callback
 *   GET  /change-orders/:clientSlug           → all change orders (optionally by project)
 *   GET  /summary/:clientSlug                 → project cost impact summaries
 *   GET  /alerts/:clientSlug                  → alert history
 *   POST /trigger/sync                        → manually sync change orders
 *   POST /trigger/weekly-report               → manually trigger weekly summary
 *   POST /trigger/all                         → trigger job for all clients
 *
 * Environment vars required:
 *   PROCORE_CLIENT_ID, PROCORE_CLIENT_SECRET, PROCORE_REDIRECT_URI
 *   QB_CLIENT_ID, QB_CLIENT_SECRET
 *   QB_SANDBOX=true (optional)
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   REDIS_URL
 *   GRIDHAND_API_KEY
 *   PORT (default: 3011)
 */

'use strict';

const express = require('express');
const cron    = require('node-cron');
const procore = require('./procore');
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
        worker:  'Change Order Tracker',
        status:  'online',
        version: '1.0.0',
        jobs:    ['sync-change-orders', 'weekly-co-report'],
        integrations: ['Procore API', 'QuickBooks Online v3', 'Supabase'],
    });
});

// ─── Procore OAuth Flow ───────────────────────────────────────────────────────

app.get('/auth/procore', (req, res) => {
    const { clientSlug, ownerPhone, companyId } = req.query;
    if (!clientSlug || !ownerPhone) {
        return res.status(400).json({ error: 'clientSlug and ownerPhone are required' });
    }
    const state = Buffer.from(JSON.stringify({ clientSlug, ownerPhone, companyId: companyId || '', ts: Date.now() })).toString('base64');
    res.redirect(procore.getAuthorizationUrl(state));
});

app.get('/auth/procore/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing code or state from Procore.');

    let clientSlug, ownerPhone, companyId;
    try {
        const d = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
        clientSlug = d.clientSlug; ownerPhone = d.ownerPhone; companyId = d.companyId;
    } catch { return res.status(400).send('Invalid state.'); }

    try {
        await procore.exchangeCode({ code, clientSlug, ownerPhone, companyId });
        console.log(`[OAuth] Connected Procore for ${clientSlug}`);
        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px">
                <h2>✅ Procore Connected!</h2>
                <p><strong>${clientSlug}</strong> is now connected.</p>
                <p>Change Order Tracker will monitor all COs and sync approved ones to QuickBooks.</p>
            </body></html>
        `);
    } catch (err) {
        res.status(500).send(`OAuth failed: ${err.message}`);
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

app.get('/change-orders/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { projectId } = req.query;

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No connection for ${clientSlug}` });
        const cos = await db.getChangeOrdersByProject(clientSlug, projectId || null);
        res.json({ clientSlug, total: cos.length, changeOrders: cos });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/summary/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    try {
        const summaries = await db.getProjectSummaries(clientSlug);
        const totalApproved = summaries.reduce((s, p) => s + parseFloat(p.approved_cos_total || 0), 0);
        const totalPending  = summaries.reduce((s, p) => s + parseFloat(p.pending_cos_total || 0), 0);
        res.json({ clientSlug, totalApproved, totalPending, projects: summaries });
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

app.post('/trigger/sync', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });
    try {
        const job = await jobs.runSyncChangeOrders(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/weekly-report', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });
    try {
        const job = await jobs.runWeeklyReport(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/all', requireApiKey, async (req, res) => {
    const { job } = req.body;
    const jobMap = {
        'sync':          jobs.runSyncChangeOrders,
        'weekly-report': jobs.runWeeklyReport,
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

// Sync change orders — every hour
cron.schedule('0 * * * *', async () => {
    console.log('[Cron] Syncing change orders for all clients...');
    await jobs.runForAllClients(jobs.runSyncChangeOrders);
}, { timezone: 'America/Chicago' });

// Weekly CO report — Monday 8:00am
cron.schedule('0 8 * * 1', async () => {
    console.log('[Cron] Running weekly CO reports for all clients...');
    await jobs.runForAllClients(jobs.runWeeklyReport);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3011;
app.listen(PORT, () => {
    console.log(`[ChangeOrderTracker] Online — port ${PORT}`);
    console.log(`[ChangeOrderTracker] Crons: CO sync every hour | weekly report Mon 8am`);
});
