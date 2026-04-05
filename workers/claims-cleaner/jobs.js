/**
 * GRIDHAND AI — Claims Cleaner
 * Bull Queue Job Definitions
 *
 * Queues:
 *   cc:scrub-batch      — Scrub all pending claims for a client
 *   cc:single-scrub     — Scrub one claim
 *   cc:check-denials    — Fetch and process new ERAs from clearinghouse
 *   cc:resubmit         — Resubmit a corrected/denied claim
 *   cc:digest           — Weekly denial stats digest via SMS
 *
 * Cron:
 *   6am daily        — Scrub overnight batch for all clients
 *   Every 4 hours    — Check clearinghouse for new ERAs
 *   Monday 8am       — Weekly denial digest
 */

'use strict';

const Bull = require('bull');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const dayjs = require('dayjs');
const twilio = require('twilio');

const pms = require('./practice-mgmt');
const ch = require('./clearinghouse');
const { scrubClaim, autoCorrectClaim, getComplexReviewNarrative, buildScrubReport } = require('./scrubber');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ============================================================
// REDIS + QUEUE CONFIG
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
        removeOnComplete: 50,
        removeOnFail: 100,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 }
    }
};

const queues = {
    scrubBatch:   new Bull('cc:scrub-batch',   QUEUE_OPTS),
    singleScrub:  new Bull('cc:single-scrub',  QUEUE_OPTS),
    checkDenials: new Bull('cc:check-denials', QUEUE_OPTS),
    resubmit:     new Bull('cc:resubmit',      QUEUE_OPTS),
    digest:       new Bull('cc:digest',        QUEUE_OPTS)
};

// ============================================================
// SMS HELPER
// ============================================================

async function sendSMS(clientSlug, toPhone, message) {
    try {
        const msg = await twilioClient.messages.create({
            body: message,
            from: process.env.TWILIO_FROM_NUMBER,
            to: toPhone
        });
        await supabase.from('cc_sms_log').insert({
            client_slug: clientSlug,
            direction: 'outbound',
            recipient_phone: toPhone,
            message_body: message,
            twilio_sid: msg.sid,
            status: msg.status
        });
        return { ok: true, sid: msg.sid };
    } catch (err) {
        console.error(`[Jobs] SMS error for ${clientSlug}:`, err.message);
        return { ok: false, error: err.message };
    }
}

// ============================================================
// JOB: SCRUB BATCH
// Fetches pending claims from PMS, scrubs each, saves results
// ============================================================

