// Campaign Tracker — tracks send/reply/convert rates per worker per client
const store = require('../store');

function getStatsKey(clientSlug) {
    return `${clientSlug}_stats`;
}

function getStats(clientSlug) {
    return store.readJson('campaign-stats', getStatsKey(clientSlug)) || {
        clientSlug,
        workers: {},
        updatedAt: null,
    };
}

function saveStats(clientSlug, stats) {
    stats.updatedAt = new Date().toISOString();
    store.writeJson('campaign-stats', getStatsKey(clientSlug), stats);
}

function ensureWorker(stats, workerName) {
    if (!stats.workers[workerName]) {
        stats.workers[workerName] = {
            sent: 0,
            received: 0,
            replied: 0,
            converted: 0,
            escalated: 0,
            optedOut: 0,
            lastActivity: null,
        };
    }
    return stats.workers[workerName];
}

function trackSent(clientSlug, workerName) {
    const stats = getStats(clientSlug);
    const w = ensureWorker(stats, workerName);
    w.sent++;
    w.lastActivity = new Date().toISOString();
    saveStats(clientSlug, stats);
}

function trackReceived(clientSlug, workerName) {
    const stats = getStats(clientSlug);
    const w = ensureWorker(stats, workerName);
    w.received++;
    w.lastActivity = new Date().toISOString();
    saveStats(clientSlug, stats);
}

function trackReply(clientSlug, workerName) {
    const stats = getStats(clientSlug);
    const w = ensureWorker(stats, workerName);
    w.replied++;
    w.lastActivity = new Date().toISOString();
    saveStats(clientSlug, stats);
}

function trackConversion(clientSlug, workerName) {
    const stats = getStats(clientSlug);
    const w = ensureWorker(stats, workerName);
    w.converted++;
    w.lastActivity = new Date().toISOString();
    saveStats(clientSlug, stats);
}

function trackEscalation(clientSlug, workerName) {
    const stats = getStats(clientSlug);
    const w = ensureWorker(stats, workerName);
    w.escalated++;
    saveStats(clientSlug, stats);
}

function trackOptOut(clientSlug, workerName) {
    const stats = getStats(clientSlug);
    const w = ensureWorker(stats, workerName);
    w.optedOut++;
    saveStats(clientSlug, stats);
}

function getReport(clientSlug) {
    const stats = getStats(clientSlug);
    const report = { clientSlug, updatedAt: stats.updatedAt, workers: {} };

    for (const [name, w] of Object.entries(stats.workers)) {
        const replyRate = w.sent > 0 ? ((w.replied / w.sent) * 100).toFixed(1) : '0.0';
        const convertRate = w.replied > 0 ? ((w.converted / w.replied) * 100).toFixed(1) : '0.0';
        report.workers[name] = {
            ...w,
            replyRate: `${replyRate}%`,
            convertRate: `${convertRate}%`,
        };
    }

    return report;
}

module.exports = { trackSent, trackReceived, trackReply, trackConversion, trackEscalation, trackOptOut, getReport, getStats };
