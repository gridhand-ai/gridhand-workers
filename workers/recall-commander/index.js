/**
 * GRIDHAND AI — Recall Commander
 * Main Express Server
 *
 * Endpoints:
 *   GET  /                          - Worker info + endpoint list
 *   GET  /health                    - Health check + queue stats
 *
 *   GET  /auth/connect              - Initiate dental practice connection flow
 *   GET  /auth/callback             - OAuth/API key callback handler
 *
 *   POST /webhooks/sms              - Inbound patient SMS replies (Twilio webhook)
 *
 *   GET  /recall/:clientSlug        - Get recall queue for a practice
 *   GET  /analytics/:clientSlug     - Booking rate and response stats
 *
 *   POST /trigger/recall-scan       - Manually trigger recall scan
 *   POST /trigger/daily-digest      - Manually send daily digest
 *   POST /trigger/send-reminders    - Manually fire first-reminder batch
 *   POST /trigger/follow-ups        - Manually fire follow-up batch
 *   POST /trigger/escalate          - Manually fire escalation alert
 *
 *   PATCH /recall/:clientSlug/:queueId/status  - Update a recall record status
 */

'use strict';

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const twilio     = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const dayjs      = require('dayjs');

const { handlePatientReply } = require('./reminders');
const {
    runRecallScan,
    runSendReminders,
    runFollowUps,
    runEscalation,
    runDailyDigest,
    startCronJobs,
    getQueueStats
} = require('./jobs');
const { updateRecallStatus } = require('./dentrix');

const app  = express();
const PORT = process.env.RECALL_PORT || 3007;

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (!key || key !== process.env.GRIDHAND_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ============================================================
// ROOT + HEALTH
// ============================================================

app.get('/', (req, res) => {
    res.json({
        name:        'GRIDHAND AI — Recall Commander',
        version:     '1.0.0',
        description: 'Dental patient recall automation — hygiene, exam, and xray recall via SMS',
        status:      'running',
        integrations: ['Dentrix G6+', 'Open Dental', 'Twilio SMS'],
        jobs: [
            'recall:scan',
            'recall:reminder',
            'recall:followup',
            'recall:escalate',
            'recall:digest'
        ],
        endpoints: [
            'GET  /health',
            'GET  /auth/connect',
            'GET  /auth/callback',
            'POST /webhooks/sms',
            'GET  /recall/:clientSlug',
            'GET  /analytics/:clientSlug',
            'POST /trigger/recall-scan',
            'POST /trigger/daily-digest',
            'POST /trigger/send-reminders',
            'POST /trigger/follow-ups',
            'POST /trigger/escalate',
            'PATCH /recall/:clientSlug/:queueId/status'
        ]
    });
});

app.get('/health', async (req, res) => {
    let queueStats = {};
    let dbOk = false;

    try {
        queueStats = await getQueueStats();
    } catch (err) {
        queueStats = { error: err.message };
    }

    try {
        const { error } = await supabase.from('rc_connections').select('id').limit(1);
        dbOk = !error;
    } catch (_) {}

    res.json({
        status:    'ok',
        worker:    'recall-commander',
        version:   '1.0.0',
        timestamp: new Date().toISOString(),
        database:  dbOk ? 'connected' : 'error',
        queues:    queueStats
    });
});

// ============================================================
// AUTH FLOW
// Connect a dental practice to Recall Commander
// ============================================================

/**
 * GET /auth/connect
 * Registers a new practice connection or returns current config.
 * For Dentrix: provide api_key, api_secret, api_base_url in query.
 * For Open Dental: provide api_key (developer key), api_base_url.
 */
app.get('/auth/connect', requireApiKey, async (req, res) => {
    const {
        client_slug,
        practice_name,
        owner_phone,
        front_desk_phone,
        pms_type,
        api_key,
        api_secret,
        api_base_url,
        twilio_number,
        recall_hygiene_interval_months,
        recall_exam_interval_months
    } = req.query;

    const required = ['client_slug', 'practice_name', 'owner_phone', 'front_desk_phone', 'pms_type', 'api_key', 'api_base_url'];
    const missing  = required.filter(k => !req.query[k]);
    if (missing.length) {
        return res.status(400).json({ error: `Missing required params: ${missing.join(', ')}` });
    }

    if (!['dentrix', 'open_dental'].includes(pms_type)) {
        return res.status(400).json({ error: 'pms_type must be dentrix or open_dental' });
    }

    const row = {
        client_slug,
        practice_name,
        owner_phone,
        front_desk_phone,
        pms_type,
        api_key,
        api_secret:                      api_secret || null,
        api_base_url,
        twilio_number:                   twilio_number || null,
        recall_hygiene_interval_months:  parseInt(recall_hygiene_interval_months || '6'),
        recall_exam_interval_months:     parseInt(recall_exam_interval_months || '12'),
        active: true
    };

    const { data: existing } = await supabase
        .from('rc_connections')
        .select('id')
        .eq('client_slug', client_slug)
        .single();

    let result;
    if (existing) {
        result = await supabase
            .from('rc_connections')
            .update(row)
            .eq('client_slug', client_slug)
            .select()
            .single();
    } else {
        result = await supabase
            .from('rc_connections')
            .insert(row)
            .select()
            .single();
    }

    if (result.error) {
        return res.status(500).json({ error: result.error.message });
    }

    res.json({
        ok:           true,
        action:       existing ? 'updated' : 'created',
        client_slug,
        practice_name,
        pms_type,
        message:      `${practice_name} is connected to Recall Commander. Use POST /trigger/recall-scan to run your first scan.`
    });
});

/**
 * GET /auth/callback
 * Handles OAuth callback flows (e.g. future Dentrix Enterprise OAuth).
 * Currently stores the authorization_code and exchanges it for a token.
 */
app.get('/auth/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
        return res.status(400).json({ error: `OAuth error: ${oauthError}` });
    }

    if (!code || !state) {
        return res.status(400).json({ error: 'Missing code or state parameter' });
    }

    // state encodes the client_slug
    const clientSlug = state;

    const { data: conn } = await supabase
        .from('rc_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (!conn) {
        return res.status(404).json({ error: `No connection found for client_slug: ${clientSlug}` });
    }

    // Store the authorization code — token exchange would happen here for
    // full OAuth implementations (Dentrix Enterprise uses API keys, not OAuth,
    // but this stub is ready for future PMS integrations).
    await supabase
        .from('rc_connections')
        .update({ api_key: code, active: true })
        .eq('client_slug', clientSlug);

    res.json({
        ok:          true,
        client_slug: clientSlug,
        message:     'Authorization received. Connection is now active.'
    });
});

