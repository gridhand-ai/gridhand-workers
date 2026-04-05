/**
 * GRIDHAND Change Order Tracker — Bull Queue Job Definitions
 *
 * Jobs:
 *  - sync-change-orders  → hourly: pull new/updated COs from Procore, sync to QB
 *  - weekly-co-report    → Monday 8am: send weekly cost impact summary to owner
 */

'use strict';

const Bull    = require('bull');
const dayjs   = require('dayjs');
const procore = require('./procore');
const qb      = require('./quickbooks');
const db      = require('./db');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const syncQueue   = new Bull('change-order-tracker:sync-change-orders', REDIS_URL);
const reportQueue = new Bull('change-order-tracker:weekly-co-report',   REDIS_URL);

// ─── Job: Sync Change Orders ──────────────────────────────────────────────────

syncQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[COSync] Syncing change orders for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const projects = await procore.getActiveProjects(clientSlug, conn.procore_company_id);
    let newCOs = 0, approvedCOs = 0, qbSynced = 0;

    for (const project of projects) {
        const cos = await procore.getChangeOrders(clientSlug, conn.procore_company_id, project.id);
        let approvedTotal = 0, pendingTotal = 0, approvedCount = 0, pendingCount = 0;

        for (const co of cos) {
            const existing = await db.getChangeOrder(clientSlug, co.procoreCoId);
            const isNew    = !existing;
            const statusChanged = existing && existing.status !== co.status;

            // Calculate markup
            const markupRate   = parseFloat(conn.markup_rate || 0.15);
            const markupAmount = co.approvedAmount * markupRate;

            // Auto-generate client-facing summary
            const clientSummary = buildClientSummary({ ...co, markupAmount, projectName: project.name });

            await db.upsertChangeOrder(clientSlug, {
                ...co,
                projectId:    project.id,
                projectName:  project.name,
                markupAmount,
                clientSummary,
            });

            if (co.status === 'approved') {
                approvedTotal += co.approvedAmount + markupAmount;
                approvedCount++;
            } else if (co.status === 'pending') {
                pendingTotal += co.originalAmount;
                pendingCount++;
            }

            if (isNew) {
                newCOs++;
                await db.logAlert(clientSlug, {
                    alertType:   'new_co',
                    recipient:   conn.owner_phone,
                    messageBody: `📋 New Change Order #${co.coNumber} on "${project.name}": ${co.title} — $${fmt(co.originalAmount)}. Status: ${co.status}.`,
                    coId:        co.procoreCoId,
                    projectId:   project.id,
                });
            }

            if (statusChanged && co.status === 'approved') {
                approvedCOs++;
                // Sync approved CO to QuickBooks as invoice
                if (conn.qb_realm_id && !existing?.qb_invoice_id) {
                    const qbInvoiceId = await qb.createInvoiceForCO(clientSlug, conn.qb_realm_id, {
                        coNumber:    co.coNumber,
                        title:       co.title,
                        amount:      co.approvedAmount + markupAmount,
                        customerName: project.name,
                        projectName: project.name,
                    });
                    if (qbInvoiceId) {
                        await db.markQBSynced(clientSlug, co.procoreCoId, qbInvoiceId);
                        qbSynced++;
                    }
                }
                await db.logAlert(clientSlug, {
                    alertType:   'co_approved',
                    recipient:   conn.owner_phone,
                    messageBody: `✅ Change Order #${co.coNumber} APPROVED on "${project.name}": $${fmt(co.approvedAmount + markupAmount)} added to contract.`,
                    coId:        co.procoreCoId,
                    projectId:   project.id,
                });
            }

            if (statusChanged && co.status === 'rejected') {
                await db.logAlert(clientSlug, {
                    alertType:   'co_rejected',
                    recipient:   conn.owner_phone,
                    messageBody: `❌ Change Order #${co.coNumber} REJECTED on "${project.name}": ${co.title}.`,
                    coId:        co.procoreCoId,
                    projectId:   project.id,
                });
            }
        }

        await db.upsertProjectSummary(clientSlug, {
            projectId:        project.id,
            projectName:      project.name,
            originalContract: project.originalContract,
            approvedTotal,
            pendingTotal,
            approvedCount,
            pendingCount,
        });
    }

    console.log(`[COSync] Done for ${clientSlug} — ${newCOs} new, ${approvedCOs} approved, ${qbSynced} QB synced`);
    return { clientSlug, newCOs, approvedCOs, qbSynced };
});

// ─── Job: Weekly CO Report ────────────────────────────────────────────────────

reportQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[WeeklyCOReport] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const summaries = await db.getProjectSummaries(clientSlug);
    if (!summaries.length) {
        console.log(`[WeeklyCOReport] No projects for ${clientSlug}`);
        return { clientSlug, projects: 0 };
    }

    const totalApproved = summaries.reduce((s, p) => s + parseFloat(p.approved_cos_total || 0), 0);
    const totalPending  = summaries.reduce((s, p) => s + parseFloat(p.pending_cos_total || 0), 0);
    const projectLines  = summaries.map(p =>
        `• ${p.project_name}: +$${fmt(p.approved_cos_total)} approved, $${fmt(p.pending_cos_total)} pending`
    ).join('\n');

    const msg = [
        `📊 Weekly Change Order Summary — ${conn.business_name || clientSlug}`,
        `Week of ${dayjs().startOf('week').format('MMM D')}`,
        ``,
        `TOTAL APPROVED COs: $${fmt(totalApproved)}`,
        `TOTAL PENDING COs:  $${fmt(totalPending)}`,
        ``,
        `By Project:`,
        projectLines,
    ].join('\n');

    await db.logAlert(clientSlug, {
        alertType:   'weekly_summary',
        recipient:   conn.owner_phone,
        messageBody: msg,
    });

    console.log(`[WeeklyCOReport] Done for ${clientSlug}`);
    return { clientSlug, totalApproved, totalPending };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n) {
    return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function buildClientSummary({ coNumber, title, description, approvedAmount, markupAmount, status, projectName }) {
    const total = approvedAmount + markupAmount;
    return [
        `Change Order #${coNumber} — ${title}`,
        `Project: ${projectName}`,
        description ? `Details: ${description}` : null,
        `Amount: $${fmt(total)} (includes markup)`,
        `Status: ${status.toUpperCase()}`,
    ].filter(Boolean).join('\n');
}

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['sync-change-orders', syncQueue],
    ['weekly-co-report',   reportQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runSyncChangeOrders(clientSlug) {
    return syncQueue.add({ clientSlug }, { attempts: 3, backoff: 30000 });
}

async function runWeeklyReport(clientSlug) {
    return reportQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runForAllClients(jobFn) {
    const clients = await db.getAllConnectedClients();
    const results = [];
    for (const { client_slug } of clients) {
        try {
            const job = await jobFn(client_slug);
            results.push({ clientSlug: client_slug, jobId: job.id });
        } catch (err) {
            console.error(`[Jobs] Failed to queue for ${client_slug}: ${err.message}`);
        }
    }
    return results;
}

module.exports = {
    runSyncChangeOrders,
    runWeeklyReport,
    runForAllClients,
    syncQueue,
    reportQueue,
};
