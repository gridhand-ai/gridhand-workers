// FAQ Extractor — reads conversations and auto-builds the FAQ list for each client
const aiClient = require('../../lib/ai-client');
const store = require('../store');

function getFAQs(clientSlug) {
    return store.readJson('extracted-faqs', clientSlug) || { faqs: [], updatedAt: null };
}

function saveFAQs(clientSlug, faqs) {
    store.writeJson('extracted-faqs', clientSlug, {
        faqs,
        updatedAt: new Date().toISOString(),
        count: faqs.length,
    });
}

// Check if a question is already in the FAQ list (fuzzy)
function isDuplicate(question, existingFaqs) {
    const qLower = question.toLowerCase();
    return existingFaqs.some(f => {
        const similarity = f.question.toLowerCase().split(' ')
            .filter(w => w.length > 3)
            .filter(w => qLower.includes(w)).length;
        return similarity >= 2;
    });
}

async function extractFromConversation(conversationHistory, clientSlug, businessName) {
    if (!conversationHistory || conversationHistory.length < 2) return null;

    const customerMessages = conversationHistory
        .filter(h => h.role === 'user')
        .map(h => h.content)
        .join('\n');

    // Only process if there are actual questions
    if (!customerMessages.includes('?') && !/\b(what|how|when|where|do you|can you)\b/i.test(customerMessages)) {
        return null;
    }

    try {
        const raw = await aiClient.call({
            modelString: 'claude-haiku-4-5-20251001',
            systemPrompt: `Extract real customer questions from this SMS conversation for ${businessName}. Return ONLY valid JSON:
{
  "questions": [
    { "question": "the customer's question rephrased cleanly", "category": "hours|pricing|services|booking|policy|other" }
  ]
}
Only extract genuine questions about the business. Ignore greetings and small talk. Max 3 questions per conversation.`,
            messages: [{ role: 'user', content: customerMessages }],
            maxTokens: 300,
        });

        const result = JSON.parse(raw);
        if (!result.questions?.length) return null;

        // Merge with existing FAQs
        const existing = getFAQs(clientSlug);
        const currentFaqs = existing.faqs || [];
        let added = 0;

        for (const q of result.questions) {
            if (!isDuplicate(q.question, currentFaqs)) {
                currentFaqs.push({
                    question: q.question,
                    category: q.category,
                    frequency: 1,
                    firstSeen: new Date().toISOString(),
                    lastSeen: new Date().toISOString(),
                    answered: false,
                });
                added++;
            } else {
                // Increment frequency for existing
                const match = currentFaqs.find(f => f.question.toLowerCase().includes(q.question.toLowerCase().split(' ')[1]));
                if (match) { match.frequency++; match.lastSeen = new Date().toISOString(); }
            }
        }

        // Sort by frequency
        currentFaqs.sort((a, b) => b.frequency - a.frequency);
        saveFAQs(clientSlug, currentFaqs.slice(0, 100)); // cap at 100

        if (added > 0) console.log(`[FAQExtractor] Added ${added} new questions for ${clientSlug} (total: ${currentFaqs.length})`);
        return { added, total: currentFaqs.length };
    } catch (e) {
        console.log(`[FAQExtractor] Error: ${e.message}`);
        return null;
    }
}

// Get top unanswered questions (for business owner review)
function getTopUnanswered(clientSlug, limit = 10) {
    const { faqs } = getFAQs(clientSlug);
    return (faqs || [])
        .filter(f => !f.answered)
        .sort((a, b) => b.frequency - a.frequency)
        .slice(0, limit);
}

// Mark a question as answered (add to official FAQ)
function markAnswered(clientSlug, questionIndex, answer) {
    const data = getFAQs(clientSlug);
    if (data.faqs[questionIndex]) {
        data.faqs[questionIndex].answered = true;
        data.faqs[questionIndex].answer = answer;
        saveFAQs(clientSlug, data.faqs);
    }
}

module.exports = { extractFromConversation, getFAQs, getTopUnanswered, markAnswered };
