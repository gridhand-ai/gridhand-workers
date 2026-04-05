/**
 * GRIDHAND Maintenance Dispatcher — Main Express Server
 *
 * Auto-triages tenant maintenance requests from AppFolio,
 * dispatches best-fit vendors via SMS, tracks completion, sends owner reports.
 *
 * Routes:
 *   GET  /                                    → health check
 *   POST /connect                             → save AppFolio credentials
 *   POST /requests/inbound                    → receive new maintenance request (webhook or manual entry)
 *   POST /requests/:id/complete               → mark request completed
 *   GET  /requests/:clientSlug                → open requests list
 *   GET  /vendors/:clientSlug                 → vendor directory
 *   POST /vendors/:clientSlug                 → add/update a vendor
 *   GET  /alerts/:clientSlug                  → SMS history
 *   POST /trigger/poll                        → manually poll AppFolio
 *   POST /trigger/sla-check                   → manually run SLA check
 *   POST /trigger/daily-summary               → manually send daily summary
 *   POST /trigger/all                         → trigger job for all clients
 *
 * Environment vars required:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   REDIS_URL
 *   GRIDHAND_API_KEY
 *   PORT (default: 3013)
 */

'use strict';

const express  = require('express');
const cron     = require('node-cron');
const appfolio = require('./appfolio');
const jobs     = require('./jobs');
const db       = require('./db');

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
        worker:  'Maintenance Dispatcher',
        status:  'online',
        version: '1.0.0',
        jobs:    ['poll-new-requests', 'dispatch-vendor', 'check-sla', 'daily-summary'],
        integrations: ['AppFolio API', 'Twilio SMS', 'Vendor Database'],
    });
});

// ─── Connection Setup ─────────────────────────────────────────────────────────

app.post('/connect', requireApiKey, async (req, res) => {
    const { clientSlug, ownerPhone, businessName, appfolioClientId, appfolioDatabaseName, appfolioUsername, appfolioPassword } = req.body;
    if (!clientSlug || !ownerPhone) return res.status(400).json({ error: 'clientSlug and ownerPhone required' });

    try {
        await db.upsertConnection({
            client_slug:              clientSlug,
            owner_phone:              ownerPhone,
            business_name:            businessName || null,
            appfolio_client_id:       appfolioClientId || null,
            appfolio_database_name:   appfolioDatabaseName || null,
            appfolio_api_username:    appfolioUsername || null,
            appfolio_api_password:    appfolioPassword || null,
        });
        res.json({ success: true, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Request Endpoints ────────────────────────────────────────────────────────

// Inbound maintenance request (from webhook, portal form, or SMS parsing)
app.post('/requests/inbound', requireApiKey, async (req, res) => {
    const { clientSlug, propertyAddress, unitNumber, tenantName, tenantPhone, category, priority, description } = req.body;
    if (!clientSlug || !description) return res.status(400).json({ error: 'clientSlug and description required' });

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No connection for ${clientSlug}` });

        const request = await db.createRequest(clientSlug, {
            propertyAddress, unitNumber, tenantName, tenantPhone,
            category: category ? appfolio.mapCategory(category) : 'general',
            priority: priority ? appfolio.mapPriority(priority) : 'routine',
            description,
        });

        // Queue dispatch
        await jobs.dispatchQueue.add({ clientSlug, requestId: request.id }, { attempts: 2, backoff: 30000 });

        res.json({ success: true, requestId: request.id, priority: request.priority });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/requests/:id/complete', requireApiKey, async (req, res) => {
    const { id } = req.params;
    const { completionNotes, clientSlug } = req.body;

    try {
        const request = await db.getRequest(id);
        if (!request) return res.status(404).json({ error: 'Request not found' });

        await db.updateRequest(id, {
            status:           'completed',
            completed_at:     new Date().toISOString(),
            completion_notes: completionNotes || null,
        });

        // Notify tenant
        const conn = await db.getConnection(request.client_slug);
        if (conn && request.tenant_phone) {
            const { sms } = require('./sms');
            // inline import to avoid circular — use direct Twilio call
        }

        res.json({ success: true, requestId: id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/requests/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    try {
        const requests = await db.getOpenRequests(clientSlug);
        res.json({ clientSlug, total: requests.length, requests });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Vendor Endpoints ─────────────────────────────────────────────────────────

app.get('/vendors/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    try {
        const vendors = await db.getVendors(clientSlug);
        res.json({ clientSlug, total: vendors.length, vendors });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/vendors/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { name, phone, trade, email, rating, notes } = req.body;
    if (!name || !phone || !trade) return res.status(400).json({ error: 'name, phone, and trade required' });
    try {
        const vendor = await db.upsertVendor(clientSlug, { name, phone, trade, email, rating, notes });
        res.json({ success: true, vendor });
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

app.post('/trigger/poll', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });
    try {
        const job = await jobs.runPollRequests(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/sla-check', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });
    try {
        const job = await jobs.runSLACheck(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/daily-summary', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });
    try {
        const job = await jobs.runDailySummary(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/all', requireApiKey, async (req, res) => {
    const { job } = req.body;
    const jobMap = {
        'poll':          jobs.runPollRequests,
        'sla-check':     jobs.runSLACheck,
        'daily-summary': jobs.runDailySummary,
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

// Poll AppFolio for new requests — every 15 minutes
cron.schedule('*/15 * * * *', async () => {
    await jobs.runForAllClients(jobs.runPollRequests);
}, { timezone: 'America/Chicago' });

// SLA check — every hour
cron.schedule('0 * * * *', async () => {
    await jobs.runForAllClients(jobs.runSLACheck);
}, { timezone: 'America/Chicago' });

// Daily summary — 8:00am every day
cron.schedule('0 8 * * *', async () => {
    console.log('[Cron] Sending daily maintenance summaries...');
    await jobs.runForAllClients(jobs.runDailySummary);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3013;
app.listen(PORT, () => {
    console.log(`[MaintenanceDispatcher] Online — port ${PORT}`);
    console.log(`[MaintenanceDispatcher] Crons: poll every 15m | SLA check every 1h | summary @ 8am`);
});
