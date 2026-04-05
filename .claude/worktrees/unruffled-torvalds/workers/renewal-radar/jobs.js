// ============================================================
// Bull Queue Job Definitions — Renewal Radar
//
// Queues:
//   daily-scan       — runs every night, finds all 60-day renewals
//   quote-pull       — pulls carrier quotes for a single policy
//   client-outreach  — sends SMS/email to the insured
//   agent-alert      — alerts the agent via SMS
//   weekly-report    — weekly pipeline report sent to agent
//
// Redis env: REDIS_URL (e.g. redis://localhost:6379)
// ============================================================

'use strict';

require('dotenv').config();

const Bull    = require('bull');
const cron    = require('node-cron');
const ezlynx  = require('./ezlynx');
const carriers = require('./carriers');
const outreach = require('./outreach');
const db       = require('./db');    // Supabase helper — created inline below if missing

// ─── Queue Factory ────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const queueDefaults = {
    redis: REDIS_URL,
    defaultJobOptions: {
        removeOnComplete: 100,  // Keep last 100 completed jobs
        removeOnFail:     200,
        attempts:         3,
        backoff: {
            type:  'exponential',
            delay: 10000,       // 10s base, then 20s, then 40s
        },
    },
};

const dailyScanQueue    = new Bull('renewal-radar:daily-scan',    queueDefaults);
const quotePullQueue    = new Bull('renewal-radar:quote-pull',    queueDefaults);
const clientOutreachQueue = new Bull('renewal-radar:client-outreach', queueDefaults);
const agentAlertQueue   = new Bull('renewal-radar:agent-alert',   queueDefaults);
const weeklyReportQueue = new Bull('renewal-radar:weekly-report', queueDefaults);

// ─── Processors ──────────────────────────────────────────────

/**
 * DAILY SCAN
 * Job data: { clientSlug, ezlynxConfig, daysAhead }
 *
 * Pulls all policies renewing in the next 60 days from EZLynx,
 * upserts them into rr_renewals, and enqueues quote pulls.
 */
dailyScanQueue.process(3, async (job) => {
    const { clientSlug, ezlynxConfig, daysAhead = 60 } = job.data;
    console.log(`[daily-scan] Starting for client: ${clientSlug}`);

    // 1. Pull upcoming renewals from EZLynx
    const policies = await ezlynx.getUpcomingRenewals(ezlynxConfig, daysAhead);
    job.progress(20);

    // 2. Upsert policies into Supabase
    let upserted = 0;
    for (const policy of policies) {
        try {
            await db.upsertPolicy(clientSlug, policy);
            upserted++;
        } catch (err) {
            console.error(`[daily-scan] Failed to upsert policy ${policy.policyNumber}: ${err.message}`);
        }
    }
    job.progress(50);

    // 3. Ensure each policy has a renewal record
    const renewalRecords = await db.ensureRenewalRecords(clientSlug, policies);
    job.progress(70);

    // 4. Enqueue quote pulls for renewals that haven't been quoted yet
    let queued = 0;
    for (const renewal of renewalRecords) {
        if (renewal.stage === 'detected') {
            await quotePullQueue.add({
                clientSlug,
                ezlynxConfig,
                renewalId:  renewal.id,
                policyId:   renewal.policyId,
                daysLeft:   renewal.daysUntilRenewal,
            }, {
                delay: queued * 2000,   // Stagger by 2s to avoid rate limits
                priority: Math.max(1, 60 - (renewal.daysUntilRenewal || 60)),  // Closer = higher priority
            });
            queued++;
        }
    }
    job.progress(100);

    const summary = { clientSlug, policiesFound: policies.length, upserted, quoteJobsQueued: queued };
    console.log(`[daily-scan] Done:`, summary);
    return summary;
});

/**
 * QUOTE PULL
 * Job data: { clientSlug, ezlynxConfig, renewalId, policyId, daysLeft }
 *
 * Pulls comparative quotes for a single policy, stores them,
 * then triggers outreach if needed.
 */
