/**
 * GRIDHAND Chair Filler — Main Express Server
 *
 * A standalone microservice. Runs on its own port.
 *
 * Routes:
 *   GET  /                                         → health check
 *   GET  /auth/instagram?clientSlug=               → Instagram OAuth start
 *   GET  /auth/instagram/callback                  → exchange code for long-lived token
 *   GET  /slots/:clientSlug                        → current open slots today/tomorrow
 *   GET  /campaigns/:clientSlug                    → recent fill campaigns (posts + texts sent)
 *   GET  /alerts/:clientSlug                       → SMS log
 *   POST /trigger/check-openings                   → scan for open slots and launch fill campaign
 *   POST /trigger/post-instagram                   → post available slots to Instagram
 *   POST /trigger/text-matches                     → text matched clients about open slots
 *   POST /trigger/all                              → trigger any job for all clients
 *
 * Environment vars required:
 *   BOULEVARD_API_KEY, BOULEVARD_BUSINESS_ID
 *   SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID
 *   BOOKING_SYSTEM                (boulevard or square)
 *   INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, INSTAGRAM_REDIRECT_URI
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   REDIS_URL                     (Bull queue backend)
 *   GRIDHAND_API_KEY              (protects admin endpoints)
 *   PORT                          (default: 3014)
 */

'use strict';

const express   = require('express');
const cron      = require('node-cron');
const jobs      = require('./jobs');
const db        = require('./db');
const instagram = require('./instagram');

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
        worker:       'Chair Filler',
        status:       'online',
        version:      '1.0.0',
        jobs:         ['check-openings', 'post-instagram', 'text-matches'],
        integrations: ['Boulevard API', 'Square Appointments API', 'Instagram Graph API', 'Twilio SMS', 'Supabase'],
    });
});

// ─── Instagram OAuth Flow ─────────────────────────────────────────────────────

// Step 1: Redirect to Instagram authorization page
app.get('/auth/instagram', (req, res) => {
    const { clientSlug } = req.query;

    if (!clientSlug) {
        return res.status(400).json({ error: 'clientSlug is required' });
    }

    const appId      = process.env.INSTAGRAM_APP_ID;
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

    if (!appId || !redirectUri) {
        return res.status(503).json({ error: 'INSTAGRAM_APP_ID and INSTAGRAM_REDIRECT_URI must be set' });
    }

    const state = Buffer.from(JSON.stringify({ clientSlug, ts: Date.now() })).toString('base64');

    // Instagram Graph API OAuth — requires Facebook App review for Business accounts
    const params = new URLSearchParams({
        client_id:     appId,
        redirect_uri:  redirectUri,
        scope:         'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement',
        response_type: 'code',
        state,
    });

    res.redirect(`https://www.facebook.com/v18.0/dialog/oauth?${params.toString()}`);
});

// Step 2: Instagram redirects back with code
app.get('/auth/instagram/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
        return res.status(400).send(`Instagram authorization denied: ${oauthError}`);
    }

    if (!code || !state) {
        return res.status(400).send('Missing code or state from Instagram.');
    }

    let clientSlug;
    try {
        const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
        clientSlug = decoded.clientSlug;
    } catch {
        return res.status(400).send('Invalid state parameter.');
    }

    try {
        // Exchange short-lived code for long-lived token
        const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;
        const tokens = await instagram.exchangeCode(code, redirectUri);

        // Get Instagram account info
        const accountInfo = await instagram.getAccountInfo(tokens.access_token);

        // Compute expiry (long-lived tokens last 60 days)
        const expiresAt = new Date(Date.now() + (tokens.expires_in || 5184000) * 1000).toISOString();

        await db.updateInstagramToken(clientSlug, {
            accessToken:           tokens.access_token,
            instagramAccountId:    accountInfo.id,
            instagramTokenExpiresAt: expiresAt,
        });

        console.log(`[OAuth] Connected Instagram for client: ${clientSlug} (account: @${accountInfo.username})`);
        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px">
                <h2>✅ Instagram Connected!</h2>
                <p><strong>${clientSlug}</strong> is now connected as <strong>@${accountInfo.username}</strong>.</p>
                <p>Chair Filler will post last-minute openings to your Instagram automatically.</p>
            </body></html>
        `);
    } catch (err) {
        console.error(`[OAuth] Instagram token exchange failed: ${err.message}`);
        res.status(500).send(`OAuth failed: ${err.message}`);
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

// Open slots for today and tomorrow
app.get('/slots/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No connection for ${clientSlug}` });

        const slots = await db.getOpenSlots(clientSlug);
        res.json({ clientSlug, total: slots.length, slots });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Recent fill campaigns (posts + texts sent per slot)
app.get('/campaigns/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { limit = 20 } = req.query;

    try {
        const supabase = db.__supabase();
        const { data, error } = await supabase
            .from('open_slots')
            .select('*')
            .eq('client_slug', clientSlug)
            .order('created_at', { ascending: false })
            .limit(parseInt(limit));

        if (error) throw error;
        res.json({ clientSlug, total: (data || []).length, campaigns: data || [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// SMS alert log
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

app.post('/trigger/check-openings', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runCheckOpenings(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/post-instagram', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runPostInstagram(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/text-matches', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runTextMatches(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Trigger all jobs for all clients
app.post('/trigger/all', requireApiKey, async (req, res) => {
    const { job } = req.body; // 'check-openings' | 'post-instagram' | 'text-matches'

    const jobMap = {
        'check-openings': jobs.runCheckOpenings,
        'post-instagram': jobs.runPostInstagram,
        'text-matches':   jobs.runTextMatches,
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

// Morning check — 8am daily: catch same-day openings
cron.schedule('0 8 * * *', async () => {
    console.log('[Cron] Checking same-day openings for all clients...');
    await jobs.runForAllClients(jobs.runCheckOpenings);
}, { timezone: 'America/Chicago' });

// Afternoon check — 4pm daily: next-day openings for evening/tomorrow
cron.schedule('0 16 * * *', async () => {
    console.log('[Cron] Checking next-day openings for all clients...');
    await jobs.runForAllClients(jobs.runCheckOpenings);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3014;
app.listen(PORT, () => {
    console.log(`[ChairFiller] Online — port ${PORT}`);
    console.log(`[ChairFiller] Crons: same-day openings @ 8am | next-day openings @ 4pm`);
});
