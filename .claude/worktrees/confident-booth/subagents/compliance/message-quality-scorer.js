// Message Quality Scorer — rates generated messages before sending, rewrites if needed
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Quick rule-based quality checks
function quickScore(message) {
    const issues = [];
    let score = 100;

    if (!message || message.trim().length === 0) return { score: 0, issues: ['Empty message'] };

    // Length checks
    if (message.length < 10) { score -= 30; issues.push('Too short to be useful'); }
    if (message.length > 300) { score -= 10; issues.push('Very long — consider shortening'); }

    // Tone checks
    if (/\b(you must|you need to|do it now|mandatory|required immediately)\b/i.test(message)) {
        score -= 20; issues.push('Aggressive/demanding tone');
    }
    if (message.toLowerCase().includes('as per') || message.toLowerCase().includes('kindly revert')) {
        score -= 10; issues.push('Overly formal/robotic phrasing');
    }

    // Clarity checks
    if (/\b(lorem|ipsum|placeholder|todo|tbd|xxx)\b/i.test(message)) {
        score -= 50; issues.push('Contains placeholder text');
    }

    // Completeness
    if (!message.includes('{') && message.split('?').length - 1 > 2) {
        score -= 10; issues.push('Too many questions in one message');
    }

    // Positive signals
    if (message.length >= 50 && message.length <= 200) score += 5;
    if (/[.!?]$/.test(message.trim())) score += 5;

    return { score: Math.max(0, Math.min(100, score)), issues };
}

async function score(message, context = '') {
    const quick = quickScore(message);

    // Only call Claude if quick score is borderline (40-80)
    if (quick.score < 40 || quick.score >= 80) {
        return {
            score: quick.score,
            grade: quick.score >= 80 ? 'A' : quick.score >= 60 ? 'B' : quick.score >= 40 ? 'C' : 'F',
            issues: quick.issues,
            recommendation: quick.score >= 80 ? 'Send as-is' : 'Review before sending',
            method: 'quick'
        };
    }

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 150,
            system: `You score SMS messages for customer service quality. Return ONLY valid JSON:
{
  "score": 0-100,
  "grade": "A|B|C|D|F",
  "issues": ["list of issues if any"],
  "recommendation": "send as-is|minor edits needed|rewrite recommended"
}
Score 90-100=excellent, 80-89=good, 70-79=acceptable, below 70=needs work.
Judge: clarity, tone, length (ideal 50-180 chars), professionalism, actionability.`,
            messages: [{ role: 'user', content: `Message: "${message}"\nContext: ${context || 'Business SMS reply'}` }]
        });

        const result = JSON.parse(response.content[0]?.text?.trim());
        return { ...result, method: 'claude' };
    } catch (e) {
        return { ...quick, grade: quick.score >= 70 ? 'B' : 'C', recommendation: 'Review before sending', method: 'fallback' };
    }
}

async function scoreAndImprove(message, context = '', threshold = 70) {
    const result = await score(message, context);

    if (result.score >= threshold) {
        return { original: message, improved: null, used: message, scoreResult: result };
    }

    // Rewrite if below threshold
    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            system: `Rewrite this SMS message to fix quality issues. Keep the same meaning. Return ONLY the improved message text, nothing else.
Issues to fix: ${result.issues.join(', ')}
Context: ${context || 'Business customer service SMS'}`,
            messages: [{ role: 'user', content: message }]
        });

        const improved = response.content[0]?.text?.trim();
        console.log(`[MessageQualityScorer] Improved message (score was ${result.score})`);
        return { original: message, improved, used: improved, scoreResult: result };
    } catch (e) {
        return { original: message, improved: null, used: message, scoreResult: result };
    }
}

module.exports = { score, scoreAndImprove, quickScore };
