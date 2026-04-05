/**
 * GRIDHAND Deadline Sentinel — Main Express Server
 *
 * Monitors all case deadlines (statutes of limitation, filing deadlines,
 * court dates, discovery cutoffs) for law firms using Clio or MyCase.
 * Sends escalating SMS alerts to attorneys and generates weekly reports.
 *
 * Routes:
 *   POST /webhook/clio                         → Clio matter/deadline webhooks
 *   POST /webhook/mycase                       → MyCase task/event webhooks
 *   POST /trigger/scan-deadlines               → Manual scan for all clients
 *   POST /trigger/weekly-report                → Manual weekly report for all clients
 *   GET  /clients/:clientSlug/deadlines        → All upcoming deadlines for a client
 *   GET  /clients/:clientSlug/deadlines/urgent → Critical + urgent only (≤7 days)
 *   GET  /auth/clio                            → Start Clio OAuth flow
 *   GET  /auth/clio/callback                   → Clio OAuth callback
 *   POST /clients/:clientSlug/mycase-key       → Save MyCase API key
 *   POST /clients/:clientSlug/setup            → Configure attorney/partner phones, firm name
 *   GET  /health                               → Health check
 *
 * Environment vars:
 *   CLIO_CLIENT_ID, CLIO_CLIENT_SECRET, CLIO_REDIRECT_URI
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   REDIS_URL
 *   GRIDHAND_API_KEY
 *   PORT (default: 3005)
 */

'use strict';

require('dotenv').config();

const express  = require('express');
const caseMgmt = require('./case-mgmt');
const deadlines = require('./deadlines');
const alerts   = require('./alerts');
const jobs     = require('./jobs');
const { createClient } = require('@supabase/supabase-js');

const app      = express();
const PORT     = process.env.PORT || 3005;
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

app.use(express.json());

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
    const serverKey = process.env.GRIDHAND_API_KEY;
    if (!serverKey) return res.status(503).json({ error: 'GRIDHAND_API_KEY not configured' });
    const provided = (req.headers['authorization'] || '').replace('Bearer ', '');
    if (provided !== serverKey) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({
        worker:  'Deadline Sentinel',
        status:  'online',
        version: '1.0.0',
        uptime:  Math.floor(process.uptime()),
        time:    new Date().toISOString(),
    });
});

// ─── Clio OAuth ───────────────────────────────────────────────────────────────

/**
 * GET /auth/clio?clientSlug=xxx
 * Redirects firm to Clio's OAuth consent screen.
 */
app.get('/auth/clio', (req, res) => {
    const { clientSlug } = req.query;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug is required' });

    const url = caseMgmt.getAuthUrl(clientSlug);
    res.redirect(url);
});

/**
 * GET /auth/clio/callback?code=...&state=clientSlug
 * Exchanges authorization code for tokens and saves to DB.
 */
