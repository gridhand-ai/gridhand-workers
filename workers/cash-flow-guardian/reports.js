/**
 * GRIDHAND Cash Flow Guardian — Report Generation
 *
 * Formats financial data into SMS-ready summaries.
 * All messages are kept under 160 chars when possible,
 * or split into logical 2-part texts for daily reports.
 */

'use strict';

const dayjs = require('dayjs');

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmt(amount) {
    if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`;
    if (amount >= 1000)    return `$${(amount / 1000).toFixed(1)}K`;
    return `$${amount.toFixed(0)}`;
}

function fmtFull(amount) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(amount);
}

// ─── Daily Cash Flow Report ────────────────────────────────────────────────────

/**
 * Generate the daily SMS report sent to the business owner.
 * Returns an array of message strings (1-2 messages).
 */
function generateDailySummary(snapshot, businessName) {
    const date     = dayjs(snapshot.date).format('MMM D');
    const net      = snapshot.netCashFlow;
    const netSign  = net >= 0 ? '+' : '';
    const trend    = net >= 0 ? '↑' : '↓';

    const msg1 = [
        `📊 ${businessName} Cash Flow — ${date}`,
        `Cash: ${fmt(snapshot.cashBalance)}`,
        `MTD: ${netSign}${fmt(net)} (In: ${fmt(snapshot.totalIncome)} / Out: ${fmt(snapshot.totalExpenses)})`,
    ].join('\n');

    const arLine  = snapshot.arBalance > 0 ? `AR Owed: ${fmt(snapshot.arBalance)}` : 'AR: $0';
    const apLine  = snapshot.apBalance > 0 ? `AP Due: ${fmt(snapshot.apBalance)}`  : 'No bills due';
    const overdueNote = snapshot.overdueCount > 0
        ? `⚠️ ${snapshot.overdueCount} overdue invoice${snapshot.overdueCount > 1 ? 's' : ''} (${fmt(snapshot.overdueAmount)})`
        : '✅ No overdue invoices';

    const msg2 = [arLine, apLine, overdueNote].join(' | ');

    return [msg1, msg2];
}

// ─── Invoice Reminder Messages ─────────────────────────────────────────────────

/**
 * Generate an invoice reminder SMS to send to a customer.
 * Escalates tone based on how many reminders have been sent.
 */
function generateInvoiceReminder({ customerName, invoiceNumber, amount, dueDate, daysOverdue, reminderCount, businessName, businessPhone, paymentLink }) {
    const nameGreet  = customerName ? `Hi ${customerName}` : 'Hi there';
    const invoiceRef = invoiceNumber ? ` #${invoiceNumber}` : '';
    const amtStr     = fmtFull(amount);
    const dueDateStr = dueDate ? dayjs(dueDate).format('MMM D') : null;
    const payStr     = paymentLink
        ? ` Pay here: ${paymentLink}`
        : ` Call us: ${businessPhone}`;

    if (reminderCount === 0) {
        // Soft first touch
        const dueStr = dueDateStr ? ` due ${dueDateStr}` : '';
        return `${nameGreet} — friendly reminder from ${businessName}. Invoice${invoiceRef} for ${amtStr} is${dueStr}.${payStr} Questions? Reply anytime. — ${businessName}`;
    }

    if (reminderCount === 1) {
        // Following up
        const daysStr = daysOverdue > 0 ? ` (${daysOverdue} days past due)` : '';
        return `${nameGreet}, following up from ${businessName} — invoice${invoiceRef} for ${amtStr} is still outstanding${daysStr}.${payStr} — ${businessName}`;
    }

    // Final notice
    return `${nameGreet}, final notice from ${businessName}. Invoice${invoiceRef} for ${amtStr} is ${daysOverdue} days overdue. Please contact us at ${businessPhone} immediately. — ${businessName}`;
}

// ─── Payment Received Alert ────────────────────────────────────────────────────

/**
 * Alert the owner when an invoice gets paid.
 */
function generatePaymentReceivedAlert({ customerName, invoiceNumber, amount, businessName }) {
    const invoiceRef = invoiceNumber ? ` #${invoiceNumber}` : '';
    return `💰 Payment received! ${customerName || 'A customer'} paid ${fmtFull(amount)} (invoice${invoiceRef}). — ${businessName} Cash Flow Guardian`;
}

// ─── Low Cash Alert ────────────────────────────────────────────────────────────

/**
 * Alert the owner when cash balance drops below the configured threshold.
 */
function generateLowCashAlert({ cashBalance, threshold, arBalance, businessName }) {
    const arNote = arBalance > 0
        ? ` You have ${fmt(arBalance)} in unpaid invoices — consider following up.`
        : '';
    return `⚠️ Low cash alert for ${businessName}. Balance is ${fmtFull(cashBalance)} — below your ${fmtFull(threshold)} threshold.${arNote} — Cash Flow Guardian`;
}

// ─── Weekly Forecast ──────────────────────────────────────────────────────────

/**
 * Generate the weekly cash flow forecast SMS.
 */
function generateWeeklyForecast({ expectedInflow, expectedOutflow, currentCashBalance, businessName, days = 30 }) {
    const projected = currentCashBalance + expectedInflow - expectedOutflow;
    const health    = projected > 0 ? '✅ Healthy' : '⚠️ Tight';
    const label     = days === 7 ? 'This week' : `Next ${days} days`;

    return [
        `📅 ${businessName} ${days === 7 ? 'Weekly' : '30-Day'} Forecast`,
        `${label}: +${fmt(expectedInflow)} in / -${fmt(expectedOutflow)} out`,
        `Projected balance: ${fmt(projected)} ${health}`,
        `Current cash: ${fmt(currentCashBalance)}`,
    ].join('\n');
}

// ─── Anomaly Alerts ────────────────────────────────────────────────────────────

/**
 * Detect unusual spending or income changes compared to recent averages.
 * snapshots: array of past daily snapshots (oldest first)
 * today: current snapshot
 * Returns array of alert strings (empty if no anomalies).
 */
function detectAnomalies(snapshots, today, businessName) {
    const alerts = [];
    if (!snapshots || snapshots.length < 5) return alerts;

    const avgExpenses = snapshots.reduce((s, r) => s + r.total_expenses, 0) / snapshots.length;
    const avgIncome   = snapshots.reduce((s, r) => s + r.total_income,   0) / snapshots.length;

    // Flag if today's expenses are >50% above average
    if (avgExpenses > 0 && today.totalExpenses > avgExpenses * 1.5) {
        const pct = Math.round(((today.totalExpenses / avgExpenses) - 1) * 100);
        alerts.push(`⚠️ Unusual spending detected for ${businessName}: expenses are ${pct}% above your recent average (${fmt(today.totalExpenses)} vs avg ${fmt(avgExpenses)}). — Cash Flow Guardian`);
    }

    // Flag if income dropped >40% vs average (possible slow period)
    if (avgIncome > 500 && today.totalIncome < avgIncome * 0.6) {
        const pct = Math.round((1 - today.totalIncome / avgIncome) * 100);
        alerts.push(`📉 Income dip alert for ${businessName}: revenue is ${pct}% below your recent average. Consider reviewing your pipeline. — Cash Flow Guardian`);
    }

    return alerts;
}

module.exports = {
    generateDailySummary,
    generateInvoiceReminder,
    generatePaymentReceivedAlert,
    generateLowCashAlert,
    generateWeeklyForecast,
    detectAnomalies,
    fmt,
    fmtFull,
};
