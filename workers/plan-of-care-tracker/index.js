/**
 * GRIDHAND Plan of Care Tracker — Main Express Server
 *
 * Standalone microservice for chiropractic/PT clinics.
 * Tracks patients against their treatment plans, sends visit reminders,
 * and flags dropoffs before they walk away.
 *
 * Routes:
 *   GET  /                                   → health check
 *   GET  /plans/:clientSlug                  → active treatment plans
 *   GET  /alerts/:clientSlug                 → recent alert log
 *   POST /connect                            → register a new clinic connection
 *   POST /trigger/plan-sync                  → manually sync plans from EHR
 *   POST /trigger/visit-reminders            → manually send upcoming visit reminders
 *   POST /trigger/dropoff-monitor            → manually run dropoff detection
 *   POST /trigger/provider-summary           → manually send provider daily summary
 *   POST /trigger/all                        → trigger any job for all clients
 *
 * Environment vars required:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   REDIS_URL                  (Bull queue backend)
 *   GRIDHAND_API_KEY           (protects admin endpoints)
 *   PORT                       (default: 3010)
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
        worker:  'Plan of Care Tracker',
        status:  'online',
        version: '1.0.0',
        jobs: ['plan-sync', 'visit-reminders', 'dropoff-monitor', 'provider-summary'],
        integrations: ['WebPT API', 'Jane App API', 'Twilio SMS', 'Supabase'],
    });
});

// ─── Connect a Clinic ─────────────────────────────────────────────────────────

// Register a clinic's EHR credentials
app.post('/connect', requireApiKey, async (req, res) => {
    const { clientSlug, ehrType, apiKey, apiSecret, accessToken, locationId,
            clinicName, ownerPhone, providerPhone, reminderHours, dropoffThreshold } = req.body;

    if (!clientSlug || !ehrType) {
        return res.status(400).json({ error: 'clientSlug and ehrType are required' });
    }

    try {
        await db.upsertConnection({
            client_slug:       clientSlug,
            ehr_type:          ehrType,
            api_key:           apiKey || null,
            api_secret:        apiSecret || null,
            access_token:      accessToken || null,
            location_id:       locationId || null,
            clinic_name:       clinicName || clientSlug,
            owner_phone:       ownerPhone || null,
            provider_phone:    providerPhone || null,
            reminder_hours:    reminderHours || 24,
            dropoff_threshold: dropoffThreshold || 14,
        });

        // Immediately sync plans
        await jobs.runPlanSync(clientSlug);

        res.json({ success: true, clientSlug, message: `${clinicName || clientSlug} connected. Initial plan sync queued.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

app.get('/plans/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { status } = req.query;

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No connection for ${clientSlug}` });

        const plans = await db.getActivePlans(clientSlug);
        const filtered = status ? plans.filter(p => p.status === status) : plans;

        res.json({
            clientSlug,
            total:    filtered.length,
            active:   plans.filter(p => p.status === 'active').length,
            dropoffs: plans.filter(p => p.dropoff_flagged).length,
            plans:    filtered,
        });
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

app.post('/trigger/plan-sync', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runPlanSync(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/visit-reminders', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runVisitReminders(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/dropoff-monitor', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runDropoffMonitor(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/provider-summary', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runProviderSummary(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/all', requireApiKey, async (req, res) => {
    const { job } = req.body;

    const jobMap = {
        'plan-sync':       jobs.runPlanSync,
        'visit-reminders': jobs.runVisitReminders,
        'dropoff-monitor': jobs.runDropoffMonitor,
        'provider-summary': jobs.runProviderSummary,
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

// Plan sync — 6:00am daily (keep local data current)
cron.schedule('0 6 * * *', async () => {
    console.log('[Cron] Running plan sync for all clients...');
    await jobs.runForAllClients(jobs.runPlanSync);
}, { timezone: 'America/Chicago' });

// Provider daily summary — 7:30am daily
cron.schedule('30 7 * * *', async () => {
    console.log('[Cron] Running provider summary for all clients...');
    await jobs.runForAllClients(jobs.runProviderSummary);
}, { timezone: 'America/Chicago' });

// Visit reminders — 8:00am daily (sends reminders for next-day appointments)
cron.schedule('0 8 * * *', async () => {
    console.log('[Cron] Running visit reminders for all clients...');
    await jobs.runForAllClients(jobs.runVisitReminders);
}, { timezone: 'America/Chicago' });

// Dropoff monitor — 10:00am daily
cron.schedule('0 10 * * *', async () => {
    console.log('[Cron] Running dropoff monitor for all clients...');
    await jobs.runForAllClients(jobs.runDropoffMonitor);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
    console.log(`[PlanOfCareTracker] Online — port ${PORT}`);
    console.log(`[PlanOfCareTracker] Crons: plan-sync @ 6am | summary @ 7:30am | reminders @ 8am | dropoffs @ 10am`);
});
