'use strict';

/**
 * GridHand AI — Cross-Sell Scanner
 * Express server with REST endpoints + Bull queue management
 *
 * POST /scan/:agencySlug          — Trigger full book scan immediately
 * POST /scan/:agencySlug/delta    — Delta scan (last 24h changes only)
 * GET  /opportunities/:agencySlug — List open opportunities (ranked)
 * POST /opportunities/:id/send    — Trigger outreach for a single opportunity
 * POST /opportunities/:id/convert — Mark opportunity as converted
 * POST /opportunities/:id/dismiss — Dismiss an opportunity
 * GET  /reports/:agencySlug/weekly  — Latest weekly report
 * GET  /reports/:agencySlug/monthly — Latest monthly report
 * GET  /clients/:agencySlug        — List clients with gap counts
 * GET  /clients/:agencySlug/:clientId/gaps — Gaps for a single client
 * POST /agencies                  — Register a new agency
 * GET  /health                    — Health check
 * GET  /queue/status              — Queue job counts
 */

require('dotenv').config();

const express         = require('express');
const { createClient } = require('@supabase/supabase-js');
const { queues, scheduleRecurringJobs } = require('./jobs');
const { syncBookOfBusiness, syncDelta } = require('./ams');
const { analyzeBook }   = require('./analyzer');
const { sendBulkAlerts, processOpportunity } = require('./outreach');

const app  = express();
const PORT = process.env.PORT || 3003;

app.use(express.json());

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

const API_KEY = process.env.GRIDHAND_API_KEY;

function requireAuth(req, res, next) {
    if (!API_KEY) return next(); // no key set — open in dev
    const authHeader = req.headers.authorization || '';
    const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized — invalid or missing API key' });
    }
    next();
}

app.use(requireAuth);

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

function getSupabase() {
    return createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY,
    );
}

async function getAgencyBySlug(supabase, slug) {
    const { data, error } = await supabase
        .from('css_agencies')
        .select('*')
        .eq('slug', slug)
        .eq('active', true)
        .single();
    if (error || !data) throw new Error(`Agency not found: ${slug}`);
    return data;
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
    res.json({
        status:    'ok',
        service:   'cross-sell-scanner',
        version:   '1.0.0',
        timestamp: new Date().toISOString(),
    });
});

// ---------------------------------------------------------------------------
// Queue status
// ---------------------------------------------------------------------------

