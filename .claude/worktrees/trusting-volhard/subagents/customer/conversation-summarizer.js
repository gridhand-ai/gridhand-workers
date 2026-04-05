// Conversation Summarizer — condenses long conversations into bullet points
// Workers use this to get instant context without processing full history
const Anthropic = require('@anthropic-ai/sdk');
const store = require('../store');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getKey(clientSlug, customerNumber) {
    return `${clientSlug}_${customerNumber.replace(/[^0-9]/g, '')}`;
}

function getStoredSummary(clientSlug, customerNumber) {
    const key = getKey(clientSlug, customerNumber);
    return store.readJson('summaries', key);
}

async function summarize(conversationHistory, clientSlug, customerNumber, businessName) {
    if (!conversationHistory || conversationHistory.length < 4) {
        return null; // Not enough to summarize
    }

    const formatted = conversationHistory
        .map(h => `${h.role === 'user' ? 'Customer' : 'Business'}: ${h.content}`)
        .join('\n');

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            system: `You summarize SMS conversations between a business and customer. Return ONLY valid JSON:
{
  "customerName": "name if mentioned or null",
  "serviceInterest": "what service they're interested in or null",
  "status": "new|interested|booked|completed|upset|dormant",
  "keyFacts": ["bullet 1", "bullet 2", "bullet 3"],
  "openItems": ["anything unresolved or pending"],
  "sentiment": "positive|negative|neutral"
}
Be concise. keyFacts should be the 2-3 most important things to know about this customer.`,
            messages: [{
                role: 'user',
                content: `Business: ${businessName}\n\nConversation:\n${formatted}`
            }]
        });

        const summary = JSON.parse(response.content[0]?.text?.trim());
        summary.summarizedAt = new Date().toISOString();
        summary.messageCount = conversationHistory.length;

        // Store it
        const key = getKey(clientSlug, customerNumber);
        store.writeJson('summaries', key, summary);

        console.log(`[ConversationSummarizer] Summarized ${conversationHistory.length} messages for ${customerNumber}`);
        return summary;
    } catch (e) {
        console.log(`[ConversationSummarizer] Error: ${e.message}`);
        return null;
    }
}

// Get summary or generate one if it doesn't exist / is stale
async function getSummary(conversationHistory, clientSlug, customerNumber, businessName, maxAgeHours = 24) {
    const stored = getStoredSummary(clientSlug, customerNumber);

    if (stored) {
        const ageHours = (Date.now() - new Date(stored.summarizedAt).getTime()) / 3600000;
        const messageCountChanged = conversationHistory.length > (stored.messageCount || 0) + 4;

        if (ageHours < maxAgeHours && !messageCountChanged) {
            return stored; // Return cached
        }
    }

    return summarize(conversationHistory, clientSlug, customerNumber, businessName);
}

module.exports = { summarize, getSummary, getStoredSummary };
