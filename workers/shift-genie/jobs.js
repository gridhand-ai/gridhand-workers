/**
 * GRIDHAND Shift Genie — Bull Queue Job Definitions
 *
 * Job types:
 *   optimize-schedule  — Sunday 6pm: analyze next week, send suggestions to GM
 *   check-coverage     — 10am + 4pm daily: detect understaffed shifts, alert manager
 *   daily-summary      — 7am daily: send today's schedule + labor projection to manager
 *   process-swap       — On demand: find coverage for a swap request
 *   labor-report       — Monday 8am: weekly labor cost report to GM
 *
 * Cron schedules are registered in index.js.
 * This module exposes queue processors + dispatch helpers.
 */

'use strict';

require('dotenv').config();

const Bull      = require('bull');
const dayjs     = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

const optimizer  = require('./optimizer');
const scheduling = require('./scheduling');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const genieQueue = new Bull('shift-genie', REDIS_URL);

// ─── Job: Optimize Schedule ───────────────────────────────────────────────────

async function handleOptimizeSchedule(job) {
    const { clientSlug, weekStart } = job.data;
    console.log(`[Jobs] optimize-schedule for ${clientSlug} week of ${weekStart}`);

    const week = weekStart || dayjs().add(1, 'day').startOf('week').add(1, 'day').format('YYYY-MM-DD');

    const result = await optimizer.optimizeSchedule(clientSlug, week);
    console.log(`[Jobs] optimize-schedule done — ${result.suggestions.length} suggestions`);
    return result;
}

// ─── Job: Check Coverage ──────────────────────────────────────────────────────

async function handleCheckCoverage(job) {
    const { clientSlug, date } = job.data;
    const targetDate = date || dayjs().format('YYYY-MM-DD');
    console.log(`[Jobs] check-coverage for ${clientSlug} on ${targetDate}`);

    const understaffed = await optimizer.detectUnderstaffedShifts(clientSlug, targetDate);

    if (understaffed.length > 0) {
        for (const gap of understaffed) {
            await optimizer.sendCoverageAlert(clientSlug, gap);
        }
    }

    console.log(`[Jobs] check-coverage done — ${understaffed.length} gaps found`);
    return { clientSlug, date: targetDate, gaps: understaffed.length };
}

// ─── Job: Daily Summary ───────────────────────────────────────────────────────

async function handleDailySummary(job) {
    const { clientSlug, date } = job.data;
    const targetDate = date || dayjs().format('YYYY-MM-DD');
    console.log(`[Jobs] daily-summary for ${clientSlug} on ${targetDate}`);

    await optimizer.sendDailyScheduleSummary(clientSlug, targetDate);

    console.log(`[Jobs] daily-summary sent for ${clientSlug}`);
    return { clientSlug, date: targetDate };
}

// ─── Job: Process Swap ────────────────────────────────────────────────────────

async function handleProcessSwap(job) {
    const { clientSlug, requesterId, targetDate, targetShift } = job.data;
    console.log(`[Jobs] process-swap for ${clientSlug} requester=${requesterId} date=${targetDate}`);

    const result = await optimizer.processShiftSwapRequest(
        clientSlug,
        requesterId,
        targetDate,
        targetShift
    );

    console.log(`[Jobs] process-swap done — offered=${result.offered}`);
    return result;
}

// ─── Job: Labor Report ────────────────────────────────────────────────────────

async function handleLaborReport(job) {
    const { clientSlug } = job.data;
    console.log(`[Jobs] labor-report for ${clientSlug}`);

    await optimizer.sendWeeklyLaborReport(clientSlug);

    console.log(`[Jobs] labor-report sent for ${clientSlug}`);
    return { clientSlug };
}

// ─── Queue Processor ──────────────────────────────────────────────────────────

genieQueue.process(async (job) => {
    const { type } = job.data;

    switch (type) {
        case 'optimize-schedule': return handleOptimizeSchedule(job);
        case 'check-coverage':   return handleCheckCoverage(job);
        case 'daily-summary':    return handleDailySummary(job);
        case 'process-swap':     return handleProcessSwap(job);
        case 'labor-report':     return handleLaborReport(job);
        default:
            throw new Error(`[Jobs] Unknown job type: ${type}`);
    }
});

genieQueue.on('failed', (job, err) => {
    console.error(`[Jobs] ${job.data.type} failed for ${job.data.clientSlug}: ${err.message}`);
});

genieQueue.on('completed', (job) => {
    console.log(`[Jobs] ${job.data.type} completed for ${job.data.clientSlug}`);
});

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runDailySummary(clientSlug, date) {
    return genieQueue.add(
        { type: 'daily-summary', clientSlug, date },
        { attempts: 2, backoff: 30000 }
    );
}

async function runCheckCoverage(clientSlug, date) {
    return genieQueue.add(
        { type: 'check-coverage', clientSlug, date },
        { attempts: 2, backoff: 30000 }
    );
}

async function runOptimizeSchedule(clientSlug, weekStart) {
    return genieQueue.add(
        { type: 'optimize-schedule', clientSlug, weekStart },
        { attempts: 2, backoff: 60000 }
    );
}

async function runProcessSwap(clientSlug, requesterId, targetDate, targetShift) {
    return genieQueue.add(
        { type: 'process-swap', clientSlug, requesterId, targetDate, targetShift },
        { attempts: 3, backoff: 15000 }
    );
}

async function runLaborReport(clientSlug) {
    return genieQueue.add(
        { type: 'labor-report', clientSlug },
        { attempts: 2, backoff: 60000 }
    );
}

/**
 * Run a given job function for all connected clients.
 */
async function runForAllClients(jobFn, ...args) {
    const { data: clients, error } = await supabase
        .from('genie_connections')
        .select('client_slug, manager_phone');

    if (error) {
        console.error(`[Jobs] Failed to fetch clients: ${error.message}`);
        return [];
    }

    const results = [];
    for (const { client_slug } of (clients || [])) {
        try {
            const job = await jobFn(client_slug, ...args);
            results.push({ clientSlug: client_slug, jobId: job.id });
        } catch (err) {
            console.error(`[Jobs] Failed to queue job for ${client_slug}: ${err.message}`);
        }
    }
    return results;
}

module.exports = {
    genieQueue,
    runDailySummary,
    runCheckCoverage,
    runOptimizeSchedule,
    runProcessSwap,
    runLaborReport,
    runForAllClients,
};
