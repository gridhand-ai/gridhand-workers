/**
 * GRIDHAND Reconciliation Bot — Bull Queue Job Definitions
 *
 * Queues:
 *   rb:transaction-sync    — Pull latest transactions from QBO, Xero, Plaid
 *   rb:reconciliation      — Run monthly reconciliation + flag discrepancies
 *   rb:discrepancy-alert   — SMS alert for critical discrepancies ($500+)
 *
 * All queues use QUEUE_OPTS with optional Redis TLS (REDIS_HOST/PORT/PASSWORD/TLS).
 */

'use strict';

const Bull  = require('bull');
const dayjs = require('dayjs');
const db    = require('./db');
const qb    = require('./quickbooks');
const xero  = require('./xero');
const plaid = require('./plaid');
const twilio = require('twilio');

// ─── Redis + Queue Config ─────────────────────────────────────────────────────

const REDIS_CONFIG = {
    host:     process.env.REDIS_HOST || '127.0.0.1',
    port:     parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    tls:      process.env.REDIS_TLS === 'true' ? {} : undefined,
};

const QUEUE_OPTS = {
    redis: REDIS_CONFIG,
    defaultJobOptions: {
        removeOnComplete: 50,
        removeOnFail:     100,
        attempts:         3,
        backoff:          { type: 'exponential', delay: 5000 },
    },
};

// ─── Queue Definitions ────────────────────────────────────────────────────────

const transactionSync   = new Bull('rb:transaction-sync',   QUEUE_OPTS);
const reconciliation    = new Bull('rb:reconciliation',      QUEUE_OPTS);
const discrepancyAlert  = new Bull('rb:discrepancy-alert',   QUEUE_OPTS);

// ─── SMS Helper ───────────────────────────────────────────────────────────────

async function sendSms(client, message, alertType) {
    try {
        const sid   = client.twilio_sid   || process.env.TWILIO_ACCOUNT_SID;
        const token = client.twilio_token || process.env.TWILIO_AUTH_TOKEN;
        const from  = client.twilio_number || process.env.TWILIO_FROM_NUMBER;
        const to    = client.owner_phone;

        if (!to || !from || !sid || !token) return;

        const tw = twilio(sid, token);
        await tw.messages.create({ from, to, body: message });

        await db.logAlert(client.id, {
            alertType,
            recipient:   to,
            messageBody: message,
            sentAt:      new Date().toISOString(),
        });

        console.log(`[SMS] ${alertType} sent to ${to} for ${client.client_slug}`);
    } catch (err) {
        console.error(`[SMS] Failed to send ${alertType} for ${client.client_slug}: ${err.message}`);
    }
}

// ─── Job: Transaction Sync ────────────────────────────────────────────────────

transactionSync.process('sync', 3, async (job) => {
    const { clientSlug, startDate, endDate } = job.data;
    console.log(`[TransactionSync] Starting for ${clientSlug} (${startDate} → ${endDate})`);

    const client = await db.getClient(clientSlug);
    if (!client) throw new Error(`Client not found: ${clientSlug}`);

    let synced = 0;

    // ── QuickBooks ──
    if (client.qbo_realm_id && client.qbo_access_token) {
        try {
            const txns = await qb.getTransactions(clientSlug, client.qbo_realm_id, startDate, endDate);
            await db.upsertTransactions(client.id, txns);
            synced += txns.length;
            console.log(`[TransactionSync] QBO: ${txns.length} transactions for ${clientSlug}`);
        } catch (err) {
            console.error(`[TransactionSync] QBO error for ${clientSlug}: ${err.message}`);
        }
    }

    // ── Xero ──
    if (client.xero_tenant_id && client.xero_access_token) {
        try {
            const txns = await xero.getTransactions(clientSlug, client.xero_tenant_id, startDate, endDate);
            await db.upsertTransactions(client.id, txns);
            synced += txns.length;
            console.log(`[TransactionSync] Xero: ${txns.length} transactions for ${clientSlug}`);
        } catch (err) {
            console.error(`[TransactionSync] Xero error for ${clientSlug}: ${err.message}`);
        }
    }

    // ── Plaid ──
    if (client.plaid_access_token) {
        try {
            const result = await plaid.getTransactions(clientSlug, startDate, endDate);
            if (result.ok) {
                await db.upsertTransactions(client.id, result.data);
                synced += result.data.length;
                console.log(`[TransactionSync] Plaid: ${result.data.length} transactions for ${clientSlug}`);
            }
        } catch (err) {
            console.error(`[TransactionSync] Plaid error for ${clientSlug}: ${err.message}`);
        }
    }

    // ── Re-categorize any Uncategorized transactions ──
    const uncategorized = await db.getUncategorizedTransactions(client.id, 200);
    for (const txn of uncategorized) {
        const { category, confidence } = qb.categorizeTransaction(txn.description, txn.amount);
        if (category !== 'Uncategorized') {
            await db.upsertTransactions(client.id, [{
                source:               txn.source,
                source_transaction_id: txn.source_transaction_id,
                date:                 txn.date,
                amount:               txn.amount,
                description:          txn.description,
                merchant_name:        txn.merchant_name,
                category,
                category_confidence:  confidence,
                account_id:           txn.account_id,
                account_name:         txn.account_name,
                currency:             txn.currency,
            }]);
        }
    }

    console.log(`[TransactionSync] Done for ${clientSlug} — ${synced} total synced`);
    return { clientSlug, synced, startDate, endDate };
});

