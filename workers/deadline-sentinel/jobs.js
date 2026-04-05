/**
 * GRIDHAND Deadline Sentinel — Bull Queue Job Definitions
 *
 * Jobs:
 *   scan-deadlines   — 7am daily: fetch all matters + deadlines, evaluate urgency, send alerts
 *   check-critical   — 12pm daily: second pass for critical (≤3 day) deadlines only
 *   check-missed     — Every 30 minutes: detect and flag any newly overdue deadlines
 *   weekly-report    — Monday 8am: compile and send the full weekly report per firm
 *
 * All cron scheduling is handled here via node-cron inside registerCrons().
 * index.js calls registerCrons() once on startup.
 */

'use strict';

require('dotenv').config();

const Bull     = require('bull');
const cron     = require('node-cron');
const caseMgmt = require('./case-mgmt');
const deadlines = require('./deadlines');
const alerts   = require('./alerts');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// ─── Queue Definitions ────────────────────────────────────────────────────────

const scanQueue   = new Bull('deadline-sentinel:scan-deadlines',  REDIS_URL);
const alertQueue  = new Bull('deadline-sentinel:send-alert',      REDIS_URL);
const reportQueue = new Bull('deadline-sentinel:weekly-report',   REDIS_URL);
const missedQueue = new Bull('deadline-sentinel:check-missed',    REDIS_URL);

// ─── Job: Scan Deadlines ──────────────────────────────────────────────────────

scanQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[Jobs/Scan] Starting deadline scan for ${clientSlug}`);

    // 1. Sync all deadlines from Clio/MyCase into DB
    const scanResult = await deadlines.scanAllDeadlines(clientSlug);

    // 2. Fetch upcoming deadlines within 14 days and send appropriate alerts
    const upcoming = await deadlines.getUpcomingDeadlines(clientSlug, 14);
    let alertsSent = 0;

    for (const deadline of upcoming) {
        const urgency = deadlines.calculateUrgency({ dueDate: deadline.deadline_date });
        try {
            await alerts.sendDeadlineAlert(clientSlug, deadline, urgency);
            alertsSent++;
        } catch (err) {
            console.error(`[Jobs/Scan] Alert failed for deadline ${deadline.id}: ${err.message}`);
        }
    }

    console.log(`[Jobs/Scan] Done for ${clientSlug}: ${scanResult.upserted} deadlines, ${alertsSent} alerts evaluated`);
    return { clientSlug, ...scanResult, alertsSent };
});

// ─── Job: Check Critical (noon pass) ─────────────────────────────────────────

// Reuses the alertQueue worker but only fires for ≤3-day deadlines
alertQueue.process(async (job) => {
    const { clientSlug, urgencyFilter } = job.data;
    console.log(`[Jobs/Alert] Running ${urgencyFilter || 'all'} alert pass for ${clientSlug}`);

    let upcoming;
    if (urgencyFilter === 'critical') {
        upcoming = await deadlines.getUpcomingDeadlines(clientSlug, 3);
    } else {
        upcoming = await deadlines.getUpcomingDeadlines(clientSlug, 14);
    }

    let alertsSent = 0;
    for (const deadline of upcoming) {
        const urgency = deadlines.calculateUrgency({ dueDate: deadline.deadline_date });
        if (urgencyFilter === 'critical' && urgency !== 'critical') continue;

        try {
            await alerts.sendDeadlineAlert(clientSlug, deadline, urgency);
            alertsSent++;
        } catch (err) {
            console.error(`[Jobs/Alert] Alert failed for deadline ${deadline.id}: ${err.message}`);
        }
    }

    console.log(`[Jobs/Alert] Done for ${clientSlug}: ${alertsSent} alerts evaluated`);
    return { clientSlug, alertsSent };
});

// ─── Job: Check Missed Deadlines ─────────────────────────────────────────────

missedQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[Jobs/Missed] Checking for missed deadlines for ${clientSlug}`);

    const missed = await deadlines.checkForMissedDeadlines(clientSlug);

    let alertsSent = 0;
    for (const deadline of missed) {
        try {
            await alerts.sendDeadlineAlert(clientSlug, deadline, 'missed');
            alertsSent++;
        } catch (err) {
            console.error(`[Jobs/Missed] Alert failed for deadline ${deadline.id}: ${err.message}`);
        }
    }

    console.log(`[Jobs/Missed] Done for ${clientSlug}: ${missed.length} missed, ${alertsSent} alerts sent`);
    return { clientSlug, missedCount: missed.length, alertsSent };
});

// ─── Job: Weekly Report ───────────────────────────────────────────────────────

reportQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[Jobs/Report] Generating weekly report for ${clientSlug}`);

    const report = await deadlines.generateWeeklyReport(clientSlug);
    await alerts.sendWeeklyReport(clientSlug, report);

    console.log(`[Jobs/Report] Weekly report sent for ${clientSlug}`);
    return {
        clientSlug,
        critical: report.criticalCount,
        urgent:   report.urgentCount,
        missed:   report.missedCount,
    };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

const queues = [
    ['scan-deadlines', scanQueue],
    ['send-alert',     alertQueue],
    ['weekly-report',  reportQueue],
    ['check-missed',   missedQueue],
];

for (const [name, queue] of queues) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} completed for ${job.data.clientSlug}`);
    });
    queue.on('error', (err) => {
        console.error(`[Jobs] Queue ${name} error: ${err.message}`);
    });
}

// ─── Dispatchers ─────────────────────────────────────────────────────────────

async function runScanDeadlines(clientSlug) {
    return scanQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runSendAlert(clientSlug, urgencyFilter = null) {
    return alertQueue.add({ clientSlug, urgencyFilter }, { attempts: 2, backoff: 30000 });
}

async function runWeeklyReport(clientSlug) {
    return reportQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runCheckMissed(clientSlug) {
    return missedQueue.add({ clientSlug }, { attempts: 3, backoff: 15000 });
}

/**
 * Dispatch a job for all connected clients.
 * @param {Function} jobFn  — one of the run* dispatchers above
 */
async function runForAllClients(jobFn) {
    const clients = await caseMgmt.getAllConnectedClients();
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

// ─── Cron Registration ────────────────────────────────────────────────────────

/**
 * Register all recurring cron jobs.
 * Called once from index.js on startup.
 */
function registerCrons() {
    // 7:00am daily — full scan + urgency alerts for all clients
    cron.schedule('0 7 * * *', async () => {
        console.log('[Cron] 7am scan: running deadline scan for all clients');
        await runForAllClients(runScanDeadlines);
    });

    // 12:00pm daily — second pass, critical-only alerts (≤3 days)
    cron.schedule('0 12 * * *', async () => {
        console.log('[Cron] 12pm check: running critical alert pass for all clients');
        await runForAllClients((slug) => runSendAlert(slug, 'critical'));
    });

    // Monday 8:00am — weekly deadline report
    cron.schedule('0 8 * * 1', async () => {
        console.log('[Cron] Monday 8am: sending weekly reports for all clients');
        await runForAllClients(runWeeklyReport);
    });

    // Every 30 minutes — check for any newly missed deadlines
    cron.schedule('*/30 * * * *', async () => {
        console.log('[Cron] 30-min check: scanning for missed deadlines');
        await runForAllClients(runCheckMissed);
    });

    console.log('[Jobs] All cron jobs registered');
}

module.exports = {
    runScanDeadlines,
    runSendAlert,
    runWeeklyReport,
    runCheckMissed,
    runForAllClients,
    registerCrons,
    // Queue references for health checks
    scanQueue,
    alertQueue,
    reportQueue,
    missedQueue,
};
