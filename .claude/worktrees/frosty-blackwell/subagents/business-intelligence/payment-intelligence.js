// Payment Intelligence — predicts who's likely to pay late, optimizes chase timing
const store = require('../store');

function getKey(clientSlug, customerNumber) {
    return `${clientSlug}_${customerNumber.replace(/[^0-9]/g, '')}`;
}

function getPaymentHistory(clientSlug, customerNumber) {
    return store.readJson('payment-history', getKey(clientSlug, customerNumber)) || {
        invoices: [],
        avgDaysToPayment: null,
        onTimeCount: 0,
        lateCount: 0,
        overdueCount: 0,
        totalPaid: 0,
    };
}

function recordPayment(clientSlug, customerNumber, { invoiceNumber, amount, dueDate, paidDate, status }) {
    const history = getPaymentHistory(clientSlug, customerNumber);
    const due = new Date(dueDate);
    const paid = paidDate ? new Date(paidDate) : null;
    const daysLate = paid ? Math.floor((paid - due) / 86400000) : null;

    const invoice = {
        invoiceNumber,
        amount,
        dueDate,
        paidDate: paidDate || null,
        status, // 'paid-on-time' | 'paid-late' | 'overdue' | 'unpaid'
        daysLate,
        recordedAt: new Date().toISOString(),
    };

    history.invoices.push(invoice);
    history.invoices = history.invoices.slice(-50);

    // Recompute stats
    const paid_invoices = history.invoices.filter(i => i.paidDate);
    history.avgDaysToPayment = paid_invoices.length
        ? Math.round(paid_invoices.reduce((sum, i) => sum + (i.daysLate || 0), 0) / paid_invoices.length)
        : null;
    history.onTimeCount = history.invoices.filter(i => i.status === 'paid-on-time').length;
    history.lateCount = history.invoices.filter(i => i.status === 'paid-late').length;
    history.overdueCount = history.invoices.filter(i => i.status === 'overdue').length;
    history.totalPaid = history.invoices.filter(i => i.paidDate).reduce((sum, i) => sum + (i.amount || 0), 0);

    store.writeJson('payment-history', getKey(clientSlug, customerNumber), history);
    return history;
}

function predictPaymentRisk(clientSlug, customerNumber) {
    const history = getPaymentHistory(clientSlug, customerNumber);
    const total = history.onTimeCount + history.lateCount + history.overdueCount;

    if (total === 0) {
        return { risk: 'unknown', recommendation: 'No history — send standard reminder at 3 days', chaseAfterDays: 3 };
    }

    const lateRate = (history.lateCount + history.overdueCount) / total;
    const avgDays = history.avgDaysToPayment || 0;

    let risk, recommendation, chaseAfterDays;

    if (lateRate >= 0.5 || history.overdueCount >= 2) {
        risk = 'high';
        recommendation = 'Send reminder on due date, follow up at day 2';
        chaseAfterDays = 1;
    } else if (lateRate >= 0.25 || avgDays > 7) {
        risk = 'medium';
        recommendation = 'Send reminder 1 day after due date';
        chaseAfterDays = 2;
    } else {
        risk = 'low';
        recommendation = 'Send standard reminder at 3-5 days';
        chaseAfterDays = 3;
    }

    console.log(`[PaymentIntelligence] ${customerNumber} payment risk: ${risk} (late rate: ${(lateRate * 100).toFixed(0)}%)`);
    return { risk, recommendation, chaseAfterDays, history };
}

// Get all high-risk payers for a client
function getHighRiskPayers(clientSlug) {
    const allCustomers = store.readGlobal('payment-history', `${clientSlug}_index.json`) || {};
    return Object.entries(allCustomers)
        .filter(([, data]) => data.risk === 'high')
        .map(([number, data]) => ({ customerNumber: number, ...data }));
}

module.exports = { recordPayment, predictPaymentRisk, getPaymentHistory, getHighRiskPayers };
