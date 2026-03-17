const Anthropic = require('@anthropic-ai/sdk');
const memoryModule = require('./memory');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
        friendly: 'Be warm, casual, and friendly.',
        professional: 'Be professional and formal.',
        casual: 'Be relaxed and conversational.'
    };
    return toneMap[tone] || toneMap.friendly;
}

async function run({ client, message, customerNumber, workerName, systemPrompt, maxTokens = 150, skipHandoffs = false }) {
    const biz = client.business;
    const global = client.settings?.global || {};

    // Escalate if upset
    if (!skipHandoffs && global.escalateOnUpset && isUpset(message)) {
        console.log(`[${workerName}] Escalation triggered for ${customerNumber}`);
        const name = biz.name;
        return `I understand your concern and want to make sure you're taken care of. Someone from the ${name} team will reach out to you directly very shortly. We appreciate your patience.`;
    }

    // FAQ handoff if question detected
    if (!skipHandoffs && global.faqHandoff && isLikelyQuestion(message)) {
        const faq = require('./faq');
        return faq.run({ client, message, customerNumber });
    }

    // Load conversation history
    const history = memoryModule.loadHistory(client.slug, customerNumber);
    const messages = [
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: message }
    ];

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: maxTokens,
            system: systemPrompt,
            messages
        });

        const reply = response.content[0]?.text?.trim() || '';
        memoryModule.saveMessage(client.slug, customerNumber, 'user', message);
        memoryModule.saveMessage(client.slug, customerNumber, 'assistant', reply);
        console.log(`[${workerName}] Reply to ${customerNumber}: "${reply}"`);
        return reply;
    } catch (e) {
        console.log(`[${workerName}] Error: ${e.message}`);
        return `Thanks for reaching out to ${biz.name}! We'll get back to you shortly.`;
    }
}

module.exports = { run, isLikelyQuestion, isUpset, getTone };
