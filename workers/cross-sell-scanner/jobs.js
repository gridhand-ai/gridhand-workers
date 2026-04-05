'use strict';

/**
 * Bull Queue Job Definitions — Cross-Sell Scanner
 *
 * Jobs:
 *   daily-scan       — Full book sync + gap analysis + top-5 outreach alerts
 *   outreach-send    — Send a single opportunity alert (on-demand or queued)
 *   weekly-report    — Top 10 opportunities report, sent every Monday
 *   monthly-report   — Revenue attribution report, sent 1st of each month
 *   life-event-scan  — Delta sync to detect life events and queue fast outreach
 */

const Bull        = require('bull');
const { createClient } = require('@supabase/supabase-js');
const { syncBookOfBusiness, syncDelta } = require('./ams');
const { analyzeBook, getTopOpportunities } = require('./analyzer');
const { sendBulkAlerts, processOpportunity, generateAgentAlert, sendAgentAlert } = require('./outreach');
const Anthropic   = require('@anthropic-ai/sdk');
const twilio      = require('twilio');

// ---------------------------------------------------------------------------
// Redis connection
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const QUEUE_OPTS = {
    redis: REDIS_URL,
    defaultJobOptions: {
        attempts:    3,
        backoff:     { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail:     200,
    },
};

// ---------------------------------------------------------------------------
// Queue definitions
// ---------------------------------------------------------------------------

const queues = {
    dailyScan:      new Bull('css:daily-scan',      QUEUE_OPTS),
    outreachSend:   new Bull('css:outreach-send',   QUEUE_OPTS),
    weeklyReport:   new Bull('css:weekly-report',   QUEUE_OPTS),
    monthlyReport:  new Bull('css:monthly-report',  QUEUE_OPTS),
    lifeEventScan:  new Bull('css:life-event-scan', QUEUE_OPTS),
};

// ---------------------------------------------------------------------------
// Supabase factory
// ---------------------------------------------------------------------------

function getSupabase() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
    return createClient(url, key);
}

// ---------------------------------------------------------------------------
// Shared DB helpers
// ---------------------------------------------------------------------------

async function getActiveAgencies(supabase) {
    const { data, error } = await supabase
        .from('css_agencies')
        .select('*')
        .eq('active', true);
    if (error) throw new Error(`Failed to load agencies: ${error.message}`);
    return data || [];
}

async function upsertClients(supabase, agencyId, clients) {
    for (const client of clients) {
        await supabase
            .from('css_clients')
            .upsert({
                agency_id:      agencyId,
                ams_client_id:  client.ams_client_id,
                full_name:      client.full_name,
                email:          client.email,
                phone:          client.phone,
                address:        client.address,
                date_of_birth:  client.date_of_birth,
                client_since:   client.client_since,
                ams_raw:        client.ams_raw,
                last_synced_at: new Date().toISOString(),
            }, { onConflict: 'agency_id,ams_client_id' });
    }
}

async function upsertPolicies(supabase, agencyId, policies) {
    for (const policy of policies) {
        // Resolve client UUID
        const { data: clientRow } = await supabase
            .from('css_clients')
            .select('id')
            .eq('agency_id', agencyId)
            .eq('ams_client_id', policy.ams_client_id)
            .single();

        if (!clientRow) continue;

        await supabase
            .from('css_policies')
            .upsert({
                agency_id:        agencyId,
                client_id:        clientRow.id,
                ams_policy_id:    policy.ams_policy_id,
                line_of_business: policy.line_of_business,
                carrier:          policy.carrier,
                policy_number:    policy.policy_number,
                effective_date:   policy.effective_date,
                expiration_date:  policy.expiration_date,
                annual_premium:   policy.annual_premium,
                coverage_limit:   policy.coverage_limit,
                deductible:       policy.deductible,
                status:           policy.status,
                coverage_details: policy.coverage_details,
                ams_raw:          policy.ams_raw,
            }, { onConflict: 'agency_id,ams_policy_id' });
    }
}

