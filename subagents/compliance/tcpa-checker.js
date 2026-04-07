// TCPA Compliance Checker — scans messages before sending to avoid violations
// TCPA = Telephone Consumer Protection Act (US SMS law)

const QUIET_HOURS_START = 21; // 9pm
const QUIET_HOURS_END   = 8;  // 8am
const TIMEZONE_DEFAULT  = 'America/Chicago';

// Words/phrases that trigger TCPA risk
const HIGH_RISK_PHRASES = [
    'you have been selected',
    'you are a winner',
    'act now',
    'limited time offer',
    'click here to claim',
    'free gift',
    'no obligation',
    'this is not spam',
    'remove me',
    'opt out',
    'reply stop',
    'unsubscribe link',
];

function getHourInTz(timezone) {
    // Intl.DateTimeFormat returns the correct wall-clock hour in the target TZ
    // regardless of the server's own timezone. The old approach of re-parsing
    // toLocaleString() through `new Date(...)` silently used server-local TZ
    // and produced off-by-TZ-offset hours.
    return parseInt(
        new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }).format(new Date()),
        10
    );
}

function isQuietHours(timezone = TIMEZONE_DEFAULT) {
    try {
        const hour = getHourInTz(timezone);
        return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
    } catch {
        const hour = new Date().getHours();
        return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
    }
}

function checkMessage(message) {
    const lower = message.toLowerCase();
    const issues = [];

    // Check for high-risk phrases
    for (const phrase of HIGH_RISK_PHRASES) {
        if (lower.includes(phrase)) {
            issues.push(`Contains high-risk phrase: "${phrase}"`);
        }
    }

    // Check length (TCPA doesn't limit but carriers do — 160 chars for single SMS)
    if (message.length > 320) {
        issues.push(`Message is ${message.length} chars — will split into multiple SMS segments`);
    }

    // Check for ALL CAPS (spam signal)
    const words = message.split(' ');
    const capsWords = words.filter(w => w.length > 3 && w === w.toUpperCase());
    if (capsWords.length > 2) {
        issues.push(`Too many ALL CAPS words (${capsWords.length}) — looks like spam`);
    }

    // Check for excessive punctuation/symbols
    const specialChars = (message.match(/[!$%&*]{2,}/g) || []).length;
    if (specialChars > 0) {
        issues.push('Excessive special characters — spam filter risk');
    }

    const passed = issues.length === 0;
    return { passed, issues };
}

function check(message, clientTimezone = TIMEZONE_DEFAULT) {
    const quietHours = isQuietHours(clientTimezone);
    const { passed, issues } = checkMessage(message);

    if (quietHours) {
        issues.push(`Quiet hours active (${QUIET_HOURS_START}pm–${QUIET_HOURS_END}am in ${clientTimezone}) — message should be queued`);
    }

    const result = {
        passed: passed && !quietHours,
        quietHours,
        issues,
        recommendation: !passed
            ? 'Fix the flagged issues before sending'
            : quietHours
                ? 'Queue this message to send after 8am'
                : 'Good to send',
    };

    if (!result.passed) {
        console.log(`[TCPAChecker] Issues found: ${issues.join('; ')}`);
    }

    return result;
}

// Queue a message for later (when quiet hours end).
// Returns an ISO timestamp — safe to pass to `new Date(iso).getTime()`.
// Uses Intl to compute the wall-clock Y/M/D/H in the target TZ, then walks
// forward one hour at a time (TZ-agnostic UTC math) until we hit QUIET_HOURS_END.
function getNextSendTime(timezone = TIMEZONE_DEFAULT) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        hour12: false,
    });

    let cursor = new Date();
    // If currently pre-8am, send-time is the next 8am (usually today).
    // If currently >=21, walk forward until the hour flips to 8.
    // Cap the loop at 48 hours to guarantee termination.
    for (let i = 0; i < 48; i++) {
        const hour = parseInt(fmt.format(cursor), 10);
        if (hour === QUIET_HOURS_END) {
            // Snap to the top of this hour in UTC (close enough — we just want
            // an in-window send time; minute precision isn't critical).
            const snapped = new Date(cursor);
            snapped.setUTCMinutes(0, 0, 0);
            return snapped.toISOString();
        }
        cursor = new Date(cursor.getTime() + 60 * 60 * 1000);
    }
    // Fallback — 8 hours out
    return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
}

module.exports = { check, isQuietHours, getNextSendTime };
