/**
 * GRIDHAND AI — Claims Shepherd
 * Bull Queue Job Definitions
 *
 * Jobs:
 *   - status-check       : Poll carrier APIs for claim status updates
 *   - client-update      : Send proactive SMS to insured
 *   - document-reminder  : Follow up on missing documents
 *   - weekly-report      : Generate + send weekly pipeline report
 *   - ams-sync           : Pull new claims from AMS
 *   - fnol-queue         : Process queued FNOL filings
 */

'use strict';

const Bull = require('bull');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const carriers = require('./carriers');
const filing = require('./filing');
const notifications = require('./notifications');
const { AMSClient } = require('./ams');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ============================================================
// REDIS CONFIG
// ============================================================

const REDIS_CONFIG = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined
};

const QUEUE_OPTS = {
    redis: REDIS_CONFIG,
    defaultJobOptions: {
        removeOnComplete: 50,     // Keep last 50 completed jobs
        removeOnFail: 100,        // Keep last 100 failed jobs
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 }
    }
};

// ============================================================
// QUEUE DEFINITIONS
// ============================================================

const queues = {
    statusCheck:      new Bull('cs:status-check', QUEUE_OPTS),
    clientUpdate:     new Bull('cs:client-update', QUEUE_OPTS),
    documentReminder: new Bull('cs:document-reminder', QUEUE_OPTS),
    weeklyReport:     new Bull('cs:weekly-report', QUEUE_OPTS),
    amsSync:          new Bull('cs:ams-sync', QUEUE_OPTS),
    fnolQueue:        new Bull('cs:fnol-queue', QUEUE_OPTS)
};

// ============================================================
// JOB: STATUS CHECK
// Poll carrier API/portal for each open claim
// ============================================================

queues.statusCheck.process('check', 5, async (job) => {
    const { claimId, clientId } = job.data;

    const { data: claim } = await supabase
        .from('cs_claims')
        .select('*')
        .eq('id', claimId)
        .single();

    if (!claim) {
        return { skipped: true, reason: 'Claim not found' };
    }

    // Skip closed/terminal claims
    if (['closed', 'denied', 'paid'].includes(claim.status)) {
        return { skipped: true, reason: 'Claim in terminal status' };
    }

    // Skip if no claim number yet (can't check status without it)
    if (!claim.claim_number) {
        return { skipped: true, reason: 'No claim number yet' };
    }

    const { data: clientConfig } = await supabase
        .from('cs_clients')
        .select('*')
        .eq('id', clientId)
        .single();

    const { data: carrierConfig } = await supabase
        .from('cs_carrier_configs')
        .select('*')
        .eq('client_id', clientId)
        .eq('carrier_code', claim.carrier_code)
        .single();

    const statusResult = await carriers.getClaimStatus(claim, carrierConfig);

    if (!statusResult.ok) {
        return { ok: false, error: statusResult.error, manual: true };
    }

    const prevStatus = claim.status;
    const newStatus = statusResult.status;
    const statusChanged = newStatus && newStatus !== prevStatus;

    // Update adjuster info if changed
    const updates = {
        last_status_check: new Date().toISOString(),
        sub_status: statusResult.subStatus || claim.sub_status
    };

    if (statusResult.adjusterName) updates.adjuster_name = statusResult.adjusterName;
    if (statusResult.adjusterPhone) updates.adjuster_phone = statusResult.adjusterPhone;
    if (statusResult.adjusterEmail) updates.adjuster_email = statusResult.adjusterEmail;

    if (statusChanged) {
        updates.status = newStatus;
        if (['closed', 'denied', 'paid'].includes(newStatus)) {
            updates.resolved_at = new Date().toISOString();
        }
    }

    await supabase.from('cs_claims').update(updates).eq('id', claimId);

    // Log and notify if status changed
    if (statusChanged) {
        await filing.logEvent(claimId, clientId, 'status_change', {
            source: 'carrier_api',
            rawStatus: statusResult.subStatus
        }, prevStatus, newStatus);

        // Send client update
        const updatedClaim = { ...claim, ...updates };
        await notifications.sendClientStatusUpdate(clientConfig, updatedClaim);

        // Alert agent on significant changes
        const agentAlertStatuses = ['assigned', 'appraised', 'negotiating', 'denied', 'on_hold'];
        if (agentAlertStatuses.includes(newStatus)) {
            await notifications.alertAgent(clientConfig, 'status_change', updatedClaim, prevStatus);
        }

        // Flag for agent action on hold/denial
        if (['denied', 'on_hold'].includes(newStatus)) {
            await filing.flagForAgentAction(claimId, `Carrier set status to ${newStatus}`);
        }

        // Trigger document collection if carrier requests docs
        if (newStatus === 'docs_requested') {
            const pendingDocs = await filing.getPendingDocuments(claimId);
            if (pendingDocs.length === 0) {
                await filing.createDocumentRequests(claimId, clientId, claim.loss_type);
            }
            // Schedule document reminder
            await queues.documentReminder.add('remind', {
                claimId,
                clientId,
                delayHours: 48
            }, { delay: 48 * 60 * 60 * 1000 });
        }
    }

    return { ok: true, prevStatus, newStatus: updates.status || prevStatus, statusChanged };
});

