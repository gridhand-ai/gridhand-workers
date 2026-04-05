/**
 * GRIDHAND Billable Hour Hawk — Bull Queue Job Definitions
 *
 * Queue: 'billable-hour-hawk'
 *
 * Job types:
 *   scan-unbilled          → 8am daily: detect unbilled time entries, send alerts
 *   generate-invoice-drafts → 1st of month 9am: auto-draft invoices for prior month
 *   check-retainers        → 8am daily: detect matters below retainer threshold
 *   weekly-summary         → Friday 4pm: send weekly billing report to managing partner
 *   attorney-reminder      → 5pm daily: remind attorneys who haven't logged time
 *
 * Dispatchers (called by index.js crons and /trigger endpoints):
 *   runScanUnbilled(clientSlug)
 *   runGenerateInvoiceDrafts(clientSlug, month)
 *   runCheckRetainers(clientSlug)
 *   runWeeklySummary(clientSlug)
 *   runAttorneyReminder(clientSlug)
 *   runForAllClients(jobFn)
 */

'use strict';

require('dotenv').config();

const Bull       = require('bull');
const dayjs      = require('dayjs');
const tracker    = require('./tracker');
const invoicing  = require('./invoicing');
const billingApi = require('./billing-api');
const { createClient } = require('@supabase/supabase-js');

// ─── Supabase ─────────────────────────────────────────────────────────────────

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const hawkQueue = new Bull('billable-hour-hawk', REDIS_URL);

// ─── Job Processor ────────────────────────────────────────────────────────────

