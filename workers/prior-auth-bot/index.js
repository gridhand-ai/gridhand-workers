/**
 * GRIDHAND AI — Prior Auth Bot
 * Main Express Server
 *
 * Endpoints:
 *   GET  /                          - Service info + endpoint list
 *   POST /auth/connect              - Register a medical practice
 *   POST /webhooks/payer            - Payer status callback webhook
 *
 *   GET  /auths/:clientSlug         - List prior auths (filters: status, payer, date range)
 *   GET  /auths/:clientSlug/:authId - Single auth detail with full timeline
 *   POST /auths/:clientSlug/submit  - Manually submit a prior auth
 *   POST /auths/:clientSlug/:authId/appeal - Trigger appeal workflow
 *
 *   GET  /analytics/:clientSlug     - Approval rates by payer, avg turnaround time
 *
 *   POST /trigger/scan-pending      - Scan EHR for orders needing auth
 *   POST /trigger/status-check      - Check status of all in-flight auths
 *
 *   GET  /health                    - System health + queue stats
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const dayjs = require('dayjs');
const { v4: uuidv4 } = require('uuid');

const ehr = require('./ehr');
const payers = require('./payers');
const workflow = require('./auth-workflow');
const { queues, runScanOrders, runStatusChecks, startCronJobs, getQueueStats } = require('./jobs');

const app = express();
const PORT = process.env.PAB_PORT || 3010;

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
    if (!key || key !== process.env.PAB_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

async function loadConnection(clientSlug) {
    const { data } = await supabase
        .from('pab_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    return data;
}

// ============================================================
// ROOT — service info
// ============================================================

app.get('/', (req, res) => {
    res.json({
        name: 'GRIDHAND AI — Prior Auth Bot',
        version: '1.0.0',
        description: 'Medical prior authorization automation — Epic/Cerner FHIR + payer portal integration',
        endpoints: [
            'POST /auth/connect',
            'POST /webhooks/payer',
            'GET  /auths/:clientSlug',
            'GET  /auths/:clientSlug/:authId',
            'POST /auths/:clientSlug/submit',
            'POST /auths/:clientSlug/:authId/appeal',
            'GET  /analytics/:clientSlug',
            'POST /trigger/scan-pending',
            'POST /trigger/status-check',
            'GET  /health'
        ]
    });
});

// ============================================================
// CONNECT — register a medical practice
// ============================================================

app.post('/auth/connect', requireApiKey, async (req, res) => {
    const {
        client_slug, practice_name, staff_phone, billing_phone,
        ehr_type, ehr_base_url, ehr_client_id, ehr_client_secret,
        npi, tax_id, auto_appeal, default_urgency, anthropic_key
    } = req.body;

    if (!client_slug || !practice_name || !ehr_type || !ehr_base_url || !ehr_client_id || !ehr_client_secret) {
        return res.status(400).json({
            error: 'Missing required fields: client_slug, practice_name, ehr_type, ehr_base_url, ehr_client_id, ehr_client_secret'
        });
    }

    if (!['epic', 'cerner'].includes(ehr_type)) {
        return res.status(400).json({ error: 'ehr_type must be "epic" or "cerner"' });
    }

    const { data, error } = await supabase
        .from('pab_connections')
        .upsert({
            client_slug,
            practice_name,
            staff_phone: staff_phone || null,
            billing_phone: billing_phone || null,
            ehr_type,
            ehr_base_url,
            ehr_client_id,
            ehr_client_secret,
            npi: npi || null,
            tax_id: tax_id || null,
            auto_appeal: auto_appeal === true,
            default_urgency: default_urgency || 'routine',
            anthropic_key: anthropic_key || null,
            updated_at: new Date().toISOString()
        }, { onConflict: 'client_slug' })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    res.status(201).json({
        ok: true,
        clientSlug: data.client_slug,
        message: `Practice "${practice_name}" connected successfully`
    });
});

// ============================================================
// WEBHOOK — payer status callbacks
// ============================================================

app.post('/webhooks/payer', async (req, res) => {
    // Validate shared secret from payer
    const secret = req.headers['x-webhook-secret'] || req.query.secret;
    if (process.env.PAB_WEBHOOK_SECRET && secret !== process.env.PAB_WEBHOOK_SECRET) {
        return res.status(403).json({ error: 'Invalid webhook secret' });
    }

    const { referenceNumber, status, authNumber, denialReason, expirationDate, clientSlug, payerId } = req.body;

    if (!referenceNumber || !status) {
        return res.status(400).json({ error: 'referenceNumber and status required' });
    }

    // Acknowledge immediately — process async
    res.json({ received: true });

    try {
        // Find the auth record
        let query = supabase
            .from('pab_auths')
            .select('*')
            .eq('reference_number', referenceNumber);

        if (clientSlug) query = query.eq('client_slug', clientSlug);

        const { data: authRecord } = await query.maybeSingle();

        if (!authRecord) {
            console.warn(`[Webhook] No auth found for referenceNumber: ${referenceNumber}`);
            return;
        }

        // Use the same status update logic
        await workflow.checkAndUpdateStatus(authRecord.client_slug, authRecord);

        console.log(`[Webhook] Status updated for auth ${authRecord.id}: ${status}`);
    } catch (err) {
        console.error('[Webhook] Processing error:', err.message);
    }
});

// ============================================================
// AUTHS — list
// ============================================================

app.get('/auths/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { status, payer_id, from, to, page = 1, limit = 50 } = req.query;

    const conn = await loadConnection(clientSlug);
    if (!conn) return res.status(404).json({ error: 'Client not found' });

    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
        .from('pab_auths')
        .select('*', { count: 'exact' })
        .eq('client_slug', clientSlug)
        .order('created_at', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

    if (status) {
        const statuses = status.split(',').map(s => s.trim());
        query = query.in('status', statuses);
    }
    if (payer_id) query = query.eq('payer_id', payer_id);
    if (from)    query = query.gte('submitted_at', from);
    if (to)      query = query.lte('submitted_at', to);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({
        auths: data,
        total: count,
        page: parseInt(page),
        limit: parseInt(limit)
    });
});

// ============================================================
// AUTHS — single detail with timeline
// ============================================================

app.get('/auths/:clientSlug/:authId', requireApiKey, async (req, res) => {
    const { clientSlug, authId } = req.params;

    const conn = await loadConnection(clientSlug);
    if (!conn) return res.status(404).json({ error: 'Client not found' });

    const [authResult, timelineResult, smsResult] = await Promise.all([
        supabase.from('pab_auths').select('*').eq('id', authId).eq('client_slug', clientSlug).single(),
        supabase.from('pab_timeline').select('*').eq('auth_id', authId).order('created_at', { ascending: true }),
        supabase.from('pab_sms_log').select('*').eq('auth_id', authId).order('created_at', { ascending: false }).limit(20)
    ]);

    if (!authResult.data) return res.status(404).json({ error: 'Auth not found' });

    res.json({
        auth: authResult.data,
        timeline: timelineResult.data || [],
        smsLog: smsResult.data || []
    });
});

// ============================================================
// AUTHS — manual submit
// ============================================================

app.post('/auths/:clientSlug/submit', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { patientId, procedureCodes, diagnosisCodes, payerId, urgency, clinicalNotes } = req.body;

    const conn = await loadConnection(clientSlug);
    if (!conn) return res.status(404).json({ error: 'Client not found' });

    if (!patientId || !procedureCodes || !payerId) {
        return res.status(400).json({ error: 'patientId, procedureCodes, and payerId are required' });
    }

    // Build a synthetic order object and run the workflow
    const syntheticOrder = {
        id: `manual-${uuidv4()}`,
        patientId,
        procedureCode: Array.isArray(procedureCodes) ? procedureCodes[0] : procedureCodes,
        procedureCodes: Array.isArray(procedureCodes) ? procedureCodes : [procedureCodes],
        priority: urgency === 'urgent' ? 'stat' : 'routine',
        notes: clinicalNotes || null,
        status: 'active',
        intent: 'order',
        authRequired: true // Force auth since this is a manual submission
    };

    // Override isAuthRequired check by injecting direct workflow call
    const patient = await ehr.getPatient(clientSlug, patientId).catch(() => null);
    const coverage = await ehr.getCoverage(clientSlug, patientId).catch(() => null);
    const conditions = await ehr.getConditions(clientSlug, patientId).catch(() => []);

    if (!coverage) return res.status(422).json({ error: 'No active coverage found for patient' });

    const resolvedPayerId = payerId || workflow.resolvePayer(coverage.payerName);
    const authRequest = {
        patientDOB: patient?.dob,
        memberId: coverage.memberId,
        groupNumber: coverage.groupNumber,
        npi: conn.npi,
        procedureCodes: Array.isArray(procedureCodes) ? procedureCodes : [procedureCodes],
        diagnosisCodes: diagnosisCodes || conditions.map(c => c.code).filter(Boolean),
        requestDate: dayjs().format('YYYY-MM-DD'),
        urgency: urgency || conn.default_urgency || 'routine',
        clinicalNotes: clinicalNotes || '',
        payerName: coverage.payerName,
        coverageFhirId: coverage.fhirId
    };

    const submitResult = await payers.submitAuthRequest(clientSlug, resolvedPayerId, authRequest);

    const { data: authRecord, error: insertError } = await supabase
        .from('pab_auths')
        .insert({
            client_slug: clientSlug,
            order_id: syntheticOrder.id,
            patient_id: patientId,
            patient_name: patient?.name || 'Unknown',
            payer_id: resolvedPayerId,
            payer_name: coverage.payerName,
            member_id: coverage.memberId,
            group_number: coverage.groupNumber,
            procedure_codes: authRequest.procedureCodes,
            diagnosis_codes: authRequest.diagnosisCodes,
            clinical_notes: clinicalNotes || null,
            urgency: authRequest.urgency,
            status: submitResult.ok ? 'submitted' : 'draft',
            reference_number: submitResult.referenceNumber || null,
            submitted_at: submitResult.ok ? new Date().toISOString() : null
        })
        .select()
        .single();

    if (insertError) return res.status(500).json({ error: insertError.message });

    res.status(201).json({
        ok: submitResult.ok,
        authId: authRecord.id,
        referenceNumber: submitResult.referenceNumber,
        status: authRecord.status,
        estimatedDecisionDate: submitResult.estimatedDecisionDate,
        method: submitResult.method
    });
});

// ============================================================
// AUTHS — trigger appeal
// ============================================================

app.post('/auths/:clientSlug/:authId/appeal', requireApiKey, async (req, res) => {
    const { clientSlug, authId } = req.params;

    const conn = await loadConnection(clientSlug);
    if (!conn) return res.status(404).json({ error: 'Client not found' });

    const { data: authRecord } = await supabase
        .from('pab_auths')
        .select('*')
        .eq('id', authId)
        .eq('client_slug', clientSlug)
        .single();

    if (!authRecord) return res.status(404).json({ error: 'Auth not found' });

    if (!['denied', 'appeal_denied'].includes(authRecord.status)) {
        return res.status(422).json({
            error: `Cannot appeal auth with status "${authRecord.status}" — must be denied or appeal_denied`
        });
    }

    // Queue the appeal job
    const job = await queues['pab:appeal'].add('appeal', {
        clientSlug,
        authId
    }, { priority: 1, jobId: `appeal-${authId}` });

    res.json({
        ok: true,
        queued: true,
        jobId: job.id,
        message: 'Appeal workflow queued — letter will be generated and submitted'
    });
});

// ============================================================
// ANALYTICS
// ============================================================

app.get('/analytics/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { days = 30 } = req.query;

    const conn = await loadConnection(clientSlug);
    if (!conn) return res.status(404).json({ error: 'Client not found' });

    const since = dayjs().subtract(parseInt(days), 'day').toISOString();

    const { data: auths } = await supabase
        .from('pab_auths')
        .select('payer_id, payer_name, status, submitted_at, decision_at, urgency')
        .eq('client_slug', clientSlug)
        .gte('created_at', since);

    const all = auths || [];
    const decided = all.filter(a => a.decision_at && a.submitted_at);

    // Turnaround hours per decided auth
    const turnaroundHours = decided.map(a => {
        const hrs = (new Date(a.decision_at) - new Date(a.submitted_at)) / 3_600_000;
        return hrs;
    }).filter(h => h >= 0);

    const avgTurnaround = turnaroundHours.length > 0
        ? (turnaroundHours.reduce((a, b) => a + b, 0) / turnaroundHours.length).toFixed(1)
        : null;

    // By payer
    const payerMap = {};
    for (const auth of all) {
        const key = auth.payer_id || 'UNKNOWN';
        if (!payerMap[key]) {
            payerMap[key] = {
                payer_id: key,
                payer_name: auth.payer_name || key,
                total: 0,
                approved: 0,
                denied: 0,
                pending: 0,
                appealing: 0,
                appeal_approved: 0,
                turnaroundHours: []
            };
        }
        payerMap[key].total++;
        if (['approved', 'appeal_approved'].includes(auth.status)) payerMap[key].approved++;
        else if (['denied', 'appeal_denied'].includes(auth.status)) payerMap[key].denied++;
        else if (['submitted', 'pending'].includes(auth.status)) payerMap[key].pending++;
        else if (auth.status === 'appealing') payerMap[key].appealing++;

        if (auth.decision_at && auth.submitted_at) {
            const hrs = (new Date(auth.decision_at) - new Date(auth.submitted_at)) / 3_600_000;
            if (hrs >= 0) payerMap[key].turnaroundHours.push(hrs);
        }
    }

    const byPayer = Object.values(payerMap).map(p => ({
        payer_id: p.payer_id,
        payer_name: p.payer_name,
        total: p.total,
        approved: p.approved,
        denied: p.denied,
        pending: p.pending,
        approval_rate: p.total > 0 ? ((p.approved / p.total) * 100).toFixed(1) + '%' : null,
        avg_turnaround_hours: p.turnaroundHours.length > 0
            ? parseFloat((p.turnaroundHours.reduce((a, b) => a + b, 0) / p.turnaroundHours.length).toFixed(1))
            : null
    })).sort((a, b) => b.total - a.total);

    // Overall stats
    const approved = all.filter(a => ['approved', 'appeal_approved'].includes(a.status)).length;
    const denied = all.filter(a => ['denied', 'appeal_denied'].includes(a.status)).length;
    const pending = all.filter(a => ['submitted', 'pending'].includes(a.status)).length;

    res.json({
        period_days: parseInt(days),
        total: all.length,
        approved,
        denied,
        pending,
        overall_approval_rate: all.length > 0 ? ((approved / all.length) * 100).toFixed(1) + '%' : null,
        avg_turnaround_hours: avgTurnaround ? parseFloat(avgTurnaround) : null,
        by_payer: byPayer
    });
});

// ============================================================
// TRIGGER ENDPOINTS
// ============================================================

app.post('/trigger/scan-pending', requireApiKey, async (req, res) => {
    const { client_slug } = req.body;

    if (client_slug) {
        const conn = await loadConnection(client_slug);
        if (!conn) return res.status(404).json({ error: 'Client not found' });

        const job = await queues['pab:scan-orders'].add('scan', { clientSlug: client_slug }, { priority: 1 });
        return res.json({ queued: true, jobId: job.id, clientSlug: client_slug });
    }

    // All clients
    const { data: connections } = await supabase.from('pab_connections').select('client_slug');
    const jobs = [];
    for (const conn of connections || []) {
        const job = await queues['pab:scan-orders'].add('scan', { clientSlug: conn.client_slug }, {
            jobId: `scan-${conn.client_slug}-${Date.now()}`
        });
        jobs.push(job.id);
    }

    res.json({ queued: true, jobCount: jobs.length });
});

app.post('/trigger/status-check', requireApiKey, async (req, res) => {
    const { client_slug } = req.body;

    if (client_slug) {
        const conn = await loadConnection(client_slug);
        if (!conn) return res.status(404).json({ error: 'Client not found' });

        const job = await queues['pab:status-check'].add('check', { clientSlug: client_slug }, { priority: 1 });
        return res.json({ queued: true, jobId: job.id, clientSlug: client_slug });
    }

    const { data: connections } = await supabase.from('pab_connections').select('client_slug');
    const jobs = [];
    for (const conn of connections || []) {
        const job = await queues['pab:status-check'].add('check', { clientSlug: conn.client_slug }, {
            jobId: `status-${conn.client_slug}-${Date.now()}`
        });
        jobs.push(job.id);
    }

    res.json({ queued: true, jobCount: jobs.length });
});

// ============================================================
// HEALTH
// ============================================================

app.get('/health', async (req, res) => {
    let queueStats = {};
    let dbOk = false;

    try {
        queueStats = await getQueueStats();
    } catch (err) {
        queueStats = { error: err.message };
    }

    try {
        const { error } = await supabase.from('pab_connections').select('client_slug').limit(1);
        dbOk = !error;
    } catch (_) {}

    res.json({
        status: 'ok',
        worker: 'prior-auth-bot',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        database: dbOk ? 'connected' : 'error',
        queues: queueStats,
        supportedPayers: payers.listPayers().map(p => p.name)
    });
});

// ============================================================
// START
// ============================================================

app.listen(PORT, () => {
    console.log(`\n🏥  GRIDHAND Prior Auth Bot running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   Docs:   http://localhost:${PORT}/\n`);

    startCronJobs();
});

module.exports = app;