queues.scrubBatch.process('scrub', 2, async (job) => {
    const { clientSlug } = job.data;

    // Load client connection
    const { data: conn } = await supabase
        .from('cc_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (!conn) return { error: 'Client connection not found', clientSlug };

    let pendingClaims = [];
    try {
        pendingClaims = await pms.getPendingClaims(clientSlug);
    } catch (err) {
        console.error(`[Jobs] getPendingClaims failed for ${clientSlug}:`, err.message);
        return { error: err.message };
    }

    if (pendingClaims.length === 0) {
        return { ok: true, scrubbed: 0, message: 'No pending claims' };
    }

    let scrubbed = 0;
    let passed = 0;
    let autoCorrected = 0;
    let needsReview = 0;

    for (const claim of pendingClaims) {
        try {
            // Queue each as a single-scrub job for parallel processing
            await queues.singleScrub.add('scrub', { clientSlug, claimId: claim.claimId, claimData: claim });
        } catch (err) {
            console.error(`[Jobs] Failed to queue scrub for claim ${claim.claimId}:`, err.message);
        }
        scrubbed++;
    }

    return { ok: true, queued: scrubbed, clientSlug };
});

// ============================================================
// JOB: SINGLE SCRUB
// Scrubs one claim, auto-corrects if enabled, saves to DB
// ============================================================

queues.singleScrub.process('scrub', 5, async (job) => {
    const { clientSlug, claimId, claimData } = job.data;

    // Load connection for settings
    const { data: conn } = await supabase
        .from('cc_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (!conn) return { error: 'Client connection not found' };

    // Fetch full claim if only ID was passed
    let claim = claimData;
    if (!claim && claimId) {
        try {
            claim = await pms.getClaimById(clientSlug, claimId);
        } catch (err) {
            return { error: `Failed to fetch claim: ${err.message}` };
        }
    }

    if (!claim) return { error: 'No claim data available' };

    // Fetch patient + provider info
    let patientInfo = null;
    let providerInfo = null;

    try {
        if (claim.patientId) patientInfo = await pms.getPatientInfo(clientSlug, claim.patientId);
        if (claim.provider?.npi || conn.npi) {
            providerInfo = { npi: conn.npi, billingNpi: conn.npi, taxonomyCode: conn.taxonomy_code };
        }
    } catch (err) {
        console.warn(`[Jobs] Could not fetch patient/provider info for ${claimId}:`, err.message);
    }

    // Run scrub
    const scrubResult = await scrubClaim(claim, patientInfo, providerInfo);

    let finalClaim = claim;
    let corrections = [];

    // Auto-correct if enabled and there are fixable issues
    if (conn.auto_correct_enabled && scrubResult.autoFixable.length > 0) {
        const { corrected, corrections: autoCorrections } = autoCorrectClaim(claim, scrubResult.autoFixable);
        finalClaim = corrected;
        corrections = autoCorrections;
        scrubResult.autoFixed = autoCorrections;
    }

    // Get plain-English narrative for complex cases
    let narrative = null;
    if (scrubResult.scrubScore < 60) {
        narrative = await getComplexReviewNarrative(claim, scrubResult.errors, scrubResult.warnings);
    }

    // Build scrub report
    const report = buildScrubReport(claim, finalClaim, scrubResult.errors, scrubResult.warnings, corrections);

    // Upsert claim record in DB
    const claimRecord = {
        client_slug: clientSlug,
        claim_id: claim.claimId,
        patient_id: claim.patientId,
        patient_name: claim.patientName,
        dos: claim.dos,
        payer_id: claim.payer?.payerId,
        payer_name: claim.payer?.payerName,
        member_id: claim.payer?.memberId,
        procedure_codes: claim.procedureCodes || [],
        diagnosis_codes: claim.diagnosisCodes || [],
        billed_amount: claim.billedAmount || 0,
        status: scrubResult.passed ? 'scrubbed' : 'pending_scrub',
        scrub_score: scrubResult.scrubScore,
        scrub_errors: scrubResult.errors,
        scrub_warnings: scrubResult.warnings,
        auto_corrections: corrections,
        updated_at: new Date().toISOString()
    };

    const { data: existing } = await supabase
        .from('cc_claims')
        .select('id')
        .eq('client_slug', clientSlug)
        .eq('claim_id', claim.claimId)
        .single();

    if (existing) {
        await supabase.from('cc_claims').update(claimRecord).eq('id', existing.id);
    } else {
        await supabase.from('cc_claims').insert(claimRecord);
    }

    // Update PMS with scrub status
    try {
        const statusNote = scrubResult.passed
            ? `GRIDHAND: Clean claim — score ${scrubResult.scrubScore}/100`
            : `GRIDHAND: ${scrubResult.errors.length} error(s) found — score ${scrubResult.scrubScore}/100${narrative ? '. ' + narrative.substring(0, 200) : ''}`;
        await pms.updateClaimStatus(clientSlug, claim.claimId, scrubResult.passed ? 'scrubbed' : 'hold', statusNote);
    } catch (err) {
        console.warn(`[Jobs] Could not update PMS status for claim ${claimId}:`, err.message);
    }

    return {
        ok: true,
        claimId: claim.claimId,
        passed: scrubResult.passed,
        scrubScore: scrubResult.scrubScore,
        errors: scrubResult.errors.length,
        warnings: scrubResult.warnings.length,
        autoFixed: corrections.length
    };
});

// ============================================================
// JOB: CHECK DENIALS
// Fetches new ERAs from clearinghouse, processes denial records
// ============================================================

queues.checkDenials.process('check', 2, async (job) => {
    const { clientSlug } = job.data;

    let eraRecords = [];
    try {
        eraRecords = await ch.fetchERA(clientSlug);
    } catch (err) {
        console.error(`[Jobs] fetchERA failed for ${clientSlug}:`, err.message);
        return { error: err.message };
    }

    if (eraRecords.length === 0) {
        return { ok: true, processed: 0 };
    }

    let paidCount = 0;
    let deniedCount = 0;
    let totalPaid = 0;

    for (const era of eraRecords) {
        // Find matching claim in DB
        const { data: claim } = await supabase
            .from('cc_claims')
            .select('*')
            .eq('client_slug', clientSlug)
            .eq('claim_id', era.originalClaimId)
            .single();

        const newStatus = era.status === 'paid' ? 'paid' : era.status === 'denied' ? 'denied' : 'accepted';
        const updates = {
            status: newStatus,
            paid_amount: era.paidAmount || 0,
            clearinghouse_status: era.status,
            updated_at: new Date().toISOString()
        };

        if (era.status === 'denied') {
            updates.denial_code = era.denialCode;
            updates.denial_reason = era.denialReason;
            updates.denied_at = new Date().toISOString();
            deniedCount++;
        }

        if (era.status === 'paid') {
            updates.paid_at = new Date().toISOString();
            totalPaid += era.paidAmount || 0;
            paidCount++;
        }

        if (claim) {
            await supabase.from('cc_claims').update(updates).eq('id', claim.id);
        }

        // Log denial
        if (era.status === 'denied' && era.denialCode) {
            await supabase.from('cc_denial_log').insert({
                client_slug: clientSlug,
                claim_id: claim?.id || null,
                denial_code: era.denialCode,
                denial_reason: era.denialReason,
                dos: claim?.dos,
                payer_id: claim?.payer_id,
                procedure_code: (claim?.procedure_codes?.[0]?.cpt) || null,
                amount: claim?.billed_amount || 0,
                action_taken: 'pending'
            });
        }
    }

    // Log ERA batch
    await supabase.from('cc_era_log').insert({
        client_slug: clientSlug,
        era_date: dayjs().format('YYYY-MM-DD'),
        total_claims: eraRecords.length,
        paid_count: paidCount,
        denied_count: deniedCount,
        total_paid: totalPaid,
        raw_data: { summary: `${eraRecords.length} records processed` },
        processed_at: new Date().toISOString()
    });

    // Alert billing staff if high denial count
    if (deniedCount > 0) {
        const { data: conn } = await supabase
            .from('cc_connections')
            .select('staff_phone, practice_name')
            .eq('client_slug', clientSlug)
            .single();

        if (conn?.staff_phone) {
            const msg = `GRIDHAND Claims: ${deniedCount} new denial(s) received for ${conn.practice_name}. $${totalPaid.toFixed(2)} paid on ${paidCount} claim(s). Review denial log for action items.`;
            await sendSMS(clientSlug, conn.staff_phone, msg);
        }
    }

    return { ok: true, processed: eraRecords.length, paid: paidCount, denied: deniedCount, totalPaid };
});

// ============================================================
// JOB: RESUBMIT
// Resubmits a corrected/previously denied claim
// ============================================================

queues.resubmit.process('resubmit', 3, async (job) => {
    const { clientSlug, claimDbId } = job.data;

    const { data: claim } = await supabase
        .from('cc_claims')
        .select('*')
        .eq('id', claimDbId)
        .eq('client_slug', clientSlug)
        .single();

    if (!claim) return { error: 'Claim not found in DB' };

    if (!['denied', 'rejected', 'scrubbed'].includes(claim.status)) {
        return { skipped: true, reason: `Claim status is ${claim.status} — not eligible for resubmit` };
    }

    // Build normalized claim object from DB record
    const claimObj = {
        claimId: claim.claim_id,
        patientName: claim.patient_name,
        dos: claim.dos,
        payer: { payerId: claim.payer_id, payerName: claim.payer_name, memberId: claim.member_id },
        procedureCodes: claim.procedure_codes || [],
        diagnosisCodes: claim.diagnosis_codes || [],
        billedAmount: claim.billed_amount
    };

    // Re-scrub before resubmitting
    const reScrub = await scrubClaim(claimObj, null, null);
    if (!reScrub.passed && reScrub.scrubScore < 50) {
        return { ok: false, error: 'Claim still has significant errors — manual review needed', scrubScore: reScrub.scrubScore };
    }

    // Auto-correct any remaining fixable issues
    let finalClaim = claimObj;
    if (reScrub.autoFixable.length > 0) {
        const { corrected } = autoCorrectClaim(claimObj, reScrub.autoFixable);
        finalClaim = corrected;
    }

    // Submit to clearinghouse
    let submitResult;
    try {
        if (claim.tracking_id) {
            submitResult = await ch.resubmitCorrectedClaim(clientSlug, claim.tracking_id, finalClaim, '7');
        } else {
            submitResult = await ch.submitClaim(clientSlug, finalClaim);
        }
    } catch (err) {
        await supabase.from('cc_claims').update({
            status: 'rejected',
            clearinghouse_status: 'submission_error',
            updated_at: new Date().toISOString()
        }).eq('id', claimDbId);
        return { ok: false, error: err.message };
    }

    // Update claim record
    await supabase.from('cc_claims').update({
        status: 'resubmitted',
        tracking_id: submitResult.trackingId,
        clearinghouse_status: submitResult.status,
        resubmission_count: (claim.resubmission_count || 0) + 1,
        last_resubmit_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    }).eq('id', claimDbId);

    // Update denial log action
    if (claim.denial_code) {
        await supabase.from('cc_denial_log')
            .update({ action_taken: 'resubmitted', action_at: new Date().toISOString() })
            .eq('claim_id', claimDbId)
            .eq('action_taken', 'pending');
    }

    return { ok: true, trackingId: submitResult.trackingId, status: submitResult.status };
});

// ============================================================
// JOB: WEEKLY DIGEST
// Sends denial stats summary to billing staff
// ============================================================

queues.digest.process('digest', 2, async (job) => {
    const { clientSlug } = job.data;

    const { data: conn } = await supabase
        .from('cc_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (!conn?.staff_phone) return { skipped: true, reason: 'No staff phone configured' };

    const weekStart = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
    const today = dayjs().format('YYYY-MM-DD');

    const [claimsRes, denialsRes, weekStatsRes] = await Promise.all([
        supabase.from('cc_claims')
            .select('status, billed_amount, paid_amount, denial_code')
            .eq('client_slug', clientSlug)
            .gte('updated_at', weekStart),
        supabase.from('cc_denial_log')
            .select('denial_code, denial_reason, amount, action_taken')
            .eq('client_slug', clientSlug)
            .gte('created_at', weekStart),
        supabase.from('cc_weekly_stats')
            .select('*')
            .eq('client_slug', clientSlug)
            .eq('week_start', weekStart)
            .single()
    ]);

    const claims = claimsRes.data || [];
    const denials = denialsRes.data || [];

    const submitted = claims.filter(c => ['submitted','accepted','paid','denied','resubmitted'].includes(c.status)).length;
    const paid = claims.filter(c => c.status === 'paid').length;
    const denied = claims.filter(c => c.status === 'denied').length;
    const scrubbed = claims.filter(c => c.status === 'scrubbed').length;
    const totalBilled = claims.reduce((s, c) => s + (c.billed_amount || 0), 0);
    const totalCollected = claims.reduce((s, c) => s + (c.paid_amount || 0), 0);
    const denialRate = submitted > 0 ? ((denied / submitted) * 100).toFixed(1) : '0.0';
    const cleanClaimRate = scrubbed > 0 ? (((scrubbed - denied) / scrubbed) * 100).toFixed(1) : '0.0';

    // Top denial codes
    const codeCount = {};
    for (const d of denials) {
        codeCount[d.denial_code] = (codeCount[d.denial_code] || 0) + 1;
    }
    const topCodes = Object.entries(codeCount)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([code, count]) => `${code}(${count})`);

    // Save weekly stats
    const statsRecord = {
        client_slug: clientSlug,
        week_start: weekStart,
        claims_scrubbed: scrubbed,
        clean_claim_rate: parseFloat(cleanClaimRate),
        auto_corrections_count: 0, // aggregated separately if needed
        claims_submitted: submitted,
        claims_paid: paid,
        claims_denied: denied,
        denial_rate: parseFloat(denialRate),
        revenue_billed: totalBilled,
        revenue_collected: totalCollected,
        top_denial_codes: topCodes.map(c => ({ code: c }))
    };

    await supabase.from('cc_weekly_stats')
        .upsert(statsRecord, { onConflict: 'client_slug,week_start' });

    // Send SMS digest
    const smsLines = [
        `GRIDHAND Weekly Claims Report — ${conn.practice_name}`,
        `Week of ${weekStart}`,
        `Submitted: ${submitted} | Paid: ${paid} | Denied: ${denied}`,
        `Denial Rate: ${denialRate}% | Clean Claim Rate: ${cleanClaimRate}%`,
        `Billed: $${totalBilled.toFixed(0)} | Collected: $${totalCollected.toFixed(0)}`
    ];
    if (topCodes.length > 0) smsLines.push(`Top Denial Codes: ${topCodes.join(', ')}`);
    if (denied > 0) smsLines.push(`${denied} claim(s) need action — check denial log.`);

    await sendSMS(clientSlug, conn.staff_phone, smsLines.join('\n'));

    return { ok: true, submitted, paid, denied, denialRate, cleanClaimRate };
});

// ============================================================
// HELPERS — called from index.js
// ============================================================

async function runScrubBatch(clientSlug) {
    return queues.scrubBatch.add('scrub', { clientSlug }, { priority: 2 });
}

async function runSingleScrub(clientSlug, claimId, claimData) {
    return queues.singleScrub.add('scrub', { clientSlug, claimId, claimData: claimData || null }, { priority: 1 });
}

async function runCheckDenials(clientSlug) {
    return queues.checkDenials.add('check', { clientSlug }, { priority: 2 });
}

async function runResubmit(clientSlug, claimDbId) {
    return queues.resubmit.add('resubmit', { clientSlug, claimDbId }, { priority: 1 });
}

async function runWeeklyDigest(clientSlug) {
    return queues.digest.add('digest', { clientSlug }, { priority: 3 });
}

async function runForAllClients(jobFn) {
    const { data: clients } = await supabase
        .from('cc_connections')
        .select('client_slug');

    const results = [];
    for (const client of clients || []) {
        try {
            const job = await jobFn(client.client_slug);
            results.push({ clientSlug: client.client_slug, jobId: job.id });
        } catch (err) {
            results.push({ clientSlug: client.client_slug, error: err.message });
        }
    }
    return results;
}

// ============================================================
// CRON JOBS
// ============================================================

function startCronJobs() {
    // 6am daily — scrub overnight batch
    cron.schedule('0 6 * * *', async () => {
        console.log('[Jobs] Running overnight scrub batch for all clients...');
        await runForAllClients(runScrubBatch);
    });

    // Every 4 hours — check clearinghouse for new ERAs
    cron.schedule('0 */4 * * *', async () => {
        console.log('[Jobs] Checking clearinghouse ERAs for all clients...');
        await runForAllClients(runCheckDenials);
    });

    // Monday 8am — weekly denial digest
    cron.schedule('0 8 * * 1', async () => {
        console.log('[Jobs] Sending weekly denial digests...');
        await runForAllClients(runWeeklyDigest);
    });

    console.log('[Jobs] Claims Cleaner cron jobs started.');
}

// ============================================================
// QUEUE ERROR HANDLERS
// ============================================================

for (const [name, queue] of Object.entries(queues)) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] Queue "${name}" job ${job.id} failed (attempt ${job.attemptsMade}):`, err.message);
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

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    queues,
    runScrubBatch,
    runSingleScrub,
    runCheckDenials,
    runResubmit,
    runWeeklyDigest,
    runForAllClients,
    startCronJobs,
    getQueueStats
};
