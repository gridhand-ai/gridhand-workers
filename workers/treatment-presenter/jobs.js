/**
 * GRIDHAND AI — Treatment Presenter
 * Bull Queue Job Definitions
 *
 * Queues:
 *   tp:scan-plans  — Find new uncontacted treatment plans from PMS
 *   tp:present     — Present one specific treatment plan to patient via SMS
 *   tp:followup    — Run full follow-up cadence for a practice
 *   tp:digest      — Send weekly acceptance rate stats to practice owner
 */

'use strict';

const Bull  = require('bull');
const cron  = require('node-cron');
const dayjs = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

const { getTreatmentPlans, getTreatmentPlanById, getPatientById } = require('./pms');
const { generatePlanSummary, sendPlanToPatient } = require('./presenter');
const { runFollowUpSequence, sendWeeklyDigest } = require('./followup');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ============================================================
// REDIS CONFIG
// ============================================================

const REDIS_CONFIG = {
    host:     process.env.REDIS_HOST     || '127.0.0.1',
    port:     parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    tls:      process.env.REDIS_TLS === 'true' ? {} : undefined
};

const QUEUE_OPTS = {
    redis: REDIS_CONFIG,
    defaultJobOptions: {
        removeOnComplete: 50,
        removeOnFail:    100,
        attempts:        3,
        backoff: { type: 'exponential', delay: 5000 }
    }
};

// ============================================================
// QUEUE DEFINITIONS
// ============================================================

const queues = {
    scan:    new Bull('tp:scan-plans', QUEUE_OPTS),
    present: new Bull('tp:present',    QUEUE_OPTS),
    followup: new Bull('tp:followup',  QUEUE_OPTS),
    digest:  new Bull('tp:digest',     QUEUE_OPTS)
};

// ============================================================
// JOB: SCAN NEW PLANS
// Find treatment plans from PMS not yet in tp_plans (uncontacted).
// Fetches 'pending' status plans, checks against existing DB records,
// and upserts new plans ready for presentation.
// ============================================================

queues.scan.process('scan', 2, async (job) => {
    const { clientSlug } = job.data;

    const conn = await _getConn(clientSlug);
    if (!conn) return { error: 'Connection not found', clientSlug };

    let plans;
    try {
        plans = await getTreatmentPlans(clientSlug, 'pending');
    } catch (err) {
        console.error(`[Jobs:scan] PMS fetch error for ${clientSlug}:`, err.message);
        return { error: err.message };
    }

    if (!plans || plans.length === 0) {
        return { ok: true, found: 0, inserted: 0 };
    }

    let inserted = 0;
    let skipped  = 0;

    for (const plan of plans) {
        if (!plan.patient_id) { skipped++; continue; }

        // Check if we already have this plan tracked
        const { data: existing } = await supabase
            .from('tp_plans')
            .select('id, status')
            .eq('client_slug', clientSlug)
            .eq('plan_id', plan.plan_id)
            .single();

        if (existing) {
            skipped++;
            continue;
        }

        // Fetch patient contact info
        let patient;
        try {
            patient = await getPatientById(clientSlug, plan.patient_id);
        } catch (err) {
            console.warn(`[Jobs:scan] Could not fetch patient ${plan.patient_id}:`, err.message);
            skipped++;
            continue;
        }

        if (!patient.phone) { skipped++; continue; }

        // Insert into tp_plans
        const row = {
            client_slug:            clientSlug,
            plan_id:                plan.plan_id,
            patient_id:             plan.patient_id,
            patient_name:           patient.full_name || plan.patient_name,
            patient_phone:          patient.phone,
            procedures:             plan.procedures || [],
            total_fee:              plan.total_fee || 0,
            total_insurance_est:    plan.total_insurance_est || 0,
            total_patient_portion:  plan.total_patient_portion || 0,
            plain_summary:          null,
            status:                 'pending',
            contact_count:          0,
            created_at:             new Date().toISOString(),
            updated_at:             new Date().toISOString()
        };

        const { error } = await supabase.from('tp_plans').insert(row);
        if (!error) {
            inserted++;
        } else {
            console.error('[Jobs:scan] Insert error:', error.message);
        }

        await _sleep(200);
    }

    console.log(`[Jobs:scan] ${clientSlug} — found ${plans.length}, inserted ${inserted}, skipped ${skipped}`);
    return { ok: true, found: plans.length, inserted, skipped };
});

// ============================================================
// JOB: PRESENT PLAN
// Fetch full plan detail from PMS, generate AI summary,
// send initial SMS to patient, and mark as contacted.
// ============================================================

