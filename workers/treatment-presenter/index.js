/**
 * GRIDHAND AI — Treatment Presenter
 * Main Express Server
 *
 * Endpoints:
 *   GET  /                                 — Worker info + endpoint list
 *   GET  /health                           — Health check + queue stats
 *
 *   POST /auth/connect                     — Register dental practice
 *
 *   POST /webhooks/sms                     — Twilio inbound SMS (patient replies)
 *
 *   GET  /plans/:clientSlug                — List treatment plans (filter by status)
 *   GET  /plans/:clientSlug/:planId        — Plan detail
 *   POST /plans/:clientSlug/present/:planId — Trigger immediate text to patient
 *   GET  /analytics/:clientSlug            — Acceptance rates, revenue pipeline
 *
 *   POST /trigger/scan-new-plans           — Scan for new uncontacted treatment plans
 *   POST /trigger/send-followups           — Run follow-up sequence
 */

'use strict';

require('dotenv').config();

const express        = require('express');
const cors           = require('cors');
const twilio         = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const dayjs          = require('dayjs');

const { handlePatientReply } = require('./followup');
const {
    runScanNewPlans,
    runPresentPlan,
    runFollowUps,
    runWeeklyDigest,
    runForAllClients,
    startCronJobs,
    getQueueStats
} = require('./jobs');

const app  = express();
const PORT = process.env.TP_PORT || 3009;

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
        name:        'GRIDHAND AI — Treatment Presenter',
        version:     '1.0.0',
        description: 'Dental treatment plan automation — AI summaries, SMS delivery, follow-up cadence, acceptance tracking',
        status:      'running',
        integrations: ['Dentrix G6+', 'Open Dental', 'Twilio SMS', 'Claude AI (Haiku)'],
        jobs: [
            'tp:scan-plans',
            'tp:present',
            'tp:followup',
            'tp:digest'
        ],
        endpoints: [
            'GET  /health',
            'POST /auth/connect',
            'POST /webhooks/sms',
            'GET  /plans/:clientSlug',
            'GET  /plans/:clientSlug/:planId',
            'POST /plans/:clientSlug/present/:planId',
            'GET  /analytics/:clientSlug',
            'POST /trigger/scan-new-plans',
            'POST /trigger/send-followups'
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
        const { error } = await supabase.from('tp_connections').select('id').limit(1);
        dbOk = !error;
    } catch (_) {}

    res.json({
        status:    'ok',
        worker:    'treatment-presenter',
        version:   '1.0.0',
        timestamp: new Date().toISOString(),
        database:  dbOk ? 'connected' : 'error',
        queues:    queueStats
    });
});

// ============================================================
// AUTH: REGISTER PRACTICE
// ============================================================

/**
 * POST /auth/connect
 * Registers a new dental practice or updates existing config.
 * Body params:
 *   client_slug, practice_name, owner_phone, front_desk_phone,
 *   pms_type (dentrix | open_dental), pms_api_key, pms_api_base_url,
 *   twilio_number, schedule_link, financing_options_text, followup_enabled
 */
