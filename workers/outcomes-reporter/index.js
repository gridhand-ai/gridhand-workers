/**
 * GRIDHAND Outcomes Reporter — Main Express Server
 *
 * Standalone microservice for chiropractic/PT clinics.
 * Auto-generates patient outcome reports for insurance carriers,
 * tracks functional improvements over time, and alerts providers
 * on evals due and milestone improvements.
 *
 * Routes:
 *   GET  /                                   → health check
 *   GET  /outcomes/:clientSlug               → all patient outcomes + score trends
 *   GET  /reports/:clientSlug                → generated reports list
 *   GET  /reports/:clientSlug/:patientId     → full report for a specific patient
 *   GET  /alerts/:clientSlug                 → recent alert log
 *   POST /connect                            → register clinic EHR connection
 *   POST /trigger/eval-sync                  → manually sync evaluations from EHR
 *   POST /trigger/eval-due-check             → manually check for overdue evals
 *   POST /trigger/generate-reports           → manually generate outcome reports
 *   POST /trigger/milestone-check            → manually run milestone detection
 *   POST /trigger/all                        → trigger any job for all clients
 *
 * Environment vars required:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   REDIS_URL                  (Bull queue backend)
 *   GRIDHAND_API_KEY           (protects admin endpoints)
 *   PORT                       (default: 3011)
 */

'use strict';

const express = require('express');
const cron    = require('node-cron');
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
        worker:  'Outcomes Reporter',
        status:  'online',
        version: '1.0.0',
        jobs: ['eval-sync', 'eval-due-check', 'generate-reports', 'milestone-check'],
        integrations: ['WebPT API', 'PROMPT EMR API', 'Twilio SMS', 'Supabase'],
    });
});

// ─── Connect a Clinic ─────────────────────────────────────────────────────────

app.post('/connect', requireApiKey, async (req, res) => {
    const { clientSlug, ehrType, apiKey, apiSecret, accessToken, locationId,
            clinicName, ownerPhone, reportFrequency, autoSendReports, reportRecipientEmail } = req.body;

    if (!clientSlug || !ehrType) {
        return res.status(400).json({ error: 'clientSlug and ehrType are required' });
    }

    try {
        await db.upsertConnection({
            client_slug:             clientSlug,
            ehr_type:                ehrType,
            api_key:                 apiKey || null,
            api_secret:              apiSecret || null,
            access_token:            accessToken || null,
            location_id:             locationId || null,
            clinic_name:             clinicName || clientSlug,
            owner_phone:             ownerPhone || null,
            report_frequency:        reportFrequency || 'monthly',
            auto_send_reports:       autoSendReports || false,
            report_recipient_email:  reportRecipientEmail || null,
        });

        await jobs.runEvalSync(clientSlug);

        res.json({ success: true, clientSlug, message: `${clinicName || clientSlug} connected. Initial eval sync queued.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

app.get('/outcomes/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No connection for ${clientSlug}` });

        const outcomes = await db.getAllPatientOutcomes(clientSlug);
        const evalsDue = await db.getPatientsWithEvalDue(clientSlug);

        res.json({
            clientSlug,
            total:          outcomes.length,
            evalsDue:       evalsDue.length,
            dischargeReady: outcomes.filter(o => o.discharge_ready).length,
            outcomes,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/reports/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { limit = 50 } = req.query;

    try {
        const reports = await db.getRecentReports(clientSlug, parseInt(limit));
        res.json({ clientSlug, total: reports.length, reports });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/reports/:clientSlug/:patientId', requireApiKey, async (req, res) => {
    const { clientSlug, patientId } = req.params;

    try {
        const patient = await db.getPatientOutcome(clientSlug, patientId);
        if (!patient) return res.status(404).json({ error: `No outcome data for patient ${patientId}` });

        const history = await db.getScoreHistory(clientSlug, patientId);
        res.json({ clientSlug, patient, scoreHistory: history });
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

app.post('/trigger/eval-sync', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runEvalSync(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/eval-due-check', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runEvalDueCheck(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/generate-reports', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runGenerateReports(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/milestone-check', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runMilestoneCheck(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/all', requireApiKey, async (req, res) => {
    const { job } = req.body;

    const jobMap = {
        'eval-sync':       jobs.runEvalSync,
        'eval-due-check':  jobs.runEvalDueCheck,
        'generate-reports': jobs.runGenerateReports,
        'milestone-check': jobs.runMilestoneCheck,
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

// Eval sync — 6:00am daily
cron.schedule('0 6 * * *', async () => {
    console.log('[Cron] Running eval sync for all clients...');
    await jobs.runForAllClients(jobs.runEvalSync);
}, { timezone: 'America/Chicago' });

// Eval due check — 9:00am daily
cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] Running eval due check for all clients...');
    await jobs.runForAllClients(jobs.runEvalDueCheck);
}, { timezone: 'America/Chicago' });

// Generate reports — 7:00am Monday and Thursday
cron.schedule('0 7 * * 1,4', async () => {
    console.log('[Cron] Generating outcome reports for all clients...');
    await jobs.runForAllClients(jobs.runGenerateReports);
}, { timezone: 'America/Chicago' });

// Milestone check — after eval sync, 6:30am daily
cron.schedule('30 6 * * *', async () => {
    console.log('[Cron] Running milestone check for all clients...');
    await jobs.runForAllClients(jobs.runMilestoneCheck);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3011;
app.listen(PORT, () => {
    console.log(`[OutcomesReporter] Online — port ${PORT}`);
    console.log(`[OutcomesReporter] Crons: eval-sync @ 6am | milestone-check @ 6:30am | eval-due @ 9am | reports @ Mon/Thu 7am`);
});