// ─── Job: Monthly Reconciliation ─────────────────────────────────────────────

reconciliation.process('reconcile', 2, async (job) => {
    const { clientSlug, periodStart, periodEnd } = job.data;
    console.log(`[Reconciliation] Starting for ${clientSlug} (${periodStart} → ${periodEnd})`);

    const client = await db.getClient(clientSlug);
    if (!client) throw new Error(`Client not found: ${clientSlug}`);

    // Create run record
    const runId = await db.createReconciliationRun(client.id, periodStart, periodEnd);

    try {
        // Pull all transactions for the period
        const [booksTxns, bankTxns] = await Promise.all([
            // Books = QBO or Xero (accounting system of record)
            client.qbo_realm_id
                ? db.getTransactionsByPeriod(client.id, 'qbo', periodStart, periodEnd)
                : db.getTransactionsByPeriod(client.id, 'xero', periodStart, periodEnd),
            // Bank = Plaid
            db.getTransactionsByPeriod(client.id, 'plaid', periodStart, periodEnd),
        ]);

        console.log(`[Reconciliation] ${clientSlug}: ${booksTxns.length} books txns, ${bankTxns.length} bank txns`);

        const discrepancies = [];
        let reconciledCount = 0;

        // ── Match books → bank ──
        // For each accounting transaction, find a matching Plaid transaction.
        // Match criteria: same date ±2 days, amount within $0.01.
        const unmatchedBank = new Set(bankTxns.map(t => t.id));

        for (const booksTxn of booksTxns) {
            const booksDate   = dayjs(booksTxn.date);
            const booksAmount = parseFloat(booksTxn.amount);

            const match = bankTxns.find(bankTxn => {
                const bankDate   = dayjs(bankTxn.date);
                const bankAmount = parseFloat(bankTxn.amount);
                const daysDiff   = Math.abs(booksDate.diff(bankDate, 'day'));
                const amtDiff    = Math.abs(booksAmount - bankAmount);
                return daysDiff <= 2 && amtDiff <= 0.01;
            });

            if (match) {
                // Matched — mark both reconciled
                await db.markReconciled(booksTxn.id, match.source_transaction_id);
                await db.markReconciled(match.id, booksTxn.source_transaction_id);
                unmatchedBank.delete(match.id);
                reconciledCount++;
            } else {
                // No bank match — check for amount mismatch (close but not exact)
                const closestBank = bankTxns.find(bankTxn => {
                    const bankDate   = dayjs(bankTxn.date);
                    const bankAmount = parseFloat(bankTxn.amount);
                    const daysDiff   = Math.abs(booksDate.diff(bankDate, 'day'));
                    return daysDiff <= 2 && Math.abs(booksAmount - bankAmount) < Math.abs(booksAmount) * 0.05;
                });

                if (closestBank) {
                    const bankAmt = parseFloat(closestBank.amount);
                    await db.flagDiscrepancy(booksTxn.id, `Amount mismatch: books $${booksAmount}, bank $${bankAmt}`);
                    discrepancies.push({
                        type:          'amount_mismatch',
                        transactionId: booksTxn.id,
                        description:   `${booksTxn.description}: books $${booksAmount.toFixed(2)}, bank $${bankAmt.toFixed(2)}`,
                        qboAmount:     booksAmount,
                        bankAmount:    bankAmt,
                    });
                } else {
                    // Missing from bank entirely
                    await db.flagDiscrepancy(booksTxn.id, 'Transaction not found in bank feed');
                    discrepancies.push({
                        type:          'missing_in_bank',
                        transactionId: booksTxn.id,
                        description:   `"${booksTxn.description}" on ${booksTxn.date} for $${booksAmount.toFixed(2)} not found in bank`,
                        qboAmount:     booksAmount,
                        bankAmount:    null,
                    });
                }
            }
        }

        // ── Remaining unmatched bank transactions → missing in books ──
        for (const bankTxnId of unmatchedBank) {
            const bankTxn   = bankTxns.find(t => t.id === bankTxnId);
            if (!bankTxn) continue;
            const bankAmount = parseFloat(bankTxn.amount);

            await db.flagDiscrepancy(bankTxn.id, 'Bank transaction not found in accounting records');
            discrepancies.push({
                type:          'missing_in_books',
                transactionId: bankTxn.id,
                description:   `Bank: "${bankTxn.description}" on ${bankTxn.date} for $${bankAmount.toFixed(2)} not in books`,
                qboAmount:     null,
                bankAmount,
            });
        }

        // ── Detect duplicates in books ──
        const booksMap = {};
        for (const txn of booksTxns) {
            const key = `${txn.date}:${parseFloat(txn.amount).toFixed(2)}`;
            if (booksMap[key]) {
                discrepancies.push({
                    type:          'duplicate',
                    transactionId: txn.id,
                    description:   `Possible duplicate: "${txn.description}" on ${txn.date} for $${parseFloat(txn.amount).toFixed(2)}`,
                    qboAmount:     parseFloat(txn.amount),
                    bankAmount:    null,
                });
            } else {
                booksMap[key] = txn;
            }
        }

        // ── Detect unusual amounts (>$10,000 or unusual for category) ──
        for (const txn of booksTxns) {
            const amt = Math.abs(parseFloat(txn.amount));
            if (amt > 10000 && txn.category !== 'Payroll' && txn.category !== 'Transfer' && txn.category !== 'Loan Payment') {
                discrepancies.push({
                    type:          'unusual_amount',
                    transactionId: txn.id,
                    description:   `Unusually large transaction: "${txn.description}" $${amt.toFixed(2)} in category ${txn.category}`,
                    qboAmount:     parseFloat(txn.amount),
                    bankAmount:    null,
                });
            }
        }

        // ── Save discrepancies ──
        for (const d of discrepancies) {
            await db.insertDiscrepancy({
                clientId:        client.id,
                runId,
                transactionId:   d.transactionId,
                discrepancyType: d.type,
                description:     d.description,
                qboAmount:       d.qboAmount,
                bankAmount:      d.bankAmount,
            });
        }

        // ── Compute totals ──
        const totalAmount = booksTxns.reduce((sum, t) => sum + Math.abs(parseFloat(t.amount)), 0);
        const discrepancyAmount = discrepancies.reduce((sum, d) => {
            const amt = d.qboAmount || d.bankAmount || 0;
            return sum + Math.abs(amt);
        }, 0);

        const reportData = {
            summary: {
                totalTransactions: booksTxns.length,
                bankTransactions:  bankTxns.length,
                reconciledCount,
                unreconciledCount: booksTxns.length - reconciledCount,
                discrepancyCount:  discrepancies.length,
                totalAmount:       totalAmount.toFixed(2),
                discrepancyAmount: discrepancyAmount.toFixed(2),
            },
            byType: discrepancies.reduce((acc, d) => {
                acc[d.type] = (acc[d.type] || 0) + 1;
                return acc;
            }, {}),
            generatedAt: new Date().toISOString(),
        };

        // ── Update run ──
        await db.updateReconciliationRun(runId, {
            status:             'completed',
            total_transactions: booksTxns.length,
            reconciled_count:   reconciledCount,
            unreconciled_count: booksTxns.length - reconciledCount,
            discrepancy_count:  discrepancies.length,
            total_amount:       totalAmount,
            discrepancy_amount: discrepancyAmount,
            report_data:        reportData,
        });

        // ── SMS summary if discrepancies found ──
        if (discrepancies.length > 0 && client.owner_phone) {
            const msg = [
                `📊 GRIDHAND: ${client.business_name} Reconciliation Complete`,
                `Period: ${periodStart} – ${periodEnd}`,
                `✅ ${reconciledCount} matched | ⚠️ ${discrepancies.length} discrepancies`,
                `Discrepancy total: $${discrepancyAmount.toFixed(2)}`,
                `Log in to review flagged items.`,
            ].join('\n');

            await sendSms(client, msg, 'reconciliation_complete');

            // Queue critical alerts for large discrepancies
            for (const d of discrepancies) {
                const amt = Math.abs(d.qboAmount || d.bankAmount || 0);
                if (amt >= 500 || d.type === 'unusual_amount') {
                    await discrepancyAlert.add('alert', {
                        clientSlug,
                        discrepancy: d,
                    }, { priority: 1 });
                }
            }
        }

        console.log(`[Reconciliation] Done for ${clientSlug}: ${reconciledCount} matched, ${discrepancies.length} discrepancies`);
        return { clientSlug, runId, reconciledCount, discrepancyCount: discrepancies.length };

    } catch (err) {
        await db.updateReconciliationRun(runId, { status: 'failed' });
        throw err;
    }
});

