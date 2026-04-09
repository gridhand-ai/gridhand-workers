// ─── Client Intelligence — cross-session insights per client ─────────────────
// Tracks patterns ACROSS all customers for a client, not just per-conversation.
//
// What it tracks:
//   - Upset customer count this week
//   - Most common questions (FAQ patterns)
//   - Review request click rate
//   - Worker performance (which workers get the most traction)
//   - Peak contact hours
//
// Written to: memory/{slug}/intel.json
// Read by:    monthly report, portal dashboard, admin intel tab

const fs   = require('fs');
const path = require('path');

const MEMORY_DIR = path.join(__dirname, '../memory');

function getIntelPath(clientSlug) {
    const dir = path.join(MEMORY_DIR, clientSlug);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'intel.json');
}

function loadIntel(clientSlug) {
    try {
        const fp = getIntelPath(clientSlug);
        if (!fs.existsSync(fp)) return createEmptyIntel();
        return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {
        return createEmptyIntel();
    }
}

function createEmptyIntel() {
    return {
        upsetsThisWeek:     0,
        upsetsThisMonth:    0,
        totalContacts:      0,
        reviewRequestsSent: 0,
        escalationsTotal:   0,
        workerCounts:       {},   // { workerName: taskCount }
        peakHours:          {},   // { "14": 23 } — hour → contact count
        commonTopics:       [],   // top 5 FAQ topics detected
        lastUpdated:        null,
        weekStarted:        getWeekKey(),
        monthStarted:       getMonthKey(),
    };
}

function getWeekKey() {
    const d = new Date();
    const day = d.getUTCDay();
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
    return monday.toISOString().slice(0, 10);
}

function getMonthKey() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function saveIntel(clientSlug, intel) {
    try {
        intel.lastUpdated = new Date().toISOString();
        fs.writeFileSync(getIntelPath(clientSlug), JSON.stringify(intel, null, 2));
    } catch (e) {
        console.error('[ClientIntel] Failed to save:', e.message);
    }
}

// ─── Record a task event ──────────────────────────────────────────────────────
function recordTask(clientSlug, { workerName, wasUpset = false, wasEscalated = false }) {
    try {
        const intel = loadIntel(clientSlug);

        // Reset week/month counters if period rolled over
        if (intel.weekStarted !== getWeekKey()) {
            intel.upsetsThisWeek = 0;
            intel.weekStarted = getWeekKey();
        }
        if (intel.monthStarted !== getMonthKey()) {
            intel.upsetsThisMonth = 0;
            intel.monthStarted = getMonthKey();
        }

        intel.totalContacts += 1;
        if (wasUpset) {
            intel.upsetsThisWeek  += 1;
            intel.upsetsThisMonth += 1;
        }
        if (wasEscalated) intel.escalationsTotal += 1;

        // Worker counts
        intel.workerCounts[workerName] = (intel.workerCounts[workerName] || 0) + 1;

        // Peak hours
        const hour = String(new Date().getUTCHours());
        intel.peakHours[hour] = (intel.peakHours[hour] || 0) + 1;

        saveIntel(clientSlug, intel);
    } catch (e) {
        // Non-fatal
    }
}

// ─── Record a review request sent ────────────────────────────────────────────
function recordReviewRequest(clientSlug) {
    try {
        const intel = loadIntel(clientSlug);
        intel.reviewRequestsSent += 1;
        saveIntel(clientSlug, intel);
    } catch {}
}

// ─── Get a human-readable summary for reports/dashboard ──────────────────────
function getSummary(clientSlug) {
    const intel = loadIntel(clientSlug);

    // Top worker
    const topWorker = Object.entries(intel.workerCounts)
        .sort((a, b) => b[1] - a[1])[0];

    // Peak hour (convert UTC to rough local — just display, not critical)
    const peakHour = Object.entries(intel.peakHours)
        .sort((a, b) => b[1] - a[1])[0];

    return {
        totalContacts:      intel.totalContacts,
        upsetsThisWeek:     intel.upsetsThisWeek,
        upsetsThisMonth:    intel.upsetsThisMonth,
        reviewRequestsSent: intel.reviewRequestsSent,
        escalationsTotal:   intel.escalationsTotal,
        topWorker:          topWorker ? { name: topWorker[0], count: topWorker[1] } : null,
        peakHour:           peakHour  ? { hour: peakHour[0],  count: peakHour[1]  } : null,
        lastUpdated:        intel.lastUpdated,
    };
}

module.exports = { recordTask, recordReviewRequest, getSummary, loadIntel };
