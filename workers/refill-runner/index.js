/**
 * GRIDHAND Refill Runner — Main Express Server
 *
 * A standalone microservice. Runs on its own port.
 *
 * Routes:
 *   GET  /                              → health check
 *   GET  /prescriptions/:clientSlug     → active prescriptions with next refill dates
 *   GET  /refills/:clientSlug           → recent refill activity
 *   GET  /alerts/:clientSlug            → SMS log
 *   POST /sms/inbound                   → Twilio webhook — handle client SMS replies (YES to approve refill)
 *   POST /trigger/refill-check          → scan all prescriptions, send reminders for those due
 *   POST /trigger/process-refills       → process approved refill requests through Vetsource
 *   POST /trigger/all                   → trigger all jobs for all clients
 *
 * Environment vars required:
 *   EVET_BASE_URL            (eVetPractice API base URL)
 *   EVET_API_KEY             (eVetPractice API key)
 *   VETSOURCE_API_KEY        (Vetsource pharmacy API key)
 *   VETSOURCE_PRACTICE_ID    (Vetsource practice identifier)
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   REDIS_URL                (Bull queue backend)
 *   GRIDHAND_API_KEY         (protects admin endpoints)
 *   PORT                     (default: 3012)
 */

'use strict';

const express = require('express');
const cron    = require('node-cron');
const jobs    = require('./jobs');
const db      = require('./db');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // needed for Twilio webhook form posts

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
        worker:  'Refill Runner',
        status:  'online',
        version: '1.0.0',
        jobs: ['refill-check', 'process-refills'],
        integrations: ['eVetPractice API', 'Vetsource API', 'Twilio SMS', 'Supabase'],
    });
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

// Active prescriptions with next refill dates
app.get('/prescriptions/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { status } = req.query; // optional: 'active' | 'pending_reminder' | 'approved' | 'processing' | 'completed'

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No refill connection for ${clientSlug}` });

        const prescriptions = status
            ? await db.getPrescriptionsByStatus(clientSlug, status)
            : await db.getPrescriptionsDueSoon(clientSlug, 30);

        res.json({ clientSlug, total: prescriptions.length, prescriptions });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Recent refill activity
app.get('/refills/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { limit = 50 } = req.query;

    try {
        const refills = await db.getApprovedRefills(clientSlug, parseInt(limit));
        res.json({ clientSlug, total: refills.length, refills });
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

// ─── Twilio Inbound SMS Webhook ────────────────────────────────────────────────

// Client replies "YES" to a refill reminder → mark prescription as approved
// and queue it for Vetsource processing.
app.post('/sms/inbound', async (req, res) => {
    const { From: ownerPhone, Body: body } = req.body;

    console.log(`[SMS Inbound] From ${ownerPhone}: "${body}"`);

    const reply = (body || '').trim().toUpperCase();

    if (reply === 'YES' || reply === 'Y') {
        try {
            // Find the most recent prescription waiting for approval for this phone
            const prescription = await db.getMostRecentPendingPrescription(ownerPhone);
            if (prescription) {
                await db.updatePrescriptionStatus(prescription.client_slug, prescription.prescription_id, 'approved', {
                    approvedAt: new Date().toISOString(),
                });
                // Queue for Vetsource processing right away
                await jobs.runProcessRefills(prescription.client_slug);
                console.log(`[SMS Inbound] Approved refill for ${ownerPhone} — Rx ${prescription.prescription_id}`);
            } else {
                console.log(`[SMS Inbound] No pending prescription found for ${ownerPhone}`);
            }
        } catch (err) {
            console.error(`[SMS Inbound] Error processing YES reply: ${err.message}`);
        }
    }

    // Always return empty TwiML
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');
});

// ─── Manual Trigger Endpoints ─────────────────────────────────────────────────

app.post('/trigger/refill-check', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runRefillCheck(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/process-refills', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runProcessRefills(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Trigger all jobs for all clients
app.post('/trigger/all', requireApiKey, async (req, res) => {
    const { job } = req.body; // 'refill-check' | 'process-refills'

    const jobMap = {
        'refill-check':    jobs.runRefillCheck,
        'process-refills': jobs.runProcessRefills,
    };

    if (job && !jobMap[job]) return res.status(400).json({ error: `Unknown job: ${job}` });

    try {
        const runFn = job ? jobMap[job] : jobs.runRefillCheck;
        const results = await jobs.runForAllClients(runFn);
        res.json({ success: true, queued: results.length, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Cron Schedules ────────────────────────────────────────────────────────────

// Refill check — 9am Tuesday and Friday (twice weekly)
cron.schedule('0 9 * * 2,5', async () => {
    console.log('[Cron] Running refill check for all clients...');
    await jobs.runForAllClients(jobs.runRefillCheck);
}, { timezone: 'America/Chicago' });

// Process approved refills — 10am daily
cron.schedule('0 10 * * *', async () => {
    console.log('[Cron] Processing pending approved refills for all clients...');
    await jobs.runForAllClients(jobs.runProcessRefills);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3012;
app.listen(PORT, () => {
    console.log(`[RefillRunner] Online — port ${PORT}`);
    console.log(`[RefillRunner] Crons: refill check @ Tue+Fri 9am | process refills @ 10am daily`);
});
