/**
 * GRIDHAND Transaction Tracker — Bull Queue Job Definitions
 *
 * Queues:
 *  tt:milestone-alert      — alert agent on milestone completion / status change
 *  tt:deadline-warning     — warn agent of approaching milestones (≤3 days)
 *  tt:missing-docs-alert   — alert agent of missing required documents
 *  tt:buyer-seller-update  — send automated status SMS to buyer or seller
 *  tt:daily-pipeline-scan  — daily scan of all active transactions for issues
 *  tt:closing-checklist    — generate and send closing checklist to agent
 *
 * Crons (scheduled by index.js):
 *  7:30 AM Chicago — daily pipeline scan
 *  9:00 AM Chicago — deadline check for all clients
 *  5:00 PM Chicago — EOD transaction summary
 */

'use strict';

const Bull    = require('bull');
const dayjs   = require('dayjs');
const db      = require('./db');
const tracker = require('./tracker');
const { sendSMS } = require('../../lib/twilio-client');

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const milestoneAlertQueue   = new Bull('tt:milestone-alert',     REDIS_URL);
const deadlineWarningQueue  = new Bull('tt:deadline-warning',    REDIS_URL);
const missingDocsQueue      = new Bull('tt:missing-docs-alert',  REDIS_URL);
const buyerSellerQueue      = new Bull('tt:buyer-seller-update', REDIS_URL);
const dailyScanQueue        = new Bull('tt:daily-pipeline-scan', REDIS_URL);
const closingChecklistQueue = new Bull('tt:closing-checklist',   REDIS_URL);

// ─── Helper: Send SMS ─────────────────────────────────────────────────────────

async function sendSms(to, body, clientSlug, transactionId, messageType) {
    if (!to) throw new Error('No phone number provided for SMS');

    const { sid } = await sendSMS({
        to,
        body,
        clientSlug,
        clientTimezone: undefined,
    });

    await db.logSms(clientSlug, {
        transactionId,
        recipient:   to,
        messageBody: body,
        messageType,
        twilioSid:   sid,
    });

    return sid;
}

// ─── Job: Milestone Alert ─────────────────────────────────────────────────────

milestoneAlertQueue.process(async (job) => {
    const { transactionId, clientSlug, milestoneName, milestoneStatus, changedBy } = job.data;
    console.log(`[MilestoneAlert] Transaction ${transactionId}: "${milestoneName}" → ${milestoneStatus}`);

    const [transaction, settings] = await Promise.all([
        db.getTransaction(transactionId),
        db.getClientSettings(clientSlug),
    ]);

    if (!transaction) throw new Error(`Transaction ${transactionId} not found`);
    if (!settings?.agent_phone) throw new Error(`No agent phone for ${clientSlug}`);

    const address = transaction.address || 'Unknown address';
    let message;

    if (milestoneStatus === 'completed') {
        message = `✓ GRIDHAND: Milestone complete on ${address}.\n"${milestoneName}" done.`;

        // Check next upcoming milestone
        const milestones = await db.getMilestones(transactionId);
        const next = milestones
            .filter(m => !m.completed_at && m.due_date)
            .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))[0];

        if (next) {
            message += ` Next: "${next.name}" by ${dayjs(next.due_date).format('M/D')}.`;
        }
    } else {
        message = `GRIDHAND: Status update on ${address}.\n"${milestoneName}" status: ${milestoneStatus}.`;
    }

    await sendSms(settings.agent_phone, message, clientSlug, transactionId, 'milestone_alert');

    console.log(`[MilestoneAlert] Sent to ${settings.agent_phone} for ${transactionId}`);
    return { transactionId, milestoneName, sent: true };
});

// ─── Job: Deadline Warning ────────────────────────────────────────────────────

deadlineWarningQueue.process(async (job) => {
    const { transactionId, clientSlug } = job.data;
    console.log(`[DeadlineWarning] Checking deadlines for transaction ${transactionId}`);

    const [settings, milestones] = await Promise.all([
        db.getClientSettings(clientSlug),
        db.getMilestones(transactionId),
    ]);

    const transaction = await db.getTransaction(transactionId);
    if (!transaction) throw new Error(`Transaction ${transactionId} not found`);
    if (!settings?.agent_phone) throw new Error(`No agent phone for ${clientSlug}`);

    const transactionWithMilestones = { ...transaction, milestones };
    const { overdue, dueToday, dueSoon } = tracker.checkDeadlines(transactionWithMilestones);

    const urgent = [...overdue, ...dueToday, ...dueSoon.filter(m => m.daysOut <= 3)];
    if (urgent.length === 0) {
        console.log(`[DeadlineWarning] No urgent deadlines for ${transactionId}`);
        return { transactionId, urgent: 0 };
    }

    const address = transaction.address || 'Transaction';
    const lines   = [];

    for (const m of overdue.slice(0, 3)) {
        lines.push(`⚠ OVERDUE: ${m.name} (${m.daysLate}d late)`);
    }
    for (const m of dueToday.slice(0, 2)) {
        lines.push(`TODAY: ${m.name}`);
    }
    for (const m of dueSoon.slice(0, 2)) {
        lines.push(`In ${m.daysOut}d: ${m.name} (${dayjs(m.dueDate).format('M/D')})`);
    }

    const message = `GRIDHAND Deadlines — ${address}:\n${lines.join('\n')}`;

    await sendSms(settings.agent_phone, message, clientSlug, transactionId, 'deadline_warning');

    console.log(`[DeadlineWarning] Sent ${urgent.length} deadline alerts for ${transactionId}`);
    return { transactionId, urgent: urgent.length };
});