// ============================================================
// WEBHOOK: INBOUND SMS (Twilio)
// ============================================================

app.post('/webhooks/sms', async (req, res) => {
    const { From, To, Body } = req.body;

    // Validate Twilio signature in production
    if (process.env.NODE_ENV === 'production') {
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const signature = req.headers['x-twilio-signature'];
        const url       = `${process.env.BASE_URL}/webhooks/sms`;
        const valid     = twilio.validateRequest(authToken, signature, url, req.body);
        if (!valid) {
            return res.status(403).type('text/xml').send('<Response></Response>');
        }
    }

    // Reply immediately so Twilio doesn't time out
    res.type('text/xml').send('<Response></Response>');

    // Find the connection by Twilio number
    const { data: conn } = await supabase
        .from('rc_connections')
        .select('*')
        .eq('twilio_number', To)
        .eq('active', true)
        .single();

    if (!conn) {
        console.warn(`[SMS] No active connection for Twilio number: ${To}`);
        return;
    }

    try {
        const normalizedFrom = From.startsWith('+') ? From : `+1${From.replace(/\D/g, '')}`;
        await handlePatientReply(conn, normalizedFrom, Body || '');
    } catch (err) {
        console.error('[SMS] handlePatientReply error:', err.message);
    }
});

// ============================================================
// RECALL QUEUE READ
// ============================================================

/**
 * GET /recall/:clientSlug
 * Returns the current recall queue for a practice.
 * Optional query params: status, recall_type, page, limit
 */
app.get('/recall/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { status, recall_type, page = 1, limit = 50 } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
        .from('rc_recall_queue')
        .select('*', { count: 'exact' })
        .eq('client_slug', clientSlug)
        .order('days_overdue', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

    if (status) {
        const statuses = status.split(',');
        query = query.in('status', statuses);
    }
    if (recall_type) {
        query = query.eq('recall_type', recall_type);
    }

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Summary counts by status
    const { data: summary } = await supabase
        .from('rc_recall_queue')
        .select('status')
        .eq('client_slug', clientSlug);

    const statusCounts = {};
    for (const row of (summary || [])) {
        statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
    }

    res.json({
        patients:      data || [],
        total:         count,
        page:          parseInt(page),
        limit:         parseInt(limit),
        status_counts: statusCounts
    });
});

// ============================================================
// ANALYTICS
// ============================================================

/**
 * GET /analytics/:clientSlug
 * Returns booking rate stats and recall performance for a practice.
 * Optional query params: days (default 30)
 */