async function upsertGapsAndOpportunities(supabase, agencyId, analysisResults) {
    for (const { client, gaps, opportunities } of analysisResults) {
        const { data: clientRow } = await supabase
            .from('css_clients')
            .select('id')
            .eq('agency_id', agencyId)
            .eq('ams_client_id', client.ams_client_id)
            .single();

        if (!clientRow) continue;
        const clientId = clientRow.id;

        // Upsert gaps
        for (const gap of gaps) {
            const { data: gapRow } = await supabase
                .from('css_coverage_gaps')
                .upsert({
                    agency_id:     agencyId,
                    client_id:     clientId,
                    gap_type:      gap.gap_type,
                    description:   gap.description,
                    existing_line: gap.existing_line,
                    missing_line:  gap.missing_line,
                    severity:      gap.severity,
                    detected_at:   new Date().toISOString(),
                }, { onConflict: 'client_id,gap_type' })
                .select('id')
                .single();

            // Find matching opportunity
            const opp = opportunities.find(o => o._gap_type === gap.gap_type);
            if (!opp || !gapRow) continue;

            // Upsert opportunity (open ones only — don't overwrite converted/dismissed)
            const { data: existing } = await supabase
                .from('css_opportunities')
                .select('id, status')
                .eq('agency_id', agencyId)
                .eq('client_id', clientId)
                .eq('opportunity_type', opp.opportunity_type)
                .single();

            if (existing && !['open', 'outreach_sent'].includes(existing.status)) continue;

            await supabase
                .from('css_opportunities')
                .upsert({
                    agency_id:         agencyId,
                    client_id:         clientId,
                    gap_id:            gapRow.id,
                    opportunity_type:  opp.opportunity_type,
                    title:             opp.title,
                    estimated_premium: opp.estimated_premium,
                    conversion_score:  opp.conversion_score,
                    revenue_score:     opp.revenue_score,
                    composite_score:   opp.composite_score,
                    scoring_factors:   opp.scoring_factors,
                    status:            existing?.status || 'open',
                    updated_at:        new Date().toISOString(),
                }, { onConflict: 'agency_id,client_id,opportunity_type' });
        }
    }
}

async function saveLifeEvents(supabase, agencyId, analysisResults) {
    for (const { client, lifeEvents } of analysisResults) {
        if (!lifeEvents?.length) continue;

        const { data: clientRow } = await supabase
            .from('css_clients')
            .select('id')
            .eq('agency_id', agencyId)
            .eq('ams_client_id', client.ams_client_id)
            .single();

        if (!clientRow) continue;

        for (const event of lifeEvents) {
            await supabase
                .from('css_life_events')
                .insert({
                    agency_id:       agencyId,
                    client_id:       clientRow.id,
                    event_type:      event.event_type,
                    detected_source: event.detected_source,
                    event_date:      event.event_date,
                    details:         event.details,
                })
                .select()
                .single();
        }
    }
}

// ---------------------------------------------------------------------------
// JOB: Daily Scan
// ---------------------------------------------------------------------------

queues.dailyScan.process(async (job) => {
    const supabase = getSupabase();
    const { agencyId } = job.data;

    let agency;
    if (agencyId) {
        const { data } = await supabase.from('css_agencies').select('*').eq('id', agencyId).single();
        agency = data;
    }

    const agencies = agency ? [agency] : await getActiveAgencies(supabase);
    console.log(`[DailyScan] Processing ${agencies.length} agencies`);

    for (const ag of agencies) {
        try {
            job.progress({ agency: ag.slug, step: 'ams_sync' });
            console.log(`[DailyScan] Syncing ${ag.slug}`);

            // 1. Pull full book from AMS
            const { clients, policies } = await syncBookOfBusiness(ag);

            // 2. Persist to Supabase
            job.progress({ agency: ag.slug, step: 'persisting_clients' });
            await upsertClients(supabase, ag.id, clients);
            await upsertPolicies(supabase, ag.id, policies);

            // 3. Analyze full book
            job.progress({ agency: ag.slug, step: 'analyzing' });
            const { results, allOpportunities } = analyzeBook(clients, policies);
            await upsertGapsAndOpportunities(supabase, ag.id, results);

            // 4. Pull top open opportunities with client data for outreach
            const { data: topOpps } = await supabase
                .from('css_opportunities')
                .select('*, css_clients(*)')
                .eq('agency_id', ag.id)
                .eq('status', 'open')
                .order('composite_score', { ascending: false })
                .limit(5);

            if (topOpps?.length) {
                job.progress({ agency: ag.slug, step: 'sending_alerts' });
                const toAlert = topOpps.map(o => ({
                    opportunity: o,
                    client:      o.css_clients,
                }));
                await sendBulkAlerts({ agency: ag, opportunities: toAlert, supabase, maxAlerts: 5 });
            }

            console.log(`[DailyScan] Done: ${ag.slug} | gaps found: ${results.length}`);
        } catch (e) {
            console.error(`[DailyScan] Error for ${ag.slug}: ${e.message}`);
            throw e;
        }
    }

    return { done: true, agenciesProcessed: agencies.length };
});