app.post('/auth/connect', requireApiKey, async (req, res) => {
    const {
        client_slug,
        practice_name,
        owner_phone,
        front_desk_phone,
        pms_type,
        pms_api_key,
        pms_api_base_url,
        twilio_number,
        schedule_link,
        financing_options_text,
        followup_enabled
    } = req.body;

    const required = ['client_slug', 'practice_name', 'owner_phone', 'front_desk_phone', 'pms_type', 'pms_api_key', 'pms_api_base_url'];
    const missing  = required.filter(k => !req.body[k]);
    if (missing.length) {
        return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
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
        pms_api_key,
        pms_api_base_url,
        twilio_number:         twilio_number         || null,
        schedule_link:         schedule_link         || null,
        financing_options_text: financing_options_text || null,
        followup_enabled:      followup_enabled !== false,
        updated_at:            new Date().toISOString()
    };

    const { data: existing } = await supabase
        .from('tp_connections')
        .select('id')
        .eq('client_slug', client_slug)
        .single();

    let result;
    if (existing) {
        result = await supabase.from('tp_connections').update(row).eq('client_slug', client_slug).select().single();
    } else {
        row.created_at = new Date().toISOString();
        result = await supabase.from('tp_connections').insert(row).select().single();
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
        message:      `${practice_name} is connected to Treatment Presenter. Use POST /trigger/scan-new-plans to run your first scan.`
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

    // Find connection by Twilio number
    const { data: conn } = await supabase
        .from('tp_connections')
        .select('*')
        .eq('twilio_number', To)
        .single();

    if (!conn) {
        console.warn(`[SMS] No connection found for Twilio number: ${To}`);
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
// PLANS: READ
// ============================================================

/**
 * GET /plans/:clientSlug
 * Returns treatment plans for a practice.
 * Query: status (pending|contacted|interested|accepted|declined|stale|opted_out|all), page, limit
 */
app.get('/plans/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { status, page = 1, limit = 50 } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
        .from('tp_plans')
        .select('*', { count: 'exact' })
        .eq('client_slug', clientSlug)
        .order('created_at', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

    if (status && status !== 'all') {
        const statuses = status.split(',');
        query = query.in('status', statuses);
    }

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Summary counts by status
    const { data: summary } = await supabase
        .from('tp_plans')
        .select('status')
        .eq('client_slug', clientSlug);

    const statusCounts = {};
    for (const row of (summary || [])) {
        statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
    }

    res.json({
        plans:         data || [],
        total:         count,
        page:          parseInt(page),
        limit:         parseInt(limit),
        status_counts: statusCounts
    });
});

/**
 * GET /plans/:clientSlug/:planId
 * Returns full detail for a single treatment plan by PMS plan_id.
 */
app.get('/plans/:clientSlug/:planId', requireApiKey, async (req, res) => {
    const { clientSlug, planId } = req.params;

    const { data, error } = await supabase
        .from('tp_plans')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('plan_id', planId)
        .single();

    if (error || !data) {
        return res.status(404).json({ error: 'Plan not found' });
    }

    // Fetch SMS log for this plan
    const { data: smsLog } = await supabase
        .from('tp_sms_log')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('plan_id', data.id)
        .order('created_at', { ascending: true });

    res.json({ plan: data, sms_log: smsLog || [] });
});

// ============================================================
// PLANS: PRESENT (trigger immediate presentation)
// ============================================================

/**
 * POST /plans/:clientSlug/present/:planId
 * Trigger immediate treatment plan presentation to patient via SMS.
 * planId is the PMS plan_id (string).
 */
app.post('/plans/:clientSlug/present/:planId', requireApiKey, async (req, res) => {
    const { clientSlug, planId } = req.params;

    // Verify the plan exists
    const { data: plan } = await supabase
        .from('tp_plans')
        .select('id, status')
        .eq('client_slug', clientSlug)
        .eq('plan_id', planId)
        .single();

    if (!plan) {
        // Plan not yet in our DB — scan it first then present
        const scanJob = await runScanNewPlans(clientSlug);
        const presentJob = await runPresentPlan(clientSlug, planId);
        return res.json({
            queued:   true,
            scanJobId: scanJob.id,
            presentJobId: presentJob.id,
            message:  `Plan ${planId} queued for scan + presentation for ${clientSlug}`
        });
    }

    const job = await runPresentPlan(clientSlug, planId);
    res.json({
        queued:  true,
        jobId:   job.id,
        status:  plan.status,
        message: `Plan ${planId} queued for presentation for ${clientSlug}`
    });
});

// ============================================================
// ANALYTICS
// ============================================================

/**
 * GET /analytics/:clientSlug
 * Returns acceptance rates, revenue pipeline, and plan stats.
 * Query: days (default 30)
 */
app.get('/analytics/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const days = parseInt(req.query.days || '30');
    const since = dayjs().subtract(days, 'day').toISOString();

    const { data: plans, error } = await supabase
        .from('tp_plans')
        .select('status, total_fee, total_insurance_est, total_patient_portion, created_at, accepted_at, contact_count')
        .eq('client_slug', clientSlug)
        .gte('created_at', since);

    if (error) return res.status(500).json({ error: error.message });

    const totals = (plans || []).reduce((acc, p) => {
        acc.total++;
        if (p.status === 'accepted')   acc.accepted++;
        if (p.status === 'declined')   acc.declined++;
        if (p.status === 'stale')      acc.stale++;
        if (p.status === 'opted_out')  acc.opted_out++;
        if (['pending', 'contacted', 'interested'].includes(p.status)) acc.pending++;
        if (p.status === 'accepted')   acc.revenue_accepted   += parseFloat(p.total_patient_portion || 0);
        acc.revenue_pipeline += parseFloat(p.total_patient_portion || 0);
        acc.total_treatment_value += parseFloat(p.total_fee || 0);
        return acc;
    }, {
        total: 0, accepted: 0, declined: 0, pending: 0, stale: 0, opted_out: 0,
        revenue_accepted: 0, revenue_pipeline: 0, total_treatment_value: 0
    });

    const acceptanceRate = totals.total > 0
        ? parseFloat(((totals.accepted / totals.total) * 100).toFixed(1))
        : 0;

    // Weekly stats history
    const { data: weeklyStats } = await supabase
        .from('tp_weekly_stats')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('week_start', { ascending: false })
        .limit(8);

    // SMS activity count
    const { count: smsCount } = await supabase
        .from('tp_sms_log')
        .select('id', { count: 'exact' })
        .eq('client_slug', clientSlug)
        .gte('created_at', since);

    res.json({
        period_days:          days,
        totals,
        acceptance_rate:      acceptanceRate,
        revenue_accepted:     parseFloat(totals.revenue_accepted.toFixed(2)),
        revenue_pipeline:     parseFloat(totals.revenue_pipeline.toFixed(2)),
        total_treatment_value: parseFloat(totals.total_treatment_value.toFixed(2)),
        sms_sent_received:    smsCount || 0,
        weekly_history:       weeklyStats || []
    });
});

// ============================================================
// TRIGGER ENDPOINTS
// ============================================================

app.post('/trigger/scan-new-plans', requireApiKey, async (req, res) => {
    const { client_slug } = req.body;

    if (client_slug) {
        const job = await runScanNewPlans(client_slug);
        return res.json({ queued: true, jobId: job.id, message: `Plan scan queued for ${client_slug}` });
    }

    // Run for all clients if no specific slug provided
    const jobs = await runForAllClients(runScanNewPlans);
    res.json({ queued: true, jobs, message: `Plan scan queued for ${jobs.length} client(s)` });
});

app.post('/trigger/send-followups', requireApiKey, async (req, res) => {
    const { client_slug } = req.body;

    if (client_slug) {
        const job = await runFollowUps(client_slug);
        return res.json({ queued: true, jobId: job.id, message: `Follow-up sequence queued for ${client_slug}` });
    }

    const jobs = await runForAllClients(runFollowUps);
    res.json({ queued: true, jobs, message: `Follow-up sequences queued for ${jobs.length} client(s)` });
});

// ============================================================
// START
// ============================================================

app.listen(PORT, () => {
    console.log(`\n🦷  GRIDHAND Treatment Presenter running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   Docs:   http://localhost:${PORT}/\n`);

    startCronJobs();
});

module.exports = app;
