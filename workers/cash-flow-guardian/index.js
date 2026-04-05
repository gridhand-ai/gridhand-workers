/**
 * GRIDHAND Cash Flow Guardian — Main Express Server
 *
 * A standalone microservice. Runs on its own port.
 *
 * Routes:
 *   GET  /                                → health check
 *   GET  /auth/quickbooks?clientSlug=xxx  → start QB OAuth flow
 *   GET  /auth/quickbooks/callback        → QB OAuth callback (exchange code for tokens)
 *   POST /webhooks/quickbooks             → QB real-time event webhook
 *   GET  /cashflow/:clientSlug            → latest snapshot + overdue invoices
 *   GET  /alerts/:clientSlug             → recent alert log
 *   POST /trigger/daily-report            → manually trigger daily report
 *   POST /trigger/invoice-reminders       → manually trigger invoice reminder sweep
 *   POST /trigger/weekly-forecast         → manually trigger weekly forecast
 *   POST /trigger/payment-check           → manually trigger payment detection
 *
 * Environment vars required:
 *   QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REDIRECT_URI
 *   QB_WEBHOOK_VERIFIER_TOKEN  (from QB developer dashboard)
 *   QB_SANDBOX=true            (optional — uses sandbox API)
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   REDIS_URL                  (Bull queue backend)
 *   GRIDHAND_API_KEY           (protects admin endpoints)
 *   PORT                       (default: 3001)
 */

'use strict';

const express = require('express');
const cron    = require('node-cron');
const qb      = require('./quickbooks');
const jobs    = require('./jobs');
const db      = require('./db');

const app = express();

app.use(express.json());

// Raw body needed for webhook signature verification
app.use('/webhooks/quickbooks', express.raw({ type: 'application/json' }));

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
        worker:  'Cash Flow Guardian',
        status:  'online',
        version: '1.0.0',
        jobs: ['daily-report', 'invoice-reminders', 'weekly-forecast', 'payment-check'],
        integrations: ['QuickBooks Online v3', 'Twilio SMS', 'Supabase'],
    });
});

// ─── QuickBooks OAuth Flow ────────────────────────────────────────────────────

// Step 1: Redirect business owner to QuickBooks authorization page
app.get('/auth/quickbooks', (req, res) => {
    const { clientSlug, ownerPhone } = req.query;

    if (!clientSlug || !ownerPhone) {
        return res.status(400).json({ error: 'clientSlug and ownerPhone are required' });
    }

    // Temporarily store ownerPhone in state (base64 encoded)
    const state = Buffer.from(JSON.stringify({ clientSlug, ownerPhone, ts: Date.now() })).toString('base64');

    const { clientId } = (() => {
        const clientId     = process.env.QB_CLIENT_ID;
        const clientSecret = process.env.QB_CLIENT_SECRET;
        if (!clientId || !clientSecret) throw new Error('QB credentials not configured');
        return { clientId, clientSecret };
    })();

    const redirectUri = process.env.QB_REDIRECT_URI;
    const params = new URLSearchParams({
        client_id:     clientId,
        scope:         'com.intuit.quickbooks.accounting',
        redirect_uri:  redirectUri,
        response_type: 'code',
        access_type:   'offline',
        state,
    });

    res.redirect(`https://appcenter.intuit.com/connect/oauth2?${params.toString()}`);
});

