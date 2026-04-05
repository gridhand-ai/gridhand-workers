/**
 * GRIDHAND Churn Blocker — Main Express Server
 *
 * Fitness industry worker. Detects gym/fitness members who haven't
 * visited in 7+ days and sends personalized re-engagement SMS via Twilio.
 * Integrates with the Mindbody API v6 for member + visit data.
 *
 * Routes:
 *   GET  /health                                    → status + queue stats
 *   POST /webhooks/sms                              → Twilio inbound SMS webhook
 *   GET  /api/clients                               → list all active clients
 *   POST /api/clients                               → create / update client config
 *   GET  /api/clients/:slug/members                 → list members (?inactive=true&days=7)
 *   GET  /api/clients/:slug/alerts                  → recent churn alerts
 *   POST /trigger/sync-members/:slug                → manually trigger member sync
 *   POST /trigger/send-reengagement/:slug           → manually trigger re-engagement run
 *   POST /trigger/sync-members-all                  → sync members for all clients
 *
 * Required environment variables:
 *   SUPABASE_URL               Supabase project URL
 *   SUPABASE_SERVICE_KEY       Supabase service role key
 *   GRIDHAND_API_KEY           API key for protected endpoints
 *   REDIS_HOST                 Redis host (default: 127.0.0.1)
 *   REDIS_PORT                 Redis port (default: 6379)
 *   REDIS_PASSWORD             Redis password (optional)
 *   REDIS_TLS                  Set to "true" for TLS Redis (e.g. Upstash)
 *   TWILIO_ACCOUNT_SID         Global Twilio account SID fallback
 *   TWILIO_AUTH_TOKEN          Global Twilio auth token fallback
 *   TWILIO_FROM_NUMBER         Global Twilio from number fallback
 *   PORT                       Server port (default: 3005)
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const jobs = require('./jobs');
const db   = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Auth Middleware ───────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
    const serverKey = process.env.GRIDHAND_API_KEY;
    if (!serverKey) {
        return res.status(503).json({ error: 'GRIDHAND_API_KEY not configured on server' });
    }

    const fromHeader = req.headers['x-api-key'];
    const fromQuery  = req.query.api_key;
    const provided   = fromHeader || fromQuery;

    if (!provided || provided !== serverKey) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
}

// ─── Health Check ──────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
    try {
        const queueStats = await jobs.getQueueStats();
        res.json({
            status:       'ok',
            worker:       'churn-blocker',
            version:      '1.0.0',
            port:         process.env.PORT || 3005,
            integrations: ['Mindbody API v6', 'Twilio SMS', 'Supabase'],
            queues:       queueStats,
            crons: [
                'Daily 9am (America/Chicago) — churn detection for all clients',
                'Sunday 7am (America/Chicago) — member data sync for all clients',
            ],
        });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// ─── Twilio Inbound SMS Webhook ────────────────────────────────────────────────
// Twilio sends a POST here when a member replies to an SMS.
// We must respond 200 immediately and process async.

app.post('/webhooks/sms', (req, res) => {
    // Immediate 200 ACK — Twilio requires fast response
    res.status(200).send('<Response></Response>');

    setImmediate(async () => {
        try {
            const { From: fromPhone, Body: body, To: toNumber } = req.body;

            if (!fromPhone || !body) return;

            console.log(`[Webhook] Inbound SMS from ${fromPhone}: "${body.slice(0, 80)}"`);

            // Find the client that owns this Twilio number
            const allClients = await db.getAllClients();
            const matchedClient = allClients.find(
                c => c.twilio_number === toNumber || process.env.TWILIO_FROM_NUMBER === toNumber
            );

            let clientId = matchedClient?.id || null;
            let memberId = null;

            // Try to match the phone to a known member
            if (clientId) {
                const member = await db.getMemberByPhone(clientId, fromPhone);
                memberId = member?.id || null;
            }

            await db.logResponse({
                clientId,
                memberId,
                phoneNumber: fromPhone,
                body:        body.trim(),
                receivedAt:  new Date().toISOString(),
            });

            console.log(`[Webhook] Response logged — clientId=${clientId} memberId=${memberId}`);
        } catch (err) {
            console.error(`[Webhook] SMS processing error: ${err.message}`);
        }
    });
});

// ─── Client Config Endpoints ──────────────────────────────────────────────────

// List all active client configs
app.get('/api/clients', requireApiKey, async (req, res) => {
    try {
        const clients = await db.getAllClients();
        // Strip sensitive keys from response
        const safe = clients.map(({ mindbody_api_key, twilio_token, ...rest }) => rest);
        res.json({ total: safe.length, clients: safe });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create or update a client config
app.post('/api/clients', requireApiKey, async (req, res) => {
    const {
        clientSlug,
        businessName,
        mindbodySiteId,
        mindbodyApiKey,
        twilioSid,
        twilioToken,
        twilioNumber,
        ownerPhone,
        inactivityThresholdDays,
    } = req.body;

    if (!clientSlug || !businessName || !mindbodySiteId || !mindbodyApiKey || !ownerPhone) {
        return res.status(400).json({
            error: 'Required: clientSlug, businessName, mindbodySiteId, mindbodyApiKey, ownerPhone',
        });
    }

    try {
        const client = await db.upsertClient({
            clientSlug,
            businessName,
            mindbodySiteId,
            mindbodyApiKey,
            twilioSid,
            twilioToken,
            twilioNumber,
            ownerPhone,
            inactivityThresholdDays: inactivityThresholdDays || 7,
        });

        const { mindbody_api_key, twilio_token, ...safe } = client;
        res.json({ success: true, client: safe });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Member Endpoints ─────────────────────────────────────────────────────────

// List members for a client — supports ?inactive=true&days=7
app.get('/api/clients/:slug/members', requireApiKey, async (req, res) => {
    const { slug } = req.params;
    const { inactive, days } = req.query;

    try {
        const conn = await db.getClient(slug);
        if (!conn) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        if (inactive === 'true') {
            const thresholdDays = parseInt(days || conn.inactivity_threshold_days || 7, 10);
            const members = await db.getInactiveMembers(conn.id, thresholdDays);
            return res.json({
                slug,
                thresholdDays,
                total:   members.length,
                members,
            });
        }

        // Return all members
        const { createClient } = require('@supabase/supabase-js');
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        const { data, error } = await sb
            .from('cb_members')
            .select('*')
            .eq('client_id', conn.id)
            .order('last_visit_date', { ascending: false, nullsFirst: false })
            .limit(500);

        if (error) throw error;
        res.json({ slug, total: (data || []).length, members: data || [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Alert Endpoints ──────────────────────────────────────────────────────────

// List recent churn alerts for a client
app.get('/api/clients/:slug/alerts', requireApiKey, async (req, res) => {
    const { slug } = req.params;
    const { limit = 100 } = req.query;

    try {
        const conn = await db.getClient(slug);
        if (!conn) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        const alerts = await db.getRecentAlerts(conn.id, parseInt(limit, 10));
        res.json({ slug, total: alerts.length, alerts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Manual Trigger Endpoints ─────────────────────────────────────────────────

// Sync Mindbody members for a single client
app.post('/trigger/sync-members/:slug', requireApiKey, async (req, res) => {
    const { slug } = req.params;

    try {
        const conn = await db.getClient(slug);
        if (!conn) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        const job = await jobs.scheduleMemberSync(slug);
        res.json({ success: true, jobId: job.id, clientSlug: slug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Run churn detection + send re-engagement SMS for a single client
app.post('/trigger/send-reengagement/:slug', requireApiKey, async (req, res) => {
    const { slug } = req.params;

    try {
        const conn = await db.getClient(slug);
        if (!conn) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        const job = await jobs.scheduleChurnDetect(slug);
        res.json({ success: true, jobId: job.id, clientSlug: slug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Sync members for all active clients
app.post('/trigger/sync-members-all', requireApiKey, async (req, res) => {
    try {
        const results = await jobs.runForAllClients(jobs.scheduleMemberSync);
        res.json({ success: true, queued: results.length, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Cron Schedules ────────────────────────────────────────────────────────────

// Churn detection — 9:00am every day
cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] Running churn detection for all clients...');
    try {
        await jobs.runForAllClients(jobs.scheduleChurnDetect);
    } catch (err) {
        console.error(`[Cron] Churn detection failed: ${err.message}`);
    }
}, { timezone: 'America/Chicago' });

// Member sync — every Sunday at 7:00am
cron.schedule('0 7 * * 0', async () => {
    console.log('[Cron] Running member sync for all clients...');
    try {
        await jobs.runForAllClients(jobs.scheduleMemberSync);
    } catch (err) {
        console.error(`[Cron] Member sync failed: ${err.message}`);
    }
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3005;
app.listen(PORT, () => {
    console.log(`[ChurnBlocker] Online — port ${PORT}`);
    console.log(`[ChurnBlocker] Crons: churn detect @ 9am daily | member sync @ Sun 7am`);
    console.log(`[ChurnBlocker] Integrations: Mindbody API v6 | Twilio SMS | Supabase`);
});