hawkQueue.process(async (job) => {
    const { type, clientSlug, month } = job.data;
    console.log(`[Jobs] Processing job type="${type}" for ${clientSlug}`);

    switch (type) {

        // ── scan-unbilled ─────────────────────────────────────────────────────
        case 'scan-unbilled': {
            const conn = await tracker.getConnection(clientSlug);
            const { entries, newlyFlagged } = await tracker.scanUnbilledWork(clientSlug);

            // Send an SMS alert for each newly-flagged entry (cap at 5 to avoid spam)
            const flagged = entries.filter(e => {
                const threshold = conn.unbilled_flag_days || 30;
                return !e.billed && tracker.flagUnbilledEntry(e, threshold);
            });

            let alertsSent = 0;
            for (const entry of flagged.slice(0, 5)) {
                await invoicing.sendUnbilledFlagAlert(clientSlug, entry);
                alertsSent++;
            }

            if (flagged.length > 5) {
                console.log(`[Jobs] ${clientSlug}: ${flagged.length - 5} additional flagged entries not alerted (cap reached)`);
            }

            console.log(`[Jobs] scan-unbilled done for ${clientSlug} — ${flagged.length} flagged, ${alertsSent} alerts sent`);
            return { clientSlug, totalEntries: entries.length, flaggedCount: flagged.length, alertsSent };
        }

        // ── generate-invoice-drafts ───────────────────────────────────────────
        case 'generate-invoice-drafts': {
            // Default to previous month if none specified
            const targetMonth = month || dayjs().subtract(1, 'month').format('YYYY-MM');
            const startDate   = dayjs(targetMonth, 'YYYY-MM').startOf('month').format('YYYY-MM-DD');
            const endDate     = dayjs(targetMonth, 'YYYY-MM').endOf('month').format('YYYY-MM-DD');

            // Pull unbilled entries for the period
            const allEntries = await billingApi.getTimeEntries(clientSlug, startDate, endDate);
            const unbilled   = allEntries.filter(e => !e.billed);

            // Group by matter
            const byMatter = {};
            for (const entry of unbilled) {
                const mid = entry.matter_id;
                if (!mid) continue;
                if (!byMatter[mid]) byMatter[mid] = [];
                byMatter[mid].push(entry);
            }

            const draftsCreated = [];

            for (const [matterId, entries] of Object.entries(byMatter)) {
                if (!entries.length) continue;

                try {
                    const draft = await invoicing.generateInvoiceDraft(clientSlug, matterId);
                    if (draft) {
                        await invoicing.sendInvoiceDraftAlert(clientSlug, matterId, draft);
                        draftsCreated.push({ matterId, totalAmount: draft.total_amount });
                    }
                } catch (err) {
                    console.error(`[Jobs] Failed to draft invoice for matter ${matterId}: ${err.message}`);
                }
            }

            console.log(`[Jobs] generate-invoice-drafts done for ${clientSlug} — ${draftsCreated.length} drafts created`);
            return { clientSlug, targetMonth, draftsCreated };
        }

        // ── check-retainers ───────────────────────────────────────────────────
        case 'check-retainers': {
            const matters = await tracker.checkRetainerLimits(clientSlug);

            for (const matter of matters) {
                await invoicing.sendRetainerAlert(clientSlug, matter);
            }

            console.log(`[Jobs] check-retainers done for ${clientSlug} — ${matters.length} alerts sent`);
            return { clientSlug, retainerAlerts: matters.length };
        }

        // ── weekly-summary ────────────────────────────────────────────────────
        case 'weekly-summary': {
            await invoicing.sendWeeklySummary(clientSlug);
            console.log(`[Jobs] weekly-summary done for ${clientSlug}`);
            return { clientSlug, sent: true };
        }

        // ── attorney-reminder ─────────────────────────────────────────────────
        case 'attorney-reminder': {
            const flagged = await tracker.detectMissingTimeEntries(clientSlug);

            for (const attorney of flagged) {
                await invoicing.sendAttorneyReminder(clientSlug, attorney);
            }

            console.log(`[Jobs] attorney-reminder done for ${clientSlug} — ${flagged.length} reminders sent`);
            return { clientSlug, remindersSent: flagged.length };
        }

        default:
            throw new Error(`Unknown job type: ${type}`);
    }
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

hawkQueue.on('failed', (job, err) => {
    console.error(`[Jobs] Job failed — type=${job.data.type} client=${job.data.clientSlug}: ${err.message}`);
});

hawkQueue.on('completed', (job, result) => {
    console.log(`[Jobs] Job completed — type=${job.data.type} client=${job.data.clientSlug}`);
});

hawkQueue.on('error', (err) => {
    console.error(`[Jobs] Queue error: ${err.message}`);
});

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runScanUnbilled(clientSlug) {
    return hawkQueue.add(
        { type: 'scan-unbilled', clientSlug },
        { attempts: 3, backoff: { type: 'exponential', delay: 60000 } }
    );
}

async function runGenerateInvoiceDrafts(clientSlug, month) {
    return hawkQueue.add(
        { type: 'generate-invoice-drafts', clientSlug, month },
        { attempts: 2, backoff: { type: 'fixed', delay: 120000 } }
    );
}

async function runCheckRetainers(clientSlug) {
    return hawkQueue.add(
        { type: 'check-retainers', clientSlug },
        { attempts: 3, backoff: { type: 'exponential', delay: 60000 } }
    );
}

async function runWeeklySummary(clientSlug) {
    return hawkQueue.add(
        { type: 'weekly-summary', clientSlug },
        { attempts: 2, backoff: { type: 'fixed', delay: 30000 } }
    );
}

async function runAttorneyReminder(clientSlug) {
    return hawkQueue.add(
        { type: 'attorney-reminder', clientSlug },
        { attempts: 2, backoff: { type: 'fixed', delay: 30000 } }
    );
}

/**
 * Run a job function for every connected client.
 * Called by cron triggers in index.js.
 */
async function runForAllClients(jobFn) {
    const clients = await tracker.getAllConnectedClients();
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

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    hawkQueue,
    runScanUnbilled,
    runGenerateInvoiceDrafts,
    runCheckRetainers,
    runWeeklySummary,
    runAttorneyReminder,
    runForAllClients,
};
