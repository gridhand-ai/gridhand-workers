// Bay Boss — GRIDHAND AI Shop Scheduling & Bay Management Worker
// Standalone Express server — connects to Tekmetric, Google Calendar, Supabase
// Sends SMS alerts to shop owner via Twilio
//
// ENV VARS (copy to .env):
//   PORT                        (default: 3001)
//   REDIS_URL                   (default: redis://127.0.0.1:6379)
//   ANTHROPIC_API_KEY
//   TEKMETRIC_API_KEY
//   TEKMETRIC_SHOP_ID
//   TEKMETRIC_TOTAL_BAYS        (default: 6)
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM_NUMBER
//   OWNER_PHONE                 (e.g. +14145550000)
//   GOOGLE_CLIENT_ID            (optional — for calendar integration)
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN
//   GOOGLE_SERVICE_ACCOUNT_KEY  (path to service account JSON — alternative to OAuth)
//   SUPABASE_URL                (optional — for persistent metrics)
//   SUPABASE_KEY
//   BAY_BOSS_API_KEY            (secret key for protected endpoints)

require('dotenv').config();

const express   = require('express');
const tekmetric = require('./tekmetric');
const scheduler = require('./scheduler');
const calendar  = require('./calendar');
const jobs      = require('./jobs');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// ─── Shared Config ────────────────────────────────────────────────────────────
// Build config from env vars — can be swapped for per-client DB lookup later
function getConfig(overrides = {}) {
    return {
        tekmetricApiKey:    process.env.TEKMETRIC_API_KEY,
        shopId:             process.env.TEKMETRIC_SHOP_ID,
        totalBays:          parseInt(process.env.TEKMETRIC_TOTAL_BAYS || '6'),
        ownerPhone:         process.env.OWNER_PHONE,
        twilioAccountSid:   process.env.TWILIO_ACCOUNT_SID,
        twilioAuthToken:    process.env.TWILIO_AUTH_TOKEN,
        twilioFrom:         process.env.TWILIO_FROM_NUMBER,
        timezone:           process.env.TIMEZONE || 'America/Chicago',
        calendarConfig: {
            googleClientId:     process.env.GOOGLE_CLIENT_ID,
            googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
            googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN,
            serviceAccountKey:  process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
            timezone:           process.env.TIMEZONE || 'America/Chicago',
        },
        // Map of technicianId → Google Calendar ID for each tech
        // Set in env as JSON: TECH_CALENDAR_MAP={"1":"tech1@shop.com","2":"tech2@shop.com"}
        techCalendarMap: process.env.TECH_CALENDAR_MAP
            ? JSON.parse(process.env.TECH_CALENDAR_MAP)
            : {},
        ...overrides,
    };
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.apiKey;
    if (!process.env.BAY_BOSS_API_KEY || key === process.env.BAY_BOSS_API_KEY) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized — missing or invalid API key' });
}

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status:  'ok',
        worker:  'bay-boss',
        version: '1.0.0',
        time:    new Date().toISOString(),
    });
});