app.get('/auth/clio/callback', async (req, res) => {
    const { code, state: clientSlug, error } = req.query;

    if (error) {
        return res.status(400).json({ error: `Clio OAuth error: ${error}` });
    }

    if (!code || !clientSlug) {
        return res.status(400).json({ error: 'Missing code or state (clientSlug)' });
    }

    try {
        await caseMgmt.exchangeCode(clientSlug, code);
        res.json({
            success: true,
            message: `Clio connected for ${clientSlug}. Run a scan to load deadlines.`,
            clientSlug,
        });
    } catch (err) {
        console.error(`[Auth] Clio callback error for ${clientSlug}: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// ─── MyCase Setup ─────────────────────────────────────────────────────────────

/**
 * POST /clients/:clientSlug/mycase-key
 * Body: { apiKey: "..." }
 */
app.post('/clients/:clientSlug/mycase-key', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { apiKey } = req.body;

    if (!apiKey) return res.status(400).json({ error: 'apiKey is required' });

    try {
        await caseMgmt.setMyCaseKey(clientSlug, apiKey);
        res.json({ success: true, message: `MyCase API key saved for ${clientSlug}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Client Setup ─────────────────────────────────────────────────────────────

/**
 * POST /clients/:clientSlug/setup
 * Body: { firmName, attorneyPhone, partnerPhone, timezone }
 *
 * Save or update contact/config info for a firm.
 */
app.post('/clients/:clientSlug/setup', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { firmName, attorneyPhone, partnerPhone, timezone } = req.body;

    if (!attorneyPhone) {
        return res.status(400).json({ error: 'attorneyPhone is required' });
    }

    const { error } = await supabase
        .from('sentinel_connections')
        .upsert({
            client_slug:    clientSlug,
            firm_name:      firmName || clientSlug,
            attorney_phone: attorneyPhone,
            partner_phone:  partnerPhone || null,
            timezone:       timezone || 'America/Chicago',
        }, { onConflict: 'client_slug' });

    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true, message: `Setup saved for ${clientSlug}` });
});

// ─── Clio Webhooks ────────────────────────────────────────────────────────────

/**
 * POST /webhook/clio
 * Receives real-time events from Clio (matter created, task updated, etc.).
 * Queues a targeted scan for the affected matter.
 *
 * Clio webhook payload shape (simplified):
 *   { event: { type: "matter.created" | "task.updated" | ..., data: { id, matter_id, ... } } }
 */
app.post('/webhook/clio', async (req, res) => {
    const payload = req.body;

    // Acknowledge immediately — Clio expects 200 within 5s
    res.status(200).json({ received: true });

    try {
        const eventType = payload?.event?.type || payload?.type || 'unknown';
        const eventData = payload?.event?.data || payload?.data || {};

        console.log(`[Webhook/Clio] Event: ${eventType}`, JSON.stringify(eventData).slice(0, 200));

        // Determine clientSlug from state param or header (Clio sends custom headers if configured)
        const clientSlug = req.headers['x-gridhand-client'] || payload?.clientSlug;

        if (!clientSlug) {
            console.warn('[Webhook/Clio] No clientSlug — cannot route event');
            return;
        }

        // For any matter or task event, queue a full scan so our DB stays current
        const matterEvents = ['matter.created', 'matter.updated', 'task.created', 'task.updated', 'task.deleted', 'calendar_entry.created', 'calendar_entry.updated'];

        if (matterEvents.some(e => eventType.includes(e.split('.')[0]))) {
            await jobs.runScanDeadlines(clientSlug);
            console.log(`[Webhook/Clio] Queued scan for ${clientSlug} due to ${eventType}`);
        }
    } catch (err) {
        console.error(`[Webhook/Clio] Processing error: ${err.message}`);
    }
});

// ─── MyCase Webhooks ──────────────────────────────────────────────────────────

/**
 * POST /webhook/mycase
 * Receives real-time events from MyCase.
 */
app.post('/webhook/mycase', async (req, res) => {
    const payload = req.body;

    res.status(200).json({ received: true });

    try {
        const eventType  = payload?.event || 'unknown';
        const clientSlug = req.headers['x-gridhand-client'] || payload?.clientSlug;

        console.log(`[Webhook/MyCase] Event: ${eventType}`);

        if (!clientSlug) {
            console.warn('[Webhook/MyCase] No clientSlug — cannot route event');
            return;
        }

        // Queue a scan for any case/task event
        await jobs.runScanDeadlines(clientSlug);
        console.log(`[Webhook/MyCase] Queued scan for ${clientSlug}`);
    } catch (err) {
        console.error(`[Webhook/MyCase] Processing error: ${err.message}`);
    }
});

// ─── Manual Triggers ──────────────────────────────────────────────────────────

/**
 * POST /trigger/scan-deadlines
 * Body: { clientSlug } — optional. If omitted, runs for all clients.
 */
app.post('/trigger/scan-deadlines', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;

    try {
        if (clientSlug) {
            const job = await jobs.runScanDeadlines(clientSlug);
            return res.json({ success: true, jobId: job.id, clientSlug });
        }

        const results = await jobs.runForAllClients(jobs.runScanDeadlines);
        res.json({ success: true, queued: results.length, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /trigger/weekly-report
 * Body: { clientSlug } — optional. If omitted, runs for all clients.
 */
app.post('/trigger/weekly-report', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;

    try {
        if (clientSlug) {
            const job = await jobs.runWeeklyReport(clientSlug);
            return res.json({ success: true, jobId: job.id, clientSlug });
        }

        const results = await jobs.runForAllClients(jobs.runWeeklyReport);
        res.json({ success: true, queued: results.length, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Deadline Queries ─────────────────────────────────────────────────────────

/**
 * GET /clients/:clientSlug/deadlines?days=30
 * Returns all upcoming deadlines for a client within the next N days.
 */
app.get('/clients/:clientSlug/deadlines', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const days = parseInt(req.query.days, 10) || 30;

    try {
        const upcoming = await deadlines.getUpcomingDeadlines(clientSlug, days);

        // Group by urgency for convenience
        const grouped = {
            critical: upcoming.filter(d => d.urgency === 'critical'),
            urgent:   upcoming.filter(d => d.urgency === 'urgent'),
            warning:  upcoming.filter(d => d.urgency === 'warning'),
            normal:   upcoming.filter(d => d.urgency === 'normal'),
        };

        res.json({
            clientSlug,
            days,
            total:   upcoming.length,
            grouped,
            deadlines: upcoming,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /clients/:clientSlug/deadlines/urgent
 * Returns only critical + urgent deadlines (≤7 days).
 */
app.get('/clients/:clientSlug/deadlines/urgent', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;

    try {
        const urgent = await deadlines.getUrgentDeadlines(clientSlug);
        res.json({
            clientSlug,
            total:     urgent.length,
            critical:  urgent.filter(d => d.urgency === 'critical').length,
            urgent:    urgent.filter(d => d.urgency === 'urgent').length,
            deadlines: urgent,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── 404 ──────────────────────────────────────────────────────────────────────

app.use((req, res) => {
    res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ─── Global Error Handler ────────────────────────────────────────────────────

app.use((err, req, res, next) => {
    console.error(`[Server] Unhandled error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`[Deadline Sentinel] Running on port ${PORT}`);

    // Register all cron jobs
    jobs.registerCrons();

    console.log('[Deadline Sentinel] Ready — monitoring law firm deadlines');
});

module.exports = app;
