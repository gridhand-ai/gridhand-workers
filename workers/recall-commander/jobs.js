/**
 * GRIDHAND AI — Recall Commander
 * Bull Queue Job Definitions
 *
 * Queues:
 *   recall:scan       — Detect overdue patients from PMS and populate rc_recall_queue
 *   recall:reminder   — Send first recall SMS to newly detected overdue patients
 *   recall:followup   — Send follow-up texts on day 3 and day 7 to non-responders
 *   recall:escalate   — Alert front desk about patients with 7+ day no response
 *   recall:digest     — Morning digest SMS to front desk and owner
 */

'use strict';

const Bull = require('bull');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const dayjs = require('dayjs');

const { getRecallDuePatients, updateRecallStatus } = require('./dentrix');
const { sendRecallReminder, sendFollowUp, sendEscalationAlert, sendDailyDigest, _upsertDailyStat } = require('./reminders');

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
    scan:     new Bull('recall:scan',     QUEUE_OPTS),
    reminder: new Bull('recall:reminder', QUEUE_OPTS),
    followup: new Bull('recall:followup', QUEUE_OPTS),
    escalate: new Bull('recall:escalate', QUEUE_OPTS),
    digest:   new Bull('recall:digest',   QUEUE_OPTS)
};

// ============================================================
// JOB: RECALL SCAN
// Detect overdue patients from PMS and upsert into rc_recall_queue
// ============================================================

queues.scan.process('scan', 2, async (job) => {
    const { clientSlug } = job.data;

    const conn = await _getConn(clientSlug);
    if (!conn) return { error: 'Connection not found', clientSlug };

    const overdue = await getRecallDuePatients(clientSlug);
    if (!overdue || overdue.length === 0) {
        return { ok: true, detected: 0 };
    }

    let inserted = 0;
    let updated  = 0;
    let skipped  = 0;

    for (const patient of overdue) {
        if (!patient.patient_phone) { skipped++; continue; }

        // Upsert: on conflict (client_slug, patient_id, recall_type) update days_overdue only
        const row = {
            client_slug:     clientSlug,
            patient_id:      patient.patient_id,
            patient_name:    patient.patient_name,
            patient_phone:   patient.patient_phone,
            patient_email:   patient.email || null,
            last_visit_date: patient.last_visit_date || null,
            recall_type:     patient.recall_type,
            days_overdue:    patient.days_overdue || 0,
            status:          'pending'
        };

        const { data: existing } = await supabase
            .from('rc_recall_queue')
            .select('id, status')
            .eq('client_slug', clientSlug)
            .eq('patient_id', patient.patient_id)
            .eq('recall_type', patient.recall_type)
            .single();

        if (existing) {
            // Only update days_overdue if status is still pending or no_response
            if (['pending', 'no_response'].includes(existing.status)) {
                await supabase.from('rc_recall_queue')
                    .update({ days_overdue: patient.days_overdue })
                    .eq('id', existing.id);
                updated++;
            } else {
                skipped++;
            }
        } else {
            const { error } = await supabase.from('rc_recall_queue').insert(row);
            if (!error) inserted++;
            else console.error('[Jobs:scan] Insert error:', error.message);
        }
    }

    console.log(`[Jobs:scan] ${clientSlug} — detected ${overdue.length}, inserted ${inserted}, updated ${updated}, skipped ${skipped}`);
    return { ok: true, detected: overdue.length, inserted, updated, skipped };
});

// ============================================================
// JOB: SEND REMINDERS
// Send first recall SMS to patients in 'pending' status
// ============================================================

