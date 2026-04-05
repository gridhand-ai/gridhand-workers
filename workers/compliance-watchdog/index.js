/**
 * GRIDHAND Compliance Watchdog — Main Express Server
 *
 * Standalone microservice for insurance agencies.
 * Monitors agent license renewals, CE requirements, and carrier appointments
 * before they lapse — sends SMS alerts on a configurable schedule.
 *
 * Routes:
 *   GET  /                                    → health check
 *   GET  /licenses/:clientSlug               → all agent licenses (with expiry status)
 *   GET  /ce/:clientSlug                     → CE status for all agents
 *   GET  /appointments/:clientSlug           → carrier appointment status
 *   GET  /alerts/:clientSlug                 → recent alert log
 *   POST /connect                            → register agency AMS connection
 *   POST /trigger/ams-sync                   → manually sync from AMS
 *   POST /trigger/license-check              → manually run license expiry check
 *   POST /trigger/ce-check                   → manually run CE check
 *   POST /trigger/appointment-check          → manually run appointment check
 *   POST /trigger/weekly-digest              → manually send weekly summary
 *   POST /trigger/all                        → trigger any job for all clients
 *
 * Environment vars required:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   REDIS_URL                  (Bull queue backend)
 *   GRIDHAND_API_KEY           (protects admin endpoints)
 *   PORT                       (default: 3013)
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
        worker:  'Compliance Watchdog',
        status:  'online',
        version: '1.0.0',
        jobs: ['ams-sync', 'license-check', 'ce-check', 'appointment-check', 'weekly-digest'],
        integrations: ['Applied Epic API', 'HawkSoft API', 'State DOI Databases', 'Twilio SMS', 'Supabase'],
    });
});

// ─── Connect an Agency ────────────────────────────────────────────────────────

app.post('/connect', requireApiKey, async (req, res) => {
    const { clientSlug, amsType, amsApiKey, amsApiSecret, amsBaseUrl,
            agencyName, ownerPhone, stateCodes, alertDaysAhead } = req.body;

    if (!clientSlug || !amsType || !amsApiKey) {
        return res.status(400).json({ error: 'clientSlug, amsType, and amsApiKey are required' });
    }

    try {
        await db.upsertConnection({
            client_slug:      clientSlug,
            ams_type:         amsType,
            ams_api_key:      amsApiKey,
            ams_api_secret:   amsApiSecret || null,
            ams_base_url:     amsBaseUrl || null,
            agency_name:      agencyName || clientSlug,
            owner_phone:      ownerPhone || null,
            state_codes:      stateCodes || [],
            alert_days_ahead: alertDaysAhead || [90, 60, 30, 14],
        });

        // Initial sync
        await jobs.runAMSSync(clientSlug);

        res.json({ success: true, clientSlug, message: `${agencyName || clientSlug} connected. Initial AMS sync queued.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

app.get('/licenses/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { daysAhead = 90 } = req.query;

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No connection for ${clientSlug}` });

        const [expiring, expired] = await Promise.all([
            db.getExpiringLicenses(clientSlug, parseInt(daysAhead)),
            db.getExpiredLicenses(clientSlug),
        ]);

        res.json({
            clientSlug,
            expired:       expired.length,
            expiringSoon:  expiring.length,
            expiredList:   expired,
            expiringList:  expiring,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/ce/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No connection for ${clientSlug}` });

        const behind = await db.getCEsBehindSchedule(clientSlug);
        res.json({ clientSlug, agentsBehind: behind.length, ceRecords: behind });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/appointments/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { daysAhead = 90 } = req.query;

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No connection for ${clientSlug}` });

        const expiring = await db.getExpiringAppointments(clientSlug, parseInt(daysAhead));
        res.json({ clientSlug, expiringCount: expiring.length, appointments: expiring });
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

app.post('/trigger/ams-sync', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runAMSSync(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/license-check', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runLicenseCheck(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/ce-check', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runCECheck(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/appointment-check', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runAppointmentCheck(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/weekly-digest', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runWeeklyDigest(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/all', requireApiKey, async (req, res) => {
    const { job } = req.body;

    const jobMap = {
        'ams-sync':          jobs.runAMSSync,
        'license-check':     jobs.runLicenseCheck,
        'ce-check':          jobs.runCECheck,
        'appointment-check': jobs.runAppointmentCheck,
        'weekly-digest':     jobs.runWeeklyDigest,
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

// AMS sync — 6:00am daily
cron.schedule('0 6 * * *', async () => {
    console.log('[Cron] Running AMS sync for all clients...');
    await jobs.runForAllClients(jobs.runAMSSync);
}, { timezone: 'America/Chicago' });

// License check — 7:00am daily
cron.schedule('0 7 * * *', async () => {
    console.log('[Cron] Running license check for all clients...');
    await jobs.runForAllClients(jobs.runLicenseCheck);
}, { timezone: 'America/Chicago' });

// CE check — 7:30am Monday
cron.schedule('30 7 * * 1', async () => {
    console.log('[Cron] Running CE check for all clients...');
    await jobs.runForAllClients(jobs.runCECheck);
}, { timezone: 'America/Chicago' });

// Appointment check — 8:00am Monday
cron.schedule('0 8 * * 1', async () => {
    console.log('[Cron] Running appointment check for all clients...');
    await jobs.runForAllClients(jobs.runAppointmentCheck);
}, { timezone: 'America/Chicago' });

// Weekly digest — 8:30am Monday
cron.schedule('30 8 * * 1', async () => {
    console.log('[Cron] Sending weekly digest for all clients...');
    await jobs.runForAllClients(jobs.runWeeklyDigest);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3013;
app.listen(PORT, () => {
    console.log(`[ComplianceWatchdog] Online — port ${PORT}`);
    console.log(`[ComplianceWatchdog] Crons: ams-sync @ 6am | license-check @ 7am | CE/appt/digest @ Mon 7:30-8:30am`);
});
