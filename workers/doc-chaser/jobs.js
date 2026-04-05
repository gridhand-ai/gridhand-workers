/**
 * GRIDHAND Doc Chaser — Bull Queue Job Definitions
 *
 * Queues:
 *   dc:request-sync    - Pull document requests from TaxDome, upsert to DB
 *   dc:reminder-send   - Send SMS/email reminders for pending/overdue requests
 *   dc:weekly-report   - Aggregate outstanding docs, save snapshot, notify owner
 *
 * Cron scheduling lives in index.js.
 * Job dispatchers at the bottom are called by index.js cron and /trigger endpoints.
 */

'use strict';

const Bull  = require('bull');
const dayjs = require('dayjs');

const db      = require('./db');
const taxdome = require('./taxdome');
const sms     = require('./sms');
const email   = require('./email');

// ─── Redis / Queue Config ─────────────────────────────────────────────────────

const REDIS_CONFIG = {
    host:     process.env.REDIS_HOST     || '127.0.0.1',
    port:     parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    tls:      process.env.REDIS_TLS === 'true' ? {} : undefined,
};

const QUEUE_OPTS = {
    redis: REDIS_CONFIG,
    defaultJobOptions: {
        attempts:         3,
        backoff:          { type: 'exponential', delay: 5000 },
        removeOnComplete: 50,
        removeOnFail:     100,
    },
};

// ─── Queue Definitions ────────────────────────────────────────────────────────

const requestSyncQueue  = new Bull('dc:request-sync',  QUEUE_OPTS);
const reminderSendQueue = new Bull('dc:reminder-send', QUEUE_OPTS);
const weeklyReportQueue = new Bull('dc:weekly-report', QUEUE_OPTS);

// ─── Job: Request Sync ────────────────────────────────────────────────────────
// Pull latest document requests from TaxDome, upsert to dc_document_requests,
// mark any that are now fulfilled as received.

requestSyncQueue.process('sync', 3, async (job) => {
    const { clientSlug } = job.data;
    console.log(`[RequestSync] Starting for ${clientSlug}`);

    const conn = await db.getClient(clientSlug);
    if (!conn) throw new Error(`No dc_client found for slug: ${clientSlug}`);
    if (!conn.taxdome_api_key || !conn.taxdome_firm_id) {
        console.warn(`[RequestSync] ${clientSlug} has no TaxDome credentials — skipping`);
        return { skipped: true, reason: 'No TaxDome credentials' };
    }

    // Fetch all outstanding requests from TaxDome
    const tdRequests = await taxdome.getAllDocumentRequests(conn.taxdome_api_key, conn.taxdome_firm_id);

    let upserted = 0;
    let markedReceived = 0;

    const liveRequestIds = new Set(tdRequests.map(r => r.taxdomeRequestId).filter(Boolean));

    // Upsert each live TaxDome request into our DB
    for (const req of tdRequests) {
        await db.upsertDocumentRequest(conn.id, req);
        upserted++;
    }

    // Promote pending requests past due_date to overdue
    await db.promoteOverdueRequests(conn.id);

    // Mark any of our tracked pending/overdue requests as received
    // if they no longer appear in TaxDome's outstanding list
    const ourRequests = await db.getPendingAndOverdueRequests(conn.id);
    for (const ourReq of ourRequests) {
        if (ourReq.taxdome_request_id && !liveRequestIds.has(ourReq.taxdome_request_id)) {
            await db.markRequestReceived(ourReq.id);
            markedReceived++;
            console.log(`[RequestSync] Marked received: "${ourReq.document_name}" for ${ourReq.client_name}`);
        }
    }

    console.log(`[RequestSync] Done for ${clientSlug} — upserted: ${upserted}, marked received: ${markedReceived}`);
    return { clientSlug, upserted, markedReceived };
});

// ─── Job: Reminder Send ───────────────────────────────────────────────────────
// For each pending/overdue request: check if interval has passed since last
// reminder, check reminder_count < max_reminders, send SMS + email.

reminderSendQueue.process('send', 5, async (job) => {
    const { clientSlug } = job.data;
    console.log(`[ReminderSend] Starting for ${clientSlug}`);

    const conn = await db.getClient(clientSlug);
    if (!conn) throw new Error(`No dc_client found for slug: ${clientSlug}`);

    const requests = await db.getPendingAndOverdueRequests(conn.id);
    const maxReminders        = conn.max_reminders || 4;
    const intervalDays        = conn.default_reminder_interval_days || 3;

    let smsSent   = 0;
    let emailSent = 0;
    let skipped   = 0;

    for (const req of requests) {
        // Skip if max reminders already sent
        if (req.reminder_count >= maxReminders) {
            skipped++;
            continue;
        }

        // Skip if not enough time has passed since last reminder
        if (req.last_reminder_sent_at) {
            const daysSinceLast = dayjs().diff(dayjs(req.last_reminder_sent_at), 'day');
            if (daysSinceLast < intervalDays) {
                skipped++;
                continue;
            }
        }

        const reminderCount = req.reminder_count || 0;
        let anySent = false;

        // Send SMS if phone available
        if (req.client_phone) {
            const result = await sms.sendDocumentReminder(conn, req, reminderCount);
            if (result.ok) {
                smsSent++;
                anySent = true;
            }
        }

        // Send email if email available
        if (req.client_email) {
            const result = await email.sendDocumentReminderEmail(conn, req, reminderCount);
            if (result.ok) {
                emailSent++;
                anySent = true;
            }
        }

        // Update reminder count only if at least one channel succeeded
        if (anySent) {
            await db.incrementReminderCount(req.id);
        } else {
            console.warn(`[ReminderSend] No valid contact info for request ${req.id} (${req.client_name}, "${req.document_name}")`);
        }
    }

    console.log(`[ReminderSend] Done for ${clientSlug} — SMS: ${smsSent}, Email: ${emailSent}, Skipped: ${skipped}`);
    return { clientSlug, smsSent, emailSent, skipped, total: requests.length };
});

