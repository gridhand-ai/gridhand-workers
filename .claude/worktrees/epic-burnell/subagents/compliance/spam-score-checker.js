// Spam Score Checker — prevents messages from being filtered by carriers
// Based on common carrier spam detection patterns

const HIGH_RISK_WORDS = [
    'free', 'winner', 'won', 'prize', 'cash', 'earn money', 'make money',
    'risk free', 'guarantee', 'no obligation', 'no risk', 'act now',
    'limited time', 'expires', 'urgent', 'congratulations',
    'click here', 'visit our website', 'apply now', '100%',
    'lose weight', 'pills', 'buy now', 'order now', 'cheap',
    'lowest price', 'best price', 'compare rates', 'save big',
    'call now', 'call free', 'toll free',
];

const MEDIUM_RISK_WORDS = [
    'offer', 'deal', 'sale', 'discount', 'promotion', 'special',
    'today only', 'exclusive', 'selected', 'chosen', 'opportunity',
    'investment', 'income', 'profit', 'bonus', 'reward', 'gift',
];

const LINK_PATTERN = /https?:\/\/[^\s]+/g;
const SHORT_URL_PATTERN = /\b(bit\.ly|tinyurl|goo\.gl|t\.co|ow\.ly|short\.io)\b/i;

function check(message) {
    const lower = message.toLowerCase();
    const issues = [];
    let spamScore = 0;

    // High risk words
    const highRiskFound = HIGH_RISK_WORDS.filter(w => lower.includes(w));
    if (highRiskFound.length > 0) {
        spamScore += highRiskFound.length * 15;
        issues.push(`High-risk words: ${highRiskFound.slice(0, 3).join(', ')}`);
    }

    // Medium risk words
    const medRiskFound = MEDIUM_RISK_WORDS.filter(w => lower.includes(w));
    if (medRiskFound.length > 0) {
        spamScore += medRiskFound.length * 5;
        if (medRiskFound.length > 2) issues.push(`Multiple promotional words: ${medRiskFound.slice(0, 3).join(', ')}`);
    }

    // Links
    const links = message.match(LINK_PATTERN) || [];
    if (links.length > 1) { spamScore += 20; issues.push('Multiple URLs in one message'); }
    if (links.length === 1) spamScore += 5;
    if (SHORT_URL_PATTERN.test(message)) { spamScore += 25; issues.push('Short URL detected — carriers distrust these'); }

    // Punctuation abuse
    const exclamationCount = (message.match(/!/g) || []).length;
    if (exclamationCount > 2) { spamScore += 10; issues.push(`${exclamationCount} exclamation marks`); }

    // ALL CAPS
    const allCapsWords = message.split(/\s+/).filter(w => w.length > 3 && w === w.toUpperCase() && /[A-Z]/.test(w));
    if (allCapsWords.length > 1) { spamScore += allCapsWords.length * 8; issues.push(`ALL CAPS words: ${allCapsWords.join(', ')}`); }

    // Very short messages with links (phishing signal)
    if (message.length < 30 && links.length > 0) { spamScore += 20; issues.push('Very short message with link — phishing signal'); }

    // Score to risk level
    const riskLevel = spamScore >= 50 ? 'high' : spamScore >= 25 ? 'medium' : 'low';
    const passed = spamScore < 40;

    if (!passed) {
        console.log(`[SpamScoreChecker] Score ${spamScore} (${riskLevel}): ${issues.join('; ')}`);
    }

    return {
        spamScore,
        riskLevel,
        passed,
        issues,
        recommendation: passed
            ? 'Good to send'
            : riskLevel === 'high'
                ? 'Do not send — rewrite required'
                : 'Review and reduce promotional language',
    };
}

// Suggest a cleaned version of the message
function suggest(message) {
    // Remove excessive punctuation
    let cleaned = message.replace(/!{2,}/g, '!').replace(/\?{2,}/g, '?');
    // Replace ALL CAPS words with title case
    cleaned = cleaned.replace(/\b([A-Z]{3,})\b/g, word =>
        word.charAt(0) + word.slice(1).toLowerCase()
    );
    return cleaned;
}

module.exports = { check, suggest };