// ============================================================
// JOB: CLIENT UPDATE (proactive outreach)
// Send a check-in text if no update sent in X days
// ============================================================

queues.clientUpdate.process('update', 5, async (job) => {
    const { claimId, clientId, force } = job.data;

    const { data: claim } = await supabase
        .from('cs_claims')
        .select('*')
        .eq('id', claimId)
        .single();

    if (!claim || ['closed', 'paid'].includes(claim.status)) {
        return { skipped: true };
    }

    // Check if enough time has passed since last update (default: 72h)
    if (!force && claim.last_client_update) {
        const hoursSinceUpdate = (Date.now() - new Date(claim.last_client_update).getTime()) / 3600000;
        if (hoursSinceUpdate < 72) {
            return { skipped: true, reason: 'Updated recently' };
        }
    }

    const { data: clientConfig } = await supabase
        .from('cs_clients')
        .select('*')
        .eq('id', clientId)
        .single();

    const result = await notifications.sendClientStatusUpdate(clientConfig, claim);
    return { ok: result.ok, status: claim.status };
});

// ============================================================
// JOB: DOCUMENT REMINDER
// Follow up with insured on missing documents
// ============================================================

queues.documentReminder.process('remind', 3, async (job) => {
    const { claimId, clientId } = job.data;

    const pendingDocs = await filing.getPendingDocuments(claimId);
    if (pendingDocs.length === 0) {
        return { skipped: true, reason: 'All documents received' };
    }

    const { data: claim } = await supabase
        .from('cs_claims')
        .select('*')
        .eq('id', claimId)
        .single();

    const { data: clientConfig } = await supabase
        .from('cs_clients')
        .select('*')
        .eq('id', clientId)
        .single();

    // Don't send more than 3 reminders total
    const mostRequested = pendingDocs.reduce((max, doc) => Math.max(max, doc.sms_request_count || 0), 0);
    if (mostRequested >= 3) {
        // Escalate to agent instead
        await filing.flagForAgentAction(claimId, `Documents overdue after 3 client reminders: ${pendingDocs.map(d => d.doc_type).join(', ')}`);
        await notifications.alertAgent(clientConfig, 'docs_overdue', claim, pendingDocs.length);
        return { escalated: true, docCount: pendingDocs.length };
    }

    const missingDocTypes = pendingDocs.map(d => d.doc_type);
    const result = await notifications.sendDocumentRequest(clientConfig, claim, missingDocTypes);

    // Schedule next reminder in 48h if docs still pending
    if (result.ok) {
        await queues.documentReminder.add('remind', { claimId, clientId }, {
            delay: 48 * 60 * 60 * 1000,
            jobId: `doc-reminder-${claimId}-${Date.now()}`
        });
    }

    return { ok: result.ok, docsRequested: missingDocTypes };
});

// ============================================================
// JOB: WEEKLY REPORT
// ============================================================