// ---------------------------------------------------------------------------
// JOB: Single Outreach Send (on-demand)
// ---------------------------------------------------------------------------

queues.outreachSend.process(async (job) => {
    const supabase = getSupabase();
    const { opportunityId } = job.data;

    const { data: opp, error } = await supabase
        .from('css_opportunities')
        .select('*, css_clients(*), css_agencies(*)')
        .eq('id', opportunityId)
        .single();

    if (error || !opp) throw new Error(`Opportunity ${opportunityId} not found`);

    const result = await processOpportunity({
        agency:      opp.css_agencies,
        client:      opp.css_clients,
        opportunity: opp,
        supabase,
    });

    return { done: true, opportunityId, twilioSid: result.twilioSid };
});

// ---------------------------------------------------------------------------
// JOB: Weekly Report
// ---------------------------------------------------------------------------

queues.weeklyReport.process(async (job) => {
    const supabase  = getSupabase();
    const agencies  = await getActiveAgencies(supabase);
    const now       = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());     // Sunday
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    for (const agency of agencies) {
        try {
            // Top 10 open opportunities
            const { data: topOpps } = await supabase
                .from('css_opportunities')
                .select('*, css_clients(full_name, ams_client_id)')
                .eq('agency_id', agency.id)
                .eq('status', 'open')
                .order('composite_score', { ascending: false })
                .limit(10);

            // Outreach + conversion counts for the week
            const { count: outreachCount } = await supabase
                .from('css_outreach_log')
                .select('*', { count: 'exact', head: true })
                .eq('agency_id', agency.id)
                .gte('sent_at', weekStart.toISOString());

            const { count: convertedCount } = await supabase
                .from('css_conversions')
                .select('*', { count: 'exact', head: true })
                .eq('agency_id', agency.id)
                .gte('converted_at', weekStart.toISOString());

            const { data: pipelineData } = await supabase
                .from('css_opportunities')
                .select('estimated_premium')
                .eq('agency_id', agency.id)
                .eq('status', 'open');

            const estimatedPipeline = (pipelineData || []).reduce(
                (sum, o) => sum + (o.estimated_premium || 0), 0
            );

            const topList = (topOpps || []).map((o, i) => ({
                rank:             i + 1,
                client:           o.css_clients?.full_name || 'Unknown',
                opportunity:      o.title,
                est_premium:      o.estimated_premium,
                composite_score:  o.composite_score,
            }));

            // Build report summary via Claude
            const reportText = await generateWeeklyReportText(agency, topList, outreachCount, convertedCount, estimatedPipeline);

            // Save report
            await supabase
                .from('css_weekly_reports')
                .upsert({
                    agency_id:         agency.id,
                    week_start:        weekStart.toISOString().split('T')[0],
                    week_end:          weekEnd.toISOString().split('T')[0],
                    top_opportunities: topList,
                    total_open:        pipelineData?.length || 0,
                    total_outreach:    outreachCount || 0,
                    total_converted:   convertedCount || 0,
                    estimated_pipeline: estimatedPipeline,
                    report_text:       reportText,
                    generated_at:      new Date().toISOString(),
                }, { onConflict: 'agency_id,week_start' });

            // Send summary SMS to agent
            if (agency.agent_phone && agency.twilio_number) {
                const summaryMsg = buildWeeklyAlertSMS(agency, topList, outreachCount, convertedCount, estimatedPipeline);
                await sendAgentAlert({ agency, messageBody: summaryMsg });
            }

            console.log(`[WeeklyReport] Generated for ${agency.slug}`);
        } catch (e) {
            console.error(`[WeeklyReport] Error for ${agency.slug}: ${e.message}`);
        }
    }

    return { done: true };
});

