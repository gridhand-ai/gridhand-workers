/**
 * GRIDHAND Sub-Scheduler — Main Express Server
 *
 * Coordinates subcontractor scheduling, sends SMS reminders,
 * and tracks who showed up. Mirrors Buildertrend to Google Calendar.
 *
 * Routes:
 *   GET  /                                    → health check
 *   GET  /auth/google?clientSlug=&ownerPhone= → start Google OAuth
 *   GET  /auth/google/callback                → Google OAuth callback
 *   POST /subs/:clientSlug                    → add/update a subcontractor
 *   GET  /schedules/:clientSlug               → upcoming schedules
 *   GET  /subcontractors/:clientSlug          → sub directory
 *   GET  /alerts/:clientSlug                  → SMS history
 *   POST /trigger/sync                        → manually sync from Buildertrend
 *   POST /trigger/reminders                   → manually send reminders
 *   POST /trigger/no-shows                    → manually check no-shows
 *   POST /trigger/daily-brief                 → manually send daily brief
 *   POST /trigger/all                         → trigger job for all clients
 *
 * Environment vars required:
 *   BUILDERTREND_API_KEY        (or per-client in DB)
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   REDIS_URL
 *   GRIDHAND_API_KEY
 *   PORT (default: 3012)
 */

'use strict';

const express  = require('express');
const cron     = require('node-cron');
const calendar = require('./calendar');
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
        worker:  'Sub-Scheduler',
        status:  'online',
        version: '1.0.0',
        jobs:    ['sync-schedules', 'send-reminders', 'check-no-shows', 'daily-brief'],
        integrations: ['Buildertrend API', 'Google Calendar API', 'Twilio SMS'],
    });
});

// ─── Google OAuth Flow ────────────────────────────────────────────────────────

app.get('/auth/google', (req, res) => {
    const { clientSlug, ownerPhone, btApiKey, btCompanyId } = req.query;
    if (!clientSlug || !ownerPhone) {
        return res.status(400).json({ error: 'clientSlug and ownerPhone are required' });
    }
    const state = Buffer.from(JSON.stringify({ clientSlug, ownerPhone, btApiKey, btCompanyId, ts: Date.now() })).toString('base64');
    res.redirect(calendar.getAuthorizationUrl(state));
});

app.get('/auth/google/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing code or state.');

    let clientSlug, ownerPhone, btApiKey, btCompanyId;
    try {
        const d = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
        clientSlug = d.clientSlug; ownerPhone = d.ownerPhone; btApiKey = d.btApiKey; btCompanyId = d.btCompanyId;
    } catch { return res.status(400).send('Invalid state.'); }

    try {
        await calendar.exchangeCode(clientSlug, code);
        // Upsert connection with Buildertrend credentials too
        await db.upsertConnection({
            client_slug:              clientSlug,
            owner_phone:              ownerPhone,
            buildertrend_api_key:     btApiKey || null,
            buildertrend_company_id:  btCompanyId || null,
        });
        console.log(`[OAuth] Connected Google Calendar for ${clientSlug}`);
        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px">
                <h2>✅ Google Calendar Connected!</h2>
                <p><strong>${clientSlug}</strong> is now connected.</p>
                <p>Sub-Scheduler will sync your Buildertrend schedule and send subcontractor SMS reminders.</p>
            </body></html>
        `);
    } catch (err) {
        res.status(500).send(`OAuth failed: ${err.message}`);
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

app.get('/schedules/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    try {
        const schedules = await db.getUpcomingSchedules(clientSlug, 72);
        res.json({ clientSlug, total: schedules.length, schedules });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/subs/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { name, phone, company, trade, email } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
    try {
        await db.upsertSubcontractor(clientSlug, { name, phone, company, trade, email });
        res.json({ success: true, clientSlug, sub: { name, phone } });
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
        const job = await jobs.runSyncSchedules(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/reminders', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });
    try {
        const job = await jobs.runSendReminders(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/no-shows', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });
    try {
        const job = await jobs.runCheckNoShows(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/daily-brief', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });
    try {
        const job = await jobs.runDailyBrief(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/all', requireApiKey, async (req, res) => {
    const { job } = req.body;
    const jobMap = {
        'sync':        jobs.runSyncSchedules,
        'reminders':   jobs.runSendReminders,
        'no-shows':    jobs.runCheckNoShows,
        'daily-brief': jobs.runDailyBrief,
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

// Sync from Buildertrend — every 2 hours
cron.schedule('0 */2 * * *', async () => {
    console.log('[Cron] Syncing schedules for all clients...');
    await jobs.runForAllClients(jobs.runSyncSchedules);
}, { timezone: 'America/Chicago' });

// Daily brief to owner — 7:30am every weekday
cron.schedule('30 7 * * 1-5', async () => {
    console.log('[Cron] Sending daily brief for all clients...');
    await jobs.runForAllClients(jobs.runDailyBrief);
}, { timezone: 'America/Chicago' });

// SMS reminders to subs — 8:00am every weekday
cron.schedule('0 8 * * 1-5', async () => {
    console.log('[Cron] Sending sub reminders for all clients...');
    await jobs.runForAllClients(jobs.runSendReminders);
}, { timezone: 'America/Chicago' });

// No-show check — 10:00am every weekday
cron.schedule('0 10 * * 1-5', async () => {
    console.log('[Cron] Checking no-shows for all clients...');
    await jobs.runForAllClients(jobs.runCheckNoShows);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3012;
app.listen(PORT, () => {
    console.log(`[SubScheduler] Online — port ${PORT}`);
    console.log(`[SubScheduler] Crons: sync every 2h | brief 7:30am | reminders 8am | no-shows 10am`);
});