quotePullQueue.process(5, async (job) => {
    const { clientSlug, ezlynxConfig, renewalId, daysLeft } = job.data;
    console.log(`[quote-pull] renewalId=${renewalId} (${daysLeft} days left)`);

    // 1. Load the policy from Supabase
    const policy = await db.getPolicyByRenewalId(renewalId);
    if (!policy) throw new Error(`Policy not found for renewalId ${renewalId}`);
    job.progress(10);

    // 2. Get EZLynx comparative rates (primary)
    let ezlynxQuotes = [];
    try {
        ezlynxQuotes = await ezlynx.getComparativeRates(ezlynxConfig, policy.ezlynxPolicyId);
        job.progress(40);
    } catch (err) {
        console.warn(`[quote-pull] EZLynx comparative rating failed: ${err.message}, falling back to direct carrier APIs`);
    }

    // 3. Supplement with direct carrier API quotes
    let directComparison = null;
    try {
        directComparison = await carriers.compareCarrierRates(policy);
        job.progress(70);
    } catch (err) {
        console.warn(`[quote-pull] Direct carrier comparison failed: ${err.message}`);
    }

    // 4. Merge and pick best
    const allQuotes = [
        ...ezlynxQuotes.filter(q => q.annualPremium > 0),
        ...(directComparison?.quotes || []),
    ];
    allQuotes.sort((a, b) => a.annualPremium - b.annualPremium);

    const bestQuote = allQuotes.find(q => q.annualPremium > 0) || null;

    // 5. Store quotes in Supabase
    await db.storeQuotes(clientSlug, renewalId, policy.id, allQuotes);

    // 6. Update renewal record with best quote info
    await db.updateRenewal(renewalId, {
        stage:            'quotes_pulled',
        bestQuotePremium: bestQuote?.annualPremium || null,
        bestQuoteCarrier: bestQuote?.carrier || null,
    });
    job.progress(85);

    // 7. Trigger outreach if policy not already contacted
    await clientOutreachQueue.add({
        clientSlug,
        renewalId,
        daysLeft,
        policy: {
            insuredName:    policy.insuredName,
            insuredPhone:   policy.insuredPhone,
            insuredEmail:   policy.insuredEmail,
            policyNumber:   policy.policyNumber,
            carrier:        policy.carrier,
            lineOfBusiness: policy.lineOfBusiness,
            expirationDate: policy.expirationDate,
            annualPremium:  policy.annualPremium,
        },
        comparison: {
            bestQuote,
            quotes:          allQuotes,
            hasBetterRate:   bestQuote && bestQuote.annualPremium < policy.annualPremium,
            savingsPotential: Math.max(0, (policy.annualPremium || 0) - (bestQuote?.annualPremium || 0)),
        },
    });

    // 8. Always alert the agent
    await agentAlertQueue.add({
        clientSlug,
        renewalId,
        daysLeft,
        policy: { insuredName: policy.insuredName, policyNumber: policy.policyNumber, carrier: policy.carrier, annualPremium: policy.annualPremium, expirationDate: policy.expirationDate },
        bestQuote,
        stage: 'quotes_pulled',
    });

    job.progress(100);
    return { renewalId, quotesFound: allQuotes.length, bestCarrier: bestQuote?.carrier, bestPremium: bestQuote?.annualPremium };
});

/**
 * CLIENT OUTREACH
 * Job data: { clientSlug, renewalId, daysLeft, policy, comparison }
 *
 * Sends proactive SMS and email to the insured.
 */
