/**
 * GRIDHAND Class Optimizer — Main Express Server
 *
 * Fitness industry worker (PORT 3006).
 * Analyzes class attendance patterns, recommends schedule changes,
 * and auto-cancels underperforming classes.
 *
 * Integrations: Mindbody API v6, Google Calendar API, Supabase, Anthropic AI
 *
 * Routes:
 *   GET  /health                                          → status + queue stats
 *   GET  /api/clients                                     → list all clients
 *   POST /api/clients                                     → create/update client config
 *   GET  /api/clients/:slug/classes                       → classes with attendance stats
 *   GET  /api/clients/:slug/attendance                    → recent attendance (?days=30)
 *   GET  /api/clients/:slug/recommendations               → pending recommendations
 *   POST /api/clients/:slug/recommendations/:id/accept    → accept + apply recommendation
 *   POST /api/clients/:slug/recommendations/:id/reject    → reject recommendation
 *   POST /trigger/sync-classes/:slug                      → manually sync class schedule
 *   POST /trigger/analyze/:slug                           → manually run analysis
 *   POST /trigger/auto-cancel/:slug                       → manually run auto-cancellation
 *   POST /trigger/sync-all                                → sync all clients
 *
 * Required environment variables:
 *   SUPABASE_URL                  Supabase project URL
 *   SUPABASE_SERVICE_KEY          Supabase service role key
 *   CO_API_KEY                    API key for protected endpoints (x-api-key header or ?api_key=)
 *   REDIS_HOST                    Redis host (default: 127.0.0.1)
 *   REDIS_PORT                    Redis port (default: 6379)
 *   REDIS_PASSWORD                Redis password (optional)
 *   REDIS_TLS                     Set to "true" for TLS Redis (e.g. Upstash)
 *   ANTHROPIC_API_KEY             Optional — enables AI-enhanced analysis
 *   CO_GOOGLE_SERVICE_ACCOUNT_JSON Optional global Google service account (per-client overrides in DB)
 *   PORT                          Server port (default: 3006)
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const jobs = require('./jobs');
const db   = require('./db');
const cal  = require('./calendar');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Auth Middleware ───────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
    const serverKey = process.env.CO_API_KEY;
    if (!serverKey) {
        return res.status(503).json({ error: 'CO_API_KEY not configured on server' });
    }

    const fromHeader = req.headers['x-api-key'];
    const fromQuery  = req.query.api_key;
    const provided   = fromHeader || fromQuery;

    if (!provided || provided !== serverKey) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
}

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
    try {
        const queueStats = await jobs.getQueueStats();
        res.json({
            status:       'ok',
            worker:       'class-optimizer',
            version:      '1.0.0',
            port:         process.env.PORT || 3006,
            integrations: ['Mindbody API v6', 'Google Calendar API', 'Supabase', 'Anthropic AI'],
            queues:       queueStats,
            crons: [
                'Daily 6am (America/Chicago) — sync class schedules for all clients',
                'Monday 8am (America/Chicago) — weekly analysis + recommendations for all clients',
                'Hourly — auto-cancellation check for all clients',
            ],
        });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// ─── Client Config Endpoints ──────────────────────────────────────────────────

// List all clients (strips sensitive keys)
app.get('/api/clients', requireApiKey, async (req, res) => {
    try {
        const clients = await db.getAllClients();
        const safe = clients.map(({ mindbody_api_key, google_service_account_json, ...rest }) => rest);
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
        googleCalendarId,
        googleServiceAccountJson,
        minAttendanceThreshold,
        cancellationNoticeHours,
        ownerPhone,
    } = req.body;

    if (!clientSlug || !businessName || !mindbodySiteId || !mindbodyApiKey) {
        return res.status(400).json({
            error: 'Required: clientSlug, businessName, mindbodySiteId, mindbodyApiKey',
        });
    }

    try {
        const client = await db.upsertClient({
            clientSlug,
            businessName,
            mindbodySiteId,
            mindbodyApiKey,
            googleCalendarId:          googleCalendarId          || null,
            googleServiceAccountJson:  googleServiceAccountJson  || null,
            minAttendanceThreshold:    minAttendanceThreshold     ?? 3,
            cancellationNoticeHours:   cancellationNoticeHours    ?? 2,
            ownerPhone:                ownerPhone                 || null,
        });

        const { mindbody_api_key, google_service_account_json, ...safe } = client;
        res.json({ success: true, client: safe });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Class Endpoints ──────────────────────────────────────────────────────────

// List classes for a client, enriched with recent attendance stats
app.get('/api/clients/:slug/classes', requireApiKey, async (req, res) => {
    const { slug } = req.params;
    const { activeOnly } = req.query;

    try {
        const client = await db.getClient(slug);
        if (!client) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        const classes = await db.getClassesByClient(client.id, activeOnly === 'true');
        const stats   = await db.getClassAttendanceStats(client.id, 30);

        const statsMap = {};
        for (const s of stats) statsMap[s.classId] = s;

        const enriched = classes.map(cls => ({
            ...cls,
            stats: statsMap[cls.id] || null,
        }));

        res.json({
            slug,
            total:   enriched.length,
            classes: enriched,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Attendance Endpoints ─────────────────────────────────────────────────────

// Recent attendance records for a client
app.get('/api/clients/:slug/attendance', requireApiKey, async (req, res) => {
    const { slug } = req.params;
    const days = parseInt(req.query.days || '30', 10);

    try {
        const client = await db.getClient(slug);
        if (!client) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        const records = await db.getAttendanceByClient(client.id, days);
        res.json({
            slug,
            days,
            total:   records.length,
            records,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Recommendation Endpoints ─────────────────────────────────────────────────

// List recommendations for a client (default: pending only)
app.get('/api/clients/:slug/recommendations', requireApiKey, async (req, res) => {
    const { slug } = req.params;
    const { status } = req.query;

    try {
        const client = await db.getClient(slug);
        if (!client) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        const recs = await db.getRecommendationsByClient(client.id, status || 'pending');
        res.json({ slug, total: recs.length, recommendations: recs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Accept a recommendation and apply it
app.post('/api/clients/:slug/recommendations/:id/accept', requireApiKey, async (req, res) => {
    const { slug, id } = req.params;

    try {
        const client = await db.getClient(slug);
        if (!client) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        const rec = await db.updateRecommendationStatus(id, 'accepted');
        if (!rec) return res.status(404).json({ error: `Recommendation ${id} not found` });

        // Apply the recommendation action
        let applied = false;
        let applicationNote = null;

        if (rec.recommendation_type === 'cancel_class' && rec.class_id) {
            // Deactivate the class in our DB
            await db.deactivateClass(rec.class_id);

            // Delete from Google Calendar if configured
            if (client.google_calendar_id && client.google_service_account_json) {
                const cls = await db.getClassById(rec.class_id);
                if (cls?.google_event_id) {
                    await cal.deleteEvent(
                        client.google_calendar_id,
                        client.google_service_account_json,
                        cls.google_event_id
                    );
                }
            }

            await db.updateRecommendationStatus(id, 'applied');
            applied = true;
            applicationNote = 'Class deactivated in database and removed from Google Calendar.';
        }

        res.json({
            success: true,
            recommendation: rec,
            applied,
            applicationNote,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reject a recommendation
app.post('/api/clients/:slug/recommendations/:id/reject', requireApiKey, async (req, res) => {
    const { slug, id } = req.params;

    try {
        const client = await db.getClient(slug);
        if (!client) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        const rec = await db.updateRecommendationStatus(id, 'rejected');
        if (!rec) return res.status(404).json({ error: `Recommendation ${id} not found` });

        res.json({ success: true, recommendation: rec });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Manual Trigger Endpoints ─────────────────────────────────────────────────

// Manually sync class schedule for one client
app.post('/trigger/sync-classes/:slug', requireApiKey, async (req, res) => {
    const { slug } = req.params;

    try {
        const client = await db.getClient(slug);
        if (!client) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        res.status(200).json({ success: true, message: 'Class sync queued', clientSlug: slug });

        setImmediate(async () => {
            try {
                await jobs.runClassSync(slug);
            } catch (err) {
                console.error(`[Trigger] sync-classes failed for ${slug}: ${err.message}`);
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Manually run attendance analysis + generate recommendations for one client
app.post('/trigger/analyze/:slug', requireApiKey, async (req, res) => {
    const { slug } = req.params;

    try {
        const client = await db.getClient(slug);
        if (!client) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        res.status(200).json({ success: true, message: 'Analysis queued', clientSlug: slug });

        setImmediate(async () => {
            try {
                await jobs.runAttendanceSync(slug);
                await jobs.runAnalysis(slug);
            } catch (err) {
                console.error(`[Trigger] analyze failed for ${slug}: ${err.message}`);
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Manually run auto-cancellation for one client
app.post('/trigger/auto-cancel/:slug', requireApiKey, async (req, res) => {
    const { slug } = req.params;

    try {
        const client = await db.getClient(slug);
        if (!client) return res.status(404).json({ error: `No client found for slug: ${slug}` });

        res.status(200).json({ success: true, message: 'Auto-cancellation queued', clientSlug: slug });

        setImmediate(async () => {
            try {
                await jobs.runAutoCancellation(slug);
            } catch (err) {
                console.error(`[Trigger] auto-cancel failed for ${slug}: ${err.message}`);
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Sync class schedules for all clients
app.post('/trigger/sync-all', requireApiKey, async (req, res) => {
    try {
        res.status(200).json({ success: true, message: 'Sync queued for all clients' });

        setImmediate(async () => {
            try {
                await jobs.runForAllClients(jobs.runClassSync);
            } catch (err) {
                console.error(`[Trigger] sync-all failed: ${err.message}`);
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Cron Schedules ────────────────────────────────────────────────────────────

// Class schedule sync — every day at 6:00am
cron.schedule('0 6 * * *', async () => {
    console.log('[Cron] Syncing class schedules for all clients...');
    try {
        await jobs.runForAllClients(jobs.runClassSync);
    } catch (err) {
        console.error(`[Cron] Class sync failed: ${err.message}`);
    }
}, { timezone: 'America/Chicago' });

// Weekly analysis + recommendations — every Monday at 8:00am
cron.schedule('0 8 * * 1', async () => {
    console.log('[Cron] Running weekly analysis for all clients...');
    try {
        // Sync attendance first, then analyze
        await jobs.runForAllClients(jobs.runAttendanceSync);
        // Small delay to let attendance sync jobs complete before analysis
        setTimeout(async () => {
            await jobs.runForAllClients(jobs.runAnalysis);
        }, 30000);
    } catch (err) {
        console.error(`[Cron] Weekly analysis failed: ${err.message}`);
    }
}, { timezone: 'America/Chicago' });

// Auto-cancellation check — every hour
cron.schedule('0 * * * *', async () => {
    console.log('[Cron] Running auto-cancellation check for all clients...');
    try {
        await jobs.runForAllClients(jobs.runAutoCancellation);
    } catch (err) {
        console.error(`[Cron] Auto-cancellation failed: ${err.message}`);
    }
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3006;
app.listen(PORT, () => {
    console.log(`[ClassOptimizer] Online — port ${PORT}`);
    console.log(`[ClassOptimizer] Crons: class sync @ 6am daily | analysis @ Mon 8am | auto-cancel every hour`);
    console.log(`[ClassOptimizer] Integrations: Mindbody API v6 | Google Calendar API | Supabase | Anthropic AI`);
});
