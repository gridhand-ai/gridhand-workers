// ============================================================
// Renewal Radar — Main Express Server
// GRIDHAND AI Insurance Worker
//
// Endpoints:
//   GET  /                          — Health check
//   GET  /status                    — Queue depths + last run
//   POST /scan/:clientSlug          — Trigger immediate policy scan
//   POST /quote/:clientSlug/:renewalId — Trigger quote pull for one renewal
//   GET  /pipeline/:clientSlug      — Upcoming renewals sorted by premium
//   GET  /quotes/:clientSlug/:renewalId — All quotes for a renewal
//   GET  /outreach/:clientSlug      — Outreach log
//   GET  /report/:clientSlug        — Latest weekly report
//   GET  /stats/:clientSlug         — Retention stats
//   POST /outcome/:renewalId        — Record renewal outcome (kept/lost)
//   POST /webhook/ezlynx            — EZLynx policy change webhook
//
// Auth: Authorization: Bearer {GRIDHAND_API_KEY} on all write endpoints
// ============================================================

'use strict';

require('dotenv').config();

const express  = require('express');
const { createClient: createSupabase } = require('@supabase/supabase-js');
const ezlynx   = require('./ezlynx');
const carriers = require('./carriers');
const outreach = require('./outreach');
const jobs     = require('./jobs');

const app  = express();
const PORT = process.env.RENEWAL_RADAR_PORT || 3002;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Auth Middleware ──────────────────────────────────────────

function requireAuth(req, res, next) {
    const key = process.env.GRIDHAND_API_KEY;
    if (!key) return next();         // No key configured — open mode (dev)

    const header = req.headers['authorization'] || '';
    const token  = header.replace('Bearer ', '').trim();

    if (token !== key) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ─── Supabase ─────────────────────────────────────────────────

let supabase = null;
function getDB() {
    if (!supabase) {
        supabase = createSupabase(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY
        );
    }
    return supabase;
}

// ─── Client Config Loader ─────────────────────────────────────

function loadClientConfig(clientSlug) {
    try {
        return require(`../../clients/${clientSlug}.json`);
    } catch {
        return null;
    }
}

// ─── Routes ──────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
    res.json({
        worker:  'renewal-radar',
        version: '1.0.0',
        status:  'running',
        uptime:  Math.floor(process.uptime()),
        queues:  [
            'renewal-radar:daily-scan',
            'renewal-radar:quote-pull',
            'renewal-radar:client-outreach',
            'renewal-radar:agent-alert',
            'renewal-radar:weekly-report',
        ],
        endpoints: {
            scan:     'POST /scan/:clientSlug',
            pipeline: 'GET  /pipeline/:clientSlug',
            quotes:   'GET  /quotes/:clientSlug/:renewalId',
            outreach: 'GET  /outreach/:clientSlug',
            report:   'GET  /report/:clientSlug',
            stats:    'GET  /stats/:clientSlug',
            outcome:  'POST /outcome/:renewalId',
        },
    });
});