async function generateWeeklyReportText(agency, topList, outreachCount, convertedCount, pipeline) {
    try {
        const anthropic = new Anthropic({ apiKey: agency.anthropic_api_key || process.env.ANTHROPIC_API_KEY });
        const prompt    = `Weekly cross-sell report for ${agency.name}.
Pipeline: $${pipeline.toLocaleString()} estimated annual premium across ${topList.length} open opportunities.
Outreach sent this week: ${outreachCount}. Converted: ${convertedCount}.
Top opportunities: ${topList.slice(0, 5).map(o => `${o.client} — ${o.opportunity} ($${o.est_premium?.toLocaleString()}/yr)`).join('; ')}.
Write a 3-sentence agent-facing summary.`;

        const res = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001', max_tokens: 300,
            messages: [{ role: 'user', content: prompt }],
        });
        return res.content[0]?.text?.trim() || '';
    } catch {
        return `${agency.name} weekly report: ${topList.length} open opportunities, $${pipeline.toLocaleString()} estimated pipeline, ${outreachCount} outreach sent, ${convertedCount} converted.`;
    }
}

function buildWeeklyAlertSMS(agency, topList, outreach, converted, pipeline) {
    const top = topList[0];
    return `${agency.name} Weekly: ${topList.length} open opps | $${Math.round(pipeline / 1000)}K pipeline | ${outreach} alerts sent | ${converted} converted${top ? ` | Top: ${top.client} – ${top.opportunity}` : ''}`;
}

// ---------------------------------------------------------------------------
// JOB: Monthly Revenue Attribution Report
// ---------------------------------------------------------------------------

queues.monthlyReport.process(async (job) => {
    const supabase = getSupabase();
    const agencies = await getActiveAgencies(supabase);
    const now      = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];

    for (const agency of agencies) {
        try {
            const { data: conversions } = await supabase
                .from('css_conversions')
                .select('premium_written, policy_written')
                .eq('agency_id', agency.id)
                .gte('converted_at', `${monthStart}T00:00:00Z`);

            const { count: outreachTotal } = await supabase
                .from('css_outreach_log')
                .select('*', { count: 'exact', head: true })
                .eq('agency_id', agency.id)
                .gte('sent_at', `${monthStart}T00:00:00Z`);

            const convs         = conversions || [];
            const totalPremium  = convs.reduce((s, c) => s + (c.premium_written || 0), 0);
            const conversionRate = outreachTotal ? (convs.length / outreachTotal) * 100 : 0;

            // Group by line of business
            const byLob = {};
            for (const c of convs) {
                byLob[c.policy_written] = (byLob[c.policy_written] || 0) + (c.premium_written || 0);
            }

            await supabase
                .from('css_monthly_reports')
                .upsert({
                    agency_id:           agency.id,
                    month:               monthStart,
                    new_premium_written: totalPremium,
                    policies_written:    convs.length,
                    outreach_sent:       outreachTotal || 0,
                    outreach_converted:  convs.length,
                    conversion_rate:     Math.round(conversionRate * 10) / 10,
                    top_lines:           byLob,
                    generated_at:        new Date().toISOString(),
                }, { onConflict: 'agency_id,month' });

            // SMS summary to agent
            if (agency.agent_phone && agency.twilio_number && totalPremium > 0) {
                const msg = `${agency.name} Monthly: $${totalPremium.toLocaleString()} new premium written | ${convs.length} policies | ${Math.round(conversionRate)}% conversion from GridHand alerts`;
                await sendAgentAlert({ agency, messageBody: msg });
            }

            console.log(`[MonthlyReport] Done for ${agency.slug} — $${totalPremium} written`);
        } catch (e) {
            console.error(`[MonthlyReport] Error for ${agency.slug}: ${e.message}`);
        }
    }

    return { done: true };
});

