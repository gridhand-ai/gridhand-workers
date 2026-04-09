const aiClient = require('../lib/ai-client');
const memoryModule = require('./memory');
const { emit, withRetry } = require('../lib/events');

const UPSET_TRIGGERS = [
    'speak to someone', 'talk to a person', 'real person', 'human', 'manager',
    'supervisor', 'cancel my', 'want a refund', 'lawsuit', 'attorney', 'complaint',
    'this is ridiculous', 'terrible service', 'horrible'
];

const QUESTION_PATTERN = /^(what|when|where|how|do you|are you|can you|is there|will you|does|who|why|which)/i;

function isLikelyQuestion(text) {
    return text.includes('?') || QUESTION_PATTERN.test(text.trim());
}

function isUpset(text) {
    const lower = text.toLowerCase();
    return UPSET_TRIGGERS.some(t => lower.includes(t));
}

function getTone(client) {
    const tone = client.settings?.global?.tone || 'friendly';
    const toneMap = {
        friendly:     'Be warm, casual, and friendly.',
        professional: 'Be professional and formal.',
        casual:       'Be relaxed and conversational.',
    };
    return toneMap[tone] || toneMap.friendly;
}

async function run({ client, message, customerNumber, workerName, systemPrompt, maxTokens = 150, skipHandoffs = false }) {
    const biz    = client.business;
    const global = client.settings?.global || {};
    const clientSlug = client.slug;

    await emit('task_started', { workerName, clientSlug, customerNumber });

    // Escalate if upset
    if (!skipHandoffs && global.escalateOnUpset && isUpset(message)) {
        await emit('task_completed', { workerName, clientSlug, customerNumber, summary: 'escalated_upset' });
        return `I understand your concern and want to make sure you're taken care of. Someone from the ${biz.name} team will reach out to you directly very shortly. We appreciate your patience.`;
    }

    // FAQ handoff if question detected
    if (!skipHandoffs && global.faqHandoff && isLikelyQuestion(message)) {
        const faq = require('./faq');
        return faq.run({ client, message, customerNumber });
    }

    // Load conversation history
    const history  = memoryModule.loadHistory(clientSlug, customerNumber);
    const messages = [
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: message },
    ];

    const modelString   = client.model || 'anthropic/claude-haiku-4-5-20251001';
    const clientApiKeys = client.apiKeys || {};
    const fallbackReply = `Thanks for reaching out to ${biz.name}! We'll get back to you shortly.`;

    const reply = await withRetry(
        async () => {
            const r = await aiClient.call({
                modelString,
                clientApiKeys,
                systemPrompt,
                messages,
                maxTokens,
                _workerName: workerName,
            });
            if (!r) throw new Error('Empty response from AI');
            return r;
        },
        { workerName, clientSlug, customerNumber, maxRetries: 2, fallbackReply }
    );

    if (reply && reply !== fallbackReply) {
        memoryModule.saveMessage(clientSlug, customerNumber, 'user', message);
        memoryModule.saveMessage(clientSlug, customerNumber, 'assistant', reply);
        await emit('task_completed', {
            workerName, clientSlug, customerNumber,
            summary: reply.slice(0, 60),
            provider: aiClient.getModelLabel(modelString),
        });
    }

    return reply || fallbackReply;
}

module.exports = { run, isLikelyQuestion, isUpset, getTone };
