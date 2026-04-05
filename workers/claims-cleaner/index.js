/**
 * GRIDHAND AI — Claims Cleaner
 * Main Express Server
 *
 * Endpoints:
 *   GET  /                              - Service info + endpoint list
 *   POST /auth/connect                  - Register a medical practice
 *   POST /webhooks/clearinghouse        - ERA/remittance webhook from clearinghouse
 *
 *   GET  /claims/:clientSlug            - List claims (filters: status, date range, payer)
 *   GET  /claims/:clientSlug/:claimId   - Claim detail with scrub results
 *   POST /claims/:clientSlug/scrub      - Manually scrub a claim (body: { claimData })
 *   POST /claims/:clientSlug/:claimId/resubmit — Resubmit corrected claim
 *
 *   GET  /denials/:clientSlug           - Denial log with reason codes
 *   GET  /analytics/:clientSlug         - Denial rate by payer, by code, clean claim rate, revenue recovered
 *
 *   POST /trigger/scrub-batch           - Scrub all pending claims
 *   POST /trigger/check-denials         - Fetch new denial ERAs from clearinghouse
 *
 * Cron:
 *   6am daily        — Overnight scrub batch
 *   Every 4 hours    — Check clearinghouse for new ERAs
 *   Monday 8am       — Weekly denial digest
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');

const pms = require('./practice-mgmt');
const ch = require('./clearinghouse');
const { scrubClaim, autoCorrectClaim, getComplexReviewNarrative, buildScrubReport, calculateTimelyFiling } = require('./scrubber');
const {
    queues,
    runScrubBatch,
    runSingleScrub,
    runCheckDenials,
    runResubmit,
    runWeeklyDigest,
    runForAllClients,
    startCronJobs,
    getQueueStats
} = require('./jobs');

const app = express();
const PORT = process.env.CC_PORT || 3012;

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

// API Key auth middleware
function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (!key || key !== process.env.CC_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// Load client connection by slug
async function loadConnection(clientSlug) {
    const { data } = await supabase
        .from('cc_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    return data;
}

// ============================================================
// HEALTH CHECK / SERVICE INFO
// ============================================================

app.get('/', async (req, res) => {
    let queueStats = {};
    let dbOk = false;

    try {
        queueStats = await getQueueStats();
    } catch (err) {
        queueStats = { error: err.message };
    }

    try {
        const { error } = await supabase.from('cc_connections').select('id').limit(1);
        dbOk = !error;
    } catch (_) {}

    res.json({
        name: 'GRIDHAND AI — Claims Cleaner',
        version: '1.0.0',
        description: 'Medical claims scrubbing, submission, and denial management',
        status: 'ok',
        database: dbOk ? 'connected' : 'error',
        queues: queueStats,
        endpoints: [
            'POST /auth/connect',
            'POST /webhooks/clearinghouse',
            'GET  /claims/:clientSlug',
            'GET  /claims/:clientSlug/:claimId',
            'POST /claims/:clientSlug/scrub',
            'POST /claims/:clientSlug/:claimId/resubmit',
            'GET  /denials/:clientSlug',
            'GET  /analytics/:clientSlug',
            'POST /trigger/scrub-batch',
            'POST /trigger/check-denials'
        ]
    });
});

// ============================================================
// AUTH: REGISTER PRACTICE
// ============================================================

app.post('/auth/connect', requireApiKey, async (req, res) => {
    const {
        client_slug, practice_name, billing_phone, staff_phone,
        pms_type, pms_api_key, pms_api_base_url, pms_practice_id,
        clearinghouse_type, clearinghouse_api_key, clearinghouse_submitter_id,
        npi, tax_id, taxonomy_code,
        timely_filing_days, auto_correct_enabled
    } = req.body;

    if (!client_slug || !practice_name || !pms_type || !clearinghouse_type) {
        return res.status(400).json({
            error: 'Required fields: client_slug, practice_name, pms_type, clearinghouse_type'
        });
    }

    const validPms = ['athena', 'ecw', 'kareo'];
    const validCH = ['availity', 'change_healthcare', 'waystar'];

    if (!validPms.includes(pms_type)) {
        return res.status(400).json({ error: `pms_type must be one of: ${validPms.join(', ')}` });
    }
    if (!validCH.includes(clearinghouse_type)) {
        return res.status(400).json({ error: `clearinghouse_type must be one of: ${validCH.join(', ')}` });
    }

    const record = {
        client_slug,
        practice_name,
        billing_phone: billing_phone || null,
        staff_phone: staff_phone || null,
        pms_type,
        pms_api_key: pms_api_key || null,
        pms_api_base_url: pms_api_base_url || null,
        pms_practice_id: pms_practice_id || null,
        clearinghouse_type,
        clearinghouse_api_key: clearinghouse_api_key || null,
        clearinghouse_submitter_id: clearinghouse_submitter_id || null,
        npi: npi || null,
        tax_id: tax_id || null,
        taxonomy_code: taxonomy_code || null,
        timely_filing_days: timely_filing_days || 90,
        auto_correct_enabled: auto_correct_enabled !== false
    };

    const { data, error } = await supabase
        .from('cc_connections')
        .upsert(record, { onConflict: 'client_slug' })
        .select()
        .single();

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.status(201).json({
        ok: true,
        message: `Practice "${practice_name}" connected successfully`,
        clientSlug: client_slug,
        pmsType: pms_type,
        clearinghouseType: clearinghouse_type
    });
});

// ============================================================
// WEBHOOK: CLEARINGHOUSE ERA / REMITTANCE
// ============================================================

app.post('/webhooks/clearinghouse', async (req, res) => {
    // Validate shared secret
    const secret = req.headers['x-webhook-secret'] || req.headers['x-api-key'];
    if (process.env.CC_WEBHOOK_SECRET && secret !== process.env.CC_WEBHOOK_SECRET) {
        return res.status(403).json({ error: 'Invalid webhook secret' });
    }

    const { client_slug, era_data, event_type } = req.body;

    if (!client_slug) {
        return res.status(400).json({ error: 'client_slug required' });
    }

    // Acknowledge immediately — process async
    res.json({ received: true, event_type: event_type || 'era' });

    // Parse ERA and update claim records
    if (era_data) {
        try {
            const { parseX12_835 } = require('./clearinghouse');
            const parsed = parseX12_835(era_data);

            for (const record of parsed) {
                const { data: claim } = await supabase
                    .from('cc_claims')
                    .select('*')
                    .eq('client_slug', client_slug)
                    .eq('claim_id', record.originalClaimId)
                    .single();

                if (!claim) continue;

                const updates = {
                    paid_amount: record.paidAmount || 0,
                    clearinghouse_status: record.status,
                    status: record.status === 'paid' ? 'paid' : record.status === 'denied' ? 'denied' : 'accepted',
                    updated_at: new Date().toISOString()
                };

                if (record.status === 'denied') {
                    updates.denial_code = record.denialCode;
                    updates.denial_reason = record.denialReason;
                    updates.denied_at = new Date().toISOString();

                    await supabase.from('cc_denial_log').insert({
                        client_slug,
                        claim_id: claim.id,
                        denial_code: record.denialCode,
                        denial_reason: record.denialReason,
                        dos: claim.dos,
                        payer_id: claim.payer_id,
                        amount: claim.billed_amount || 0,
                        action_taken: 'pending'
                    });
                }

                if (record.status === 'paid') {
                    updates.paid_at = new Date().toISOString();
                }

                await supabase.from('cc_claims').update(updates).eq('id', claim.id);
            }

            console.log(`[Webhook] ERA processed for ${client_slug}: ${parsed.length} records`);
        } catch (err) {
            console.error(`[Webhook] ERA parse error for ${client_slug}:`, err.message);
        }
    } else {
        // Queue ERA check job if no raw data provided
        await runCheckDenials(client_slug);
    }
});

// ============================================================
// CLAIMS — LIST
// GET /claims/:clientSlug?status=&date_from=&date_to=&payer_id=&page=&limit=
// ============================================================

app.get('/claims/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { status, date_from, date_to, payer_id, page = 1, limit = 50 } = req.query;

    const conn = await loadConnection(clientSlug);
    if (!conn) return res.status(404).json({ error: 'Client not found' });

    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
        .from('cc_claims')
        .select('*', { count: 'exact' })
        .eq('client_slug', clientSlug)
        .order('dos', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

    if (status) {
        const statuses = status.split(',').map(s => s.trim());
        query = query.in('status', statuses);
    }
    if (date_from) query = query.gte('dos', date_from);
    if (date_to) query = query.lte('dos', date_to);
    if (payer_id) query = query.eq('payer_id', payer_id);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({
        claims: data,
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(count / parseInt(limit))
    });
});

// ============================================================
// CLAIMS — DETAIL
// GET /claims/:clientSlug/:claimId
// ============================================================

app.get('/claims/:clientSlug/:claimId', requireApiKey, async (req, res) => {
    const { clientSlug, claimId } = req.params;

    const conn = await loadConnection(clientSlug);
    if (!conn) return res.status(404).json({ error: 'Client not found' });

    const { data: claim, error } = await supabase
        .from('cc_claims')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('id', claimId)
        .single();

    if (error || !claim) return res.status(404).json({ error: 'Claim not found' });

    // Get denial log entries for this claim
    const { data: denials } = await supabase
        .from('cc_denial_log')
        .select('*')
        .eq('claim_id', claimId)
        .order('created_at', { ascending: false });

    // Timely filing check
    const timelyFiling = claim.dos
        ? calculateTimelyFiling(claim.payer_name, claim.dos)
        : null;

    res.json({
        claim,
        denials: denials || [],
        timelyFiling,
        scrubSummary: {
            score: claim.scrub_score,
            passed: (claim.scrub_errors || []).length === 0,
            errorCount: (claim.scrub_errors || []).length,
            warningCount: (claim.scrub_warnings || []).length,
            autoCorrections: (claim.auto_corrections || []).length
        }
    });
});

// ============================================================
// CLAIMS — MANUAL SCRUB
// POST /claims/:clientSlug/scrub
// Body: { claimData: ClaimObject }
// ============================================================

app.post('/claims/:clientSlug/scrub', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { claimData } = req.body;

    if (!claimData) return res.status(400).json({ error: 'claimData required in request body' });

    const conn = await loadConnection(clientSlug);
    if (!conn) return res.status(404).json({ error: 'Client not found' });

    // Fetch patient/provider info if IDs are present
    let patientInfo = null;
    let providerInfo = { npi: conn.npi, billingNpi: conn.npi, taxonomyCode: conn.taxonomy_code };

    if (claimData.patientId) {
        try {
            patientInfo = await pms.getPatientInfo(clientSlug, claimData.patientId);
        } catch (err) {
            console.warn(`[Scrub] Could not fetch patient info: ${err.message}`);
        }
    }

    const scrubResult = await scrubClaim(claimData, patientInfo, providerInfo);

    let finalClaim = claimData;
    let corrections = [];

    if (conn.auto_correct_enabled && scrubResult.autoFixable.length > 0) {
        const { corrected, corrections: autoCorrections } = autoCorrectClaim(claimData, scrubResult.autoFixable);
        finalClaim = corrected;
        corrections = autoCorrections;
        scrubResult.autoFixed = autoCorrections;
    }

    // Get narrative for complex cases
    let narrative = null;
    if (scrubResult.scrubScore < 60) {
        narrative = await getComplexReviewNarrative(claimData, scrubResult.errors, scrubResult.warnings);
    }

    const report = buildScrubReport(claimData, finalClaim, scrubResult.errors, scrubResult.warnings, corrections);

    res.json({
        ...report,
        narrative,
        correctedClaim: corrections.length > 0 ? finalClaim : null
    });
});

// ============================================================
// CLAIMS — RESUBMIT
// POST /claims/:clientSlug/:claimId/resubmit
// ============================================================

app.post('/claims/:clientSlug/:claimId/resubmit', requireApiKey, async (req, res) => {
    const { clientSlug, claimId } = req.params;

    const conn = await loadConnection(clientSlug);
    if (!conn) return res.status(404).json({ error: 'Client not found' });

    const { data: claim } = await supabase
        .from('cc_claims')
        .select('*')
        .eq('id', claimId)
        .eq('client_slug', clientSlug)
        .single();

    if (!claim) return res.status(404).json({ error: 'Claim not found' });

    const job = await runResubmit(clientSlug, claimId);
    res.json({ queued: true, jobId: job.id, claimId, message: 'Resubmission job queued' });
});

// ============================================================
// DENIALS — LOG
// GET /denials/:clientSlug?page=&limit=&denial_code=&payer_id=&action_taken=
// ============================================================

app.get('/denials/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { page = 1, limit = 50, denial_code, payer_id, action_taken } = req.query;

    const conn = await loadConnection(clientSlug);
    if (!conn) return res.status(404).json({ error: 'Client not found' });

    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
        .from('cc_denial_log')
        .select('*', { count: 'exact' })
        .eq('client_slug', clientSlug)
        .order('created_at', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

    if (denial_code) query = query.eq('denial_code', denial_code);
    if (payer_id) query = query.eq('payer_id', payer_id);
    if (action_taken) query = query.eq('action_taken', action_taken);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ denials: data, total: count, page: parseInt(page), limit: parseInt(limit) });
});

// ============================================================
// ANALYTICS
// GET /analytics/:clientSlug
// ============================================================

app.get('/analytics/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { days = 90 } = req.query;

    const conn = await loadConnection(clientSlug);
    if (!conn) return res.status(404).json({ error: 'Client not found' });

    const since = dayjs().subtract(parseInt(days), 'day').format('YYYY-MM-DD');

    const [claimsRes, denialsRes, weeklyRes] = await Promise.all([
        supabase.from('cc_claims')
            .select('status, billed_amount, paid_amount, payer_id, payer_name, scrub_score, auto_corrections, denial_code')
            .eq('client_slug', clientSlug)
            .gte('dos', since),
        supabase.from('cc_denial_log')
            .select('denial_code, denial_reason, payer_id, amount, action_taken, recovered_amount')
            .eq('client_slug', clientSlug)
            .gte('created_at', since),
        supabase.from('cc_weekly_stats')
            .select('*')
            .eq('client_slug', clientSlug)
            .gte('week_start', dayjs().subtract(12, 'week').format('YYYY-MM-DD'))
            .order('week_start', { ascending: false })
    ]);

    const claims = claimsRes.data || [];
    const denials = denialsRes.data || [];
    const weeklyStats = weeklyRes.data || [];

    // --- Totals ---
    const totalClaims = claims.length;
    const submitted = claims.filter(c => !['pending_scrub', 'scrubbed'].includes(c.status)).length;
    const paid = claims.filter(c => c.status === 'paid').length;
    const denied = claims.filter(c => c.status === 'denied').length;
    const totalBilled = claims.reduce((s, c) => s + (c.billed_amount || 0), 0);
    const totalCollected = claims.reduce((s, c) => s + (c.paid_amount || 0), 0);

    // Clean claim rate (claims with scrub score >= 90)
    const scrubbed = claims.filter(c => c.scrub_score != null);
    const cleanClaims = scrubbed.filter(c => c.scrub_score >= 90);
    const cleanClaimRate = scrubbed.length > 0 ? ((cleanClaims.length / scrubbed.length) * 100).toFixed(1) : '0.0';

    // Denial rate
    const denialRate = submitted > 0 ? ((denied / submitted) * 100).toFixed(1) : '0.0';

    // Auto-correction count
    const autoCorrected = claims.filter(c => (c.auto_corrections || []).length > 0).length;

    // --- Denial rate by payer ---
    const payerMap = {};
    for (const c of claims) {
        const key = c.payer_id || c.payer_name || 'Unknown';
        if (!payerMap[key]) payerMap[key] = { name: c.payer_name || key, submitted: 0, denied: 0 };
        if (!['pending_scrub', 'scrubbed'].includes(c.status)) payerMap[key].submitted++;
        if (c.status === 'denied') payerMap[key].denied++;
    }
    const denialByPayer = Object.values(payerMap)
        .filter(p => p.submitted > 0)
        .map(p => ({
            payer: p.name,
            submitted: p.submitted,
            denied: p.denied,
            denialRate: ((p.denied / p.submitted) * 100).toFixed(1) + '%'
        }))
        .sort((a, b) => parseFloat(b.denialRate) - parseFloat(a.denialRate))
        .slice(0, 10);

    // --- Denial rate by code ---
    const codeMap = {};
    for (const d of denials) {
        const code = d.denial_code || 'Unknown';
        if (!codeMap[code]) codeMap[code] = { code, reason: d.denial_reason, count: 0, amount: 0, recovered: 0 };
        codeMap[code].count++;
        codeMap[code].amount += d.amount || 0;
        codeMap[code].recovered += d.recovered_amount || 0;
    }
    const denialByCode = Object.values(codeMap)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

    // --- Revenue recovered from resubmissions ---
    const revenueRecovered = denials
        .filter(d => d.action_taken === 'resubmitted')
        .reduce((s, d) => s + (d.recovered_amount || 0), 0);

    res.json({
        period: `Last ${days} days`,
        summary: {
            totalClaims,
            submitted,
            paid,
            denied,
            autoCorrected,
            cleanClaimRate: `${cleanClaimRate}%`,
            denialRate: `${denialRate}%`,
            totalBilled: totalBilled.toFixed(2),
            totalCollected: totalCollected.toFixed(2),
            revenueRecovered: revenueRecovered.toFixed(2),
            collectionRate: totalBilled > 0 ? ((totalCollected / totalBilled) * 100).toFixed(1) + '%' : '0.0%'
        },
        denialByPayer,
        denialByCode,
        weeklyTrend: weeklyStats.map(w => ({
            weekStart: w.week_start,
            denialRate: w.denial_rate,
            cleanClaimRate: w.clean_claim_rate,
            submitted: w.claims_submitted,
            paid: w.claims_paid,
            denied: w.claims_denied,
            billed: w.revenue_billed,
            collected: w.revenue_collected
        }))
    });
});

// ============================================================
// TRIGGERS — MANUAL JOB INVOCATION
// ============================================================

app.post('/trigger/scrub-batch', requireApiKey, async (req, res) => {
    const { client_slug } = req.body;

    if (client_slug) {
        const conn = await loadConnection(client_slug);
        if (!conn) return res.status(404).json({ error: 'Client not found' });
        const job = await runScrubBatch(client_slug);
        return res.json({ queued: true, jobId: job.id, clientSlug: client_slug });
    }

    // Run for all clients
    const results = await runForAllClients(runScrubBatch);
    res.json({ queued: true, clients: results.length, results });
});

app.post('/trigger/check-denials', requireApiKey, async (req, res) => {
    const { client_slug } = req.body;

    if (client_slug) {
        const conn = await loadConnection(client_slug);
        if (!conn) return res.status(404).json({ error: 'Client not found' });
        const job = await runCheckDenials(client_slug);
        return res.json({ queued: true, jobId: job.id, clientSlug: client_slug });
    }

    const results = await runForAllClients(runCheckDenials);
    res.json({ queued: true, clients: results.length, results });
});

// ============================================================
// START
// ============================================================

app.listen(PORT, () => {
    console.log(`\n🩺 GRIDHAND Claims Cleaner running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/`);
    console.log(`   API:    http://localhost:${PORT}/claims/:clientSlug\n`);

    startCronJobs();
});

module.exports = app;