// ─── Status Dashboard ─────────────────────────────────────────────────────────
// GET /status — Current shop state at a glance
app.get('/status', requireApiKey, async (req, res) => {
    const config = getConfig();

    if (!config.tekmetricApiKey || !config.shopId) {
        return res.status(503).json({ error: 'Tekmetric not configured. Set TEKMETRIC_API_KEY and TEKMETRIC_SHOP_ID.' });
    }

    try {
        const snapshot   = await tekmetric.getDailySnapshot(config.tekmetricApiKey, config.shopId, config.totalBays);
        const bayStatus  = scheduler.analyzeBayUtilization(snapshot.bayStatus);
        const techAnalysis = scheduler.analyzeTechWorkloads(snapshot.techWorkload);
        const overruns   = scheduler.detectOverrunJobs(snapshot.wipOrders);
        const queueStats = await jobs.getQueueStatus();

        res.json({
            date:        snapshot.date,
            shopId:      config.shopId,
            bay:         bayStatus,
            techs:       techAnalysis,
            overruns,
            appointments: snapshot.appointments.length,
            activeJobs:  snapshot.wipOrders.length,
            queues:      queueStats,
            lastUpdated: new Date().toISOString(),
        });
    } catch (e) {
        console.error('[BayBoss] /status error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── Full Schedule Optimization ───────────────────────────────────────────────
// GET /optimize — Run full scheduling pass and get recommendations
app.get('/optimize', requireApiKey, async (req, res) => {
    const config = getConfig();

    if (!config.tekmetricApiKey || !config.shopId) {
        return res.status(503).json({ error: 'Tekmetric not configured.' });
    }

    try {
        const snapshot = await tekmetric.getDailySnapshot(config.tekmetricApiKey, config.shopId, config.totalBays);

        let techSchedules = {};
        if (config.calendarConfig?.googleRefreshToken || config.calendarConfig?.serviceAccountKey) {
            if (Object.keys(config.techCalendarMap).length > 0) {
                techSchedules = await calendar.getAllTechSchedules(config.calendarConfig, config.techCalendarMap);
            }
        }

        const result = await scheduler.runScheduleOptimization(snapshot, techSchedules);
        res.json(result);
    } catch (e) {
        console.error('[BayBoss] /optimize error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── Tekmetric Data Endpoints ─────────────────────────────────────────────────

// GET /repair-orders?date=YYYY-MM-DD&status=WORK_IN_PROGRESS
app.get('/repair-orders', requireApiKey, async (req, res) => {
    const config = getConfig();
    const { date, status } = req.query;

    try {
        const orders = await tekmetric.getRepairOrders(config.tekmetricApiKey, config.shopId, {
            startDate: date,
            endDate:   date,
            status:    status || null,
        });
        res.json({ count: orders.length, orders });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /appointments?date=YYYY-MM-DD
app.get('/appointments', requireApiKey, async (req, res) => {
    const config = getConfig();
    const { date } = req.query;

    try {
        const appts = await tekmetric.getAppointments(config.tekmetricApiKey, config.shopId, {
            startDate: date,
            endDate:   date,
        });
        res.json({ count: appts.length, appointments: appts });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /technicians
app.get('/technicians', requireApiKey, async (req, res) => {
    const config = getConfig();

    try {
        const techs = await tekmetric.getTechnicians(config.tekmetricApiKey, config.shopId);
        res.json({ count: techs.length, technicians: techs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /bays
app.get('/bays', requireApiKey, async (req, res) => {
    const config = getConfig();

    try {
        const bayStatus = await tekmetric.getBayStatus(config.tekmetricApiKey, config.shopId, config.totalBays);
        const analysis  = scheduler.analyzeBayUtilization(bayStatus);
        res.json({ ...bayStatus, ...analysis });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /tech-efficiency?techId=123&days=7
app.get('/tech-efficiency', requireApiKey, async (req, res) => {
    const config = getConfig();
    const { techId, days = 7 } = req.query;

    if (!techId) return res.status(400).json({ error: 'techId required' });

    try {
        const metrics = await tekmetric.getTechEfficiency(
            config.tekmetricApiKey,
            config.shopId,
            techId,
            parseInt(days)
        );
        res.json(metrics);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Calendar Endpoints ───────────────────────────────────────────────────────

// GET /calendar/schedule?calendarId=xxx&date=YYYY-MM-DD
app.get('/calendar/schedule', requireApiKey, async (req, res) => {
    const config = getConfig();
    const { calendarId, date } = req.query;

    if (!calendarId) return res.status(400).json({ error: 'calendarId required' });

    try {
        const schedule = await calendar.getTechSchedule(config.calendarConfig, calendarId, date);
        res.json(schedule);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /calendar/event — Create a calendar event for a tech
app.post('/calendar/event', requireApiKey, async (req, res) => {
    const config = getConfig();
    const { calendarId, ...eventData } = req.body;

    if (!calendarId) return res.status(400).json({ error: 'calendarId required' });

    try {
        const event = await calendar.createEvent(config.calendarConfig, calendarId, eventData);
        res.json({ success: true, event });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /calendar/sync-job — Sync a Tekmetric RO to a tech's calendar
app.post('/calendar/sync-job', requireApiKey, async (req, res) => {
    const config = getConfig();
    const { calendarId, job } = req.body;

    if (!calendarId || !job) return res.status(400).json({ error: 'calendarId and job required' });

    try {
        const event = await calendar.syncJobToCalendar(config.calendarConfig, calendarId, job);
        res.json({ success: true, event });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /calendar/auth-url — Generate OAuth URL for initial calendar setup
app.get('/calendar/auth-url', requireApiKey, (req, res) => {
    const config = getConfig();
    try {
        const url = calendar.generateAuthUrl(config.calendarConfig);
        res.json({ url, instructions: 'Open this URL, authorize, then POST the code to /calendar/exchange-token' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /calendar/exchange-token — Exchange auth code for refresh token
app.post('/calendar/exchange-token', requireApiKey, async (req, res) => {
    const config = getConfig();
    const { code } = req.body;

    if (!code) return res.status(400).json({ error: 'code required' });

    try {
        const tokens = await calendar.exchangeCodeForTokens(code, config.calendarConfig);
        res.json({
            success:      true,
            refreshToken: tokens.refresh_token,
            note:         'Save refresh_token as GOOGLE_REFRESH_TOKEN env var',
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Manual Job Triggers ──────────────────────────────────────────────────────

// POST /trigger/morning-briefing — Fire the morning briefing now
app.post('/trigger/morning-briefing', requireApiKey, async (req, res) => {
    const config = getConfig(req.body?.config || {});

    try {
        const job = await jobs.triggerMorningBriefing(config);
        res.json({ success: true, jobId: job.id, message: 'Morning briefing queued' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /trigger/eod-summary
app.post('/trigger/eod-summary', requireApiKey, async (req, res) => {
    const config = getConfig(req.body?.config || {});

    try {
        const job = await jobs.triggerEodSummary(config);
        res.json({ success: true, jobId: job.id, message: 'EOD summary queued' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /trigger/schedule-check
app.post('/trigger/schedule-check', requireApiKey, async (req, res) => {
    const config = getConfig(req.body?.config || {});

    try {
        const job = await jobs.triggerScheduleCheck(config);
        res.json({ success: true, jobId: job.id, message: 'Schedule check queued' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /trigger/alert — Send a custom SMS alert to shop owner
app.post('/trigger/alert', requireApiKey, async (req, res) => {
    const { message } = req.body;
    const config = getConfig();

    if (!message) return res.status(400).json({ error: 'message required' });
    if (!config.ownerPhone) return res.status(503).json({ error: 'OWNER_PHONE not configured' });

    try {
        const job = await jobs.triggerAlert(config, message);
        res.json({ success: true, jobId: job.id, message: 'Alert queued' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Queue Status ─────────────────────────────────────────────────────────────
app.get('/queues', requireApiKey, async (req, res) => {
    try {
        const status = await jobs.getQueueStatus();
        res.json(status);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        routes: [
            'GET  /health',
            'GET  /status',
            'GET  /optimize',
            'GET  /repair-orders',
            'GET  /appointments',
            'GET  /technicians',
            'GET  /bays',
            'GET  /tech-efficiency',
            'GET  /calendar/schedule',
            'POST /calendar/event',
            'POST /calendar/sync-job',
            'GET  /calendar/auth-url',
            'POST /calendar/exchange-token',
            'POST /trigger/morning-briefing',
            'POST /trigger/eod-summary',
            'POST /trigger/schedule-check',
            'POST /trigger/alert',
            'GET  /queues',
        ],
    });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
    const config = getConfig();

    // Validate required env vars
    if (!config.tekmetricApiKey) console.warn('[BayBoss] WARNING: TEKMETRIC_API_KEY not set');
    if (!config.shopId)          console.warn('[BayBoss] WARNING: TEKMETRIC_SHOP_ID not set');
    if (!config.ownerPhone)      console.warn('[BayBoss] WARNING: OWNER_PHONE not set — SMS alerts disabled');

    // Schedule recurring Bull jobs
    try {
        await jobs.scheduleRecurringJobs(config);
        console.log('[BayBoss] Recurring jobs scheduled');
    } catch (e) {
        console.warn(`[BayBoss] Could not schedule jobs (Redis may not be available): ${e.message}`);
    }

    app.listen(PORT, () => {
        console.log(`\n🔧 GRIDHAND Bay Boss`);
        console.log(`   Running on port ${PORT}`);
        console.log(`   Shop ID: ${config.shopId || '(not set)'}`);
        console.log(`   Bays: ${config.totalBays}`);
        console.log(`   Owner phone: ${config.ownerPhone || '(not set)'}`);
        console.log(`   http://localhost:${PORT}/status\n`);
    });
}

start().catch(e => {
    console.error('[BayBoss] Fatal startup error:', e.message);
    process.exit(1);
});

module.exports = app;