clientOutreachQueue.process(3, async (job) => {
    const { clientSlug, renewalId, daysLeft, policy, comparison } = job.data;
    console.log(`[client-outreach] renewalId=${renewalId}, daysLeft=${daysLeft}`);

    const config = await db.getClientConfig(clientSlug);
    const results = [];

    // Send SMS if phone available
    if (policy.insuredPhone) {
        const template = outreach.selectClientTemplate(daysLeft, comparison.hasBetterRate);
        const smsData  = {
            firstName:      policy.insuredName?.split(' ')[0] || 'there',
            carrier:        policy.carrier,
            lob:            policy.lineOfBusiness,
            renewalDate:    policy.expirationDate,
            currentPremium: policy.annualPremium,
            bestCarrier:    comparison.bestQuote?.carrier,
            bestPremium:    comparison.bestQuote?.annualPremium,
            savings:        comparison.savingsPotential,
            agencyName:     config.agencyName,
            agencyPhone:    config.agencyPhone,
        };

        const sms = await outreach.sendSMS({ config: config.apiKeys, to: policy.insuredPhone, template, data: smsData });
        results.push(sms);

        // Log to Supabase
        await db.logOutreach(clientSlug, {
            renewalId,
            recipientType:  'client',
            recipientName:  policy.insuredName,
            recipientPhone: policy.insuredPhone,
            channel:        'sms',
            template,
            messageBody:    sms.body,
            status:         'sent',
            twilioSid:      sms.sid,
        });
    }

    // Send email if address available
    if (policy.insuredEmail && comparison.quotes?.length > 0) {
        const email = await outreach.sendRenewalEmail({
            config:      config.apiKeys,
            to:          policy.insuredEmail,
            toName:      policy.insuredName,
            policy,
            comparison,
            agencyName:  config.agencyName,
            agencyPhone: config.agencyPhone,
            agencyEmail: config.agencyEmail,
        });
        results.push(email);

        await db.logOutreach(clientSlug, {
            renewalId,
            recipientType:  'client',
            recipientName:  policy.insuredName,
            recipientEmail: policy.insuredEmail,
            channel:        'email',
            template:       'renewal_comparison_email',
            messageBody:    email.subject,
            status:         'sent',
        });
    }

    // Update renewal stage
    await db.updateRenewal(renewalId, {
        stage:         'outreach_sent',
        outreachCount: (job.data.currentOutreachCount || 0) + 1,
    });

    return { renewalId, outreachSent: results.length, channels: results.map(r => r.channel) };
});

/**
 * AGENT ALERT
 * Job data: { clientSlug, renewalId, daysLeft, policy, bestQuote, stage }
 *
 * Sends the agent an SMS summary of the renewal with rate info.
 */
agentAlertQueue.process(5, async (job) => {
    const { clientSlug, renewalId, daysLeft, policy, bestQuote, stage } = job.data;

    const config = await db.getClientConfig(clientSlug);
    const agentPhone = config.agentPhone || config.settings?.agentPhone;

    if (!agentPhone) {
        console.warn(`[agent-alert] No agent phone configured for ${clientSlug}`);
        return { skipped: true, reason: 'no_agent_phone' };
    }

    const savings = bestQuote && policy.annualPremium > 0
        ? policy.annualPremium - bestQuote.annualPremium
        : 0;

    const sms = await outreach.sendAgentAlert({
        config:    config.apiKeys,
        agentPhone,
        renewalData: {
            policyNumber:   policy.policyNumber,
            insuredName:    policy.insuredName,
            renewalDate:    policy.expirationDate,
            daysLeft,
            carrier:        policy.carrier,
            currentPremium: policy.annualPremium,
            bestCarrier:    bestQuote?.carrier,
            bestPremium:    bestQuote?.annualPremium,
            savings:        Math.max(0, savings),
            stage,
        },
    });

    await db.updateRenewal(renewalId, { agentAlerted: true });
    await db.logOutreach(clientSlug, {
        renewalId,
        recipientType:  'agent',
        recipientPhone: agentPhone,
        channel:        'sms',
        template:       'agent_alert',
        messageBody:    sms.body,
        status:         'sent',
        twilioSid:      sms.sid,
    });

    return { renewalId, agentPhone, stage };
});

/**
 * WEEKLY REPORT
 * Job data: { clientSlug }
 *
 * Generates weekly pipeline report sorted by premium and sends to agent.
 */
