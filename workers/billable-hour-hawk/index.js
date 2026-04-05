/**
 * GRIDHAND Billable Hour Hawk — Main Express Server
 *
 * Law firm billing intelligence worker. Connects to Clio or Rocket Matter,
 * monitors attorney time entries in real time, flags unbilled work, auto-generates
 * invoice drafts, tracks realization rates, and sends weekly billing summaries.
 *
 * Routes:
 *   POST /webhook/clio                         → Clio real-time time-entry webhooks
 *   POST /webhook/rocketmatter                 → Rocket Matter webhooks
 *   GET  /auth/clio                            → Start Clio OAuth2 flow
 *   GET  /auth/clio/callback                   → Clio OAuth2 callback
 *   POST /trigger/scan-unbilled                → Manually trigger unbilled scan
 *   POST /trigger/generate-invoices            → Manually trigger invoice draft generation
 *   POST /trigger/weekly-summary               → Manually trigger weekly summary
 *   GET  /clients/:clientSlug/billing-summary  → Latest billing snapshot
 *   GET  /clients/:clientSlug/unbilled         → Current unbilled entries
 *   GET  /health                               → Health check
 *
 * Environment variables required:
 *   CLIO_CLIENT_ID, CLIO_CLIENT_SECRET, CLIO_REDIRECT_URI
 *   CLIO_WEBHOOK_SECRET     (to verify webhook signatures)
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   REDIS_URL               (Bull queue backend — default: redis://localhost:6379)
 *   GRIDHAND_API_KEY        (protects all admin/trigger/data endpoints)
 *   PORT                    (default: 3006)
 */

'use strict';

require('dotenv').config();

const express = require('express');
const crypto  = require('crypto');
const cron    = require('node-cron');
const dayjs   = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

const billingApi = require('./billing-api');
const tracker    = require('./tracker');
const invoicing  = require('./invoicing');
const jobs       = require('./jobs');

// ─── App & Supabase ───────────────────────────────────────────────────────────

const app      = express();
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Parse JSON for all routes except webhook (needs raw body for signature checks)
app.use((req, res, next) => {
    if (req.path.startsWith('/webhook/')) {
        express.raw({ type: '*/*' })(req, res, next);
    } else {
        express.json()(req, res, next);
    }
});

// ─── Auth Middleware ───────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
    const serverKey = process.env.GRIDHAND_API_KEY;
    if (!serverKey) return res.status(503).json({ error: 'GRIDHAND_API_KEY not configured' });
    const provided = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (provided !== serverKey) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({
        worker:       'Billable Hour Hawk',
        status:       'online',
        version:      '1.0.0',
        port:         process.env.PORT || 3006,
        integrations: ['Clio v4', 'Rocket Matter v1', 'Twilio SMS', 'Supabase'],
        jobs: [
            'scan-unbilled (daily 8am)',
            'check-retainers (daily 8am)',
            'attorney-reminder (daily 5pm)',
            'weekly-summary (Friday 4pm)',
            'generate-invoice-drafts (1st of month 9am)',
        ],
        timestamp: new Date().toISOString(),
    });
});

// ─── Clio OAuth2 Flow ─────────────────────────────────────────────────────────