// Queue status
app.get('/status', requireAuth, async (req, res) => {
    try {
        const queueList = [
            jobs.dailyScanQueue,
            jobs.quotePullQueue,
            jobs.clientOutreachQueue,
            jobs.agentAlertQueue,
            jobs.weeklyReportQueue,
        ];

        const status = await Promise.all(queueList.map(async q => {
            const [waiting, active, completed, failed] = await Promise.all([
                q.getWaitingCount(),
                q.getActiveCount(),
                q.getCompletedCount(),
                q.getFailedCount(),
            ]);
            return { queue: q.name, waiting, active, completed, failed };
        }));

        res.json({ status: 'ok', queues: status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Trigger immediate policy scan
app.post('/scan/:clientSlug', requireAuth, async (req, res) => {
    const { clientSlug } = req.params;
    const { daysAhead = 60 } = req.body;

    const config = loadClientConfig(clientSlug);
    if (!config) return res.status(404).json({ error: `Client '${clientSlug}' not found` });

    const ezlynxConfig = config.integrations?.ezlynx || {};

    try {
        const job = await jobs.dailyScanQueue.add({
            clientSlug,
            ezlynxConfig,
            daysAhead: parseInt(daysAhead),
        }, {
            jobId: `manual-scan-${clientSlug}-${Date.now()}`,
        });

        res.json({
            message: `Scan triggered for ${clientSlug}`,
            jobId:   job.id,
            daysAhead,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Trigger quote pull for a specific renewal
app.post('/quote/:clientSlug/:renewalId', requireAuth, async (req, res) => {
    const { clientSlug, renewalId } = req.params;
    const config = loadClientConfig(clientSlug);
    if (!config) return res.status(404).json({ error: `Client '${clientSlug}' not found` });

    try {
        const job = await jobs.quotePullQueue.add({
            clientSlug,
            ezlynxConfig: config.integrations?.ezlynx || {},
            renewalId,
            daysLeft: req.body.daysLeft || 30,
        }, {
            jobId: `manual-quote-${renewalId}-${Date.now()}`,
        });

        res.json({ message: 'Quote pull queued', jobId: job.id, renewalId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Upcoming renewals pipeline sorted by premium
app.get('/pipeline/:clientSlug', requireAuth, async (req, res) => {
    const { clientSlug } = req.params;
    const { days = 60, stage, minPremium } = req.query;
    const db = getDB();

    try {
        let query = db.from('rr_renewals')
            .select(`
                id, renewal_date, days_until_renewal, stage,
                current_premium, best_quote_premium, best_quote_carrier,
                savings_potential, outreach_count, agent_alerted, outcome,
                rr_policies (
                    id, policy_number, carrier, line_of_business,
                    insured_name, insured_email, insured_phone,
                    annual_premium
                )
            `)
            .eq('client_slug', clientSlug)
            .gte('renewal_date', new Date().toISOString().split('T')[0])
            .lte('renewal_date', new Date(Date.now() + parseInt(days) * 86400000).toISOString().split('T')[0])
            .order('current_premium', { ascending: false });

        if (stage)      query = query.eq('stage', stage);
        if (minPremium) query = query.gte('current_premium', parseFloat(minPremium));

        const { data, error } = await query;
        if (error) throw error;

        const totalPremium = (data || []).reduce((s, r) => s + (r.current_premium || 0), 0);
        const totalSavings = (data || []).reduce((s, r) => s + (r.savings_potential || 0), 0);

        res.json({
            clientSlug,
            daysAhead:    parseInt(days),
            count:        data?.length || 0,
            totalPremium: totalPremium.toFixed(2),
            totalSavings: totalSavings.toFixed(2),
            pipeline:     data || [],
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// All carrier quotes for a renewal
app.get('/quotes/:clientSlug/:renewalId', requireAuth, async (req, res) => {
    const { clientSlug, renewalId } = req.params;
    const db = getDB();

    try {
        const { data, error } = await db.from('rr_quotes')
            .select('*')
            .eq('client_slug', clientSlug)
            .eq('renewal_id', renewalId)
            .order('annual_premium', { ascending: true });

        if (error) throw error;

        // Get the renewal's current premium for comparison
        const { data: renewal } = await db.from('rr_renewals')
            .select('current_premium, rr_policies(carrier)')
            .eq('id', renewalId)
            .single();

        const currentPremium = renewal?.current_premium || 0;
        const currentCarrier = renewal?.rr_policies?.carrier;

        const enriched = (data || []).map(q => ({
            ...q,
            savings:    currentPremium - (q.annual_premium || 0),
            hasSavings: q.annual_premium < currentPremium,
        }));

        res.json({
            renewalId,
            currentCarrier,
            currentPremium,
            quotes:    enriched,
            bestQuote: enriched.filter(q => q.status === 'success')[0] || null,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Outreach log for a client
app.get('/outreach/:clientSlug', requireAuth, async (req, res) => {
    const { clientSlug } = req.params;
    const { limit = 50, channel, recipientType } = req.query;
    const db = getDB();

    try {
        let query = db.from('rr_outreach_log')
            .select('*')
            .eq('client_slug', clientSlug)
            .order('sent_at', { ascending: false })
            .limit(parseInt(limit));

        if (channel)       query = query.eq('channel', channel);
        if (recipientType) query = query.eq('recipient_type', recipientType);

        const { data, error } = await query;
        if (error) throw error;

        res.json({ clientSlug, count: data?.length || 0, outreach: data || [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Latest weekly report
app.get('/report/:clientSlug', requireAuth, async (req, res) => {
    const { clientSlug } = req.params;
    const db = getDB();

    try {
        const { data, error } = await db.from('rr_weekly_reports')
            .select('*')
            .eq('client_slug', clientSlug)
            .order('report_date', { ascending: false })
            .limit(1)
            .single();

        if (error && error.code !== 'PGRST116') throw error;
        if (!data) return res.status(404).json({ error: 'No report found. Run /scan first.' });

        res.json({ clientSlug, report: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Trigger weekly report generation
app.post('/report/:clientSlug', requireAuth, async (req, res) => {
    const { clientSlug } = req.params;

    try {
        const job = await jobs.weeklyReportQueue.add({ clientSlug }, {
            jobId: `report-${clientSlug}-${Date.now()}`,
        });
        res.json({ message: 'Weekly report queued', jobId: job.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Retention stats
app.get('/stats/:clientSlug', requireAuth, async (req, res) => {
    const { clientSlug } = req.params;
    const db = getDB();

    try {
        // Latest stats record
        const { data: latestStats } = await db.from('rr_retention_stats')
            .select('*')
            .eq('client_slug', clientSlug)
            .order('period_end', { ascending: false })
            .limit(1)
            .single();

        // Active pipeline counts by stage
        const { data: stageCounts } = await db.from('rr_renewals')
            .select('stage')
            .eq('client_slug', clientSlug)
            .gte('renewal_date', new Date().toISOString().split('T')[0]);

        const byStage = (stageCounts || []).reduce((acc, r) => {
            acc[r.stage] = (acc[r.stage] || 0) + 1;
            return acc;
        }, {});

        // Total outreach sent this month
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const { count: outreachThisMonth } = await db.from('rr_outreach_log')
            .select('id', { count: 'exact' })
            .eq('client_slug', clientSlug)
            .gte('sent_at', startOfMonth.toISOString());

        res.json({
            clientSlug,
            retentionStats:   latestStats || null,
            pipelineByStage:  byStage,
            outreachThisMonth: outreachThisMonth || 0,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Record renewal outcome (agent marks as renewed / lost)
app.post('/outcome/:renewalId', requireAuth, async (req, res) => {
    const { renewalId } = req.params;
    const { outcome, outcomePremium, outcomeCarrier, notes } = req.body;
    const db = getDB();

    const validOutcomes = ['renewed_same', 'renewed_new_carrier', 'lost', 'pending'];
    if (!validOutcomes.includes(outcome)) {
        return res.status(400).json({ error: `outcome must be one of: ${validOutcomes.join(', ')}` });
    }

    try {
        const { error } = await db.from('rr_renewals').update({
            outcome,
            outcome_premium: outcomePremium ? parseFloat(outcomePremium) : null,
            outcome_carrier: outcomeCarrier || null,
            notes:           notes || null,
            updated_at:      new Date().toISOString(),
        }).eq('id', renewalId);

        if (error) throw error;

        res.json({ message: 'Outcome recorded', renewalId, outcome });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// EZLynx webhook — policy changes (new policy, cancellation, endorsement)
app.post('/webhook/ezlynx', async (req, res) => {
    // Verify EZLynx webhook secret
    const secret = req.headers['x-ezlynx-secret'];
    if (process.env.EZLYNX_WEBHOOK_SECRET && secret !== process.env.EZLYNX_WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    const { event, policyId, clientSlug } = req.body;
    console.log(`[webhook/ezlynx] Event: ${event}, policyId: ${policyId}, client: ${clientSlug}`);

    // Acknowledge immediately
    res.json({ received: true });

    // Process async
    setImmediate(async () => {
        try {
            if (event === 'policy.renewed' || event === 'policy.cancelled') {
                const db = getDB();
                const status = event === 'policy.renewed' ? 'renewed' : 'cancelled';
                await db.from('rr_policies')
                    .update({ status, updated_at: new Date().toISOString() })
                    .eq('ezlynx_policy_id', policyId)
                    .eq('client_slug', clientSlug);
            }

            if (event === 'policy.expiring_soon') {
                const config = loadClientConfig(clientSlug);
                if (config) {
                    await jobs.quotePullQueue.add({
                        clientSlug,
                        ezlynxConfig: config.integrations?.ezlynx || {},
                        ezlynxPolicyId: policyId,
                        daysLeft: req.body.daysLeft || 30,
                        source: 'webhook',
                    });
                }
            }
        } catch (err) {
            console.error(`[webhook/ezlynx] Processing error: ${err.message}`);
        }
    });
});

// Manual outreach (agent-triggered)
app.post('/outreach/:clientSlug/:renewalId', requireAuth, async (req, res) => {
    const { clientSlug, renewalId } = req.params;
    const { channel = 'sms', template } = req.body;

    try {
        const job = await jobs.clientOutreachQueue.add({
            clientSlug,
            renewalId,
            manualTrigger: true,
            channel,
            template,
            ...req.body,
        }, {
            jobId: `manual-outreach-${renewalId}-${Date.now()}`,
        });

        res.json({ message: 'Outreach queued', jobId: job.id, channel });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Startup ─────────────────────────────────────────────────

function start() {
    app.listen(PORT, () => {
        console.log(`\n╔══════════════════════════════════════════╗`);
        console.log(`║  🔄 RENEWAL RADAR — GRIDHAND AI          ║`);
        console.log(`║  Running on http://localhost:${PORT}        ║`);
        console.log(`╚══════════════════════════════════════════╝\n`);

        // Schedule jobs for all configured clients
        try {
            const fs   = require('fs');
            const path = require('path');
            const clientsDir = path.join(__dirname, '../../clients');

            fs.readdirSync(clientsDir)
                .filter(f => f.endsWith('.json') && !f.startsWith('_'))
                .forEach(file => {
                    try {
                        const config     = JSON.parse(fs.readFileSync(path.join(clientsDir, file), 'utf8'));
                        const clientSlug = config.slug || file.replace('.json', '');
                        const ezlynxCfg  = config.integrations?.ezlynx || {};

                        // Only schedule if EZLynx is configured for this client
                        if (ezlynxCfg.apiKey || process.env.EZLYNX_API_KEY) {
                            jobs.scheduleClientJobs(clientSlug, ezlynxCfg);
                        }
                    } catch (err) {
                        console.warn(`[startup] Could not schedule jobs for ${file}: ${err.message}`);
                    }
                });
        } catch (err) {
            console.warn(`[startup] Could not auto-schedule client jobs: ${err.message}`);
        }
    });
}

if (require.main === module) {
    start();
}

module.exports = { app, start };
