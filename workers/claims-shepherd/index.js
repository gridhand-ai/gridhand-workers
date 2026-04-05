/**
 * GRIDHAND AI — Claims Shepherd
 * Main Express Server
 *
 * Endpoints:
 *   POST /webhook/sms          - Inbound SMS from insured (Twilio webhook)
 *   POST /webhook/ams          - AMS push webhooks (HawkSoft/Epic events)
 *   POST /webhook/email        - Parsed email notifications (loss reports)
 *
 *   GET  /claims               - List all claims for a client
 *   GET  /claims/:id           - Get a single claim with events + docs
 *   POST /claims               - Manually create a claim
 *   POST /claims/:id/file-fnol - Manually trigger FNOL filing
 *   PATCH /claims/:id/status   - Manually update claim status
 *   POST /claims/:id/action    - Resolve/clear agent action flag
 *
 *   POST /trigger/status-check        - Manually trigger status check job
 *   POST /trigger/client-update       - Manually trigger client update SMS
 *   POST /trigger/document-reminder   - Manually trigger doc reminder
 *   POST /trigger/weekly-report       - Manually trigger weekly report
 *   POST /trigger/ams-sync            - Manually trigger AMS sync
 *
 *   GET  /reports/pipeline     - Current open claims pipeline
 *   GET  /reports/metrics      - Resolution time and satisfaction metrics
 *   GET  /reports/weekly       - Latest weekly report for a client
 *
 *   GET  /carriers             - List supported carriers
 *   GET  /health               - System health + queue stats
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');

const filing = require('./filing');
const notifications = require('./notifications');
const { queues, scheduleStatusCheck, startCronJobs, getQueueStats } = require('./jobs');
const carriers = require('./carriers');
const { AMSClient, normalizeHawksoftClaim, normalizeEpicClaim } = require('./ams');

const app = express();
const PORT = process.env.CLAIMS_PORT || 3002;

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// API Key auth for all non-webhook routes
function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (!key || key !== process.env.CLAIMS_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// Load client config by slug or Twilio number
async function loadClientByNumber(twilioNumber) {
    const { data } = await supabase
        .from('cs_clients')
        .select('*')
        .eq('twilio_number', twilioNumber)
        .single();
    return data;
}

async function loadClientById(clientId) {
    const { data } = await supabase
        .from('cs_clients')
        .select('*')
        .eq('id', clientId)
        .single();
    return data;
}

// ============================================================
// WEBHOOK: INBOUND SMS (Twilio)
// ============================================================

app.post('/webhook/sms', async (req, res) => {
    const { From, To, Body, NumMedia } = req.body;

    // Validate Twilio signature (skip in dev)
    if (process.env.NODE_ENV === 'production') {
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const signature = req.headers['x-twilio-signature'];
        const url = `${process.env.BASE_URL}/webhook/sms`;
        const valid = twilio.validateRequest(authToken, signature, url, req.body);
        if (!valid) {
            return res.status(403).send('<Response><Message>Forbidden</Message></Response>');
        }
    }

    // Extract media URLs if any
    const mediaUrls = [];
    const numMedia = parseInt(NumMedia || '0');
    for (let i = 0; i < numMedia; i++) {
        const url = req.body[`MediaUrl${i}`];
        if (url) mediaUrls.push(url);
    }

    const clientConfig = await loadClientByNumber(To);
    if (!clientConfig) {
        console.warn(`[SMS] No client found for Twilio number: ${To}`);
        return res.type('text/xml').send('<Response></Response>');
    }

    // Handle async so Twilio doesn't time out
    res.type('text/xml').send('<Response></Response>');

    try {
        await notifications.handleInboundSMS(clientConfig, From, Body, mediaUrls);
    } catch (err) {
        console.error('[SMS] handleInboundSMS error:', err.message);
    }
});

// ============================================================
// WEBHOOK: AMS EVENTS
// HawkSoft/Applied Epic push notifications for new/updated claims
// ============================================================

app.post('/webhook/ams', async (req, res) => {
    const hmacSecret = process.env.AMS_WEBHOOK_SECRET;
    const incoming = req.headers['x-webhook-secret'];
    if (hmacSecret && incoming !== hmacSecret) {
        return res.status(403).json({ error: 'Invalid webhook secret' });
    }

    const { event, ams_type, agency_id, payload } = req.body;

    // Find client by agency_id
    const { data: clientConfig } = await supabase
        .from('cs_clients')
        .select('*')
        .eq('ams_agency_id', agency_id)
        .single();

    if (!clientConfig) {
        return res.status(404).json({ error: 'Client not found for agency_id' });
    }

    res.json({ received: true });

    if (event === 'claim.created' || event === 'claim.updated') {
        const normalized = ams_type === 'hawksoft'
            ? normalizeHawksoftClaim(payload)
            : normalizeEpicClaim(payload);

        const existing = await filing.findExistingClaim(
            clientConfig.id,
            normalized.policy_number,
            normalized.loss_date
        );

        if (!existing) {
            const createResult = await filing.createClaim(clientConfig.id, {
                ...normalized,
                source: 'webhook'
            });

            if (createResult.ok) {
                await queues.fnolQueue.add('file', {
                    claimId: createResult.claim.id,
                    clientId: clientConfig.id
                });
                await notifications.alertAgent(clientConfig, 'new_claim', createResult.claim);
            }
        } else if (event === 'claim.updated') {
            // Sync status from AMS
            const newStatus = normalized.status || existing.status;
            if (newStatus !== existing.status) {
                await filing.updateClaimStatus(existing.id, clientConfig.id, newStatus, 'AMS update');
            }
        }
    }
});

// ============================================================
// WEBHOOK: EMAIL (parsed loss notices)
// ============================================================

app.post('/webhook/email', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.CLAIMS_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { client_id, subject, body, from_email } = req.body;
    if (!client_id || !body) {
        return res.status(400).json({ error: 'Missing client_id or body' });
    }

    const clientConfig = await loadClientById(client_id);
    if (!clientConfig) return res.status(404).json({ error: 'Client not found' });

    const parsed = await filing.parseClaimFromEmail(subject || '', body, clientConfig.anthropic_key);
    if (!parsed || !parsed.is_claim_report) {
        return res.json({ detected: false });
    }

    // Check for duplicate
    if (parsed.policy_number && parsed.loss_date) {
        const existing = await filing.findExistingClaim(
            clientConfig.id, parsed.policy_number, parsed.loss_date
        );
        if (existing) {
            return res.json({ detected: true, duplicate: true, claimId: existing.id });
        }
    }

    const createResult = await filing.createClaim(clientConfig.id, {
        ...parsed,
        carrier_code: 'unknown',
        carrier_name: 'Unknown — To Be Determined',
        insured_phone: parsed.insured_phone || '',
        loss_type: parsed.loss_type || 'property',
        source: 'email_parse',
        raw_source_data: { subject, from_email }
    });

    if (createResult.ok) {
        // Queue for review — don't auto-file without verification
        await filing.flagForAgentAction(
            createResult.claim.id,
            'New claim detected from email — verify carrier and policy details before filing FNOL'
        );
        await notifications.alertAgent(clientConfig, 'new_claim', createResult.claim);
        return res.json({ detected: true, claimId: createResult.claim.id });
    }

    return res.status(500).json({ error: createResult.error });
});

// ============================================================
// CLAIMS CRUD
// ============================================================

// List all claims
app.get('/claims', requireApiKey, async (req, res) => {
    const { client_id, status, page = 1, limit = 50 } = req.query;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });

    const offset = (parseInt(page) - 1) * parseInt(limit);
    let query = supabase
        .from('cs_claims')
        .select('*', { count: 'exact' })
        .eq('client_id', client_id)
        .order('created_at', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

    if (status) {
        const statuses = status.split(',');
        query = query.in('status', statuses);
    }

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ claims: data, total: count, page: parseInt(page), limit: parseInt(limit) });
});

// Get single claim with events and documents
app.get('/claims/:id', requireApiKey, async (req, res) => {
    const { id } = req.params;

    const [claimResult, eventsResult, docsResult] = await Promise.all([
        supabase.from('cs_claims').select('*').eq('id', id).single(),
        supabase.from('cs_claim_events').select('*').eq('claim_id', id).order('created_at', { ascending: false }).limit(50),
        supabase.from('cs_claim_documents').select('*').eq('claim_id', id)
    ]);

    if (!claimResult.data) return res.status(404).json({ error: 'Claim not found' });

    res.json({
        claim: claimResult.data,
        events: eventsResult.data || [],
        documents: docsResult.data || []
    });
});

// Create claim manually
app.post('/claims', requireApiKey, async (req, res) => {
    const { client_id, ...claimData } = req.body;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });

    const requiredFields = ['policy_number', 'carrier_code', 'carrier_name', 'insured_name', 'insured_phone', 'loss_type', 'loss_date', 'loss_description'];
    const missing = requiredFields.filter(f => !claimData[f]);
    if (missing.length) return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });

    const result = await filing.createClaim(client_id, { ...claimData, source: 'manual' });
    if (!result.ok) return res.status(500).json({ error: result.error });

    res.status(201).json({ claim: result.claim });
});

// Manually trigger FNOL
app.post('/claims/:id/file-fnol', requireApiKey, async (req, res) => {
    const { id } = req.params;
    const { data: claim } = await supabase.from('cs_claims').select('*').eq('id', id).single();
    if (!claim) return res.status(404).json({ error: 'Claim not found' });

    await queues.fnolQueue.add('file', { claimId: id, clientId: claim.client_id }, { priority: 1 });
    res.json({ queued: true, message: 'FNOL filing queued' });
});

// Update claim status
app.patch('/claims/:id/status', requireApiKey, async (req, res) => {
    const { id } = req.params;
    const { status, reason } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });

    const { data: claim } = await supabase.from('cs_claims').select('*').eq('id', id).single();
    if (!claim) return res.status(404).json({ error: 'Claim not found' });

    const result = await filing.updateClaimStatus(id, claim.client_id, status, reason || 'Manual update', 'agent');
    if (!result.ok) return res.status(500).json({ error: result.error });

    // Optionally send client notification
    if (req.body.notify_client) {
        const clientConfig = await loadClientById(claim.client_id);
        await notifications.sendClientStatusUpdate(clientConfig, { ...claim, status });
    }

    res.json(result);
});

// Clear agent action flag
app.post('/claims/:id/action/resolve', requireApiKey, async (req, res) => {
    const { id } = req.params;
    const result = await filing.clearAgentAction(id);
    res.json(result);
});

// ============================================================
// TRIGGER ENDPOINTS (manual job triggers)
// ============================================================

app.post('/trigger/status-check', requireApiKey, async (req, res) => {
    const { claim_id, client_id } = req.body;
    if (!claim_id || !client_id) return res.status(400).json({ error: 'claim_id and client_id required' });

    const job = await queues.statusCheck.add('check', { claimId: claim_id, clientId: client_id }, { priority: 1 });
    res.json({ queued: true, jobId: job.id });
});

app.post('/trigger/client-update', requireApiKey, async (req, res) => {
    const { claim_id, client_id } = req.body;
    if (!claim_id || !client_id) return res.status(400).json({ error: 'claim_id and client_id required' });

    const job = await queues.clientUpdate.add('update', { claimId: claim_id, clientId: client_id, force: true }, { priority: 1 });
    res.json({ queued: true, jobId: job.id });
});

app.post('/trigger/document-reminder', requireApiKey, async (req, res) => {
    const { claim_id, client_id } = req.body;
    if (!claim_id || !client_id) return res.status(400).json({ error: 'claim_id and client_id required' });

    const job = await queues.documentReminder.add('remind', { claimId: claim_id, clientId: client_id }, { priority: 1 });
    res.json({ queued: true, jobId: job.id });
});

app.post('/trigger/weekly-report', requireApiKey, async (req, res) => {
    const { client_id } = req.body;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });

    const job = await queues.weeklyReport.add('report', { clientId: client_id }, { priority: 1 });
    res.json({ queued: true, jobId: job.id });
});

app.post('/trigger/ams-sync', requireApiKey, async (req, res) => {
    const { client_id } = req.body;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });

    const job = await queues.amsSync.add('sync', { clientId: client_id }, { priority: 1 });
    res.json({ queued: true, jobId: job.id });
});

// ============================================================
// REPORTS
// ============================================================

app.get('/reports/pipeline', requireApiKey, async (req, res) => {
    const { client_id } = req.query;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });

    const [openResult, actionResult, docsResult] = await Promise.all([
        supabase.from('cs_claims').select('*').eq('client_id', client_id)
            .not('status', 'in', '("closed","denied","paid")')
            .order('created_at', { ascending: false }),
        supabase.from('cs_claims').select('*').eq('client_id', client_id)
            .eq('needs_agent_action', true),
        supabase.from('cs_claim_documents').select('claim_id, doc_type, status')
            .eq('client_id', client_id).eq('status', 'requested')
    ]);

    const openClaims = openResult.data || [];

    // Group by status
    const byStatus = {};
    for (const claim of openClaims) {
        byStatus[claim.status] = byStatus[claim.status] || [];
        byStatus[claim.status].push(claim);
    }

    res.json({
        summary: {
            total_open: openClaims.length,
            needs_action: actionResult.data?.length || 0,
            pending_documents: docsResult.data?.length || 0
        },
        by_status: byStatus,
        needs_action: actionResult.data || [],
        pending_docs: docsResult.data || []
    });
});

app.get('/reports/metrics', requireApiKey, async (req, res) => {
    const { client_id, days = 90 } = req.query;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });

    const since = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000).toISOString();

    const { data: claims } = await supabase
        .from('cs_claims')
        .select('resolution_days, client_satisfaction, status, carrier_name, loss_type, created_at')
        .eq('client_id', client_id)
        .gte('created_at', since);

    const resolved = (claims || []).filter(c => c.resolution_days !== null);
    const rated = (claims || []).filter(c => c.client_satisfaction !== null);

    const avgResolutionDays = resolved.length > 0
        ? resolved.reduce((s, c) => s + c.resolution_days, 0) / resolved.length
        : null;

    const avgSatisfaction = rated.length > 0
        ? rated.reduce((s, c) => s + c.client_satisfaction, 0) / rated.length
        : null;

    // By carrier
    const carrierMap = {};
    for (const c of claims || []) {
        if (!carrierMap[c.carrier_name]) carrierMap[c.carrier_name] = { total: 0, resolved: 0, days: [] };
        carrierMap[c.carrier_name].total++;
        if (c.resolution_days !== null) {
            carrierMap[c.carrier_name].resolved++;
            carrierMap[c.carrier_name].days.push(c.resolution_days);
        }
    }

    const byCarrier = Object.entries(carrierMap).map(([name, data]) => ({
        carrier: name,
        total: data.total,
        resolved: data.resolved,
        avgResolutionDays: data.days.length > 0 ? (data.days.reduce((a, b) => a + b, 0) / data.days.length).toFixed(1) : null
    })).sort((a, b) => b.total - a.total);

    res.json({
        period_days: parseInt(days),
        total_claims: claims?.length || 0,
        avg_resolution_days: avgResolutionDays ? parseFloat(avgResolutionDays.toFixed(1)) : null,
        avg_satisfaction: avgSatisfaction ? parseFloat(avgSatisfaction.toFixed(2)) : null,
        by_carrier: byCarrier
    });
});

app.get('/reports/weekly', requireApiKey, async (req, res) => {
    const { client_id } = req.query;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });

    const { data } = await supabase
        .from('cs_weekly_reports')
        .select('*')
        .eq('client_id', client_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    if (!data) return res.status(404).json({ error: 'No weekly report found' });
    res.json(data);
});

// ============================================================
// CARRIERS + HEALTH
// ============================================================

app.get('/carriers', requireApiKey, (req, res) => {
    res.json({ carriers: carriers.listSupportedCarriers() });
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
        const { error } = await supabase.from('cs_clients').select('id').limit(1);
        dbOk = !error;
    } catch (_) {}

    res.json({
        status: 'ok',
        worker: 'claims-shepherd',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        database: dbOk ? 'connected' : 'error',
        queues: queueStats
    });
});

// Root
app.get('/', (req, res) => {
    res.json({
        name: 'GRIDHAND AI — Claims Shepherd',
        version: '1.0.0',
        description: 'Automated insurance claims filing, tracking, and client communication',
        endpoints: [
            'POST /webhook/sms',
            'POST /webhook/ams',
            'POST /webhook/email',
            'GET  /claims',
            'GET  /claims/:id',
            'POST /claims',
            'POST /claims/:id/file-fnol',
            'PATCH /claims/:id/status',
            'POST /trigger/status-check',
            'POST /trigger/client-update',
            'POST /trigger/document-reminder',
            'POST /trigger/weekly-report',
            'POST /trigger/ams-sync',
            'GET  /reports/pipeline',
            'GET  /reports/metrics',
            'GET  /reports/weekly',
            'GET  /carriers',
            'GET  /health'
        ]
    });
});

// ============================================================
// START
// ============================================================

app.listen(PORT, () => {
    console.log(`\n🛡️  GRIDHAND Claims Shepherd running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   Docs:   http://localhost:${PORT}/\n`);

    startCronJobs();
});

module.exports = app;