// Step 1: Redirect firm admin to Clio authorization page
app.get('/auth/clio', (req, res) => {
    const { clientSlug, managingPartnerPhone, billingContactPhone } = req.query;

    if (!clientSlug) {
        return res.status(400).json({ error: 'clientSlug is required' });
    }

    try {
        // Encode extra params in state so the callback can save them
        const state = Buffer.from(JSON.stringify({
            clientSlug,
            managingPartnerPhone: managingPartnerPhone || null,
            billingContactPhone:  billingContactPhone  || null,
            ts: Date.now(),
        })).toString('base64');

        // Temporarily stash state for CSRF protection — Clio returns it in callback
        const authUrl = billingApi.getAuthUrl(clientSlug);
        // Replace the state param generated inside getAuthUrl with ours (which has extra data)
        const url = new URL(authUrl);
        url.searchParams.set('state', state);

        res.redirect(url.toString());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Step 2: Clio redirects back with the authorization code
app.get('/auth/clio/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
        return res.status(400).send(`Clio authorization denied: ${oauthError}`);
    }

    if (!code || !state) {
        return res.status(400).send('Missing code or state from Clio.');
    }

    let clientSlug, managingPartnerPhone, billingContactPhone;
    try {
        const decoded       = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
        clientSlug          = decoded.clientSlug;
        managingPartnerPhone = decoded.managingPartnerPhone;
        billingContactPhone  = decoded.billingContactPhone;
    } catch {
        return res.status(400).send('Invalid state parameter.');
    }

    try {
        await billingApi.exchangeCode(code, clientSlug);

        // Update connection record with phone numbers if provided
        if (managingPartnerPhone || billingContactPhone) {
            const updates = {};
            if (managingPartnerPhone) updates.managing_partner_phone = managingPartnerPhone;
            if (billingContactPhone)  updates.billing_contact_phone  = billingContactPhone;
            await supabase.from('hawk_connections').update(updates).eq('client_slug', clientSlug);
        }

        console.log(`[OAuth] Clio connected for ${clientSlug}`);

        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#09090b;color:#f4f4f5">
                <h2 style="color:#22d3ee">Clio Connected!</h2>
                <p><strong>${clientSlug}</strong> is now connected to Clio.</p>
                <p>Billable Hour Hawk will begin monitoring time entries and sending billing alerts.</p>
            </body></html>
        `);
    } catch (err) {
        console.error(`[OAuth] Clio token exchange failed: ${err.message}`);
        res.status(500).send(`OAuth failed: ${err.message}`);
    }
});

// ─── Clio Webhook ─────────────────────────────────────────────────────────────

// Clio sends real-time events when time entries are created/updated
app.post('/webhook/clio', async (req, res) => {
    // Verify webhook signature if secret is configured
    const secret = process.env.CLIO_WEBHOOK_SECRET;
    if (secret) {
        const signature = req.headers['x-clio-signature'] || '';
        const rawBody   = req.body;
        const expected  = crypto
            .createHmac('sha256', secret)
            .update(rawBody)
            .digest('hex');

        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
            console.warn('[Webhook/Clio] Invalid signature — rejected');
            return res.status(401).json({ error: 'Invalid signature' });
        }
    }

    // ACK immediately — Clio requires a fast response
    res.status(200).json({ received: true });

    let payload;
    try {
        payload = JSON.parse(req.body.toString('utf8'));
    } catch {
        return; // malformed JSON — ignore
    }

    setImmediate(async () => {
        try {
            const event      = payload.event || {};
            const entityType = event.entity_type || '';
            const clientSlug = event.client_slug  || payload.client_slug;

            if (!clientSlug) {
                console.warn('[Webhook/Clio] No clientSlug in payload — cannot route');
                return;
            }

            // When time entries are created or updated, run a targeted unbilled scan
            if (['ActivityTimeEntry', 'Activity'].includes(entityType)) {
                console.log(`[Webhook/Clio] Time entry event for ${clientSlug} — triggering scan`);
                await jobs.runScanUnbilled(clientSlug);
            }
        } catch (err) {
            console.error(`[Webhook/Clio] Processing error: ${err.message}`);
        }
    });
});

// ─── Rocket Matter Webhook ────────────────────────────────────────────────────

app.post('/webhook/rocketmatter', async (req, res) => {
    // Rocket Matter uses API key in header for webhook auth
    const apiKey   = req.headers['x-api-key'] || req.headers['authorization'];
    const expected = process.env.RM_WEBHOOK_SECRET;

    if (expected && apiKey !== expected) {
        console.warn('[Webhook/RM] Invalid API key — rejected');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    res.status(200).json({ received: true });

    let payload;
    try {
        payload = JSON.parse(req.body.toString('utf8'));
    } catch {
        return;
    }

    setImmediate(async () => {
        try {
            const clientSlug = payload.client_slug || payload.firm_slug;
            const eventType  = payload.event || payload.type || '';

            if (!clientSlug) {
                console.warn('[Webhook/RM] No clientSlug — cannot route');
                return;
            }

            if (eventType.includes('time_entry') || eventType.includes('TimeEntry')) {
                console.log(`[Webhook/RM] Time entry event for ${clientSlug} — triggering scan`);
                await jobs.runScanUnbilled(clientSlug);
            }
        } catch (err) {
            console.error(`[Webhook/RM] Processing error: ${err.message}`);
        }
    });
});

// ─── Manual Trigger Endpoints ─────────────────────────────────────────────────

// Scan unbilled work for a client
app.post('/trigger/scan-unbilled', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runScanUnbilled(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug, type: 'scan-unbilled' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Generate invoice drafts for a client (optionally specify month)
app.post('/trigger/generate-invoices', requireApiKey, async (req, res) => {
    const { clientSlug, month } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runGenerateInvoiceDrafts(clientSlug, month || null);
        res.json({ success: true, jobId: job.id, clientSlug, month: month || dayjs().subtract(1, 'month').format('YYYY-MM') });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Send weekly billing summary for a client
app.post('/trigger/weekly-summary', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runWeeklySummary(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug, type: 'weekly-summary' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

// Latest billing snapshot for a client
app.get('/clients/:clientSlug/billing-summary', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { month } = req.query;  // optional: 'YYYY-MM'

    try {
        const targetMonth = month || dayjs().format('YYYY-MM');
        const snapshot    = await tracker.summarizeBillingPeriod(clientSlug, targetMonth);

        // Also pull attorney stats for the month
        const period = {
            start: dayjs(targetMonth, 'YYYY-MM').startOf('month').format('YYYY-MM-DD'),
            end:   dayjs(targetMonth, 'YYYY-MM').endOf('month').format('YYYY-MM-DD'),
        };
        const attorneyStats = await tracker.calculateAttorneyStats(clientSlug, period);

        // Recent snapshots for trend
        const { data: history } = await supabase
            .from('billing_snapshots')
            .select('*')
            .eq('client_slug', clientSlug)
            .order('snapshot_date', { ascending: false })
            .limit(6);

        res.json({
            clientSlug,
            month:        targetMonth,
            snapshot,
            attorneys:    attorneyStats,
            recentHistory: history || [],
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Current unbilled time entries for a client
app.get('/clients/:clientSlug/unbilled', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { flaggedOnly } = req.query;

    try {
        const { entries } = await tracker.scanUnbilledWork(clientSlug);
        const conn = await tracker.getConnection(clientSlug);
        const threshold = conn.unbilled_flag_days || 30;

        const result = entries.map(e => ({
            ...e,
            flagged:      tracker.flagUnbilledEntry(e, threshold),
            days_unbilled: dayjs().diff(dayjs(e.entry_date), 'day'),
        }));

        const filtered = flaggedOnly === 'true'
            ? result.filter(e => e.flagged)
            : result;

        // Sort: flagged first, then by days unbilled descending
        filtered.sort((a, b) => {
            if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
            return b.days_unbilled - a.days_unbilled;
        });

        res.json({
            clientSlug,
            total:       entries.length,
            flagged:     result.filter(e => e.flagged).length,
            entries:     filtered,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Cron Schedules ───────────────────────────────────────────────────────────

const TIMEZONE = 'America/Chicago';

// 8am daily — scan unbilled work + check retainer limits
cron.schedule('0 8 * * *', async () => {
    console.log('[Cron] 8am daily — scanning unbilled work and retainer limits for all clients');
    await jobs.runForAllClients(jobs.runScanUnbilled);
    await jobs.runForAllClients(jobs.runCheckRetainers);
}, { timezone: TIMEZONE });

// 5pm daily — remind attorneys who haven't logged time today
cron.schedule('0 17 * * *', async () => {
    console.log('[Cron] 5pm daily — attorney time-entry reminders');
    await jobs.runForAllClients(jobs.runAttorneyReminder);
}, { timezone: TIMEZONE });

// Friday 4pm — weekly billing summary to managing partner
cron.schedule('0 16 * * 5', async () => {
    console.log('[Cron] Friday 4pm — weekly billing summary');
    await jobs.runForAllClients(jobs.runWeeklySummary);
}, { timezone: TIMEZONE });

// 1st of month at 9am — generate invoice drafts for previous month's unbilled work
cron.schedule('0 9 1 * *', async () => {
    const prevMonth = dayjs().subtract(1, 'month').format('YYYY-MM');
    console.log(`[Cron] 1st of month 9am — generating invoice drafts for ${prevMonth}`);
    await jobs.runForAllClients((slug) => jobs.runGenerateInvoiceDrafts(slug, prevMonth));
}, { timezone: TIMEZONE });

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3006;

app.listen(PORT, () => {
    console.log(`[BillableHourHawk] Online — port ${PORT}`);
    console.log(`[BillableHourHawk] Crons:`);
    console.log(`  8am daily       → scan unbilled work + retainer checks`);
    console.log(`  5pm daily       → attorney time-entry reminders`);
    console.log(`  Friday 4pm      → weekly billing summary`);
    console.log(`  1st of month 9am → auto-generate invoice drafts`);
});