// ---------------------------------------------------------------------------
// JOB: Life Event Delta Scan
// Fast scan of recent AMS changes → detect life triggers → queue urgent outreach
// ---------------------------------------------------------------------------

queues.lifeEventScan.process(async (job) => {
    const supabase  = getSupabase();
    const agencies  = await getActiveAgencies(supabase);
    const since     = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // last 25 hours

    for (const agency of agencies) {
        try {
            const { clients, policies } = await syncDelta(agency, since);
            if (!policies.length) continue;

            // Group delta policies by client
            const byClient = {};
            for (const p of policies) {
                if (!byClient[p.ams_client_id]) byClient[p.ams_client_id] = [];
                byClient[p.ams_client_id].push(p);
            }

            for (const client of clients) {
                const newPolicies = byClient[client.ams_client_id] || [];
                if (!newPolicies.length) continue;

                // Detect life events for this client
                const { analyzeClient } = require('./analyzer');
                const { data: clientRow } = await supabase
                    .from('css_clients')
                    .select('id')
                    .eq('agency_id', agency.id)
                    .eq('ams_client_id', client.ams_client_id)
                    .single();

                if (!clientRow) continue;

                const { data: allPolicies } = await supabase
                    .from('css_policies')
                    .select('*')
                    .eq('client_id', clientRow.id);

                const { lifeEvents, opportunities } = analyzeClient(client, allPolicies || [], newPolicies);

                if (lifeEvents.length > 0) {
                    console.log(`[LifeEvent] Detected for ${client.full_name}: ${lifeEvents.map(e => e.event_type).join(', ')}`);

                    // Save life events
                    for (const event of lifeEvents) {
                        await supabase.from('css_life_events').insert({
                            agency_id:       agency.id,
                            client_id:       clientRow.id,
                            event_type:      event.event_type,
                            detected_source: 'ams_new_policy',
                            event_date:      event.event_date,
                            details:         event.details,
                        });
                    }

                    // Queue urgent outreach for top opportunity triggered by this life event
                    if (opportunities.length > 0) {
                        const top = opportunities[0];
                        const alertMsg = await generateAgentAlert({
                            client,
                            opportunity: top,
                            agency,
                            apiKey: agency.anthropic_api_key || process.env.ANTHROPIC_API_KEY,
                        });
                        const prefix = lifeEvents[0].event_type === 'new_home'
                            ? '[NEW HOME] '
                            : lifeEvents[0].event_type === 'new_vehicle'
                            ? '[NEW VEHICLE] '
                            : '[LIFE EVENT] ';
                        await sendAgentAlert({ agency, messageBody: prefix + alertMsg });
                    }
                }
            }
        } catch (e) {
            console.error(`[LifeEventScan] Error for ${agency.slug}: ${e.message}`);
        }
    }

    return { done: true };
});

// ---------------------------------------------------------------------------
// Schedule recurring jobs (called once at startup)
// ---------------------------------------------------------------------------

async function scheduleRecurringJobs() {
    // Daily scan — 6:00 AM every day
    await queues.dailyScan.add({}, {
        repeat:   { cron: '0 6 * * *' },
        jobId:    'daily-scan-recurring',
    });

    // Life event scan — every hour
    await queues.lifeEventScan.add({}, {
        repeat:   { cron: '0 * * * *' },
        jobId:    'life-event-scan-recurring',
    });

    // Weekly report — Monday 8:00 AM
    await queues.weeklyReport.add({}, {
        repeat:   { cron: '0 8 * * 1' },
        jobId:    'weekly-report-recurring',
    });

    // Monthly report — 1st of month 9:00 AM
    await queues.monthlyReport.add({}, {
        repeat:   { cron: '0 9 1 * *' },
        jobId:    'monthly-report-recurring',
    });

    console.log('[Jobs] Recurring jobs scheduled');
}

// Error handling
for (const [name, queue] of Object.entries(queues)) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs:${name}] Job ${job.id} failed (attempt ${job.attemptsMade}): ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs:${name}] Job ${job.id} completed`);
    });
}

module.exports = { queues, scheduleRecurringJobs };
