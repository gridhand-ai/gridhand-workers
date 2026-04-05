// Best Time Sender — tracks when each customer actually responds and optimizes send times
const store = require('../store');

function getKey(clientSlug, customerNumber) {
    return `${clientSlug}_${customerNumber.replace(/[^0-9]/g, '')}`;
}

function getPattern(clientSlug, customerNumber) {
    return store.readJson('response-patterns', getKey(clientSlug, customerNumber)) || {
        responseTimes: [],   // hours of day when they reply (0-23)
        responseDays: [],    // days of week (0=Sun, 6=Sat)
        avgResponseMs: null,
        totalInteractions: 0,
        updatedAt: null,
    };
}

// Record that a customer replied at this time
function recordResponse(clientSlug, customerNumber) {
    const pattern = getPattern(clientSlug, customerNumber);
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();

    pattern.responseTimes.push(hour);
    pattern.responseDays.push(day);
    pattern.totalInteractions++;
    pattern.updatedAt = new Date().toISOString();

    // Keep last 50 data points
    pattern.responseTimes = pattern.responseTimes.slice(-50);
    pattern.responseDays = pattern.responseDays.slice(-50);

    store.writeJson('response-patterns', getKey(clientSlug, customerNumber), pattern);
}

// Get the best time to send to this customer
function getBestTime(clientSlug, customerNumber) {
    const pattern = getPattern(clientSlug, customerNumber);

    if (pattern.totalInteractions < 3) {
        // Not enough data — use generic best practices
        return {
            bestHour: 10,     // 10am
            bestDay: 2,       // Tuesday
            confidence: 'low',
            reason: 'Insufficient data — using general best practice (Tue 10am)',
        };
    }

    // Find most common response hour
    const hourCounts = {};
    for (const h of pattern.responseTimes) {
        hourCounts[h] = (hourCounts[h] || 0) + 1;
    }
    const bestHour = parseInt(Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0][0]);

    // Find most common response day
    const dayCounts = {};
    for (const d of pattern.responseDays) {
        dayCounts[d] = (dayCounts[d] || 0) + 1;
    }
    const bestDay = parseInt(Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0][0]);

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const confidence = pattern.totalInteractions >= 10 ? 'high' : 'medium';

    return {
        bestHour,
        bestDay,
        confidence,
        reason: `Based on ${pattern.totalInteractions} interactions — they typically respond on ${dayNames[bestDay]} around ${bestHour}:00`,
        pattern,
    };
}

// Get optimal send time as a Date object (next occurrence of bestDay at bestHour)
function getNextOptimalSendTime(clientSlug, customerNumber) {
    const { bestHour, bestDay } = getBestTime(clientSlug, customerNumber);
    const now = new Date();
    const target = new Date();

    target.setHours(bestHour, 0, 0, 0);

    // Advance to the next occurrence of bestDay
    const currentDay = now.getDay();
    let daysUntil = (bestDay - currentDay + 7) % 7;
    if (daysUntil === 0 && now.getHours() >= bestHour) daysUntil = 7;

    target.setDate(target.getDate() + daysUntil);

    return target;
}

module.exports = { recordResponse, getBestTime, getNextOptimalSendTime };