app.get('/queue/status', async (req, res) => {
    try {
        const status = {};
        for (const [name, queue] of Object.entries(queues)) {
            const [waiting, active, completed, failed] = await Promise.all([
                queue.getWaitingCount(),
                queue.getActiveCount(),
                queue.getCompletedCount(),
                queue.getFailedCount(),
            ]);
            status[name] = { waiting, active, completed, failed };
        }
        res.json({ queues: status });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---------------------------------------------------------------------------
// Agency management
// ---------------------------------------------------------------------------

app.post('/agencies', async (req, res) => {
    const supabase = getSupabase();
    const {
        slug, name, ams_type, ams_credentials,
        twilio_number, agent_phone,
        twilio_account_sid, twilio_auth_token, anthropic_api_key,
        settings,
    } = req.body;

    if (!slug || !name || !ams_type) {
        return res.status(400).json({ error: 'slug, name, and ams_type are required' });
    }

    const { data, error } = await supabase
        .from('css_agencies')
        .upsert({
            slug, name, ams_type, ams_credentials,
            twilio_number, agent_phone,
            twilio_account_sid, twilio_auth_token, anthropic_api_key,
            settings: settings || {},
        }, { onConflict: 'slug' })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ agency: data });
});

// ---------------------------------------------------------------------------
// Scan endpoints
// ---------------------------------------------------------------------------

// Full book scan — enqueues a job and returns immediately
app.post('/scan/:agencySlug', async (req, res) => {
    const supabase = getSupabase();
    try {
        const agency = await getAgencyBySlug(supabase, req.params.agencySlug);
        const job    = await queues.dailyScan.add({ agencyId: agency.id });
        res.json({ queued: true, jobId: job.id, agencySlug: req.params.agencySlug });
    } catch (e) {
        res.status(404).json({ error: e.message });
    }
});

// Synchronous scan (waits for result) — use for small books or testing
app.post('/scan/:agencySlug/now', async (req, res) => {
    const supabase = getSupabase();
    try {
        const agency = await getAgencyBySlug(supabase, req.params.agencySlug);

        console.log(`[Scan] Starting sync scan for ${agency.slug}`);
        const { clients, policies } = await syncBookOfBusiness(agency);
        const { results, allOpportunities } = analyzeBook(clients, policies);

        // Queue top-5 outreach alerts
        const topOpps = allOpportunities.slice(0, 5).map(o => ({
            opportunity: {
                ...o,
                id:        null,
                agency_id: agency.id,
                client_id: null,
            },
            client: o.client,
        }));

        const alerts = await sendBulkAlerts({ agency, opportunities: topOpps, supabase: null, maxAlerts: 5 });

        res.json({
            agencySlug:   agency.slug,
            clients:      clients.length,
            policies:     policies.length,
            clientsWithGaps: results.length,
            totalOpportunities: allOpportunities.length,
            alertsSent:   alerts.filter(a => a.success).length,
            topOpportunities: allOpportunities.slice(0, 10).map(o => ({
                client:           o.client.full_name,
                opportunity:      o.title,
                estimated_premium: o.estimated_premium,
                composite_score:  o.composite_score,
            })),
        });
    } catch (e) {
        console.error(`[Scan] Error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Delta scan — only pull AMS changes from the last 24h
app.post('/scan/:agencySlug/delta', async (req, res) => {
    const supabase = getSupabase();
    try {
        const agency = await getAgencyBySlug(supabase, req.params.agencySlug);
        const job    = await queues.lifeEventScan.add({ agencyId: agency.id });
        res.json({ queued: true, jobId: job.id, type: 'delta' });
    } catch (e) {
        res.status(404).json({ error: e.message });
    }
});

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

app.get('/opportunities/:agencySlug', async (req, res) => {
    const supabase = getSupabase();
    try {
        const agency = await getAgencyBySlug(supabase, req.params.agencySlug);
        const status = req.query.status || 'open';
        const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;

        const { data, error, count } = await supabase
            .from('css_opportunities')
            .select('*, css_clients(full_name, phone, email)', { count: 'exact' })
            .eq('agency_id', agency.id)
            .eq('status', status)
            .order('composite_score', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) return res.status(500).json({ error: error.message });

        res.json({
            agencySlug: agency.slug,
            status,
            total:       count,
            offset,
            limit,
            opportunities: data,
        });
    } catch (e) {
        res.status(404).json({ error: e.message });
    }
});

// Send outreach for a specific opportunity
app.post('/opportunities/:id/send', async (req, res) => {
    try {
        const job = await queues.outreachSend.add({ opportunityId: req.params.id });
        res.json({ queued: true, jobId: job.id, opportunityId: req.params.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Mark opportunity as converted (agent records the win)
app.post('/opportunities/:id/convert', async (req, res) => {
    const supabase = getSupabase();
    const { policy_written, premium_written, notes } = req.body;

    const { data: opp, error: oppError } = await supabase
        .from('css_opportunities')
        .select('agency_id, client_id')
        .eq('id', req.params.id)
        .single();

    if (oppError || !opp) return res.status(404).json({ error: 'Opportunity not found' });

    // Update opportunity status
    await supabase
        .from('css_opportunities')
        .update({ status: 'converted', updated_at: new Date().toISOString() })
        .eq('id', req.params.id);

    // Record conversion
    const { data: conversion } = await supabase
        .from('css_conversions')
        .insert({
            agency_id:      opp.agency_id,
            opportunity_id: req.params.id,
            client_id:      opp.client_id,
            policy_written,
            premium_written: parseFloat(premium_written) || 0,
            notes,
            converted_at:   new Date().toISOString(),
        })
        .select()
        .single();

    res.json({ success: true, conversion });
});

// Dismiss an opportunity (won't resurface)
app.post('/opportunities/:id/dismiss', async (req, res) => {
    const supabase = getSupabase();
    const { reason } = req.body;

    const { error } = await supabase
        .from('css_opportunities')
        .update({ status: 'dismissed', updated_at: new Date().toISOString() })
        .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });

    // Also dismiss the underlying gap
    await supabase
        .from('css_coverage_gaps')
        .update({ dismissed: true, dismissed_at: new Date().toISOString(), dismissed_reason: reason || null })
        .eq('id', req.body.gap_id || '');

    res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

app.get('/reports/:agencySlug/weekly', async (req, res) => {
    const supabase = getSupabase();
    try {
        const agency = await getAgencyBySlug(supabase, req.params.agencySlug);
        const { data } = await supabase
            .from('css_weekly_reports')
            .select('*')
            .eq('agency_id', agency.id)
            .order('week_start', { ascending: false })
            .limit(1)
            .single();
        res.json({ report: data || null });
    } catch (e) {
        res.status(404).json({ error: e.message });
    }
});

app.get('/reports/:agencySlug/monthly', async (req, res) => {
    const supabase = getSupabase();
    try {
        const agency = await getAgencyBySlug(supabase, req.params.agencySlug);
        const { data } = await supabase
            .from('css_monthly_reports')
            .select('*')
            .eq('agency_id', agency.id)
            .order('month', { ascending: false })
            .limit(1)
            .single();
        res.json({ report: data || null });
    } catch (e) {
        res.status(404).json({ error: e.message });
    }
});

// Manually trigger reports
app.post('/reports/:agencySlug/weekly/generate', async (req, res) => {
    const job = await queues.weeklyReport.add({});
    res.json({ queued: true, jobId: job.id });
});

app.post('/reports/:agencySlug/monthly/generate', async (req, res) => {
    const job = await queues.monthlyReport.add({});
    res.json({ queued: true, jobId: job.id });
});

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

app.get('/clients/:agencySlug', async (req, res) => {
    const supabase = getSupabase();
    try {
        const agency = await getAgencyBySlug(supabase, req.params.agencySlug);
        const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;

        const { data, count } = await supabase
            .from('css_clients')
            .select('*, css_coverage_gaps(id, severity, gap_type)', { count: 'exact' })
            .eq('agency_id', agency.id)
            .range(offset, offset + limit - 1)
            .order('full_name');

        res.json({ total: count, clients: data });
    } catch (e) {
        res.status(404).json({ error: e.message });
    }
});

app.get('/clients/:agencySlug/:clientId/gaps', async (req, res) => {
    const supabase = getSupabase();
    try {
        const agency = await getAgencyBySlug(supabase, req.params.agencySlug);

        const { data: client } = await supabase
            .from('css_clients')
            .select('*')
            .eq('agency_id', agency.id)
            .eq('ams_client_id', req.params.clientId)
            .single();

        if (!client) return res.status(404).json({ error: 'Client not found' });

        const { data: gaps }    = await supabase
            .from('css_coverage_gaps')
            .select('*')
            .eq('client_id', client.id)
            .eq('dismissed', false);

        const { data: policies } = await supabase
            .from('css_policies')
            .select('*')
            .eq('client_id', client.id);

        const { data: opps } = await supabase
            .from('css_opportunities')
            .select('*')
            .eq('client_id', client.id)
            .order('composite_score', { ascending: false });

        res.json({ client, policies, gaps, opportunities: opps });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---------------------------------------------------------------------------
// Life events
// ---------------------------------------------------------------------------

app.get('/life-events/:agencySlug', async (req, res) => {
    const supabase = getSupabase();
    try {
        const agency = await getAgencyBySlug(supabase, req.params.agencySlug);
        const { data } = await supabase
            .from('css_life_events')
            .select('*, css_clients(full_name)')
            .eq('agency_id', agency.id)
            .order('created_at', { ascending: false })
            .limit(50);
        res.json({ events: data });
    } catch (e) {
        res.status(404).json({ error: e.message });
    }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
    // Validate required env vars
    const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
    const missing  = required.filter(k => !process.env[k]);
    if (missing.length) {
        console.error(`[CrossSellScanner] Missing required env vars: ${missing.join(', ')}`);
        process.exit(1);
    }

    // Schedule recurring Bull jobs
    await scheduleRecurringJobs();

    app.listen(PORT, () => {
        console.log(`[CrossSellScanner] Running on port ${PORT}`);
        console.log(`[CrossSellScanner] Endpoints: /health, /scan/:slug, /opportunities/:slug, /reports/:slug/*`);
    });
}

start().catch(e => {
    console.error(`[CrossSellScanner] Fatal startup error: ${e.message}`);
    process.exit(1);
});

module.exports = app;