weeklyReportQueue.process(2, async (job) => {
    const { clientSlug } = job.data;
    console.log(`[weekly-report] Generating for ${clientSlug}`);

    const config = await db.getClientConfig(clientSlug);
    const agentEmail = config.agentEmail || config.settings?.agentEmail;
    const agentPhone = config.agentPhone || config.settings?.agentPhone;

    // Pull pipeline from Supabase
    const pipeline = await db.getRenewalPipeline(clientSlug);
    const stats    = await db.getRetentionStats(clientSlug);

    const reportDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    // Save report snapshot
    await db.saveWeeklyReport(clientSlug, reportDate, pipeline, stats);

    const results = [];

    // Email report if agent email configured
    if (agentEmail) {
        const email = await outreach.sendWeeklyReportEmail({
            config:      config.apiKeys,
            to:          agentEmail,
            clientSlug,
            reportDate,
            pipeline,
            stats,
            agencyName:  config.agencyName,
        });
        results.push({ channel: 'email', to: agentEmail });
    }

    // SMS summary if agent phone configured
    if (agentPhone && pipeline.length > 0) {
        const topPolicy = pipeline[0];
        const totalPremium = pipeline.reduce((sum, r) => sum + (r.currentPremium || 0), 0);

        await outreach.sendSMS({
            config: config.apiKeys,
            to:     agentPhone,
            template: 'agent_weekly_summary',
            data: {
                weekOf:       reportDate,
                totalPolicies: pipeline.length,
                totalPremium,
                topPolicy: {
                    insuredName: topPolicy.insuredName,
                    carrier:     topPolicy.carrier,
                    premium:     topPolicy.currentPremium,
                    daysLeft:    topPolicy.daysUntilRenewal,
                },
                reportUrl: `${process.env.PORTAL_URL || 'https://app.gridhand.ai'}/renewal-radar/${clientSlug}`,
            },
        });
        results.push({ channel: 'sms', to: agentPhone });
    }

    return { clientSlug, reportDate, pipelineCount: pipeline.length, sent: results };
});

// ─── Queue Error Handlers ─────────────────────────────────────

[dailyScanQueue, quotePullQueue, clientOutreachQueue, agentAlertQueue, weeklyReportQueue].forEach(q => {
    q.on('failed', (job, err) => {
        console.error(`[${q.name}] Job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts}): ${err.message}`);
    });
    q.on('stalled', (job) => {
        console.warn(`[${q.name}] Job ${job.id} stalled`);
    });
});

// ─── Cron Schedulers ─────────────────────────────────────────

/**
 * Schedule all recurring jobs for a given client.
 * Call this on server startup for each registered client.
 */
function scheduleClientJobs(clientSlug, ezlynxConfig = {}) {
    // Daily scan — 7 AM every day
    cron.schedule('0 7 * * *', async () => {
        console.log(`[cron] Triggering daily-scan for ${clientSlug}`);
        await dailyScanQueue.add({ clientSlug, ezlynxConfig, daysAhead: 60 }, { jobId: `daily-scan-${clientSlug}-${today()}` });
    }, { timezone: 'America/Chicago' });

    // Weekly report — Monday 8 AM
    cron.schedule('0 8 * * 1', async () => {
        console.log(`[cron] Triggering weekly-report for ${clientSlug}`);
        await weeklyReportQueue.add({ clientSlug }, { jobId: `weekly-report-${clientSlug}-${today()}` });
    }, { timezone: 'America/Chicago' });

    console.log(`[jobs] Scheduled daily scan + weekly report for client: ${clientSlug}`);
}

function today() {
    return new Date().toISOString().split('T')[0];
}

// ─── Supabase DB Helper (inline) ─────────────────────────────
// Loaded lazily so this file can be imported without DB credentials

