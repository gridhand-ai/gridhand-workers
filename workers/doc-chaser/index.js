/**
 * GRIDHAND AI — Doc Chaser
 * Main Express Server
 *
 * Accounting industry worker that auto-requests missing documents from clients,
 * sends escalating SMS/email reminders, and tracks what's still outstanding.
 *
 * Integrations: TaxDome REST API, Twilio SMS, Nodemailer
 *
 * Routes:
 *   GET  /health                                   → worker status + queue stats
 *
 *   POST /webhooks/taxdome                         → TaxDome webhook (doc received, job status)
 *
 *   GET  /api/clients                              → list all configured firms
 *   POST /api/clients                              → create or update firm config
 *   GET  /api/clients/:slug/requests               → list doc requests (?status=&overdue=true)
 *   GET  /api/clients/:slug/requests/:id           → single request + reminder history
 *   PATCH /api/clients/:slug/requests/:id          → update request status manually
 *   GET  /api/clients/:slug/reports                → weekly report history
 *
 *   POST /trigger/sync-requests/:slug              → pull latest requests from TaxDome
 *   POST /trigger/send-reminders/:slug             → send reminders for pending/overdue requests
 *   POST /trigger/weekly-report/:slug              → generate + send weekly outstanding report
 *   POST /trigger/sync-all                         → sync all clients (TaxDome pull)
 *
 * Environment variables:
 *   SUPABASE_URL              Supabase project URL
 *   SUPABASE_SERVICE_KEY      Supabase service role key
 *   GRIDHAND_API_KEY          Protects all /api and /trigger endpoints (x-api-key header or ?api_key)
 *   REDIS_HOST                Redis hostname (default: 127.0.0.1)
 *   REDIS_PORT                Redis port (default: 6379)
 *   REDIS_PASSWORD            Redis password (optional)
 *   REDIS_TLS                 Set to 'true' to enable TLS for Redis (e.g. Upstash)
 *   TWILIO_ACCOUNT_SID        Fallback Twilio SID if not stored per-client
 *   TWILIO_AUTH_TOKEN         Fallback Twilio token
 *   TWILIO_FROM_NUMBER        Fallback Twilio from number
 *   EMAIL_HOST                Fallback SMTP host
 *   EMAIL_PORT                Fallback SMTP port (default: 587)
 *   EMAIL_USER                Fallback SMTP user
 *   EMAIL_PASS                Fallback SMTP password
 *   EMAIL_FROM                Fallback from address
 *   PORT                      HTTP port (default: 3007)
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const db   = require('./db');
const jobs = require('./jobs');

const app  = express();
const PORT = process.env.PORT || 3007;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
    const serverKey = process.env.GRIDHAND_API_KEY;
    if (!serverKey) return res.status(503).json({ error: 'GRIDHAND_API_KEY not configured' });

    const provided = req.headers['x-api-key'] || req.query.api_key;
    if (!provided || provided !== serverKey) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
}

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
    let queueStats = {};
    let dbOk = false;

    try {
        queueStats = await jobs.getQueueStats();
    } catch (err) {
        queueStats = { error: err.message };
    }

    try {
        const { createClient } = require('@supabase/supabase-js');
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        const { error } = await sb.from('dc_clients').select('id').limit(1);
        dbOk = !error;
    } catch (_) {}

    res.json({
        status:       'ok',
        worker:       'doc-chaser',
        version:      '1.0.0',
        port:         PORT,
        timestamp:    new Date().toISOString(),
        database:     dbOk ? 'connected' : 'error',
        integrations: ['TaxDome REST API', 'Twilio SMS', 'Nodemailer'],
        queues:       queueStats,
    });
});

// ─── Webhook: TaxDome ────────────────────────────────────────────────────────
// Respond 200 immediately — process async to avoid TaxDome timeout.

app.post('/webhooks/taxdome', (req, res) => {
    res.status(200).json({ received: true });

    setImmediate(async () => {
        try {
            const { event, data: payload } = req.body || {};

            if (!event || !payload) return;

            console.log(`[Webhook] TaxDome event: ${event}`);

            // Document uploaded / fulfilled — mark as received
            if (event === 'document_request.fulfilled' || event === 'document.uploaded') {
                const requestId  = payload.request_id  || payload.requestId;
                const clientSlug = payload.client_slug || payload.clientSlug;

                if (!requestId) {
                    console.warn('[Webhook] No request_id in TaxDome payload');
                    return;
                }

                // Find the dc_client by slug (if provided) or search by taxdome_request_id
                if (clientSlug) {
                    const conn = await db.getClient(clientSlug);
                    if (conn) {
                        await db.markReceivedByTaxdomeId(conn.id, String(requestId));
                        console.log(`[Webhook] Marked received: taxdome_request_id=${requestId} for ${clientSlug}`);
                    }
                } else {
                    // Fallback: find any request matching this taxdome_request_id across all clients
                    const allClients = await db.getAllClients();
                    for (const client of allClients) {
                        await db.markReceivedByTaxdomeId(client.id, String(requestId));
                    }
                }
            }

            // Job status changed — re-sync that client's requests
            if (event === 'job.status_changed' || event === 'job.completed') {
                const clientSlug = payload.client_slug || payload.clientSlug;
                if (clientSlug) {
                    await jobs.runSyncRequests(clientSlug);
                    console.log(`[Webhook] Queued sync for ${clientSlug} due to ${event}`);
                }
            }
        } catch (err) {
            console.error(`[Webhook] TaxDome processing error: ${err.message}`);
        }
    });
});

// ─── API: Clients ─────────────────────────────────────────────────────────────

// List all configured accounting firm clients
app.get('/api/clients', requireApiKey, async (req, res) => {
    try {
        const clients = await db.getAllClients();
        res.json({ total: clients.length, clients });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create or update a firm's config
app.post('/api/clients', requireApiKey, async (req, res) => {
    const { clientSlug, firmName } = req.body;
    if (!clientSlug || !firmName) {
        return res.status(400).json({ error: 'clientSlug and firmName are required' });
    }

    try {
        const client = await db.upsertClient(req.body);
        res.status(201).json({ ok: true, client });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── API: Document Requests ───────────────────────────────────────────────────

// List document requests for a client
// Supports ?status=pending|overdue|received|cancelled and ?overdue=true
app.get('/api/clients/:slug/requests', requireApiKey, async (req, res) => {
    const { slug } = req.params;
    const { status, overdue } = req.query;

    try {
        const conn = await db.getClient(slug);
        if (!conn) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        const filters = {};
        if (status) filters.status = status;
        if (overdue === 'true') filters.overdue = true;

        const requests = await db.getDocumentRequests(conn.id, filters);
        res.json({ clientSlug: slug, total: requests.length, requests });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Single request detail with full reminder history
app.get('/api/clients/:slug/requests/:id', requireApiKey, async (req, res) => {
    const { slug, id } = req.params;

    try {
        const conn = await db.getClient(slug);
        if (!conn) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        const [request, reminders] = await Promise.all([
            db.getDocumentRequest(id),
            db.getRemindersForRequest(id),
        ]);

        if (!request || request.client_id !== conn.id) {
            return res.status(404).json({ error: 'Request not found' });
        }

        res.json({ request, reminders });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update request status manually
app.patch('/api/clients/:slug/requests/:id', requireApiKey, async (req, res) => {
    const { slug, id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'received', 'overdue', 'cancelled'];
    if (!status || !validStatuses.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    }

    try {
        const conn = await db.getClient(slug);
        if (!conn) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        const request = await db.getDocumentRequest(id);
        if (!request || request.client_id !== conn.id) {
            return res.status(404).json({ error: 'Request not found' });
        }

        const updated = await db.updateRequestStatus(id, status);
        res.json({ ok: true, request: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── API: Weekly Reports ──────────────────────────────────────────────────────

app.get('/api/clients/:slug/reports', requireApiKey, async (req, res) => {
    const { slug } = req.params;
    const { limit = 12 } = req.query;

    try {
        const conn = await db.getClient(slug);
        if (!conn) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        const reports = await db.getWeeklyReports(conn.id, parseInt(limit));
        res.json({ clientSlug: slug, total: reports.length, reports });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Trigger Endpoints ────────────────────────────────────────────────────────

// Pull latest document requests from TaxDome for one client
app.post('/trigger/sync-requests/:slug', requireApiKey, async (req, res) => {
    const { slug } = req.params;

    try {
        const conn = await db.getClient(slug);
        if (!conn) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        const job = await jobs.runSyncRequests(slug);
        res.json({ ok: true, jobId: job.id, clientSlug: slug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Send reminders for all pending/overdue requests for one client
app.post('/trigger/send-reminders/:slug', requireApiKey, async (req, res) => {
    const { slug } = req.params;

    try {
        const conn = await db.getClient(slug);
        if (!conn) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        const job = await jobs.runSendReminders(slug);
        res.json({ ok: true, jobId: job.id, clientSlug: slug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Generate and send weekly outstanding report for one client
app.post('/trigger/weekly-report/:slug', requireApiKey, async (req, res) => {
    const { slug } = req.params;

    try {
        const conn = await db.getClient(slug);
        if (!conn) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        const job = await jobs.runWeeklyReport(slug);
        res.json({ ok: true, jobId: job.id, clientSlug: slug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Sync all clients (TaxDome pull) — used by cron and manual trigger
app.post('/trigger/sync-all', requireApiKey, async (req, res) => {
    try {
        const results = await jobs.runForAllClients(jobs.runSyncRequests);
        res.json({ ok: true, queued: results.length, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Cron Schedules ───────────────────────────────────────────────────────────

// Every day at 9:00 AM — sync TaxDome document requests and send reminders
cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] 9am: Syncing document requests + sending reminders for all clients...');
    await jobs.runForAllClients(jobs.runSyncRequests);
    // Small delay before reminders so sync results are visible
    setTimeout(async () => {
        await jobs.runForAllClients(jobs.runSendReminders);
    }, 30000);
}, { timezone: 'America/Chicago' });

// Every Friday at 4:00 PM — generate weekly outstanding reports
cron.schedule('0 16 * * 5', async () => {
    console.log('[Cron] Friday 4pm: Generating weekly outstanding reports for all clients...');
    await jobs.runForAllClients(jobs.runWeeklyReport);
}, { timezone: 'America/Chicago' });

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\n[DocChaser] Online — port ${PORT}`);
    console.log(`[DocChaser] Health: http://localhost:${PORT}/health`);
    console.log(`[DocChaser] Crons: daily sync+reminders @ 9am | weekly report @ Fri 4pm`);
    console.log(`[DocChaser] Integrations: TaxDome REST API | Twilio SMS | Nodemailer\n`);
});

module.exports = app;