queues.reminder.process('reminder', 3, async (job) => {
    const { clientSlug } = job.data;

    const conn = await _getConn(clientSlug);
    if (!conn) return { error: 'Connection not found' };

    // Fetch pending patients — up to 50 per run to avoid rate limits
    const { data: pending } = await supabase
        .from('rc_recall_queue')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'pending')
        .order('days_overdue', { ascending: false })
        .limit(50);

    if (!pending || pending.length === 0) return { ok: true, sent: 0 };

    let sent = 0;
    let failed = 0;

    for (const patient of pending) {
        // Skip opted-out patients
        if (patient.status === 'opted_out') { continue; }

        const result = await sendRecallReminder(conn, patient, patient.days_overdue);
        if (result.ok) {
            sent++;
        } else {
            failed++;
            console.error(`[Jobs:reminder] Failed for patient ${patient.patient_id}:`, result.error);
        }

        // 500ms pause between sends to respect Twilio rate limits
        await _sleep(500);
    }

    console.log(`[Jobs:reminder] ${clientSlug} — sent ${sent}, failed ${failed}`);
    return { ok: true, sent, failed };
});

// ============================================================
// JOB: SEND FOLLOW-UPS
// Day 3 and Day 7 follow-ups for non-responders
// ============================================================

queues.followup.process('followup', 3, async (job) => {
    const { clientSlug } = job.data;

    const conn = await _getConn(clientSlug);
    if (!conn) return { error: 'Connection not found' };

    const now = dayjs();
    const day3Cutoff = now.subtract(3, 'day').toISOString();
    const day7Cutoff = now.subtract(7, 'day').toISOString();
    const day10Cutoff = now.subtract(10, 'day').toISOString();

    // Patients contacted 3-6 days ago with only 1 reminder (due for attempt 2)
    const { data: day3Patients } = await supabase
        .from('rc_recall_queue')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'contacted')
        .eq('reminder_count', 1)
        .lte('last_reminder_sent_at', day3Cutoff)
        .gt('last_reminder_sent_at', day7Cutoff)
        .limit(50);

    // Patients contacted 7-9 days ago with 2 reminders (due for attempt 3)
    const { data: day7Patients } = await supabase
        .from('rc_recall_queue')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'contacted')
        .eq('reminder_count', 2)
        .lte('last_reminder_sent_at', day7Cutoff)
        .gt('last_reminder_sent_at', day10Cutoff)
        .limit(50);

    let sent3 = 0, sent7 = 0, failed = 0;

    for (const patient of (day3Patients || [])) {
        const result = await sendFollowUp(conn, patient, 1);
        if (result.ok) sent3++;
        else { failed++; console.error(`[Jobs:followup] day3 failed for ${patient.patient_id}:`, result.error); }
        await _sleep(500);
    }

    for (const patient of (day7Patients || [])) {
        const result = await sendFollowUp(conn, patient, 2);
        if (result.ok) {
            sent7++;
            // After final follow-up, mark as no_response if they still haven't replied
            // (they'll be re-checked on the next followup pass)
            await supabase.from('rc_recall_queue')
                .update({ status: 'no_response' })
                .eq('id', patient.id);
        } else {
            failed++;
            console.error(`[Jobs:followup] day7 failed for ${patient.patient_id}:`, result.error);
        }
        await _sleep(500);
    }

    console.log(`[Jobs:followup] ${clientSlug} — day3: ${sent3}, day7: ${sent7}, failed: ${failed}`);
    return { ok: true, day3Sent: sent3, day7Sent: sent7, failed };
});

// ============================================================
// JOB: ESCALATION
// Alert front desk about 7+ day no-responses
// ============================================================

queues.escalate.process('escalate', 2, async (job) => {
    const { clientSlug } = job.data;

    const conn = await _getConn(clientSlug);
    if (!conn) return { error: 'Connection not found' };

    const sevenDaysAgo = dayjs().subtract(7, 'day').toISOString();

    const { data: noResponse } = await supabase
        .from('rc_recall_queue')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'no_response')
        .lte('last_reminder_sent_at', sevenDaysAgo)
        .order('days_overdue', { ascending: false })
        .limit(100);

    if (!noResponse || noResponse.length === 0) {
        return { ok: true, escalated: 0 };
    }

    const result = await sendEscalationAlert(conn, noResponse);

    console.log(`[Jobs:escalate] ${clientSlug} — escalated ${noResponse.length} patients`);
    return { ok: result.ok, escalated: noResponse.length };
});