const _db = (() => {
    let supabase = null;

    function getClient() {
        if (!supabase) {
            const { createClient } = require('@supabase/supabase-js');
            supabase = createClient(
                process.env.SUPABASE_URL,
                process.env.SUPABASE_SERVICE_KEY  // Use service key for server-side
            );
        }
        return supabase;
    }

    return {
        async upsertPolicy(clientSlug, policy) {
            const sb = getClient();
            const { error } = await sb.from('rr_policies').upsert({
                client_slug:         clientSlug,
                ezlynx_policy_id:    policy.ezlynxPolicyId,
                ezlynx_customer_id:  policy.ezlynxCustomerId,
                policy_number:       policy.policyNumber,
                carrier:             policy.carrier,
                line_of_business:    policy.lineOfBusiness,
                status:              policy.status,
                insured_name:        policy.insuredName,
                insured_email:       policy.insuredEmail,
                insured_phone:       policy.insuredPhone,
                effective_date:      policy.effectiveDate,
                expiration_date:     policy.expirationDate,
                annual_premium:      policy.annualPremium,
                monthly_premium:     policy.monthlyPremium,
                coverage_summary:    policy.coverageSummary,
                raw_data:            policy.rawData,
                last_synced_at:      new Date().toISOString(),
            }, { onConflict: 'client_slug,ezlynx_policy_id' });
            if (error) throw error;
        },

        async ensureRenewalRecords(clientSlug, policies) {
            const sb = getClient();
            const records = [];
            for (const p of policies) {
                // Look up the DB policy ID first
                const { data: dbPolicy } = await sb.from('rr_policies')
                    .select('id, annual_premium')
                    .eq('client_slug', clientSlug)
                    .eq('ezlynx_policy_id', p.ezlynxPolicyId)
                    .single();

                if (!dbPolicy) continue;

                const { data, error } = await sb.from('rr_renewals').upsert({
                    client_slug:     clientSlug,
                    policy_id:       dbPolicy.id,
                    renewal_date:    p.expirationDate,
                    current_premium: p.annualPremium,
                    stage:           'detected',
                }, {
                    onConflict: 'policy_id,renewal_date',
                    ignoreDuplicates: true,
                }).select('id, stage, days_until_renewal').single();

                if (data) records.push({ ...data, policyId: dbPolicy.id });
            }
            return records;
        },

        async getPolicyByRenewalId(renewalId) {
            const sb = getClient();
            const { data, error } = await sb.from('rr_renewals')
                .select('*, rr_policies(*)')
                .eq('id', renewalId)
                .single();
            if (error) throw error;
            const p = data.rr_policies;
            return {
                id:              p.id,
                ezlynxPolicyId:  p.ezlynx_policy_id,
                policyNumber:    p.policy_number,
                carrier:         p.carrier,
                lineOfBusiness:  p.line_of_business,
                insuredName:     p.insured_name,
                insuredEmail:    p.insured_email,
                insuredPhone:    p.insured_phone,
                expirationDate:  p.expiration_date,
                annualPremium:   p.annual_premium,
                coverageSummary: p.coverage_summary,
            };
        },

        async storeQuotes(clientSlug, renewalId, policyId, quotes) {
            const sb = getClient();
            if (!quotes.length) return;
            const rows = quotes.map(q => ({
                renewal_id:     renewalId,
                policy_id:      policyId,
                client_slug:    clientSlug,
                carrier:        q.carrier,
                carrier_code:   q.carrierCode,
                quote_number:   q.quoteNumber,
                annual_premium: q.annualPremium,
                monthly_premium: q.monthlyPremium,
                status:         q.status || 'success',
                error_message:  q.errorMessage,
                coverage_match: q.coverageMatch,
                raw_quote:      q.rawQuote,
                expires_at:     q.expiresAt,
            }));
            const { error } = await sb.from('rr_quotes').insert(rows);
            if (error) console.error('[db] storeQuotes error:', error.message);
        },

        async updateRenewal(renewalId, updates) {
            const sb = getClient();
            const mapped = {};
            if (updates.stage !== undefined)            mapped.stage = updates.stage;
            if (updates.bestQuotePremium !== undefined) mapped.best_quote_premium = updates.bestQuotePremium;
            if (updates.bestQuoteCarrier !== undefined) mapped.best_quote_carrier = updates.bestQuoteCarrier;
            if (updates.outreachCount !== undefined)    mapped.outreach_count = updates.outreachCount;
            if (updates.agentAlerted !== undefined)     mapped.agent_alerted = updates.agentAlerted;
            if (updates.outcome !== undefined)          mapped.outcome = updates.outcome;
            if (updates.outcomePremium !== undefined)   mapped.outcome_premium = updates.outcomePremium;
            if (updates.outcomeCarrier !== undefined)   mapped.outcome_carrier = updates.outcomeCarrier;
            const { error } = await sb.from('rr_renewals').update({ ...mapped, updated_at: new Date().toISOString() }).eq('id', renewalId);
            if (error) throw error;
        },

        async logOutreach(clientSlug, entry) {
            const sb = getClient();
            const { error } = await sb.from('rr_outreach_log').insert({
                renewal_id:      entry.renewalId,
                client_slug:     clientSlug,
                recipient_type:  entry.recipientType,
                recipient_name:  entry.recipientName,
                recipient_phone: entry.recipientPhone,
                recipient_email: entry.recipientEmail,
                channel:         entry.channel,
                template:        entry.template,
                message_body:    entry.messageBody,
                status:          entry.status || 'sent',
                twilio_sid:      entry.twilioSid,
                error_message:   entry.errorMessage,
            });
            if (error) console.error('[db] logOutreach error:', error.message);
        },

        async getClientConfig(clientSlug) {
            // Load from GRIDHAND clients directory
            try {
                return require(`../../clients/${clientSlug}.json`);
            } catch {
                return {};
            }
        },

        async getRenewalPipeline(clientSlug) {
            const sb = getClient();
            const { data, error } = await sb.from('rr_renewals')
                .select('*, rr_policies(insured_name, carrier, line_of_business)')
                .eq('client_slug', clientSlug)
                .gte('renewal_date', new Date().toISOString().split('T')[0])
                .lte('renewal_date', new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0])
                .order('current_premium', { ascending: false });
            if (error) throw error;
            return (data || []).map(r => ({
                id:              r.id,
                insuredName:     r.rr_policies?.insured_name,
                carrier:         r.rr_policies?.carrier,
                lineOfBusiness:  r.rr_policies?.line_of_business,
                renewalDate:     r.renewal_date,
                daysUntilRenewal: r.days_until_renewal,
                currentPremium:  r.current_premium,
                bestQuotePremium: r.best_quote_premium,
                bestQuoteCarrier: r.best_quote_carrier,
                hasBetterRate:   r.best_quote_premium && r.best_quote_premium < r.current_premium,
                savings:         Math.max(0, (r.current_premium || 0) - (r.best_quote_premium || 0)),
                stage:           r.stage,
                outreachCount:   r.outreach_count,
            }));
        },

        async getRetentionStats(clientSlug) {
            const sb = getClient();
            const { data } = await sb.from('rr_retention_stats')
                .select('*')
                .eq('client_slug', clientSlug)
                .order('period_end', { ascending: false })
                .limit(1)
                .single();
            return {
                retentionRate: data?.retention_rate,
                totalSavings:  data?.total_savings_achieved || 0,
                totalPremium:  null,    // Calculated fresh from pipeline
            };
        },

        async saveWeeklyReport(clientSlug, reportDate, pipeline, stats) {
            const sb = getClient();
            const totalPremium = pipeline.reduce((s, r) => s + (r.currentPremium || 0), 0);
            const { error } = await sb.from('rr_weekly_reports').upsert({
                client_slug:  clientSlug,
                report_date:  new Date().toISOString().split('T')[0],
                pipeline_data: { pipeline, stats, totalPremium, generatedAt: new Date().toISOString() },
                summary:      `${pipeline.length} renewals, $${totalPremium.toFixed(2)} at risk`,
            }, { onConflict: 'client_slug,report_date' });
            if (error) console.error('[db] saveWeeklyReport error:', error.message);
        },
    };
})();

// Inject db module
const db = _db;

module.exports = {
    dailyScanQueue,
    quotePullQueue,
    clientOutreachQueue,
    agentAlertQueue,
    weeklyReportQueue,
    scheduleClientJobs,
};