// Step 2: QuickBooks redirects back here with the auth code
app.get('/auth/quickbooks/callback', async (req, res) => {
    const { code, state, realmId } = req.query;

    if (!code || !state || !realmId) {
        return res.status(400).send('Missing code, state, or realmId from QuickBooks.');
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
        await qb.exchangeCode({ code, realmId, clientSlug, ownerPhone });
        console.log(`[OAuth] Connected QuickBooks for client: ${clientSlug}`);
        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px">
                <h2>✅ QuickBooks Connected!</h2>
                <p><strong>${clientSlug}</strong> is now connected to QuickBooks Online.</p>
                <p>Cash Flow Guardian will start sending daily SMS reports to ${ownerPhone}.</p>
            </body></html>
        `);
    } catch (err) {
        console.error(`[OAuth] Token exchange failed: ${err.message}`);
        res.status(500).send(`OAuth failed: ${err.message}`);
    }
});

// ─── QuickBooks Webhook ────────────────────────────────────────────────────────

// QB sends real-time events when invoices are updated, paid, etc.
app.post('/webhooks/quickbooks', async (req, res) => {
    const signature = req.headers['intuit-signature'];
    const rawBody   = req.body; // raw Buffer from express.raw()

    if (!qb.verifyWebhookSignature(rawBody, signature)) {
        console.warn('[Webhook] Invalid QB signature — rejected');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    res.status(200).json({ received: true }); // QB requires fast ACK

    let payload;
    try {
        payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
        return;
    }

    // Process each entity in the webhook notification
    setImmediate(async () => {
        try {
            const entities = payload.eventNotifications || [];
            for (const notification of entities) {
                const realmId    = notification.realmId;
                const dataEvents = notification.dataChangeEvent?.entities || [];

                // Find clientSlug by realmId
                const allClients = await db.getAllConnectedClients();
                // Match realmId to client — we query each to find it
                // (In production you'd index realmId → slug)
                for (const { client_slug } of allClients) {
                    const conn = await db.getQBConnection(client_slug);
                    if (conn?.realm_id !== String(realmId)) continue;

                    for (const event of dataEvents) {
                        if (event.name === 'Invoice') {
                            console.log(`[Webhook] Invoice event for ${client_slug}: ${event.operation} id=${event.id}`);
                            // Trigger payment check to pick up status changes
                            await jobs.runPaymentCheck(client_slug);
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`[Webhook] Processing error: ${err.message}`);
        }
    });
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

// Latest cash flow snapshot + overdue invoice list
app.get('/cashflow/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;

    try {
        const conn = await db.getQBConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No QB connection for ${clientSlug}` });

        const [snapshot, openInvoices, history] = await Promise.all([
            db.getLatestSnapshot(clientSlug),
            db.getOpenTrackedInvoices(clientSlug),
            db.getRecentSnapshots(clientSlug, 7),
        ]);

        res.json({
            clientSlug,
            snapshot,
            openInvoices,
            recentHistory: history,
            overdue: openInvoices.filter(i => i.status === 'Overdue'),
        });
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

app.post('/trigger/daily-report', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runDailyReport(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/invoice-reminders', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runInvoiceReminders(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/weekly-forecast', requireApiKey, async (req, res) => {
    const { clientSlug, days = 30 } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runWeeklyForecast(clientSlug, days);
        res.json({ success: true, jobId: job.id, clientSlug, days });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/payment-check', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runPaymentCheck(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Trigger all jobs for all clients (useful for testing)
app.post('/trigger/all', requireApiKey, async (req, res) => {
    const { job } = req.body; // 'daily-report' | 'invoice-reminders' | 'weekly-forecast' | 'payment-check'

    const jobMap = {
        'daily-report':      jobs.runDailyReport,
        'invoice-reminders': jobs.runInvoiceReminders,
        'weekly-forecast':   jobs.runWeeklyForecast,
        'payment-check':     jobs.runPaymentCheck,
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

// Daily report — 8:00am every day
cron.schedule('0 8 * * *', async () => {
    console.log('[Cron] Running daily report for all clients...');
    await jobs.runForAllClients(jobs.runDailyReport);
}, { timezone: 'America/Chicago' });

// Invoice reminders — 9:00am every day
cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] Running invoice reminders for all clients...');
    await jobs.runForAllClients(jobs.runInvoiceReminders);
}, { timezone: 'America/Chicago' });

// Weekly forecast — 8:00am every Monday
cron.schedule('0 8 * * 1', async () => {
    console.log('[Cron] Running weekly forecasts for all clients...');
    await jobs.runForAllClients(jobs.runWeeklyForecast);
}, { timezone: 'America/Chicago' });

// Payment check — every 4 hours
cron.schedule('0 */4 * * *', async () => {
    console.log('[Cron] Running payment check for all clients...');
    await jobs.runForAllClients(jobs.runPaymentCheck);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`[CashFlowGuardian] Online — port ${PORT}`);
    console.log(`[CashFlowGuardian] Crons: daily report @ 8am | invoice reminders @ 9am | forecast @ Mon 8am | payment check every 4h`);
});
