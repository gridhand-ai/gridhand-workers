/**
 * GRIDHAND Daily Log Bot — Main Express Server
 *
 * Auto-generates daily job reports from CompanyCam photos, weather data,
 * and Procore crew check-ins. Posts the completed log back to Procore.
 *
 * Routes:
 *   GET  /                                    → health check
 *   GET  /auth/procore?clientSlug=&ownerPhone= → start Procore OAuth
 *   GET  /auth/procore/callback               → Procore OAuth callback
 *   GET  /reports/:clientSlug                 → recent daily reports
 *   GET  /alerts/:clientSlug                  → alert history
 *   POST /trigger/daily-log                   → manually trigger daily log generation
 *   POST /trigger/morning-weather             → manually trigger weather advisory
 *   POST /trigger/all                         → trigger job for all clients
 *
 * Environment vars required:
 *   PROCORE_CLIENT_ID, PROCORE_CLIENT_SECRET, PROCORE_REDIRECT_URI
 *   OPENWEATHER_API_KEY
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   REDIS_URL            (Bull queue backend)
 *   GRIDHAND_API_KEY     (protects admin endpoints)
 *   PORT                 (default: 3010)
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
        worker:  'Daily Log Bot',
        status:  'online',
        version: '1.0.0',
        jobs:    ['generate-daily-log', 'morning-weather'],
        integrations: ['Procore API', 'CompanyCam API', 'OpenWeatherMap'],
    });
});

// ─── Procore OAuth Flow ───────────────────────────────────────────────────────

app.get('/auth/procore', (req, res) => {
    const { clientSlug, ownerPhone, companyId } = req.query;
    if (!clientSlug || !ownerPhone) {
        return res.status(400).json({ error: 'clientSlug and ownerPhone are required' });
    }

    const state = Buffer.from(JSON.stringify({
        clientSlug, ownerPhone, companyId: companyId || '', ts: Date.now()
    })).toString('base64');

    res.redirect(procore.getAuthorizationUrl(state));
});

app.get('/auth/procore/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) {
        return res.status(400).send('Missing code or state from Procore.');
    }

    let clientSlug, ownerPhone, companyId;
    try {
        const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
        clientSlug = decoded.clientSlug;
        ownerPhone = decoded.ownerPhone;
        companyId  = decoded.companyId;
    } catch {
        return res.status(400).send('Invalid state parameter.');
    }

    try {
        await procore.exchangeCode({ code, clientSlug, ownerPhone, companyId });
        console.log(`[OAuth] Connected Procore for ${clientSlug}`);
        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px">
                <h2>✅ Procore Connected!</h2>
                <p><strong>${clientSlug}</strong> is now connected.</p>
                <p>Daily Log Bot will auto-generate job site reports every evening.</p>
            </body></html>
        `);
    } catch (err) {
        console.error(`[OAuth] Procore exchange failed: ${err.message}`);
        res.status(500).send(`OAuth failed: ${err.message}`);
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

app.get('/reports/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { projectId, days = 7 } = req.query;

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No connection for ${clientSlug}` });

        const reports = await db.getRecentReports(clientSlug, projectId || null, parseInt(days));
        res.json({ clientSlug, total: reports.length, reports });
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

app.post('/trigger/daily-log', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runDailyLog(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/morning-weather', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runMorningWeather(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/all', requireApiKey, async (req, res) => {
    const { job } = req.body;
    const jobMap = {
        'daily-log':       jobs.runDailyLog,
        'morning-weather': jobs.runMorningWeather,
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

// Morning weather advisory — 6:00am every weekday
cron.schedule('0 6 * * 1-5', async () => {
    console.log('[Cron] Running morning weather advisory for all clients...');
    await jobs.runForAllClients(jobs.runMorningWeather);
}, { timezone: 'America/Chicago' });

// Daily log generation — 5:00pm every weekday
cron.schedule('0 17 * * 1-5', async () => {
    console.log('[Cron] Generating daily logs for all clients...');
    await jobs.runForAllClients(jobs.runDailyLog);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
    console.log(`[DailyLogBot] Online — port ${PORT}`);
    console.log(`[DailyLogBot] Crons: weather @ 6am weekdays | daily log @ 5pm weekdays`);
});