// ─── Job: Missing Documents Alert ────────────────────────────────────────────

missingDocsQueue.process(async (job) => {
    const { transactionId, clientSlug } = job.data;
    console.log(`[MissingDocs] Checking documents for transaction ${transactionId}`);

    const [transaction, documents, settings] = await Promise.all([
        db.getTransaction(transactionId),
        db.getDocuments(transactionId),
        db.getClientSettings(clientSlug),
    ]);

    if (!transaction) throw new Error(`Transaction ${transactionId} not found`);
    if (!settings?.agent_phone) throw new Error(`No agent phone for ${clientSlug}`);

    const missing = tracker.findMissingDocuments(transaction, documents);

    if (missing.length === 0) {
        console.log(`[MissingDocs] All docs present for ${transactionId}`);
        return { transactionId, missing: 0 };
    }

    const address = transaction.address || 'Transaction';
    const docList = missing.slice(0, 5).join(', ');
    const more    = missing.length > 5 ? ` +${missing.length - 5} more` : '';
    const message = `GRIDHAND Missing Docs — ${address}:\n${docList}${more}.\nPlease upload to Dotloop.`;

    await sendSms(settings.agent_phone, message, clientSlug, transactionId, 'missing_docs_alert');

    console.log(`[MissingDocs] Alerted agent about ${missing.length} missing docs for ${transactionId}`);
    return { transactionId, missing: missing.length };
});

// ─── Job: Buyer/Seller Status Update ─────────────────────────────────────────

buyerSellerQueue.process(async (job) => {
    const { transactionId, clientSlug, recipient } = job.data;
    // recipient = 'buyer' | 'seller'
    console.log(`[BuyerSellerUpdate] Sending ${recipient} update for ${transactionId}`);

    const [transaction, milestones] = await Promise.all([
        db.getTransaction(transactionId),
        db.getMilestones(transactionId),
    ]);

    if (!transaction) throw new Error(`Transaction ${transactionId} not found`);

    const phone = recipient === 'buyer' ? transaction.buyer_phone : transaction.seller_phone;
    if (!phone) {
        console.log(`[BuyerSellerUpdate] No ${recipient} phone for ${transactionId} — skipping`);
        return { transactionId, recipient, sent: false, reason: 'no_phone' };
    }

    const transactionWithMilestones = { ...transaction, milestones };
    const message = tracker.generateStatusUpdate(transactionWithMilestones, recipient);

    await sendSms(phone, message, clientSlug, transactionId, `${recipient}_status_update`);

    console.log(`[BuyerSellerUpdate] Sent to ${recipient} (${phone}) for ${transactionId}`);
    return { transactionId, recipient, sent: true };
});

// ─── Job: Daily Pipeline Scan ─────────────────────────────────────────────────

dailyScanQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[DailyScan] Running pipeline scan for ${clientSlug}`);

    const transactions = await db.getActiveTransactions(clientSlug);
    console.log(`[DailyScan] Found ${transactions.length} active transactions for ${clientSlug}`);

    let issuesFound    = 0;
    let alertsQueued   = 0;

    for (const tx of transactions) {
        try {
            const [milestones, documents] = await Promise.all([
                db.getMilestones(tx.id),
                db.getDocuments(tx.id),
            ]);

            const txWithData = { ...tx, milestones, documents };

            // Check deadlines
            const { overdue, dueToday, dueSoon } = tracker.checkDeadlines(txWithData);
            const hasUrgentDeadlines = overdue.length > 0 || dueToday.length > 0 || dueSoon.length > 0;

            if (hasUrgentDeadlines) {
                await deadlineWarningQueue.add(
                    { transactionId: tx.id, clientSlug },
                    { attempts: 2, backoff: 30000 }
                );
                alertsQueued++;
                issuesFound++;
            }

            // Check missing documents
            const missing = tracker.findMissingDocuments(txWithData, documents);
            if (missing.length > 0) {
                await missingDocsQueue.add(
                    { transactionId: tx.id, clientSlug },
                    { attempts: 2, backoff: 30000 }
                );
                alertsQueued++;
                issuesFound++;
            }

            // Update risk level
            const risk = tracker.assessRisk(txWithData);
            if (risk.level !== tx.risk_level) {
                await db.updateTransactionRisk(tx.id, risk.level);
                console.log(`[DailyScan] Risk updated for ${tx.id}: ${tx.risk_level} → ${risk.level}`);
            }
        } catch (err) {
            console.error(`[DailyScan] Error processing transaction ${tx.id}: ${err.message}`);
        }
    }

    console.log(`[DailyScan] Done for ${clientSlug} — ${issuesFound} issues, ${alertsQueued} alerts queued`);
    return { clientSlug, scanned: transactions.length, issuesFound, alertsQueued };
});

// ─── Job: Closing Checklist ───────────────────────────────────────────────────

closingChecklistQueue.process(async (job) => {
    const { transactionId, clientSlug } = job.data;
    console.log(`[ClosingChecklist] Generating checklist for ${transactionId}`);

    const [transaction, milestones, settings] = await Promise.all([
        db.getTransaction(transactionId),
        db.getMilestones(transactionId),
        db.getClientSettings(clientSlug),
    ]);

    if (!transaction) throw new Error(`Transaction ${transactionId} not found`);
    if (!settings?.agent_phone) throw new Error(`No agent phone for ${clientSlug}`);

    const transactionWithMilestones = { ...transaction, milestones };
    const checklist = tracker.generateClosingChecklist(transactionWithMilestones);

    // SMS has a 1600 char limit per message — split if needed
    const chunks = splitMessage(checklist, 1500);
    for (const chunk of chunks) {
        await sendSms(settings.agent_phone, chunk, clientSlug, transactionId, 'closing_checklist');
    }

    console.log(`[ClosingChecklist] Sent ${chunks.length} SMS for ${transactionId}`);
    return { transactionId, chunks: chunks.length };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

const allQueues = [
    ['tt:milestone-alert',     milestoneAlertQueue],
    ['tt:deadline-warning',    deadlineWarningQueue],
    ['tt:missing-docs-alert',  missingDocsQueue],
    ['tt:buyer-seller-update', buyerSellerQueue],
    ['tt:daily-pipeline-scan', dailyScanQueue],
    ['tt:closing-checklist',   closingChecklistQueue],
];

for (const [name, queue] of allQueues) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} failed (job ${job.id}): ${err.message}`);
    });
    queue.on('completed', (job, result) => {
        console.log(`[Jobs] ${name} completed (job ${job.id})`);
    });
    queue.on('error', (err) => {
        console.error(`[Jobs] Queue ${name} error: ${err.message}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runMilestoneAlert(transactionId, clientSlug, milestoneName, milestoneStatus) {
    return milestoneAlertQueue.add(
        { transactionId, clientSlug, milestoneName, milestoneStatus },
        { attempts: 2, backoff: 30000 }
    );
}

async function runDeadlineCheck(transactionId, clientSlug) {
    return deadlineWarningQueue.add(
        { transactionId, clientSlug },
        { attempts: 2, backoff: 30000 }
    );
}

async function runMissingDocsAlert(transactionId, clientSlug) {
    return missingDocsQueue.add(
        { transactionId, clientSlug },
        { attempts: 2, backoff: 30000 }
    );
}

async function runBuyerSellerUpdate(transactionId, clientSlug, recipient) {
    return buyerSellerQueue.add(
        { transactionId, clientSlug, recipient },
        { attempts: 2, backoff: 30000 }
    );
}

async function runDailyScan(clientSlug) {
    return dailyScanQueue.add(
        { clientSlug },
        { attempts: 2, backoff: 60000 }
    );
}

async function runClosingChecklist(transactionId, clientSlug) {
    return closingChecklistQueue.add(
        { transactionId, clientSlug },
        { attempts: 2, backoff: 30000 }
    );
}

/**
 * Run a job function for every active connected client.
 * Used by cron triggers in index.js.
 */
async function runForAllClients(jobFn) {
    const clients = await db.getAllActiveClients();
    const results = [];

    for (const { client_slug } of clients) {
        try {
            const job = await jobFn(client_slug);
            results.push({ clientSlug: client_slug, jobId: job?.id });
        } catch (err) {
            console.error(`[Jobs] Failed to queue job for ${client_slug}: ${err.message}`);
            results.push({ clientSlug: client_slug, error: err.message });
        }
    }

    return results;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function splitMessage(text, maxLen) {
    if (text.length <= maxLen) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        chunks.push(remaining.substring(0, maxLen));
        remaining = remaining.substring(maxLen);
    }
    return chunks;
}

module.exports = {
    runMilestoneAlert,
    runDeadlineCheck,
    runMissingDocsAlert,
    runBuyerSellerUpdate,
    runDailyScan,
    runClosingChecklist,
    runForAllClients,
    milestoneAlertQueue,
    deadlineWarningQueue,
    missingDocsQueue,
    buyerSellerQueue,
    dailyScanQueue,
    closingChecklistQueue,
};
