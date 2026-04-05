/**
 * GRIDHAND Rent Collector — Bull Queue Job Definitions
 *
 * Jobs:
 *  - sync-payments    → daily: pull Buildium payments, update status
 *  - send-reminders   → 3 days before due: SMS rent reminders to tenants
 *  - late-fee-check   → daily after due date: flag late payers, initiate fees
 *  - owner-report     → 1st of month: send owner collection report
 */

'use strict';

const Bull     = require('bull');
const dayjs    = require('dayjs');
const buildium = require('./buildium');
const sms      = require('./sms');
const db       = require('./db');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const syncQueue     = new Bull('rent-collector:sync-payments',  REDIS_URL);
const reminderQueue = new Bull('rent-collector:send-reminders', REDIS_URL);
const lateFeeQueue  = new Bull('rent-collector:late-fee-check', REDIS_URL);
const reportQueue   = new Bull('rent-collector:owner-report',   REDIS_URL);

// ─── Job: Sync Payments ───────────────────────────────────────────────────────

syncQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[SyncPayments] Running for ${clientSlug}`);

    const conn    = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const currentMonth = dayjs().format('YYYY-MM');
    const leases       = await buildium.getActiveLeases(clientSlug);
    let paidCount = 0, newPayments = 0;

    for (const lease of leases) {
        const payments = await buildium.getLeasePayments(clientSlug, lease.buildiumLeaseId, currentMonth);
        const existing = await db.getRentTracker(clientSlug, lease.buildiumLeaseId, currentMonth);

        const wasPaid   = existing?.status === 'paid';
        const isPaidNow = payments.totalPaid >= lease.rentAmount;
        const isPartial = payments.totalPaid > 0 && payments.totalPaid < lease.rentAmount;

        const status = isPaidNow ? 'paid' : (isPartial ? 'partial' : (
            dayjs().date() > (lease.dueDay + (conn.late_fee_days || 5)) ? 'late' : 'pending'
        ));

        await db.upsertRentTracker(clientSlug, {
            ...lease,
            currentMonth,
            amountPaid: payments.totalPaid,
            paidAt:     payments.paidAt,
            status,
        });

        if (isPaidNow) paidCount++;

        // Detect new payment event
        if (!wasPaid && isPaidNow) {
            newPayments++;
            const fmt = n => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
            await sms.sendToOwner(conn,
                `💰 Rent received: ${lease.tenantName} paid ${fmt(payments.totalPaid)} for ${lease.propertyAddress || 'unit'}${lease.unitNumber ? ` #${lease.unitNumber}` : ''}`,
                'payment_received', lease.buildiumLeaseId
            );
        }
    }

    console.log(`[SyncPayments] Done for ${clientSlug} — ${paidCount} paid, ${newPayments} new payments`);
    return { clientSlug, paidCount, newPayments, total: leases.length };
});

// ─── Job: Send Reminders ──────────────────────────────────────────────────────

reminderQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[SendReminders] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const unpaid = await db.getUnpaidReminders(clientSlug);
    const daysBeforeReminder = conn.reminder_days_before || 3;
    let sent = 0;

    for (const lease of unpaid) {
        // Only remind if within the reminder window and haven't sent recently
        const dueDate = dayjs().date(lease.due_day);
        const daysUntilDue = dueDate.diff(dayjs(), 'day');

        if (daysUntilDue < 0 || daysUntilDue > daysBeforeReminder) continue;

        // Don't resend if already sent within 24h
        if (lease.last_reminder_sent) {
            const hoursSinceLast = dayjs().diff(dayjs(lease.last_reminder_sent), 'hour');
            if (hoursSinceLast < 24) continue;
        }

        const fmt = n => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
        const msg = daysUntilDue <= 0
            ? `Hi ${lease.tenant_name}! Your rent of ${fmt(lease.rent_amount)} was due today for ${lease.property_address || 'your unit'}. Please pay promptly to avoid late fees. — ${conn.business_name || 'Property Management'}`
            : `Hi ${lease.tenant_name}! Reminder: rent of ${fmt(lease.rent_amount)} is due in ${daysUntilDue} day${daysUntilDue !== 1 ? 's' : ''} for ${lease.property_address || 'your unit'}. — ${conn.business_name || 'Property Management'}`;

        await sms.sendToTenant(conn, lease.tenant_phone, msg, 'reminder', lease.buildium_lease_id);
        await db.markReminderSent(clientSlug, lease.buildium_lease_id, lease.current_month);
        sent++;
    }

    console.log(`[SendReminders] Done for ${clientSlug} — ${sent} reminders sent`);
    return { clientSlug, sent };
});

// ─── Job: Late Fee Check ──────────────────────────────────────────────────────

lateFeeQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[LateFeeCheck] Running for ${clientSlug}`);

    const conn     = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const allRent  = await db.getCurrentMonthRent(clientSlug);
    const lateFeeAfterDays = conn.late_fee_days || 5;
    const lateFeeAmount    = parseFloat(conn.late_fee_amount || 50);
    const currentDay       = dayjs().date();
    let feesIssued = 0;

    for (const lease of allRent) {
        if (lease.status === 'paid' || lease.late_fee_issued) continue;
        if (!lease.tenant_phone) continue;

        const daysOverdue = currentDay - lease.due_day;
        if (daysOverdue < lateFeeAfterDays) continue;

        const fmt = n => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

        // SMS tenant about late fee
        await sms.sendToTenant(conn, lease.tenant_phone,
            `⚠️ LATE NOTICE: Your rent of ${fmt(lease.rent_amount)} is ${daysOverdue} days overdue. A late fee of ${fmt(lateFeeAmount)} has been added to your balance. Please remit payment immediately. — ${conn.business_name || 'Property Management'}`,
            'late_fee', lease.buildium_lease_id
        );

        // Notify owner
        await sms.sendToOwner(conn,
            `⚠️ Late fee issued: ${lease.tenant_name} at ${lease.property_address || 'property'} — ${daysOverdue} days overdue. Fee: ${fmt(lateFeeAmount)}.`,
            'late_fee', lease.buildium_lease_id
        );

        await db.markLateFeeIssued(clientSlug, lease.buildium_lease_id, lease.current_month);
        feesIssued++;
    }

    console.log(`[LateFeeCheck] Done for ${clientSlug} — ${feesIssued} fees issued`);
    return { clientSlug, feesIssued };
});

