// Sentiment Analyzer — reads customer tone before worker responds
// Returns: tone, urgency, emotion, readyToBuy, escalate
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Fast keyword-based pre-check before hitting Claude
const ANGER_WORDS = ['angry', 'furious', 'pissed', 'disgusted', 'hate', 'terrible', 'horrible', 'worst', 'ridiculous', 'lawsuit', 'refund', 'scam', 'fraud'];
const URGENT_WORDS = ['urgent', 'asap', 'emergency', 'right now', 'immediately', 'today', 'tonight', 'critical', 'must'];
const BUY_WORDS = ['book', 'schedule', 'sign up', 'ready', 'yes', 'interested', 'how much', 'price', 'cost', 'when can', 'available'];

function quickCheck(message) {
    const lower = message.toLowerCase();
    return {
        likelyAngry: ANGER_WORDS.some(w => lower.includes(w)),
        likelyUrgent: URGENT_WORDS.some(w => lower.includes(w)),
        likelyBuying: BUY_WORDS.some(w => lower.includes(w))
    };
}

async function analyze(message, conversationHistory = []) {
    // Quick check first — save API call if obvious
    const quick = quickCheck(message);

    const historyContext = conversationHistory.length > 0
        ? `\nPrevious messages:\n${conversationHistory.slice(-4).map(h => `${h.role}: ${h.content}`).join('\n')}`
        : '';

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 150,
            system: `You are a sentiment analysis engine for SMS customer service. Analyze the customer message and return ONLY valid JSON with these exact fields:
{
  "tone": "positive|negative|neutral",
  "urgency": "high|medium|low",
  "emotion": "happy|angry|confused|anxious|grateful|frustrated|neutral",
  "readyToBuy": true|false,
  "escalate": true|false,
  "confidence": 0.0-1.0
}
escalate=true means the customer needs a human. Be concise and accurate.`,
            messages: [{
                role: 'user',
                content: `Customer message: "${message}"${historyContext}`
            }]
        });

        const raw = response.content[0]?.text?.trim();
        const result = JSON.parse(raw);
        console.log(`[SentimentAnalyzer] "${message.slice(0, 40)}..." → ${result.tone}/${result.emotion} urgency:${result.urgency}`);
        return result;
    } catch (e) {
        // Fallback to quick check
        console.log(`[SentimentAnalyzer] Fallback to quick check: ${e.message}`);
        return {
            tone: quick.likelyAngry ? 'negative' : 'neutral',
            urgency: quick.likelyUrgent ? 'high' : 'low',
            emotion: quick.likelyAngry ? 'angry' : 'neutral',
            readyToBuy: quick.likelyBuying,
            escalate: quick.likelyAngry,
            confidence: 0.5
        };
    }
}

module.exports = { analyze };
