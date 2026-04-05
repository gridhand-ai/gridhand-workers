/**
 * GRIDHAND Cash Flow Guardian — Bull Queue Job Definitions
 *
 * Jobs:
 *  - daily-report       → 8am daily: pull QB snapshot, SMS owner
 *  - invoice-reminders  → 9am daily: check overdue invoices, SMS customers
 *  - weekly-forecast    → 8am Monday: 30-day cash flow forecast SMS
 *  - payment-check      → Every 4 hours: detect paid invoices, alert owner
 *
 * All jobs are registered here. index.js schedules them via node-cron.
 */

'use strict';

const Bull       = require('bull');
const dayjs      = require('dayjs');
const qb         = require('./quickbooks');
const reports    = require('./reports');
const db         = require('./db');
const sms        = require('./sms');

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const dailyReportQueue     = new Bull('cash-flow:daily-report',     REDIS_URL);
const invoiceReminderQueue = new Bull('cash-flow:invoice-reminders', REDIS_URL);
const weeklyForecastQueue  = new Bull('cash-flow:weekly-forecast',   REDIS_URL);
const paymentCheckQueue    = new Bull('cash-flow:payment-check',      REDIS_URL);

// ─── Job: Daily Cash Flow Report ──────────────────────────────────────────────

dailyReportQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[DailyReport] Running for ${clientSlug}`);

    const conn = await db.getQBConnection(clientSlug);
    if (!conn) throw new Error(`No QB connection for ${clientSlug}`);

    // Pull snapshot
    const snapshot = await qb.getDailyCashFlowSnapshot(clientSlug, conn.realm_id);

    // Save snapshot to DB
    await db.upsertSnapshot(clientSlug, snapshot);

    // Check low cash alert
    if (snapshot.cashBalance < conn.low_cash_threshold) {
        const alert = reports.generateLowCashAlert({
            cashBalance:  snapshot.cashBalance,
            threshold:    conn.low_cash_threshold,
            arBalance:    snapshot.arBalance,
            businessName: conn.business_name || clientSlug,
        });
        await sms.sendToOwner(conn, alert, 'low_cash');
    }

    // Check anomalies against last 14 days
    const history = await db.getRecentSnapshots(clientSlug, 14);
    const anomalyAlerts = reports.detectAnomalies(history, snapshot, conn.business_name || clientSlug);
    for (const alertMsg of anomalyAlerts) {
        await sms.sendToOwner(conn, alertMsg, 'anomaly');
    }

    // Send daily summary
    const messages = reports.generateDailySummary(snapshot, conn.business_name || clientSlug);
    for (const msg of messages) {
        await sms.sendToOwner(conn, msg, 'daily_report');
    }

    console.log(`[DailyReport] Done for ${clientSlug}`);
    return { clientSlug, date: snapshot.date, cashBalance: snapshot.cashBalance };
});

// ─── Job: Invoice Reminders ───────────────────────────────────────────────────

invoiceReminderQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[InvoiceReminders] Running for ${clientSlug}`);

    const conn = await db.getQBConnection(clientSlug);
    if (!conn) throw new Error(`No QB connection for ${clientSlug}`);

    const invoices = await qb.getOpenInvoices(clientSlug, conn.realm_id);
    const overdue  = invoices.filter(inv => inv.daysOverdue > 0);

    let remindersSent = 0;

    for (const inv of overdue) {
        // Get existing tracker record
        const tracker = await db.getInvoiceTracker(clientSlug, inv.id);

        // Reminder throttle rules:
        //  - Reminder 1: any invoice 1+ days overdue (first contact)
        //  - Reminder 2: 7+ days overdue, at least 3 days since last reminder
        //  - Reminder 3 (final): 21+ days overdue, at least 7 days since last reminder
        const reminderCount  = tracker?.reminder_count || 0;
        const lastSent       = tracker?.last_reminder_sent ? dayjs(tracker.last_reminder_sent) : null;
        const daysSinceLast  = lastSent ? dayjs().diff(lastSent, 'day') : 999;

        let shouldSend = false;
        if (reminderCount === 0 && inv.daysOverdue >= 1) shouldSend = true;
        if (reminderCount === 1 && inv.daysOverdue >= 7  && daysSinceLast >= 3) shouldSend = true;
        if (reminderCount === 2 && inv.daysOverdue >= 21 && daysSinceLast >= 7) shouldSend = true;

        if (!shouldSend) continue;

        // Get customer phone
        let customerPhone = tracker?.customer_phone;
        if (!customerPhone && inv.customerRef) {
            customerPhone = await qb.getCustomerPhone(clientSlug, conn.realm_id, inv.customerRef);
        }

        if (!customerPhone) {
            console.log(`[InvoiceReminders] No phone for invoice ${inv.id} (${inv.customerName}) — skipping`);
            await db.upsertInvoiceTracker(clientSlug, { ...inv, customerPhone: null });
            continue;
        }

        // Build and send reminder SMS
        const message = reports.generateInvoiceReminder({
            customerName:   inv.customerName,
            invoiceNumber:  inv.invoiceNumber,
            amount:         inv.balanceDue,
            dueDate:        inv.dueDate,
            daysOverdue:    inv.daysOverdue,
            reminderCount,
            businessName:   conn.business_name || clientSlug,
            businessPhone:  conn.owner_phone,
            paymentLink:    conn.payment_link || null,
        });

        await sms.sendToCustomer(conn, customerPhone, message, inv.id, 'invoice_reminder');

        // Update tracker
        await db.upsertInvoiceTracker(clientSlug, {
            ...inv,
            customerPhone,
            reminderCount:    reminderCount + 1,
            lastReminderSent: new Date().toISOString(),
            status:           inv.daysOverdue > 0 ? 'Overdue' : 'Open',
        });

        remindersSent++;
        console.log(`[InvoiceReminders] Sent reminder ${reminderCount + 1} for invoice ${inv.invoiceNumber} to ${customerPhone}`);
    }

    console.log(`[InvoiceReminders] Done for ${clientSlug} — ${remindersSent} reminders sent`);
    return { clientSlug, remindersSent, overdueCount: overdue.length };
});

