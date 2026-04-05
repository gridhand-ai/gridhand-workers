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

function isQuietHours(timezone = TIMEZONE_DEFAULT) {
    try {
        const now = new Date();
        const localTime = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
        const hour = localTime.getHours();
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

// Queue a message for later (when quiet hours end)
function getNextSendTime(timezone = TIMEZONE_DEFAULT) {
    const now = new Date();
    const localTime = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    const tomorrow = new Date(localTime);
    tomorrow.setHours(QUIET_HOURS_END, 0, 0, 0);
    if (localTime.getHours() < QUIET_HOURS_END) {
        // Before 8am today — schedule for 8am today
        const today = new Date(localTime);
        today.setHours(QUIET_HOURS_END, 0, 0, 0);
        return today.toISOString();
    }
    // After 9pm — schedule for 8am tomorrow
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString();
}

module.exports = { check, isQuietHours, getNextSendTime };