// ─── Job: Discrepancy Alert ───────────────────────────────────────────────────

discrepancyAlert.process('alert', 5, async (job) => {
    const { clientSlug, discrepancy } = job.data;

    const client = await db.getClient(clientSlug);
    if (!client?.owner_phone) return { skipped: true };

    const amt        = Math.abs(discrepancy.qboAmount || discrepancy.bankAmount || 0);
    const typeLabels = {
        amount_mismatch:  'Amount Mismatch',
        missing_in_bank:  'Missing in Bank',
        missing_in_books: 'Missing in Books',
        duplicate:        'Possible Duplicate',
        uncategorized:    'Uncategorized',
        unusual_amount:   'Unusual Amount',
    };

    const label = typeLabels[discrepancy.type] || discrepancy.type;
    const msg   = [
        `🚨 GRIDHAND Alert: ${label}`,
        `Client: ${client.business_name}`,
        `Amount: $${amt.toFixed(2)}`,
        discrepancy.description,
        `Review in your GRIDHAND dashboard.`,
    ].join('\n');

    await sendSms(client, msg, `discrepancy_${discrepancy.type}`);

    return { clientSlug, type: discrepancy.type, amount: amt };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['transaction-sync',  transactionSync],
    ['reconciliation',    reconciliation],
    ['discrepancy-alert', discrepancyAlert],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} failed for ${job.data?.clientSlug || '?'}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} completed for ${job.data?.clientSlug || '?'}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function syncTransactions(clientSlug, startDate, endDate) {
    return transactionSync.add('sync', { clientSlug, startDate, endDate });
}

