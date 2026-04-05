/**
 * GRIDHAND Weather Watcher — Main Express Server
 *
 * A standalone microservice. Runs on its own port.
 *
 * Routes:
 *   GET  /                                      → health check
 *   GET  /auth/jobber?clientSlug=&ownerPhone=   → start Jobber OAuth flow
 *   GET  /auth/jobber/callback                  → Jobber OAuth callback (exchange code for tokens)
 *   GET  /weather/:clientSlug                   → current weather alerts + postponed jobs
 *   GET  /postponed/:clientSlug                 → list of postponed jobs awaiting rescheduling
 *   GET  /alerts/:clientSlug                    → recent SMS log
 *   POST /trigger/weather-check                 → check forecast, auto-postpone if bad weather
 *   POST /trigger/reschedule-postponed          → try to reschedule all postponed jobs
 *   POST /trigger/all                           → run a job for all clients
 *
 * Environment vars required:
 *   JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET, JOBBER_REDIRECT_URI
 *   OPENWEATHERMAP_API_KEY
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   REDIS_URL                 (Bull queue backend)
 *   GRIDHAND_API_KEY          (protects admin endpoints)
 *   PORT                      (default: 3010)
 */

'use strict';

const express = require('express');
const cron    = require('node-cron');
const jobber  = require('./jobber');
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
        worker:  'Weather Watcher',
        status:  'online',
        version: '1.0.0',
        jobs: ['weather-check', 'reschedule-postponed'],
        integrations: ['Jobber API', 'OpenWeatherMap API', 'Twilio SMS', 'Supabase'],
    });
});

// ─── Jobber OAuth Flow ────────────────────────────────────────────────────────

// Step 1: Redirect business owner to Jobber authorization page
app.get('/auth/jobber', (req, res) => {
    const { clientSlug, ownerPhone } = req.query;

    if (!clientSlug || !ownerPhone) {
        return res.status(400).json({ error: 'clientSlug and ownerPhone are required' });
    }

    const clientId = process.env.JOBBER_CLIENT_ID;
    if (!clientId) return res.status(503).json({ error: 'JOBBER_CLIENT_ID not configured' });

    const state = Buffer.from(JSON.stringify({ clientSlug, ownerPhone, ts: Date.now() })).toString('base64');

    const redirectUri = process.env.JOBBER_REDIRECT_URI;
    const params = new URLSearchParams({
        client_id:     clientId,
        redirect_uri:  redirectUri,
        response_type: 'code',
        state,
    });

    res.redirect(`https://api.getjobber.com/api/oauth/authorize?${params.toString()}`);
});

// Step 2: Jobber redirects back here with the auth code
app.get('/auth/jobber/callback', async (req, res) => {
    const { code, state } = req.query;

    if (!code || !state) {
        return res.status(400).send('Missing code or state from Jobber.');
    }

    let clientSlug, ownerPhone;
    try {
        const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
        clientSlug = decoded.clientSlug;
        ownerPhone = decoded.ownerPhone;
    } catch {
        return res.status(400).send('Invalid state parameter.');
    }

    try {
        await jobber.exchangeCode({ code, clientSlug, ownerPhone });
        console.log(`[OAuth] Connected Jobber for client: ${clientSlug}`);
        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px">
                <h2>✅ Jobber Connected!</h2>
                <p><strong>${clientSlug}</strong> is now connected to Weather Watcher.</p>
                <p>Weather Watcher will monitor forecasts and automatically postpone jobs when bad weather is predicted. Clients will be notified by SMS.</p>
            </body></html>
        `);
    } catch (err) {
        console.error(`[OAuth] Token exchange failed: ${err.message}`);
        res.status(500).send(`OAuth failed: ${err.message}`);
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

// Current weather status and postponed job count
app.get('/weather/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No Jobber connection for ${clientSlug}` });

        const postponed = await db.getPostponedJobs(clientSlug, ['postponed', 'rescheduled']);
        const recent    = postponed.filter(j => j.status === 'postponed');

        res.json({
            clientSlug,
            activePostponements: recent.length,
            postponedJobs: recent,
            totalTracked: postponed.length,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List of postponed jobs awaiting rescheduling
app.get('/postponed/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;

    try {
        const jobs = await db.getPostponedJobs(clientSlug, ['postponed']);
        res.json({ clientSlug, count: jobs.length, jobs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Recent alert / SMS log
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

app.post('/trigger/weather-check', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runWeatherCheck(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/reschedule-postponed', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runReschedulePostponed(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Trigger a job for all clients
app.post('/trigger/all', requireApiKey, async (req, res) => {
    const { job } = req.body; // 'weather-check' | 'reschedule-postponed'

    const jobMap = {
        'weather-check':         jobs.runWeatherCheck,
        'reschedule-postponed':  jobs.runReschedulePostponed,
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

// Evening forecast check — 6:00pm daily (checks next-day forecast)
cron.schedule('0 18 * * *', async () => {
    console.log('[Cron] Running evening weather check for all clients...');
    await jobs.runForAllClients(jobs.runWeatherCheck);
}, { timezone: 'America/Chicago' });

// Morning check + reschedule postponed — 8:00am daily
cron.schedule('0 8 * * *', async () => {
    console.log('[Cron] Running morning weather check and rescheduling for all clients...');
    await jobs.runForAllClients(jobs.runWeatherCheck);
    await jobs.runForAllClients(jobs.runReschedulePostponed);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
    console.log(`[WeatherWatcher] Online — port ${PORT}`);
    console.log(`[WeatherWatcher] Crons: weather check @ 6pm daily | morning check + reschedule @ 8am daily`);
});