queues.weeklyReport.process('report', 2, async (job) => {
    const { clientId } = job.data;

    const { data: clientConfig } = await supabase
        .from('cs_clients')
        .select('*')
        .eq('id', clientId)
        .single();

    if (!clientConfig) return { error: 'Client not found' };

    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 7);

    // Aggregate stats
    const { data: allClaims } = await supabase
        .from('cs_claims')
        .select('*')
        .eq('client_id', clientId);

    const claims = allClaims || [];
    const openClaims = claims.filter(c => !['closed', 'denied', 'paid'].includes(c.status));
    const newThisWeek = claims.filter(c => new Date(c.created_at) >= weekStart);
    const closedThisWeek = claims.filter(c =>
        c.resolved_at && new Date(c.resolved_at) >= weekStart &&
        ['closed', 'paid'].includes(c.status)
    );
    const deniedThisWeek = claims.filter(c =>
        c.resolved_at && new Date(c.resolved_at) >= weekStart && c.status === 'denied'
    );
    const needsAction = claims.filter(c => c.needs_agent_action);

    // Pending docs
    const { count: pendingDocsCount } = await supabase
        .from('cs_claim_documents')
        .select('id', { count: 'exact' })
        .eq('client_id', clientId)
        .eq('status', 'requested');

    // Avg resolution days
    const resolvedClaims = claims.filter(c => c.resolution_days !== null);
    const avgDays = resolvedClaims.length > 0
        ? (resolvedClaims.reduce((sum, c) => sum + c.resolution_days, 0) / resolvedClaims.length).toFixed(1)
        : null;

    // Avg satisfaction
    const ratedClaims = claims.filter(c => c.client_satisfaction !== null);
    const avgSatisfaction = ratedClaims.length > 0
        ? (ratedClaims.reduce((sum, c) => sum + c.client_satisfaction, 0) / ratedClaims.length).toFixed(2)
        : null;

    // Carrier breakdown
    const carrierMap = {};
    for (const c of openClaims) {
        carrierMap[c.carrier_name] = (carrierMap[c.carrier_name] || 0) + 1;
    }
    const topCarriers = Object.entries(carrierMap)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .map(([name, count]) => ({ name, count }));

    // Loss type breakdown
    const lossMap = {};
    for (const c of openClaims) {
        lossMap[c.loss_type] = (lossMap[c.loss_type] || 0) + 1;
    }
    const topLossTypes = Object.entries(lossMap)
        .sort(([,a], [,b]) => b - a)
        .map(([type, count]) => ({ type, count }));

    const stats = {
        open: openClaims.length,
        newThisWeek: newThisWeek.length,
        closedThisWeek: closedThisWeek.length,
        deniedThisWeek: deniedThisWeek.length,
        needsAction: needsAction.length,
        pendingDocs: pendingDocsCount || 0,
        avgDays,
        avgSatisfaction
    };

    // Save report to DB
    const { data: report } = await supabase
        .from('cs_weekly_reports')
        .insert({
            client_id: clientId,
            report_week_start: weekStart.toISOString().slice(0, 10),
            report_week_end: now.toISOString().slice(0, 10),
            total_open_claims: stats.open,
            new_claims_this_week: stats.newThisWeek,
            claims_closed_this_week: stats.closedThisWeek,
            claims_denied_this_week: stats.deniedThisWeek,
            pending_docs_count: stats.pendingDocs,
            needs_action_count: stats.needsAction,
            avg_resolution_days: avgDays ? parseFloat(avgDays) : null,
            avg_satisfaction: avgSatisfaction ? parseFloat(avgSatisfaction) : null,
            top_carriers: topCarriers,
            top_loss_types: topLossTypes,
            open_claims_detail: openClaims.slice(0, 20).map(c => ({
                ref: c.internal_ref,
                insured: c.insured_name,
                carrier: c.carrier_name,
                status: c.status,
                needsAction: c.needs_agent_action
            })),
            recently_closed_detail: closedThisWeek.slice(0, 10).map(c => ({
                ref: c.internal_ref,
                insured: c.insured_name,
                carrier: c.carrier_name,
                resolutionDays: c.resolution_days,
                satisfaction: c.client_satisfaction
            }))
        })
        .select()
        .single();

    // Send SMS to agent
    await notifications.sendWeeklyReportSMS(clientConfig, stats);

    if (report) {
        await supabase
            .from('cs_weekly_reports')
            .update({ sent_to_agent: true, sent_at: new Date().toISOString() })
            .eq('id', report.id);
    }

    return { ok: true, reportId: report?.id, stats };
});

// ============================================================
// JOB: AMS SYNC
// ============================================================

queues.amsSync.process('sync', 2, async (job) => {
    const { clientId } = job.data;

    const { data: clientConfig } = await supabase
        .from('cs_clients')
        .select('*')
        .eq('id', clientId)
        .single();

    if (!clientConfig || clientConfig.ams_type === 'manual') {
        return { skipped: true, reason: 'Manual AMS or client not found' };
    }

    const result = await filing.syncFromAMS(clientConfig);

    if (result.ok && result.newClaims > 0) {
        // Get the newly created claims and queue FNOL for each
        const { data: newClaims } = await supabase
            .from('cs_claims')
            .select('*')
            .eq('client_id', clientId)
            .eq('status', 'detected')
            .order('created_at', { ascending: false })
            .limit(result.newClaims);

        for (const claim of newClaims || []) {
            // Queue FNOL filing
            await queues.fnolQueue.add('file', {
                claimId: claim.id,
                clientId
            }, { delay: 2000 }); // Slight delay to avoid rate limits

            // Alert agent about new claim
            await notifications.alertAgent(clientConfig, 'new_claim', claim);
        }
    }

    return result;
});

// ============================================================
// JOB: FNOL QUEUE
// ============================================================