// ─── Job: Weekly Forecast ─────────────────────────────────────────────────────

weeklyForecastQueue.process(async (job) => {
    const { clientSlug, days = 30 } = job.data;
    console.log(`[WeeklyForecast] Running for ${clientSlug}`);

    const conn = await db.getQBConnection(clientSlug);
    if (!conn) throw new Error(`No QB connection for ${clientSlug}`);

    const [upcoming, cashBalance] = await Promise.all([
        qb.getUpcomingCashFlow(clientSlug, conn.realm_id, days),
        qb.getCashBalance(clientSlug, conn.realm_id),
    ]);

    const forecastMsg = reports.generateWeeklyForecast({
        expectedInflow:      upcoming.expectedInflow,
        expectedOutflow:     upcoming.expectedOutflow,
        currentCashBalance:  cashBalance,
        businessName:        conn.business_name || clientSlug,
        days,
    });

    await sms.sendToOwner(conn, forecastMsg, 'weekly_forecast');

    // Save forecast
    await db.saveForecast(clientSlug, {
        forecastWeekStart: dayjs().startOf('week').format('YYYY-MM-DD'),
        expectedInflow:    upcoming.expectedInflow,
        expectedOutflow:   upcoming.expectedOutflow,
        projectedBalance:  cashBalance + upcoming.expectedInflow - upcoming.expectedOutflow,
    });

    console.log(`[WeeklyForecast] Done for ${clientSlug}`);
    return { clientSlug, expectedInflow: upcoming.expectedInflow, expectedOutflow: upcoming.expectedOutflow };
});

// ─── Job: Payment Check ───────────────────────────────────────────────────────

paymentCheckQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[PaymentCheck] Running for ${clientSlug}`);

    const conn = await db.getQBConnection(clientSlug);
    if (!conn) throw new Error(`No QB connection for ${clientSlug}`);

    // Pull all open invoices from QB
    const liveInvoices = await qb.getOpenInvoices(clientSlug, conn.realm_id);
    const liveIds = new Set(liveInvoices.map(i => i.id));

    // Get invoices we're tracking that were Open/Overdue last we checked
    const trackedOpen = await db.getOpenTrackedInvoices(clientSlug);

    let paymentsDetected = 0;

    for (const tracked of trackedOpen) {
        if (!liveIds.has(tracked.qb_invoice_id)) {
            // Invoice is no longer in the open list — it was paid (or voided)
            const alert = reports.generatePaymentReceivedAlert({
                customerName:  tracked.customer_name,
                invoiceNumber: tracked.invoice_number,
                amount:        tracked.amount,
                businessName:  conn.business_name || clientSlug,
            });

            await sms.sendToOwner(conn, alert, 'payment_received');

            await db.markInvoicePaid(clientSlug, tracked.qb_invoice_id);
            paymentsDetected++;

            console.log(`[PaymentCheck] Invoice ${tracked.invoice_number} marked paid for ${clientSlug}`);
        }
    }

    // Upsert any new invoices we see for the first time
    for (const inv of liveInvoices) {
        await db.upsertInvoiceTracker(clientSlug, inv);
    }

    console.log(`[PaymentCheck] Done for ${clientSlug} — ${paymentsDetected} payments detected`);
    return { clientSlug, paymentsDetected };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['daily-report',     dailyReportQueue],
    ['invoice-reminders', invoiceReminderQueue],
    ['weekly-forecast',  weeklyForecastQueue],
    ['payment-check',    paymentCheckQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} job failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} job completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────
// These are called by index.js cron or by manual /trigger endpoints.

async function runDailyReport(clientSlug) {
    return dailyReportQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runInvoiceReminders(clientSlug) {
    return invoiceReminderQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runWeeklyForecast(clientSlug, days = 30) {
    return weeklyForecastQueue.add({ clientSlug, days }, { attempts: 2, backoff: 60000 });
}

async function runPaymentCheck(clientSlug) {
    return paymentCheckQueue.add({ clientSlug }, { attempts: 3, backoff: 30000 });
}

/**
 * Run all jobs for all connected clients.
 * Called by cron triggers in index.js.
 */
async function runForAllClients(jobFn) {
    const clients = await db.getAllConnectedClients();
    const results = [];
    for (const { client_slug } of clients) {
        try {
            const job = await jobFn(client_slug);
            results.push({ clientSlug: client_slug, jobId: job.id });
        } catch (err) {
            console.error(`[Jobs] Failed to queue job for ${client_slug}: ${err.message}`);
        }
    }
    return results;
}

module.exports = {
    runDailyReport,
    runInvoiceReminders,
    runWeeklyForecast,
    runPaymentCheck,
    runForAllClients,
    dailyReportQueue,
    invoiceReminderQueue,
    weeklyForecastQueue,
    paymentCheckQueue,
};
