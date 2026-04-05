/**
 * GRIDHAND Vaccine Reminder — Main Express Server
 *
 * A standalone microservice. Runs on its own port.
 *
 * Routes:
 *   GET  /                                  → health check
 *   GET  /patients/:clientSlug              → patients with upcoming/overdue vaccines
 *   GET  /reminders/:clientSlug             → recent reminders sent
 *   GET  /alerts/:clientSlug                → full alert log
 *   POST /sms/inbound                       → Twilio webhook for inbound SMS replies
 *   POST /trigger/vaccine-check             → scan for due/overdue vaccines, send reminders
 *   POST /trigger/booking-confirmations     → send appointment confirmation SMS
 *   POST /trigger/all                       → trigger all jobs for all clients
 *
 * Environment vars required:
 *   EVET_BASE_URL          (eVetPractice API base URL)
 *   EVET_API_KEY           (eVetPractice API key)
 *   PETDESK_API_KEY        (PetDesk API key)
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   REDIS_URL              (Bull queue backend)
 *   GRIDHAND_API_KEY       (protects admin endpoints)
 *   PORT                   (default: 3011)
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
        worker:  'Vaccine Reminder',
        status:  'online',
        version: '1.0.0',
        jobs: ['vaccine-check', 'booking-confirmation'],
        integrations: ['eVetPractice API', 'PetDesk API', 'Twilio SMS', 'Supabase'],
    });
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

// Patients with upcoming or overdue vaccines
app.get('/patients/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { status } = req.query; // optional: 'due_soon' | 'overdue_mild' | 'overdue_serious' | 'critical'

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No vet connection for ${clientSlug}` });

        const reminders = await db.getUpcomingReminders(clientSlug, status || null);
        res.json({ clientSlug, total: reminders.length, reminders });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Recent reminders sent
app.get('/reminders/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { limit = 50 } = req.query;

    try {
        const reminders = await db.getUpcomingReminders(clientSlug, null, parseInt(limit));
        res.json({ clientSlug, total: reminders.length, reminders });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Full alert log
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

// Handles client replies to vaccine reminder texts.
// Twilio sends a POST with From, Body, etc.
// If owner replies "YES" — queue a booking confirmation.
app.post('/sms/inbound', async (req, res) => {
    const { From: ownerPhone, Body: body } = req.body;

    console.log(`[SMS Inbound] From ${ownerPhone}: "${body}"`);

    const reply = (body || '').trim().toUpperCase();

    if (reply === 'YES' || reply === 'Y') {
        // Find the most recent pending reminder for this phone number
        try {
            const reminder = await db.getMostRecentPendingReminder(ownerPhone);
            if (reminder) {
                await jobs.runBookingConfirmation({
                    clientSlug:  reminder.client_slug,
                    ownerPhone,
                    petName:     reminder.patient_name,
                    vaccineName: reminder.vaccine_name,
                    // appointmentDate not known yet — practice will confirm
                    appointmentDate: null,
                });
                console.log(`[SMS Inbound] Booking queued for ${ownerPhone} — ${reminder.patient_name}`);
            } else {
                console.log(`[SMS Inbound] No pending reminder found for ${ownerPhone}`);
            }
        } catch (err) {
            console.error(`[SMS Inbound] Error processing YES reply: ${err.message}`);
        }
    }

    // Always respond with empty TwiML so Twilio is satisfied
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');
});

// ─── Manual Trigger Endpoints ─────────────────────────────────────────────────

app.post('/trigger/vaccine-check', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runVaccineCheck(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/booking-confirmations', requireApiKey, async (req, res) => {
    const { clientSlug, ownerPhone, petName, vaccineName, appointmentDate } = req.body;
    if (!clientSlug || !ownerPhone || !petName) {
        return res.status(400).json({ error: 'clientSlug, ownerPhone, and petName required' });
    }

    try {
        const job = await jobs.runBookingConfirmation({ clientSlug, ownerPhone, petName, vaccineName, appointmentDate });
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Trigger vaccine-check across all clients
app.post('/trigger/all', requireApiKey, async (req, res) => {
    const { job } = req.body; // 'vaccine-check'

    const jobMap = {
        'vaccine-check': jobs.runVaccineCheck,
    };

    if (job && !jobMap[job]) return res.status(400).json({ error: `Unknown job: ${job}` });

    try {
        const runFn = job ? jobMap[job] : jobs.runVaccineCheck;
        const results = await jobs.runForAllClients(runFn);
        res.json({ success: true, queued: results.length, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Cron Schedules ────────────────────────────────────────────────────────────

// Weekly vaccine reminder sweep — 9am every Monday
cron.schedule('0 9 * * 1', async () => {
    console.log('[Cron] Running weekly vaccine reminder sweep for all clients...');
    await jobs.runForAllClients(jobs.runVaccineCheck);
}, { timezone: 'America/Chicago' });

// Daily critical overdue check — 9am every day
// Sends urgent reminders for vaccines 90+ days overdue
cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] Running daily critical overdue vaccine check for all clients...');
    await jobs.runForAllClients(jobs.runCriticalOverdueCheck);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3011;
app.listen(PORT, () => {
    console.log(`[VaccineReminder] Online — port ${PORT}`);
    console.log(`[VaccineReminder] Crons: weekly sweep @ Mon 9am | critical overdue check @ 9am daily`);
});
