/**
 * GRIDHAND Reputation Engine — Main Express Server
 *
 * Standalone microservice for any business with an online presence.
 * Monitors Google Business Profile and Yelp reviews, auto-responds to
 * Google reviews, and immediately SMS-alerts the manager on negatives.
 *
 * Routes:
 *   GET  /                                    → health check
 *   GET  /auth/google?clientSlug=xxx          → start Google OAuth flow
 *   GET  /auth/google/callback                → Google OAuth callback
 *   GET  /reviews/:clientSlug                 → recent reviews (all platforms)
 *   GET  /reviews/:clientSlug/:platform       → reviews filtered by platform
 *   GET  /stats/:clientSlug                   → reputation stats summary
 *   GET  /alerts/:clientSlug                  → recent alert log
 *   POST /connect                             → register business (Yelp only, or update settings)
 *   POST /trigger/review-monitor              → manually fetch new reviews
 *   POST /trigger/alert-negatives             → manually run negative review alerts
 *   POST /trigger/auto-respond                → manually run auto-respond
 *   POST /trigger/weekly-digest               → manually send weekly digest
 *   POST /trigger/all                         → trigger any job for all clients
 *
 * Environment vars required:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   REDIS_URL                  (Bull queue backend)
 *   GRIDHAND_API_KEY           (protects admin endpoints)
 *   PORT                       (default: 3014)
 */

'use strict';

const express = require('express');
const cron    = require('node-cron');
const google  = require('./google');
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
        worker:  'Reputation Engine',
        status:  'online',
        version: '1.0.0',
        jobs: ['review-monitor', 'alert-negatives', 'auto-respond', 'weekly-digest'],
        integrations: ['Google Business Profile API', 'Yelp Fusion API', 'Twilio SMS', 'Supabase'],
    });
});

// ─── Google OAuth Flow ────────────────────────────────────────────────────────

// Step 1: Redirect business owner to Google authorization
app.get('/auth/google', (req, res) => {
    const { clientSlug, ownerPhone } = req.query;

    if (!clientSlug || !ownerPhone) {
        return res.status(400).json({ error: 'clientSlug and ownerPhone are required' });
    }

    const authUrl = google.buildAuthUrl(clientSlug, ownerPhone);
    res.redirect(authUrl);
});

// Step 2: Google redirects back here with auth code
app.get('/auth/google/callback', async (req, res) => {
    const { code, state } = req.query;

    if (!code || !state) {
        return res.status(400).send('Missing code or state from Google.');
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
        await google.exchangeCode({ code, clientSlug, ownerPhone });
        console.log(`[OAuth] Google connected for client: ${clientSlug}`);

        // Kick off initial review sync
        await jobs.runReviewMonitor(clientSlug);

        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px">
                <h2>✅ Google Reviews Connected!</h2>
                <p><strong>${clientSlug}</strong> is now connected to Google Business Profile.</p>
                <p>Reputation Engine will monitor your reviews and alert you on negatives.</p>
            </body></html>
        `);
    } catch (err) {
        console.error(`[OAuth] Google token exchange failed: ${err.message}`);
        res.status(500).send(`OAuth failed: ${err.message}`);
    }
});

// ─── Connect (Yelp / Settings Update) ────────────────────────────────────────

app.post('/connect', requireApiKey, async (req, res) => {
    const { clientSlug, businessName, ownerPhone, managerPhone, yelpBusinessId, yelpApiKey,
            googlePlaceId, negativeThreshold, autoRespondGoogle, alertOnNegative,
            responseTone, responseSignature } = req.body;

    if (!clientSlug || !businessName) {
        return res.status(400).json({ error: 'clientSlug and businessName are required' });
    }

    try {
        // Get existing connection to preserve OAuth tokens
        const existing = await db.getConnection(clientSlug) || {};

        await db.upsertConnection({
            ...existing,
            client_slug:          clientSlug,
            business_name:        businessName,
            owner_phone:          ownerPhone || existing.owner_phone || null,
            manager_phone:        managerPhone || existing.manager_phone || null,
            google_place_id:      googlePlaceId || existing.google_place_id || null,
            yelp_business_id:     yelpBusinessId || null,
            yelp_api_key:         yelpApiKey || null,
            negative_threshold:   negativeThreshold ?? 3,
            auto_respond_google:  autoRespondGoogle ?? true,
            alert_on_negative:    alertOnNegative ?? true,
            response_tone:        responseTone || 'professional',
            response_signature:   responseSignature || null,
        });

        res.json({ success: true, clientSlug, message: `${businessName} reputation settings saved.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

app.get('/reviews/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { limit = 50 } = req.query;

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No connection for ${clientSlug}` });

        const reviews = await db.getRecentReviews(clientSlug, null, parseInt(limit));
        res.json({ clientSlug, total: reviews.length, reviews });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/reviews/:clientSlug/:platform', requireApiKey, async (req, res) => {
    const { clientSlug, platform } = req.params;
    const { limit = 50 } = req.query;

    try {
        const reviews = await db.getRecentReviews(clientSlug, platform, parseInt(limit));
        res.json({ clientSlug, platform, total: reviews.length, reviews });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/stats/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No connection for ${clientSlug}` });

        const [googleStats, yelpStats] = await Promise.all([
            conn.google_place_id  ? db.getReviewStats(clientSlug, 'google') : null,
            conn.yelp_business_id ? db.getReviewStats(clientSlug, 'yelp')   : null,
        ]);

        res.json({ clientSlug, google: googleStats, yelp: yelpStats });
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

app.post('/trigger/review-monitor', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runReviewMonitor(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/alert-negatives', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runAlertNegatives(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/auto-respond', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runAutoRespond(clientSlug);
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
        'review-monitor':  jobs.runReviewMonitor,
        'alert-negatives': jobs.runAlertNegatives,
        'auto-respond':    jobs.runAutoRespond,
        'weekly-digest':   jobs.runWeeklyDigest,
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

// Review monitor — every 4 hours (8am, 12pm, 4pm, 8pm)
cron.schedule('0 8,12,16,20 * * *', async () => {
    console.log('[Cron] Running review monitor for all clients...');
    await jobs.runForAllClients(jobs.runReviewMonitor);
}, { timezone: 'America/Chicago' });

// Alert negatives — 30 minutes after each monitor run
cron.schedule('30 8,12,16,20 * * *', async () => {
    console.log('[Cron] Running negative review alerts for all clients...');
    await jobs.runForAllClients(jobs.runAlertNegatives);
}, { timezone: 'America/Chicago' });

// Auto-respond — 45 minutes after each monitor run
cron.schedule('45 8,12,16,20 * * *', async () => {
    console.log('[Cron] Running auto-respond for all clients...');
    await jobs.runForAllClients(jobs.runAutoRespond);
}, { timezone: 'America/Chicago' });

// Weekly digest — 9am Monday
cron.schedule('0 9 * * 1', async () => {
    console.log('[Cron] Sending weekly reputation digest for all clients...');
    await jobs.runForAllClients(jobs.runWeeklyDigest);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3014;
app.listen(PORT, () => {
    console.log(`[ReputationEngine] Online — port ${PORT}`);
    console.log(`[ReputationEngine] Crons: review monitor every 4h (8am/12pm/4pm/8pm) | weekly digest Mon 9am`);
});