// ─── Job: Weekly Report ───────────────────────────────────────────────────────
// Aggregate outstanding docs, save dc_weekly_reports snapshot,
// send SMS summary to owner + detailed email.

weeklyReportQueue.process('report', 2, async (job) => {
    const { clientSlug } = job.data;
    console.log(`[WeeklyReport] Starting for ${clientSlug}`);

    const conn = await db.getClient(clientSlug);
    if (!conn) throw new Error(`No dc_client found for slug: ${clientSlug}`);

    // Pull all requests for this client
    const all      = await db.getDocumentRequests(conn.id);
    const pending  = all.filter(r => r.status === 'pending');
    const overdue  = all.filter(r => r.status === 'overdue');
    const received = all.filter(r => r.status === 'received');

    const totalRequests  = all.length;
    const receivedCount  = received.length;
    const pendingCount   = pending.length;
    const overdueCount   = overdue.length;

    // Build outstanding items list (pending + overdue) for email detail
    const outstandingItems = [...overdue, ...pending].map(r => ({
        clientName:    r.client_name,
        documentName:  r.document_name,
        dueDate:       r.due_date,
        reminderCount: r.reminder_count,
        status:        r.status,
    }));

    const reportDate  = dayjs().format('YYYY-MM-DD');
    const reportData  = { outstandingItems, generatedAt: new Date().toISOString() };

    // Save snapshot
    const report = await db.saveWeeklyReport(conn.id, {
        reportDate,
        totalRequests,
        receivedCount,
        pendingCount,
        overdueCount,
        reportData,
    });

    // SMS summary to owner
    if (conn.owner_phone) {
        await sms.sendWeeklyReport(conn, { totalRequests, receivedCount, pendingCount, overdueCount });
    }

    // Detailed email to owner
    if (conn.email_from || conn.email_user || process.env.EMAIL_FROM) {
        await email.sendWeeklyOutstandingReport(conn, {
            totalRequests,
            receivedCount,
            pendingCount,
            overdueCount,
            outstandingItems,
        });
    }

    console.log(`[WeeklyReport] Done for ${clientSlug} — ${pendingCount} pending, ${overdueCount} overdue`);
    return { clientSlug, reportId: report.id, totalRequests, pendingCount, overdueCount };
});

// ─── Queue Error / Completion Handlers ────────────────────────────────────────

for (const [name, queue] of [
    ['request-sync',  requestSyncQueue],
    ['reminder-send', reminderSendQueue],
    ['weekly-report', weeklyReportQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} job failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} completed for ${job.data.clientSlug}`);
    });
    queue.on('error', (err) => {
        console.error(`[Jobs] ${name} queue error: ${err.message}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runSyncRequests(clientSlug) {
    return requestSyncQueue.add('sync', { clientSlug }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
}

async function runSendReminders(clientSlug) {
    return reminderSendQueue.add('send', { clientSlug }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
}

async function runWeeklyReport(clientSlug) {
    return weeklyReportQueue.add('report', { clientSlug }, { attempts: 2, backoff: { type: 'exponential', delay: 10000 } });
}

/**
 * Run a job function for every configured dc_clients row.
 * Matches the runForAllClients pattern used across all GridHand workers.
 *
 * @param {function} jobFn - async function(clientSlug) => Bull job
 */
async function runForAllClients(jobFn) {
    const clients = await db.getAllClients();
    const results = [];

    for (const { client_slug } of clients) {
        try {
            const job = await jobFn(client_slug);
            results.push({ clientSlug: client_slug, jobId: job.id });
        } catch (err) {
            console.error(`[Jobs] Failed to queue job for ${client_slug}: ${err.message}`);
            results.push({ clientSlug: client_slug, error: err.message });
        }
    }

    return results;
}

// ─── Queue Health ─────────────────────────────────────────────────────────────

async function getQueueStats() {
    const stats = {};

    for (const [name, queue] of [
        ['requestSync',  requestSyncQueue],
        ['reminderSend', reminderSendQueue],
        ['weeklyReport', weeklyReportQueue],
    ]) {
        const [waiting, active, completed, failed] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount(),
        ]);
        stats[name] = { waiting, active, completed, failed };
    }

    return stats;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    requestSyncQueue,
    reminderSendQueue,
    weeklyReportQueue,
    runSyncRequests,
    runSendReminders,
    runWeeklyReport,
    runForAllClients,
    getQueueStats,
};