async function runReconciliation(clientSlug, periodStart, periodEnd) {
    return reconciliation.add('reconcile', { clientSlug, periodStart, periodEnd });
}

/**
 * Run a job function for every client in rb_clients.
 * Called by cron triggers in index.js.
 */
async function runForAllClients(jobFn) {
    const clients = await db.getAllClients();
    const results = [];
    for (const client of clients) {
        try {
            const job = await jobFn(client.client_slug);
            results.push({ clientSlug: client.client_slug, jobId: job?.id });
        } catch (err) {
            console.error(`[Jobs] Failed to queue job for ${client.client_slug}: ${err.message}`);
            results.push({ clientSlug: client.client_slug, error: err.message });
        }
    }
    return results;
}

async function getQueueStats() {
    const [syncCounts, reconCounts, alertCounts] = await Promise.all([
        transactionSync.getJobCounts(),
        reconciliation.getJobCounts(),
        discrepancyAlert.getJobCounts(),
    ]);

    return {
        transactionSync:  syncCounts,
        reconciliation:   reconCounts,
        discrepancyAlert: alertCounts,
    };
}

module.exports = {
    syncTransactions,
    runReconciliation,
    runForAllClients,
    getQueueStats,
    transactionSync,
    reconciliation,
    discrepancyAlert,
};
