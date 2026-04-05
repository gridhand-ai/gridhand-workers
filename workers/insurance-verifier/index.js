/**
 * GRIDHAND AI — Insurance Verifier
 * Main Express Server — Port IV_PORT (default 3008)
 *
 * Endpoints:
 *   GET  /                                          — Worker info + endpoint list
 *   GET  /health                                    — System health + queue stats
 *
 *   POST /auth/connect                              — Register a dental practice
 *   POST /webhooks/sms                              — Twilio inbound SMS webhook
 *
 *   GET  /verifications/:clientSlug                 — List recent verifications (date, status filters)
 *   GET  /verifications/:clientSlug/:verificationId — Single verification detail
 *   GET  /upcoming/:clientSlug                      — Appointments needing verification (next 3 days)
 *   GET  /flags/:clientSlug                         — Unresolved flagged verifications
 *
 *   POST /trigger/verify-upcoming                   — Manually trigger batch verification
 *   POST /trigger/send-cost-estimate/:clientSlug/:appointmentId — Send cost estimate to patient
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const dayjs = require('dayjs');
const { v4: uuidv4 } = require('uuid');

const pms = require('./pms');
const {
    verifyEligibility,
    formatCostEstimateMessage,
    sendVerificationToStaff
} = require('./eligibility');
const {
    queues,
    runVerifyBatch,
    runSingleVerification,
    runSendCostEstimates,
    runFlagAlert,
    startCronJobs,
    getQueueStats
} = require('./jobs');

const app = express();
const PORT = process.env.IV_PORT || 3008;

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (!key || key !== process.env.IV_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

async function loadConnection(clientSlug) {
    const { data } = await supabase
        .from('iv_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    return data;
}

async function loadConnectionByTwilioNumber(twilioNumber) {
    // Match on front_desk_phone or owner_phone
    const { data } = await supabase
        .from('iv_connections')
        .select('*')
        .or(`front_desk_phone.eq.${twilioNumber},owner_phone.eq.${twilioNumber}`)
        .limit(1)
        .single();
    return data;
}

// ============================================================
// ROOT — Worker info
// ============================================================

app.get('/', (req, res) => {
    res.json({
        name: 'GRIDHAND AI — Insurance Verifier',
        version: '1.0.0',
        description: 'Dental insurance eligibility automation: auto-verify patients, flag issues, estimate patient costs, text patients',
        endpoints: [
            'GET  /health',
            'POST /auth/connect',
            'POST /webhooks/sms',
            'GET  /verifications/:clientSlug',
            'GET  /verifications/:clientSlug/:verificationId',
            'GET  /upcoming/:clientSlug',
            'GET  /flags/:clientSlug',
            'POST /trigger/verify-upcoming',
            'POST /trigger/send-cost-estimate/:clientSlug/:appointmentId'
        ]
    });
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
        const { error } = await supabase
            .from('iv_connections')
            .select('id')
            .limit(1);
        dbOk = !error;
    } catch (_) {}

    res.json({
        status: 'ok',
        worker: 'insurance-verifier',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        database: dbOk ? 'connected' : 'error',
        queues: queueStats
    });
});

// ============================================================
// AUTH: CONNECT A PRACTICE
// ============================================================

app.post('/auth/connect', requireApiKey, async (req, res) => {
    const {
        client_slug,
        practice_name,
        owner_phone,
        front_desk_phone,
        pms_type,
        pms_api_key,
        pms_api_base_url,
        eligibility_provider,
        eligibility_api_key,
        eligibility_npi,
        notify_staff_on_flag,
        cost_estimate_sms_enabled,
        hours_before_appointment_to_verify
    } = req.body;

    const required = ['client_slug', 'practice_name', 'pms_type', 'pms_api_key',
                       'pms_api_base_url', 'eligibility_provider', 'eligibility_api_key'];
    const missing = required.filter(f => !req.body[f]);
    if (missing.length) {
        return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });
    }

    if (!['dentrix', 'open_dental'].includes(pms_type)) {
        return res.status(400).json({ error: 'pms_type must be dentrix or open_dental' });
    }

    if (!['vyne', 'dentalxchange'].includes(eligibility_provider)) {
        return res.status(400).json({ error: 'eligibility_provider must be vyne or dentalxchange' });
    }

    const { data, error } = await supabase
        .from('iv_connections')
        .upsert({
            client_slug,
            practice_name,
            owner_phone: owner_phone || null,
            front_desk_phone: front_desk_phone || null,
            pms_type,
            pms_api_key,
            pms_api_base_url,
            eligibility_provider,
            eligibility_api_key,
            eligibility_npi: eligibility_npi || null,
            notify_staff_on_flag: notify_staff_on_flag !== false,
            cost_estimate_sms_enabled: cost_estimate_sms_enabled !== false,
            hours_before_appointment_to_verify: hours_before_appointment_to_verify || 48
        }, {
            onConflict: 'client_slug',
            ignoreDuplicates: false
        })
        .select()
        .single();

    if (error) {
        console.error('[Connect] Upsert error:', error.message);
        return res.status(500).json({ error: error.message });
    }

    console.log(`[Connect] Practice registered: ${client_slug} — ${practice_name}`);
    res.status(201).json({ ok: true, connection: { id: data.id, client_slug, practice_name } });
});

// ============================================================
// WEBHOOK: INBOUND SMS (Twilio)
// Handles patient replies to cost estimate texts
// ============================================================

app.post('/webhooks/sms', async (req, res) => {
    const { From, To, Body } = req.body;

    // Validate Twilio signature in production
    if (process.env.NODE_ENV === 'production') {
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const signature = req.headers['x-twilio-signature'];
        const url = `${process.env.BASE_URL}/webhooks/sms`;
        const valid = twilio.validateRequest(authToken, signature, url, req.body);
        if (!valid) {
            return res.status(403).type('text/xml').send('<Response></Response>');
        }
    }

    // Respond immediately so Twilio doesn't time out
    res.type('text/xml').send('<Response></Response>');

    const conn = await loadConnectionByTwilioNumber(To);

    // Log inbound SMS regardless
    if (conn) {
        await supabase.from('iv_sms_log').insert({
            client_slug: conn.client_slug,
            patient_id: null,
            appointment_id: null,
            direction: 'inbound',
            message_body: Body || '',
            twilio_sid: req.body.MessageSid || null,
            status: 'received'
        });

        // Forward reply to front desk
        const forwardTo = conn.front_desk_phone || conn.owner_phone;
        if (forwardTo && forwardTo !== To) {
            try {
                await twilioClient.messages.create({
                    body: `[Patient reply to ${conn.practice_name}] From: ${From}\n"${Body}"`,
                    from: process.env.TWILIO_FROM_NUMBER,
                    to: forwardTo
                });
            } catch (err) {
                console.error('[SMS] Forward failed:', err.message);
            }
        }
    }
});

// ============================================================
// VERIFICATIONS: LIST
// ============================================================

app.get('/verifications/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { date, status, page = 1, limit = 50 } = req.query;

    const conn = await loadConnection(clientSlug);
    if (!conn) return res.status(404).json({ error: 'Client not found' });

    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
        .from('iv_verifications')
        .select('*', { count: 'exact' })
        .eq('client_slug', clientSlug)
        .order('appointment_date', { ascending: true })
        .range(offset, offset + parseInt(limit) - 1);

    if (date) query = query.eq('appointment_date', date);
    if (status) {
        const statuses = status.split(',');
        query = query.in('status', statuses);
    }

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({
        verifications: data,
        total: count,
        page: parseInt(page),
        limit: parseInt(limit)
    });
});

// ============================================================
// VERIFICATIONS: SINGLE DETAIL
// ============================================================

app.get('/verifications/:clientSlug/:verificationId', requireApiKey, async (req, res) => {
    const { clientSlug, verificationId } = req.params;

    const { data: ver, error } = await supabase
        .from('iv_verifications')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('id', verificationId)
        .single();

    if (!ver) return res.status(404).json({ error: 'Verification not found' });

    // Fetch flag log entries for this verification
    const { data: flagLogs } = await supabase
        .from('iv_flag_log')
        .select('*')
        .eq('verification_id', verificationId)
        .order('created_at', { ascending: false });

    // Fetch SMS log for this appointment
    const { data: smsLogs } = await supabase
        .from('iv_sms_log')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('appointment_id', ver.appointment_id)
        .order('created_at', { ascending: false });

    res.json({
        verification: ver,
        flagLogs: flagLogs || [],
        smsLogs: smsLogs || []
    });
});

// ============================================================
// UPCOMING: Appointments needing verification in next 3 days
// ============================================================

app.get('/upcoming/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const daysAhead = parseInt(req.query.days || '3');

    const conn = await loadConnection(clientSlug);
    if (!conn) return res.status(404).json({ error: 'Client not found' });

    const today = dayjs().format('YYYY-MM-DD');
    const until = dayjs().add(daysAhead, 'day').format('YYYY-MM-DD');

    // Get appointments from PMS
    let appointments = [];
    try {
        appointments = await pms.getUpcomingAppointments(clientSlug, daysAhead);
    } catch (err) {
        return res.status(502).json({ error: `PMS error: ${err.message}` });
    }

    // Cross-reference with verification table to show status
    const appointmentIds = appointments.map(a => String(a.appointmentId));
    const { data: verifications } = await supabase
        .from('iv_verifications')
        .select('appointment_id, status, verified_at, estimated_patient_portion, flags')
        .eq('client_slug', clientSlug)
        .in('appointment_id', appointmentIds);

    const verMap = {};
    for (const v of verifications || []) {
        verMap[v.appointment_id] = v;
    }

    const enriched = appointments.map(appt => ({
        ...appt,
        verificationStatus: verMap[appt.appointmentId]?.status || 'pending',
        verifiedAt: verMap[appt.appointmentId]?.verified_at || null,
        estimatedPatientPortion: verMap[appt.appointmentId]?.estimated_patient_portion || null,
        flags: verMap[appt.appointmentId]?.flags || []
    }));

    const needsVerification = enriched.filter(a => a.verificationStatus === 'pending' || a.verificationStatus === 'error');

    res.json({
        appointments: enriched,
        total: enriched.length,
        needsVerification: needsVerification.length
    });
});

// ============================================================
// FLAGS: Unresolved flagged verifications
// ============================================================

app.get('/flags/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { days = 7 } = req.query;

    const conn = await loadConnection(clientSlug);
    if (!conn) return res.status(404).json({ error: 'Client not found' });

    const since = dayjs().format('YYYY-MM-DD');
    const until = dayjs().add(parseInt(days), 'day').format('YYYY-MM-DD');

    const { data: flagLogs, error } = await supabase
        .from('iv_flag_log')
        .select(`
            *,
            iv_verifications (
                patient_name, patient_phone, appointment_date,
                insurance_carrier, member_id, status, eligible,
                estimated_patient_portion
            )
        `)
        .eq('client_slug', clientSlug)
        .eq('resolved', false)
        .gte('iv_verifications.appointment_date', since)
        .lte('iv_verifications.appointment_date', until)
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    // Group by flag_type for summary
    const byType = {};
    for (const fl of flagLogs || []) {
        byType[fl.flag_type] = (byType[fl.flag_type] || 0) + 1;
    }

    res.json({
        flags: flagLogs || [],
        total: flagLogs?.length || 0,
        by_type: byType
    });
});

// ============================================================
// TRIGGER: Verify upcoming batch (all clients or specific)
// ============================================================

app.post('/trigger/verify-upcoming', requireApiKey, async (req, res) => {
    const { client_slug } = req.body;

    if (client_slug) {
        const conn = await loadConnection(client_slug);
        if (!conn) return res.status(404).json({ error: 'Client not found' });

        const result = await runVerifyBatch(client_slug);
        return res.json(result);
    }

    // Run for all clients
    const { data: connections } = await supabase
        .from('iv_connections')
        .select('client_slug');

    const results = [];
    for (const c of connections || []) {
        try {
            const r = await runVerifyBatch(c.client_slug);
            results.push({ clientSlug: c.client_slug, ...r });
        } catch (err) {
            results.push({ clientSlug: c.client_slug, error: err.message });
        }
    }

    res.json({ triggered: results.length, results });
});

// ============================================================
// TRIGGER: Send cost estimate to a specific patient
// ============================================================

app.post('/trigger/send-cost-estimate/:clientSlug/:appointmentId', requireApiKey, async (req, res) => {
    const { clientSlug, appointmentId } = req.params;

    const conn = await loadConnection(clientSlug);
    if (!conn) return res.status(404).json({ error: 'Client not found' });

    const { data: ver } = await supabase
        .from('iv_verifications')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('appointment_id', String(appointmentId))
        .order('verified_at', { ascending: false })
        .limit(1)
        .single();

    if (!ver) {
        return res.status(404).json({
            error: 'No verification record found for this appointment. Run verification first.'
        });
    }

    if (!ver.patient_phone) {
        return res.status(400).json({ error: 'No patient phone number on record' });
    }

    // Queue the send
    const { queues: jobQueues } = require('./jobs');
    const job = await jobQueues.costEstimate.add('estimate', {
        clientSlug,
        appointmentId: String(appointmentId)
    }, { priority: 1 });

    res.json({ queued: true, jobId: job.id, patientId: ver.patient_id });
});

// ============================================================
// START
// ============================================================

app.listen(PORT, () => {
    console.log(`\n🦷  GRIDHAND Insurance Verifier running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   Docs:   http://localhost:${PORT}/\n`);

    startCronJobs();
});

module.exports = app;