// ============================================================
// JOB: DAILY DIGEST
// Morning stats SMS to owner and front desk
// ============================================================

queues.digest.process('digest', 2, async (job) => {
    const { clientSlug } = job.data;

    const conn = await _getConn(clientSlug);
    if (!conn) return { error: 'Connection not found' };

    const result = await sendDailyDigest(conn);
    return result;
});

// ============================================================
// PUBLIC JOB RUNNER FUNCTIONS
// ============================================================

async function runRecallScan(clientSlug) {
    return queues.scan.add('scan', { clientSlug }, { jobId: `scan-${clientSlug}-${Date.now()}` });
}

async function runSendReminders(clientSlug) {
    return queues.reminder.add('reminder', { clientSlug }, { jobId: `reminder-${clientSlug}-${Date.now()}` });
}

async function runFollowUps(clientSlug) {
    return queues.followup.add('followup', { clientSlug }, { jobId: `followup-${clientSlug}-${Date.now()}` });
}

async function runEscalation(clientSlug) {
    return queues.escalate.add('escalate', { clientSlug }, { jobId: `escalate-${clientSlug}-${Date.now()}` });
}

async function runDailyDigest(clientSlug) {
    return queues.digest.add('digest', { clientSlug }, { jobId: `digest-${clientSlug}-${Date.now()}` });
}

/**
 * Run a job function for every active connected practice.
 * @param {Function} jobFn - async function(clientSlug) returning a Bull job
 */
async function runForAllClients(jobFn) {
    const { data: connections } = await supabase
        .from('rc_connections')
        .select('client_slug')
        .eq('active', true);

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
    // 9:00 AM daily — scan for overdue patients + send first reminders
    cron.schedule('0 9 * * *', async () => {
        console.log('[Jobs] 9am — Running recall scan for all clients...');
        await runForAllClients(runRecallScan);
        // Delay 5 minutes after scan before sending reminders to let scan jobs complete
        setTimeout(async () => {
            await runForAllClients(runSendReminders);
        }, 5 * 60 * 1000);
    });

    // 9:15 AM daily — send follow-ups to non-responders from day 3 and day 7
    cron.schedule('15 9 * * *', async () => {
        console.log('[Jobs] 9:15am — Running follow-up job for all clients...');
        await runForAllClients(runFollowUps);
    });

    // 4:00 PM daily — escalate 7+ day no-responses to front desk
    cron.schedule('0 16 * * *', async () => {
        console.log('[Jobs] 4pm — Running escalation job for all clients...');
        await runForAllClients(runEscalation);
    });

    // 8:00 AM daily — send daily digest to front desk and owner
    cron.schedule('0 8 * * *', async () => {
        console.log('[Jobs] 8am — Sending daily digest for all clients...');
        await runForAllClients(runDailyDigest);
    });

    console.log('[Jobs] Cron jobs started.');
}

// ============================================================
// QUEUE ERROR HANDLERS
// ============================================================

for (const [name, queue] of Object.entries(queues)) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] Queue "recall:${name}" job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts}):`, err.message);
    });

    queue.on('error', (err) => {
        console.error(`[Jobs] Queue "recall:${name}" error:`, err.message);
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
        stats[`recall:${name}`] = { waiting, active, completed, failed };
    }
    return stats;
}

// ============================================================
// HELPERS
// ============================================================

async function _getConn(clientSlug) {
    const { data } = await supabase
        .from('rc_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('active', true)
        .single();
    return data || null;
}

function _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    queues,
    runRecallScan,
    runSendReminders,
    runFollowUps,
    runEscalation,
    runDailyDigest,
    runForAllClients,
    startCronJobs,
    getQueueStats
};
