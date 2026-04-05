/**
 * GRIDHAND Route Optimizer — Main Express Server
 *
 * A standalone microservice. Runs on its own port.
 *
 * Routes:
 *   GET  /                                      → health check
 *   GET  /auth/jobber?clientSlug=&ownerPhone=   → start Jobber OAuth flow
 *   GET  /auth/jobber/callback                  → Jobber OAuth callback (exchange code for tokens)
 *   GET  /routes/:clientSlug                    → today's optimized routes for all crews
 *   GET  /routes/:clientSlug/:crewId            → route for a specific crew
 *   GET  /alerts/:clientSlug                    → recent alert log
 *   POST /trigger/optimize-routes               → manually trigger route optimization
 *   POST /trigger/morning-briefing              → manually trigger morning briefing SMS
 *   POST /trigger/all                           → run a job for all clients
 *
 * Environment vars required:
 *   JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET, JOBBER_REDIRECT_URI
 *   GOOGLE_MAPS_API_KEY
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   REDIS_URL                 (Bull queue backend)
 *   GRIDHAND_API_KEY          (protects admin endpoints)
 *   PORT                      (default: 3009)
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
        worker:  'Route Optimizer',
        status:  'online',
        version: '1.0.0',
        jobs: ['optimize-routes', 'morning-briefing'],
        integrations: ['Jobber API', 'Google Maps Directions API', 'Twilio SMS', 'Supabase'],
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

    // Encode metadata into state param (base64 JSON)
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
                <p><strong>${clientSlug}</strong> is now connected to Jobber.</p>
                <p>Route Optimizer will build optimized crew routes every morning at 6am and send SMS briefings at 6:30am.</p>
            </body></html>
        `);
    } catch (err) {
        console.error(`[OAuth] Token exchange failed: ${err.message}`);
        res.status(500).send(`OAuth failed: ${err.message}`);
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

// All optimized routes for today
app.get('/routes/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { date } = req.query;

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No Jobber connection for ${clientSlug}` });

        const routeDate = date || require('dayjs')().format('YYYY-MM-DD');
        const routes    = await db.getRoutesForDate(clientSlug, routeDate);

        res.json({ clientSlug, date: routeDate, crewCount: routes.length, routes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Route for a specific crew
app.get('/routes/:clientSlug/:crewId', requireApiKey, async (req, res) => {
    const { clientSlug, crewId } = req.params;
    const { date } = req.query;

    try {
        const routeDate = date || require('dayjs')().format('YYYY-MM-DD');
        const route     = await db.getRouteForCrew(clientSlug, crewId, routeDate);

        if (!route) {
            return res.status(404).json({ error: `No route found for crew ${crewId} on ${routeDate}` });
        }

        res.json({ clientSlug, crewId, date: routeDate, route });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Recent alert log
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

app.post('/trigger/optimize-routes', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runOptimizeRoutes(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/morning-briefing', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runMorningBriefing(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Trigger a job for all clients
app.post('/trigger/all', requireApiKey, async (req, res) => {
    const { job } = req.body; // 'optimize-routes' | 'morning-briefing'

    const jobMap = {
        'optimize-routes':  jobs.runOptimizeRoutes,
        'morning-briefing': jobs.runMorningBriefing,
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

// Optimize routes — 6:00am Monday–Saturday
cron.schedule('0 6 * * 1-6', async () => {
    console.log('[Cron] Optimizing routes for all clients...');
    await jobs.runForAllClients(jobs.runOptimizeRoutes);
}, { timezone: 'America/Chicago' });

// Morning briefing SMS — 6:30am Monday–Saturday
cron.schedule('30 6 * * 1-6', async () => {
    console.log('[Cron] Sending morning briefings for all clients...');
    await jobs.runForAllClients(jobs.runMorningBriefing);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3009;
app.listen(PORT, () => {
    console.log(`[RouteOptimizer] Online — port ${PORT}`);
    console.log(`[RouteOptimizer] Crons: optimize routes @ 6am Mon-Sat | morning briefing @ 6:30am Mon-Sat`);
});
