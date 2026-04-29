// Re-engagement Scheduler — automatically queues dormant customers for reactivation
const store = require('../store');
const customerProfiler = require('../customer/customer-profiler');
const churnPredictor = require('../intelligence/churn-predictor');

function getQueueKey(clientSlug) { return clientSlug; }

function getQueue(clientSlug) {
    return store.readJson('reengagement-queue', getQueueKey(clientSlug)) || [];
}

function saveQueue(clientSlug, queue) {
    store.writeJson('reengagement-queue', getQueueKey(clientSlug), queue);
}

// Scan all customers for a client and add dormant ones to the queue
async function scan(clientSlug, clientSettings) {
    const allCustomers = await customerProfiler.getAllCustomers(clientSlug);
    const dormantDays = clientSettings?.reactivation?.dormantDays || 90;
    const queue = getQueue(clientSlug);
    const queuedNumbers = new Set(queue.map(q => q.customerNumber));

    let added = 0;

    for (const [customerNumber, summary] of Object.entries(allCustomers)) {
        // Skip opted out
        if (summary.optedOut) continue;
        // Skip already queued
        if (queuedNumbers.has(customerNumber)) continue;

        // Check dormancy
        if (!summary.lastContact) continue;
        const daysSince = Math.floor((Date.now() - new Date(summary.lastContact).getTime()) / 86400000);

        if (daysSince >= dormantDays) {
            const { risk } = churnPredictor.getRuleBasedRisk ?
                { risk: daysSince >= dormantDays * 1.5 ? 'high' : 'medium' } :
                { risk: 'medium' };

            queue.push({
                customerNumber,
                clientSlug,
                daysSinceContact: daysSince,
                churnRisk: risk,
                queuedAt: new Date().toISOString(),
                scheduledFor: getScheduledDate(risk),
                status: 'pending',
                name: summary.name || null,
            });
            added++;
        }
    }

    if (added > 0) {
        // Sort by risk (high first) then by days dormant (longest first)
        queue.sort((a, b) => {
            const riskOrder = { high: 0, medium: 1, low: 2 };
            return (riskOrder[a.churnRisk] - riskOrder[b.churnRisk]) ||
                   (b.daysSinceContact - a.daysSinceContact);
        });
        saveQueue(clientSlug, queue);
        console.log(`[ReengagementScheduler] Added ${added} dormant customers to queue for ${clientSlug}`);
    }

    return { added, totalQueued: queue.length };
}

function getScheduledDate(risk) {
    const now = new Date();
    // High risk: reach out within 1 day, medium: within 3 days
    const daysDelay = risk === 'high' ? 0 : risk === 'medium' ? 2 : 5;
    now.setDate(now.getDate() + daysDelay);
    now.setHours(10, 0, 0, 0); // 10am
    return now.toISOString();
}

// Get customers ready to be re-engaged right now
function getDueForReengagement(clientSlug) {
    const queue = getQueue(clientSlug);
    const now = new Date().toISOString();
    return queue.filter(q => q.status === 'pending' && q.scheduledFor <= now);
}

// Mark as sent
function markSent(clientSlug, customerNumber) {
    const queue = getQueue(clientSlug);
    const item = queue.find(q => q.customerNumber === customerNumber && q.status === 'pending');
    if (item) {
        item.status = 'sent';
        item.sentAt = new Date().toISOString();
        saveQueue(clientSlug, queue);
    }
}

// Remove from queue (if they came back)
function removeFromQueue(clientSlug, customerNumber) {
    const queue = getQueue(clientSlug).filter(q => q.customerNumber !== customerNumber);
    saveQueue(clientSlug, queue);
}

function getQueueStats(clientSlug) {
    const queue = getQueue(clientSlug);
    return {
        total: queue.length,
        pending: queue.filter(q => q.status === 'pending').length,
        sent: queue.filter(q => q.status === 'sent').length,
        highRisk: queue.filter(q => q.churnRisk === 'high' && q.status === 'pending').length,
    };
}

module.exports = { scan, getDueForReengagement, markSent, removeFromQueue, getQueueStats };