// ─── Job: Owner Report ────────────────────────────────────────────────────────

reportQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[OwnerReport] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const currentMonth = dayjs().format('YYYY-MM');
    const allRent      = await db.getCurrentMonthRent(clientSlug);

    if (!allRent.length) return { clientSlug, tenants: 0 };

    const fmt = n => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

    const totalExpected   = allRent.reduce((s, r) => s + parseFloat(r.rent_amount || 0), 0);
    const totalCollected  = allRent.reduce((s, r) => s + parseFloat(r.amount_paid || 0), 0);
    const paidCount       = allRent.filter(r => r.status === 'paid').length;
    const lateCount       = allRent.filter(r => r.status === 'late' || r.status === 'late_fee_issued').length;
    const pendingCount    = allRent.filter(r => r.status === 'pending' || r.status === 'partial').length;
    const collectionRate  = totalExpected > 0 ? Math.round((totalCollected / totalExpected) * 100) : 0;

    const reportText = [
        `📊 Monthly Rent Report — ${conn.business_name || clientSlug}`,
        `${dayjs(currentMonth, 'YYYY-MM').format('MMMM YYYY')}`,
        ``,
        `COLLECTED:   ${fmt(totalCollected)} of ${fmt(totalExpected)} (${collectionRate}%)`,
        `OUTSTANDING: ${fmt(totalExpected - totalCollected)}`,
        ``,
        `✅ Paid:    ${paidCount}/${allRent.length} tenants`,
        lateCount   ? `⚠️ Late:    ${lateCount}` : null,
        pendingCount ? `⏳ Pending: ${pendingCount}` : null,
    ].filter(Boolean).join('\n');

    await sms.sendToOwner(conn, reportText, 'owner_report');
    await db.upsertOwnerReport(clientSlug, {
        month: currentMonth,
        totalExpected,
        totalCollected,
        totalOutstanding: totalExpected - totalCollected,
        tenantCount:      allRent.length,
        paidCount,
        lateCount,
        reportText,
    });

    console.log(`[OwnerReport] Done for ${clientSlug}`);
    return { clientSlug, collectionRate, paidCount };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['sync-payments',  syncQueue],
    ['send-reminders', reminderQueue],
    ['late-fee-check', lateFeeQueue],
    ['owner-report',   reportQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runSyncPayments(clientSlug) {
    return syncQueue.add({ clientSlug }, { attempts: 3, backoff: 30000 });
}

async function runSendReminders(clientSlug) {
    return reminderQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runLateFeeCheck(clientSlug) {
    return lateFeeQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runOwnerReport(clientSlug) {
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
    runSyncPayments,
    runSendReminders,
    runLateFeeCheck,
    runOwnerReport,
    runForAllClients,
    syncQueue,
    reminderQueue,
    lateFeeQueue,
    reportQueue,
};