queues.present.process('present', 3, async (job) => {
    const { clientSlug, planId } = job.data;

    const conn = await _getConn(clientSlug);
    if (!conn) return { error: 'Connection not found', clientSlug };

    // Get the tp_plans DB row (may have planId as PMS plan_id or DB uuid)
    const { data: dbRow } = await supabase
        .from('tp_plans')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('plan_id', planId)
        .single();

    if (!dbRow) {
        return { error: `Plan not found in tp_plans for plan_id: ${planId}` };
    }

    // Skip already-contacted or terminal plans
    if (['accepted', 'declined', 'opted_out'].includes(dbRow.status)) {
        return { ok: true, skipped: true, reason: `Plan status is ${dbRow.status}` };
    }

    // Fetch full plan detail from PMS (for up-to-date fees + insurance estimates)
    let fullPlan;
    try {
        fullPlan = await getTreatmentPlanById(clientSlug, planId);
    } catch (err) {
        console.warn(`[Jobs:present] PMS plan fetch failed, using DB data: ${err.message}`);
        fullPlan = {
            plan_id:               dbRow.plan_id,
            patient_id:            dbRow.patient_id,
            patient_name:          dbRow.patient_name,
            procedures:            dbRow.procedures || [],
            total_fee:             parseFloat(dbRow.total_fee || 0),
            total_insurance_est:   parseFloat(dbRow.total_insurance_est || 0),
            total_patient_portion: parseFloat(dbRow.total_patient_portion || 0)
        };
    }

    // Fetch patient info
    let patient;
    try {
        patient = await getPatientById(clientSlug, fullPlan.patient_id);
    } catch (err) {
        console.warn(`[Jobs:present] Patient fetch failed, using DB data: ${err.message}`);
        patient = {
            patient_id:   dbRow.patient_id,
            first_name:   dbRow.patient_name?.split(' ')[0] || '',
            full_name:    dbRow.patient_name,
            phone:        dbRow.patient_phone
        };
    }

    if (!patient.phone) {
        return { error: 'Patient has no phone number' };
    }

    // Generate AI-powered plain language summary
    let summaryResult;
    try {
        summaryResult = await generatePlanSummary(fullPlan, patient.first_name || patient.full_name);
    } catch (err) {
        console.error(`[Jobs:present] generatePlanSummary failed: ${err.message}`);
        summaryResult = {
            summary:   `Your dentist has recommended treatment totaling approximately $${fullPlan.total_patient_portion.toFixed(2)} out-of-pocket after insurance.`,
            breakdown: fullPlan.procedures || []
        };
    }

    // Update DB with generated summary and updated fees
    await supabase.from('tp_plans').update({
        plain_summary:          summaryResult.summary,
        procedures:             fullPlan.procedures,
        total_fee:              fullPlan.total_fee,
        total_insurance_est:    fullPlan.total_insurance_est,
        total_patient_portion:  fullPlan.total_patient_portion,
        patient_phone:          patient.phone,
        patient_name:           patient.full_name || dbRow.patient_name,
        updated_at:             new Date().toISOString()
    }).eq('id', dbRow.id);

    // Send SMS to patient
    const planWithDbId = { ...fullPlan, db_id: dbRow.id };
    const sendResult = await sendPlanToPatient(conn, patient, planWithDbId, summaryResult);

    if (!sendResult.ok) {
        return { error: sendResult.error };
    }

    // Mark plan as contacted in DB
    await supabase.from('tp_plans').update({
        status:          'contacted',
        contact_count:   1,
        last_contact_at: new Date().toISOString(),
        updated_at:      new Date().toISOString()
    }).eq('id', dbRow.id);

    console.log(`[Jobs:present] ${clientSlug} — presented plan ${planId} to ${patient.phone} (${sendResult.parts_sent} SMS parts)`);
    return { ok: true, planId, patientPhone: patient.phone, partsSent: sendResult.parts_sent };
});

// ============================================================
// JOB: FOLLOW-UPS
// Run full follow-up sequence for all active contacted plans.
// ============================================================

queues.followup.process('followup', 2, async (job) => {
    const { clientSlug } = job.data;

    const conn = await _getConn(clientSlug);
    if (!conn) return { error: 'Connection not found' };

    const result = await runFollowUpSequence(clientSlug);
    return result;
});

// ============================================================
// JOB: WEEKLY DIGEST
// Send weekly stats to practice owner.
// ============================================================

