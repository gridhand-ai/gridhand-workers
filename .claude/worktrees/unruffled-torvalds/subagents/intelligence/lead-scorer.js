// Lead Scorer — rates how likely a new lead is to convert (1-100)
const Anthropic = require('@anthropic-ai/sdk');
const store = require('../store');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Scoring signals
function getBaseScore(message, conversationHistory) {
    let score = 50; // start neutral
    const lower = message.toLowerCase();
    const historyLen = conversationHistory.length;

    // Positive signals
    if (/\b(ready|interested|yes|book|schedule|when can|how soon|asap)\b/i.test(lower)) score += 20;
    if (/\b(how much|price|cost|quote)\b/i.test(lower)) score += 10;
    if (/\b(my (business|company|family|home))\b/i.test(lower)) score += 10;
    if (historyLen >= 4) score += 10; // engaged in conversation
    if (historyLen >= 8) score += 10; // very engaged

    // Negative signals
    if (/\b(just looking|not sure|maybe|might|someday|eventually)\b/i.test(lower)) score -= 15;
    if (/\b(too expensive|can't afford|no thanks|not interested)\b/i.test(lower)) score -= 30;
    if (historyLen === 0) score -= 5; // brand new, unknown

    return Math.min(100, Math.max(1, score));
}

async function score(message, conversationHistory = [], clientSlug = null, customerNumber = null) {
    const baseScore = getBaseScore(message, conversationHistory);

    const historyContext = conversationHistory.length
        ? conversationHistory.slice(-6).map(h => `${h.role}: ${h.content}`).join('\n')
        : 'No prior history.';

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 150,
            system: `You are a sales lead scoring engine. Score the lead 1-100 and return ONLY valid JSON:
{
  "score": 1-100,
  "tier": "hot|warm|cold",
  "reason": "one sentence why",
  "nextBestAction": "what the worker should do next"
}
Scoring guide: 80-100 = hot (ready to buy), 50-79 = warm (interested, nurturing needed), 1-49 = cold (browsing or not ready).`,
            messages: [{
                role: 'user',
                content: `Latest message: "${message}"\n\nConversation:\n${historyContext}\n\nBase score hint: ${baseScore}`
            }]
        });

        const result = JSON.parse(response.content[0]?.text?.trim());

        // Save score to profile
        if (clientSlug && customerNumber) {
            const key = `${clientSlug}_${customerNumber.replace(/[^0-9]/g, '')}`;
            const existing = store.readJson('lead-scores', key) || {};
            store.writeJson('lead-scores', key, {
                ...existing,
                lastScore: result.score,
                lastTier: result.tier,
                lastScoredAt: new Date().toISOString(),
                scoreHistory: [...(existing.scoreHistory || []), { score: result.score, ts: Date.now() }].slice(-20)
            });
        }

        console.log(`[LeadScorer] Score: ${result.score}/100 (${result.tier}) — ${result.reason}`);
        return result;
    } catch (e) {
        console.log(`[LeadScorer] Fallback: ${e.message}`);
        const tier = baseScore >= 75 ? 'hot' : baseScore >= 50 ? 'warm' : 'cold';
        return { score: baseScore, tier, reason: 'Scored by keyword signals', nextBestAction: 'Follow up promptly' };
    }
}

function getStoredScore(clientSlug, customerNumber) {
    const key = `${clientSlug}_${customerNumber.replace(/[^0-9]/g, '')}`;
    return store.readJson('lead-scores', key);
}

module.exports = { score, getStoredScore };
