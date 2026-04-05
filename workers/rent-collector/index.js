/**
 * GRIDHAND Rent Collector — Main Express Server
 *
 * Auto-sends rent reminders, tracks payments via Buildium,
 * initiates late fee process, and sends owner collection reports.
 *
 * Routes:
 *   GET  /                                    → health check
 *   POST /connect                             → save Buildium credentials
 *   GET  /rent/:clientSlug                    → current month rent status
 *   GET  /reports/:clientSlug                 → owner report history
 *   GET  /alerts/:clientSlug                  → SMS history
 *   POST /trigger/sync                        → manually sync payments
 *   POST /trigger/reminders                   → manually send reminders
 *   POST /trigger/late-fee                    → manually run late fee check
 *   POST /trigger/owner-report                → manually send owner report
 *   POST /trigger/all                         → trigger job for all clients
 *
 * Environment vars required:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   QB_CLIENT_ID, QB_CLIENT_SECRET (optional — for QB invoice sync)
 *   QB_SANDBOX=true (optional)
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   REDIS_URL
 *   GRIDHAND_API_KEY
 *   PORT (default: 3014)
 */

'use strict';

const express = require('express');
const cron    = require('node-cron');
const dayjs   = require('dayjs');
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
        worker:  'Rent Collector',
        status:  'online',
        version: '1.0.0',
        jobs:    ['sync-payments', 'send-reminders', 'late-fee-check', 'owner-report'],
        integrations: ['Buildium API', 'Twilio SMS', 'QuickBooks Online v3'],
    });
});

// ─── Connection Setup ─────────────────────────────────────────────────────────

app.post('/connect', requireApiKey, async (req, res) => {
    const { clientSlug, ownerPhone, businessName, buildiumClientId, buildiumClientSecret, lateFeeAmount, lateFeeDay, reminderDaysBefore } = req.body;
    if (!clientSlug || !ownerPhone) return res.status(400).json({ error: 'clientSlug and ownerPhone required' });

    try {
        await db.upsertConnection({
            client_slug:           clientSlug,
            owner_phone:           ownerPhone,
            business_name:         businessName || null,
            buildium_client_id:    buildiumClientId || null,
            buildium_client_secret: buildiumClientSecret || null,
            late_fee_amount:       lateFeeAmount || 50,
            late_fee_days:         lateFeeDay || 5,
            reminder_days_before:  reminderDaysBefore || 3,
        });
        res.json({ success: true, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

app.get('/rent/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    try {
        const conn  = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No connection for ${clientSlug}` });

        const rent  = await db.getCurrentMonthRent(clientSlug);
        const month = dayjs().format('YYYY-MM');

        const totalExpected  = rent.reduce((s, r) => s + parseFloat(r.rent_amount || 0), 0);
        const totalCollected = rent.reduce((s, r) => s + parseFloat(r.amount_paid || 0), 0);

        res.json({
            clientSlug,
            month,
            totalExpected,
            totalCollected,
            collectionRate: totalExpected ? Math.round(totalCollected / totalExpected * 100) : 0,
            leases: rent,
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

app.post('/trigger/sync', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });
    try {
        const job = await jobs.runSyncPayments(clientSlug);
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

app.post('/trigger/late-fee', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });
    try {
        const job = await jobs.runLateFeeCheck(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/owner-report', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });
    try {
        const job = await jobs.runOwnerReport(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/all', requireApiKey, async (req, res) => {
    const { job } = req.body;
    const jobMap = {
        'sync':         jobs.runSyncPayments,
        'reminders':    jobs.runSendReminders,
        'late-fee':     jobs.runLateFeeCheck,
        'owner-report': jobs.runOwnerReport,
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

// Sync payments — daily at 6am and 6pm
cron.schedule('0 6,18 * * *', async () => {
    console.log('[Cron] Syncing rent payments for all clients...');
    await jobs.runForAllClients(jobs.runSyncPayments);
}, { timezone: 'America/Chicago' });

// Send reminders — 9am every day
cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] Sending rent reminders for all clients...');
    await jobs.runForAllClients(jobs.runSendReminders);
}, { timezone: 'America/Chicago' });

// Late fee check — 10am every day
cron.schedule('0 10 * * *', async () => {
    console.log('[Cron] Running late fee checks for all clients...');
    await jobs.runForAllClients(jobs.runLateFeeCheck);
}, { timezone: 'America/Chicago' });

// Owner report — 1st of every month at 8am
cron.schedule('0 8 1 * *', async () => {
    console.log('[Cron] Sending monthly owner reports for all clients...');
    await jobs.runForAllClients(jobs.runOwnerReport);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3014;
app.listen(PORT, () => {
    console.log(`[RentCollector] Online — port ${PORT}`);
    console.log(`[RentCollector] Crons: sync 6am/6pm | reminders 9am | late fee 10am | owner report 1st of month`);
});