app.get('/analytics/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const days = parseInt(req.query.days || '30');

    const since = dayjs().subtract(days, 'day').format('YYYY-MM-DD');

    const { data: dailyStats, error } = await supabase
        .from('rc_daily_stats')
        .select('*')
        .eq('client_slug', clientSlug)
        .gte('stat_date', since)
        .order('stat_date', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const totals = (dailyStats || []).reduce((acc, row) => {
        acc.recalls_sent       += row.recalls_sent       || 0;
        acc.responses_received += row.responses_received || 0;
        acc.appointments_booked += row.appointments_booked || 0;
        return acc;
    }, { recalls_sent: 0, responses_received: 0, appointments_booked: 0 });

    const overallBookingRate = totals.recalls_sent > 0
        ? parseFloat(((totals.appointments_booked / totals.recalls_sent) * 100).toFixed(1))
        : 0;
    const responseRate = totals.recalls_sent > 0
        ? parseFloat(((totals.responses_received / totals.recalls_sent) * 100).toFixed(1))
        : 0;

    // Queue breakdown
    const { data: queueBreakdown } = await supabase
        .from('rc_recall_queue')
        .select('status, recall_type')
        .eq('client_slug', clientSlug);

    const byStatus = {};
    const byType   = {};
    for (const row of (queueBreakdown || [])) {
        byStatus[row.status]      = (byStatus[row.status]      || 0) + 1;
        byType[row.recall_type]   = (byType[row.recall_type]   || 0) + 1;
    }

    // Last 5 escalations
    const { data: recentEscalations } = await supabase
        .from('rc_escalations')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('created_at', { ascending: false })
        .limit(5);

    res.json({
        period_days:          days,
        totals,
        overall_booking_rate: overallBookingRate,
        response_rate:        responseRate,
        queue_by_status:      byStatus,
        queue_by_type:        byType,
        daily_stats:          dailyStats || [],
        recent_escalations:   recentEscalations || []
    });
});

// ============================================================
// TRIGGER ENDPOINTS
// ============================================================

app.post('/trigger/recall-scan', requireApiKey, async (req, res) => {
    const { client_slug } = req.body;
    if (!client_slug) return res.status(400).json({ error: 'client_slug required' });

    const job = await runRecallScan(client_slug);
    res.json({ queued: true, jobId: job.id, message: `Recall scan queued for ${client_slug}` });
});

app.post('/trigger/daily-digest', requireApiKey, async (req, res) => {
    const { client_slug } = req.body;
    if (!client_slug) return res.status(400).json({ error: 'client_slug required' });

    const job = await runDailyDigest(client_slug);
    res.json({ queued: true, jobId: job.id, message: `Daily digest queued for ${client_slug}` });
});

app.post('/trigger/send-reminders', requireApiKey, async (req, res) => {
    const { client_slug } = req.body;
    if (!client_slug) return res.status(400).json({ error: 'client_slug required' });

    const job = await runSendReminders(client_slug);
    res.json({ queued: true, jobId: job.id, message: `Reminder batch queued for ${client_slug}` });
});

app.post('/trigger/follow-ups', requireApiKey, async (req, res) => {
    const { client_slug } = req.body;
    if (!client_slug) return res.status(400).json({ error: 'client_slug required' });

    const job = await runFollowUps(client_slug);
    res.json({ queued: true, jobId: job.id, message: `Follow-up batch queued for ${client_slug}` });
});

app.post('/trigger/escalate', requireApiKey, async (req, res) => {
    const { client_slug } = req.body;
    if (!client_slug) return res.status(400).json({ error: 'client_slug required' });

    const job = await runEscalation(client_slug);
    res.json({ queued: true, jobId: job.id, message: `Escalation job queued for ${client_slug}` });
});

// ============================================================
// RECALL QUEUE STATUS UPDATE
// ============================================================

/**
 * PATCH /recall/:clientSlug/:queueId/status
 * Allows front desk to manually update a recall record
 * (e.g. mark as 'scheduled' after booking by phone).
 */
app.patch('/recall/:clientSlug/:queueId/status', requireApiKey, async (req, res) => {
    const { clientSlug, queueId } = req.params;
    const { status, booked_at } = req.body;

    const validStatuses = ['pending', 'contacted', 'scheduled', 'declined', 'no_response', 'opted_out'];
    if (!status || !validStatuses.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    }

    const { data: queueRow } = await supabase
        .from('rc_recall_queue')
        .select('*')
        .eq('id', queueId)
        .eq('client_slug', clientSlug)
        .single();

    if (!queueRow) return res.status(404).json({ error: 'Recall queue record not found' });

    const updates = { status };
    if (status === 'scheduled' && booked_at) {
        updates.booked_at = booked_at;
    } else if (status === 'scheduled') {
        updates.booked_at = new Date().toISOString();
    }

    const { error } = await supabase
        .from('rc_recall_queue')
        .update(updates)
        .eq('id', queueId);

    if (error) return res.status(500).json({ error: error.message });

    // If scheduling confirmed, push back to PMS and increment appointments_booked stat
    if (status === 'scheduled') {
        await updateRecallStatus(clientSlug, queueRow.patient_id, 'scheduled');
        const { _upsertDailyStat } = require('./reminders');
        await _upsertDailyStat(clientSlug, { appointments_booked: 1 });
    } else if (status === 'declined') {
        await updateRecallStatus(clientSlug, queueRow.patient_id, 'declined');
    }

    res.json({ ok: true, status, queueId, clientSlug });
});

// ============================================================
// START
// ============================================================

app.listen(PORT, () => {
    console.log(`\n🦷  GRIDHAND Recall Commander running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   Docs:   http://localhost:${PORT}/\n`);

    startCronJobs();
});

module.exports = app;