queues.fnolQueue.process('file', 3, async (job) => {
    const { claimId, clientId } = job.data;

    const { data: claim } = await supabase
        .from('cs_claims')
        .select('*')
        .eq('id', claimId)
        .single();

    if (!claim || claim.status !== 'detected') {
        return { skipped: true, reason: 'Claim not in detected status' };
    }

    const { data: clientConfig } = await supabase
        .from('cs_clients')
        .select('*')
        .eq('id', clientId)
        .single();

    const result = await filing.fileFNOL(claim, clientConfig);

    // Send appropriate client notification
    const updatedClaim = { ...claim, status: result.ok ? 'fnol_filed' : claim.status };

    if (result.ok) {
        if (result.method === 'api') {
            await notifications.sendClientStatusUpdate(clientConfig, updatedClaim);
            await notifications.alertAgent(clientConfig, 'fnol_filed', updatedClaim);
        } else if (result.method === 'email') {
            await notifications.sendClientStatusUpdate(clientConfig, { ...updatedClaim, status: 'fnol_filed' });
            await notifications.alertAgent(clientConfig, 'fnol_email_sent', updatedClaim);
        } else if (result.method === 'manual') {
            await notifications.alertAgent(clientConfig, 'manual_required', updatedClaim, result.note);
            await filing.flagForAgentAction(claimId, `Manual FNOL required: ${result.note}`);
        }

        // Create document requests
        await filing.createDocumentRequests(claimId, clientId, claim.loss_type);

        // Schedule first document request SMS (30 min after FNOL)
        await queues.documentReminder.add('remind', { claimId, clientId }, {
            delay: 30 * 60 * 1000,
            jobId: `doc-initial-${claimId}`
        });

        // Schedule first status check based on carrier interval
        const checkIntervalHours = carriers.getCarrierStatusCheckInterval(claim.carrier_code);
        await scheduleStatusCheck(claimId, clientId, checkIntervalHours);
    }

    return { ok: result.ok, method: result.method, claimNumber: result.claimNumber };
});

// ============================================================
// CRON SCHEDULERS
// ============================================================

/**
 * Schedule a status check for a specific claim
 */
async function scheduleStatusCheck(claimId, clientId, delayHours = 24) {
    return queues.statusCheck.add('check', { claimId, clientId }, {
        delay: delayHours * 60 * 60 * 1000,
        jobId: `status-${claimId}-${Date.now()}`
    });
}

/**
 * Setup cron jobs — called once at server start
 */
function startCronJobs() {
    // AMS sync: Every 6 hours
    cron.schedule('0 */6 * * *', async () => {
        console.log('[Jobs] Running AMS sync for all clients...');
        const { data: clients } = await supabase
            .from('cs_clients')
            .select('id, ams_type')
            .neq('ams_type', 'manual');

        for (const client of clients || []) {
            await queues.amsSync.add('sync', { clientId: client.id });
        }
    });

    // Weekly reports: Every Monday at 8am
    cron.schedule('0 8 * * 1', async () => {
        console.log('[Jobs] Generating weekly reports...');
        const { data: clients } = await supabase
            .from('cs_clients')
            .select('id');

        for (const client of clients || []) {
            await queues.weeklyReport.add('report', { clientId: client.id });
        }
    });

    // Status check sweep: Every 4 hours — process claims due for check
    cron.schedule('0 */4 * * *', async () => {
        console.log('[Jobs] Running status check sweep...');
        const checkCutoff = new Date(Date.now() - 20 * 60 * 60 * 1000); // 20h ago

        const { data: staleClaims } = await supabase
            .from('cs_claims')
            .select('id, client_id, carrier_code')
            .not('claim_number', 'is', null)
            .not('status', 'in', '("closed","denied","paid")')
            .or(`last_status_check.is.null,last_status_check.lt.${checkCutoff.toISOString()}`);

        for (const claim of staleClaims || []) {
            await queues.statusCheck.add('check', {
                claimId: claim.id,
                clientId: claim.client_id
            });
        }
    });

    // Client update check: Every 24h — ping clients who haven't heard from us
    cron.schedule('0 10 * * *', async () => {
        const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000);

        const { data: staleClaims } = await supabase
            .from('cs_claims')
            .select('id, client_id')
            .not('status', 'in', '("closed","denied","paid","detected")')
            .or(`last_client_update.is.null,last_client_update.lt.${cutoff.toISOString()}`);

        for (const claim of staleClaims || []) {
            await queues.clientUpdate.add('update', {
                claimId: claim.id,
                clientId: claim.client_id
            });
        }
    });

    console.log('[Jobs] Cron jobs started.');
}

// ============================================================
// QUEUE ERROR HANDLERS
// ============================================================

for (const [name, queue] of Object.entries(queues)) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] Queue "${name}" job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts}):`, err.message);
    });

    queue.on('error', (err) => {
        console.error(`[Jobs] Queue "${name}" error:`, err.message);
    });
}

// ============================================================
// QUEUE HEALTH
// ============================================================

async function getQueueStats() {
    const stats = {};
    for (const [name, queue] of Object.entries(queues)) {
        const [waiting, active, completed, failed] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount()
        ]);
        stats[name] = { waiting, active, completed, failed };
    }
    return stats;
}

module.exports = {
    queues,
    scheduleStatusCheck,
    startCronJobs,
    getQueueStats
};
