// Intent Classifier — figures out exactly what the customer wants
// Returns: intent, confidence, suggestedWorker, extractedData
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Fast keyword routing before hitting Claude
const INTENT_PATTERNS = {
    book:        /\b(book|schedule|appoint|slot|come in|set up|reserve)\b/i,
    cancel:      /\b(cancel|cancell|stop|end|terminate|no longer)\b/i,
    reschedule:  /\b(reschedule|move|change my appoint|different time|another time)\b/i,
    pay:         /\b(pay|payment|invoice|bill|owe|charge|cost)\b/i,
    complain:    /\b(complain|complaint|unhappy|dissatisfied|problem|issue|wrong|bad)\b/i,
    quote:       /\b(quote|price|how much|cost|rate|estimate|pricing)\b/i,
    hours:       /\b(hours|open|close|when are you|what time)\b/i,
    location:    /\b(address|where are|location|directions|how to get)\b/i,
    optout:      /^(stop|unsubscribe|cancel|quit|end|optout|opt out|remove me)$/i,
    confirm:     /^(yes|yeah|yep|confirm|c|ok|okay|sure|absolutely)$/i,
    waitlist:    /\b(waitlist|wait list|wait|next available|opening)\b/i,
    referral:    /\b(refer|referral|friend|family|someone I know|recommend)\b/i,
    review:      /\b(review|google|yelp|rating|left a review|wrote)\b/i,
};

const INTENT_TO_WORKER = {
    book:       'booking',
    cancel:     'receptionist',
    reschedule: 'booking',
    pay:        'invoice-chaser',
    complain:   'receptionist',
    quote:      'quote',
    hours:      'faq',
    location:   'faq',
    optout:     'optout-manager',
    confirm:    'reminder',
    waitlist:   'waitlist',
    referral:   'referral',
    review:     'review-requester',
    general:    'receptionist',
};

function quickClassify(message) {
    for (const [intent, pattern] of Object.entries(INTENT_PATTERNS)) {
        if (pattern.test(message)) {
            return { intent, confidence: 0.8, suggestedWorker: INTENT_TO_WORKER[intent] || 'receptionist' };
        }
    }
    return null;
}

async function classify(message, availableWorkers = [], conversationHistory = []) {
    // Try keyword match first
    const quick = quickClassify(message);
    if (quick && quick.confidence >= 0.8) {
        // Make sure suggested worker is available for this client
        if (!availableWorkers.length || availableWorkers.includes(quick.suggestedWorker)) {
            console.log(`[IntentClassifier] Quick match: "${message.slice(0, 30)}..." → ${quick.intent}`);
            return { ...quick, extractedData: {}, method: 'keyword' };
        }
    }

    const workersContext = availableWorkers.length
        ? `Available workers: ${availableWorkers.join(', ')}`
        : 'Workers: receptionist, faq, booking, intake, waitlist, invoice-chaser, quote, reminder';

    const historyContext = conversationHistory.length
        ? `\nConversation history:\n${conversationHistory.slice(-3).map(h => `${h.role}: ${h.content}`).join('\n')}`
        : '';

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            system: `You are an intent classification engine for SMS customer service. Classify the customer's intent and return ONLY valid JSON:
{
  "intent": "book|cancel|reschedule|pay|complain|quote|hours|location|optout|confirm|waitlist|referral|review|general",
  "confidence": 0.0-1.0,
  "suggestedWorker": "the best worker name from the available list",
  "extractedData": { any useful data extracted from message like date, time, service name, etc }
}
${workersContext}`,
            messages: [{
                role: 'user',
                content: `Customer message: "${message}"${historyContext}`
            }]
        });

        const raw = response.content[0]?.text?.trim();
        const result = JSON.parse(raw);
        result.method = 'claude';
        console.log(`[IntentClassifier] "${message.slice(0, 30)}..." → ${result.intent} (${Math.round(result.confidence * 100)}%)`);
        return result;
    } catch (e) {
        console.log(`[IntentClassifier] Fallback: ${e.message}`);
        return {
            intent: 'general',
            confidence: 0.3,
            suggestedWorker: 'receptionist',
            extractedData: {},
            method: 'fallback'
        };
    }
}

module.exports = { classify };
