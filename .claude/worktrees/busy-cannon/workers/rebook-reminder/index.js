/**
 * GRIDHAND Rebook Reminder — Main Express Server
 *
 * A standalone microservice. Runs on its own port.
 *
 * Routes:
 *   GET  /                                         → health check
 *   GET  /auth/boulevard?clientSlug=&ownerPhone=   → Boulevard OAuth start
 *   GET  /auth/boulevard/callback                  → token exchange
 *   GET  /clients/:clientSlug                      → list clients with rebook intervals and overdue status
 *   GET  /overdue/:clientSlug                      → clients overdue for rebooking (paginated)
 *   GET  /alerts/:clientSlug                       → recent SMS log
 *   POST /sms/inbound                              → handle replies (YES to book, STOP to opt out)
 *   POST /trigger/rebook-scan                      → manually trigger rebook scan
 *   POST /trigger/sync-clients                     → manually trigger client sync from booking system
 *   POST /trigger/all                              → trigger all jobs for all clients
 *
 * Environment vars required:
 *   BOULEVARD_API_KEY, BOULEVARD_BUSINESS_ID
 *   SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID
 *   BOOKING_SYSTEM                (boulevard or square)
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   REDIS_URL                     (Bull queue backend)
 *   GRIDHAND_API_KEY              (protects admin endpoints)
 *   PORT                          (default: 3013)
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
        worker:       'Rebook Reminder',
        status:       'online',
        version:      '1.0.0',
        jobs:         ['rebook-scan', 'sync-clients'],
        integrations: ['Boulevard API', 'Square Appointments API', 'Twilio SMS', 'Supabase'],
    });
});

// ─── Boulevard OAuth Flow ─────────────────────────────────────────────────────

// Step 1: Redirect salon owner to Boulevard authorization page
app.get('/auth/boulevard', (req, res) => {
    const { clientSlug, ownerPhone } = req.query;

    if (!clientSlug || !ownerPhone) {
        return res.status(400).json({ error: 'clientSlug and ownerPhone are required' });
    }

    const apiKey = process.env.BOULEVARD_API_KEY;
    const businessId = process.env.BOULEVARD_BUSINESS_ID;

    if (!apiKey || !businessId) {
        return res.status(503).json({ error: 'BOULEVARD_API_KEY and BOULEVARD_BUSINESS_ID not configured' });
    }

    // Store state for callback
    const state = Buffer.from(JSON.stringify({ clientSlug, ownerPhone, ts: Date.now() })).toString('base64');

    // Boulevard uses API key auth (not OAuth for most endpoints), so we
    // record the connection directly and confirm to the owner
    // In a full OAuth implementation this would redirect to Boulevard's auth page
    res.send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
            <h2>Boulevard Connection</h2>
            <p>Connecting <strong>${clientSlug}</strong> to Boulevard using the configured API key.</p>
            <p><a href="/auth/boulevard/callback?state=${encodeURIComponent(state)}">Complete Connection →</a></p>
        </body></html>
    `);
});

// Step 2: Complete Boulevard connection
app.get('/auth/boulevard/callback', async (req, res) => {
    const { state } = req.query;

    if (!state) {
        return res.status(400).send('Missing state parameter.');
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
        await db.upsertConnection({
            clientSlug,
            bookingSystem:     'boulevard',
            boulevardApiKey:   process.env.BOULEVARD_API_KEY,
            boulevardBusinessId: process.env.BOULEVARD_BUSINESS_ID,
            ownerPhone,
        });

        console.log(`[OAuth] Connected Boulevard for client: ${clientSlug}`);
        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px">
                <h2>✅ Boulevard Connected!</h2>
                <p><strong>${clientSlug}</strong> is now connected to Boulevard.</p>
                <p>Rebook Reminder will sync clients and send rebooking reminders automatically.</p>
            </body></html>
        `);
    } catch (err) {
        console.error(`[OAuth] Connection failed: ${err.message}`);
        res.status(500).send(`Connection failed: ${err.message}`);
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

// List clients with rebook intervals and overdue status
app.get('/clients/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { limit = 100, offset = 0 } = req.query;

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No connection for ${clientSlug}` });

        const { data, error } = await (async () => {
            const supabase = require('./db').__supabase();
            const { data, error } = await supabase
                .from('salon_clients')
                .select('*')
                .eq('client_slug', clientSlug)
                .eq('opted_out', false)
                .order('last_visit_date', { ascending: false })
                .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
            return { data, error };
        })();

        if (error) throw error;

        const clients = (data || []).map(c => ({
            ...c,
            is_overdue: c.overdue_days > 0,
            days_until_due: c.avg_rebook_days > 0
                ? c.avg_rebook_days - Math.floor((Date.now() - new Date(c.last_visit_date)) / 86400000)
                : null,
        }));

        res.json({ clientSlug, total: clients.length, clients });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Clients who are overdue for rebooking
app.get('/overdue/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    try {
        const conn = await db.getConnection(clientSlug);
        if (!conn) return res.status(404).json({ error: `No connection for ${clientSlug}` });

        const overdue = await db.getOverdueClients(clientSlug, parseInt(limit), parseInt(offset));
        res.json({ clientSlug, total: overdue.length, overdue });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Recent SMS alert log
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

// ─── Inbound SMS Handler ───────────────────────────────────────────────────────

// Twilio posts here when a client replies to a reminder
app.post('/sms/inbound', async (req, res) => {
    const { From: fromPhone, Body: body } = req.body;
    const reply = (body || '').trim().toUpperCase();

    console.log(`[SMS Inbound] From ${fromPhone}: "${body}"`);

    try {
        if (reply === 'STOP' || reply === 'UNSUBSCRIBE') {
            // Opt out client across all slugs matching this phone
            const supabase = require('./db').__supabase();
            await supabase
                .from('salon_clients')
                .update({ opted_out: true, updated_at: new Date().toISOString() })
                .eq('phone', fromPhone);

            console.log(`[SMS Inbound] Opted out: ${fromPhone}`);
        } else if (reply === 'YES') {
            // Find the client's salon connection and log intent to book
            const supabase = require('./db').__supabase();
            const { data: clients } = await supabase
                .from('salon_clients')
                .select('client_slug, name')
                .eq('phone', fromPhone)
                .limit(1)
                .single();

            if (clients) {
                const conn = await db.getConnection(clients.client_slug);
                if (conn) {
                    const sms = require('./sms');
                    await sms.sendConfirmation(conn, {
                        clientPhone: fromPhone,
                        clientName:  clients.name,
                        salonName:   conn.salon_name,
                    });
                }
            }
        }

        // Twilio expects TwiML response
        res.set('Content-Type', 'text/xml');
        res.send('<Response></Response>');
    } catch (err) {
        console.error(`[SMS Inbound] Error handling reply from ${fromPhone}: ${err.message}`);
        res.set('Content-Type', 'text/xml');
        res.send('<Response></Response>');
    }
});

// ─── Manual Trigger Endpoints ─────────────────────────────────────────────────

app.post('/trigger/rebook-scan', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runRebookScan(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/sync-clients', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runSyncClients(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Trigger all jobs for all clients
app.post('/trigger/all', requireApiKey, async (req, res) => {
    const { job } = req.body; // 'rebook-scan' | 'sync-clients'

    const jobMap = {
        'rebook-scan':   jobs.runRebookScan,
        'sync-clients':  jobs.runSyncClients,
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

// Rebook scan — 10am every Tuesday and Thursday
cron.schedule('0 10 * * 2,4', async () => {
    console.log('[Cron] Running rebook scan for all clients...');
    await jobs.runForAllClients(jobs.runRebookScan);
}, { timezone: 'America/Chicago' });

// Sync clients — 3am every Sunday
cron.schedule('0 3 * * 0', async () => {
    console.log('[Cron] Syncing client data for all clients...');
    await jobs.runForAllClients(jobs.runSyncClients);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3013;
app.listen(PORT, () => {
    console.log(`[RebookReminder] Online — port ${PORT}`);
    console.log(`[RebookReminder] Crons: rebook scan @ 10am Tue/Thu | client sync @ Sun 3am`);
});