queues.digest.process('digest', 2, async (job) => {
    const { clientSlug } = job.data;

    const conn = await _getConn(clientSlug);
    if (!conn) return { error: 'Connection not found' };

    const result = await sendWeeklyDigest(conn);
    return result;
});

// ============================================================
// PUBLIC JOB RUNNER FUNCTIONS
// ============================================================

async function runScanNewPlans(clientSlug) {
    return queues.scan.add('scan', { clientSlug }, { jobId: `tp-scan-${clientSlug}-${Date.now()}` });
}

async function runPresentPlan(clientSlug, planId) {
    return queues.present.add('present', { clientSlug, planId }, { jobId: `tp-present-${clientSlug}-${planId}` });
}

async function runFollowUps(clientSlug) {
    return queues.followup.add('followup', { clientSlug }, { jobId: `tp-followup-${clientSlug}-${Date.now()}` });
}

async function runWeeklyDigest(clientSlug) {
    return queues.digest.add('digest', { clientSlug }, { jobId: `tp-digest-${clientSlug}-${Date.now()}` });
}

/**
 * Run a job function for every active connected practice.
 * @param {Function} jobFn - async function(clientSlug) returning a Bull job
 */
async function runForAllClients(jobFn) {
    const { data: connections } = await supabase
        .from('tp_connections')
        .select('client_slug')
        .eq('followup_enabled', true);

    const jobs = [];
    for (const conn of connections || []) {
        try {
            const job = await jobFn(conn.client_slug);
            jobs.push({ clientSlug: conn.client_slug, jobId: job?.id });
        } catch (err) {
            console.error(`[Jobs] runForAllClients error for ${conn.client_slug}:`, err.message);
        }
    }
    return jobs;
}

// ============================================================
// CRON SCHEDULERS
// ============================================================

function startCronJobs() {
    // 10:00 AM daily — scan for new uncontacted treatment plans
    cron.schedule('0 10 * * *', async () => {
        console.log('[Jobs] 10am — Scanning for new treatment plans for all clients...');
        await runForAllClients(runScanNewPlans);
        // 5-minute delay to allow scan jobs to complete before presenting
        setTimeout(async () => {
            // Present all pending plans that were just scanned
            const { data: pendingPlans } = await supabase
                .from('tp_plans')
                .select('client_slug, plan_id')
                .eq('status', 'pending')
                .is('plain_summary', null)
                .limit(100);

            for (const p of (pendingPlans || [])) {
                await runPresentPlan(p.client_slug, p.plan_id);
                await _sleep(1000); // 1s between queuing to spread load
            }
        }, 5 * 60 * 1000);
    });

    // 2:00 PM daily — send follow-ups to patients who haven't responded
    cron.schedule('0 14 * * *', async () => {
        console.log('[Jobs] 2pm — Running follow-up sequences for all clients...');
        await runForAllClients(runFollowUps);
    });

    // Monday 9:00 AM — weekly acceptance rate digest to practice owners
    cron.schedule('0 9 * * 1', async () => {
        console.log('[Jobs] Monday 9am — Sending weekly digest for all clients...');
        await runForAllClients(runWeeklyDigest);
    });

    console.log('[Jobs] Cron jobs started — 10am scan, 2pm follow-ups, Monday 9am digest.');
}

// ============================================================
// QUEUE ERROR HANDLERS + HEALTH
// ============================================================

for (const [name, queue] of Object.entries(queues)) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] Queue "tp:${name === 'scan' ? 'scan-plans' : name}" job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts}):`, err.message);
    });

    queue.on('error', (err) => {
        console.error(`[Jobs] Queue "tp:${name === 'scan' ? 'scan-plans' : name}" error:`, err.message);
    });
}

async function getQueueStats() {
    const stats = {};
    const queueNames = {
        scan:    'tp:scan-plans',
        present: 'tp:present',
        followup: 'tp:followup',
        digest:  'tp:digest'
    };

    for (const [key, queue] of Object.entries(queues)) {
        const [waiting, active, completed, failed] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount()
        ]);
        stats[queueNames[key]] = { waiting, active, completed, failed };
    }
    return stats;
}

// ============================================================
// HELPERS
// ============================================================

async function _getConn(clientSlug) {
    const { data } = await supabase
        .from('tp_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    return data || null;
}

function _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    queues,
    runScanNewPlans,
    runPresentPlan,
    runFollowUps,
    runWeeklyDigest,
    runForAllClients,
    startCronJobs,
    getQueueStats
};
