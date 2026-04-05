/**
 * GridHand AI — Proprietary Software
 * Copyright (c) 2026 GridHand AI. All rights reserved.
 *
 * This source code is the confidential and proprietary property of GridHand AI.
 * Unauthorized copying, modification, distribution, or use of this software,
 * via any medium, is strictly prohibited without express written permission.
 *
 * www.gridhand.ai
 */
const aiClient = require('../lib/ai-client');
const memoryModule = require('./memory');

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

    // Escalate if upset
    if (!skipHandoffs && global.escalateOnUpset && isUpset(message)) {
        console.log(`[${workerName}] Escalation triggered for ${customerNumber}`);
        return `I understand your concern and want to make sure you're taken care of. Someone from the ${biz.name} team will reach out to you directly very shortly. We appreciate your patience.`;
    }

    // FAQ handoff if question detected
    if (!skipHandoffs && global.faqHandoff && isLikelyQuestion(message)) {
        const faq = require('./faq');
        return faq.run({ client, message, customerNumber });
    }

    // Load conversation history
    const history  = memoryModule.loadHistory(client.slug, customerNumber);
    const messages = [
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: message },
    ];

    const modelString  = client.model || 'anthropic/claude-haiku-4-5-20251001';
    const clientApiKeys = client.apiKeys || {};

    try {
        const reply = await aiClient.call({
            modelString,
            clientApiKeys,
            systemPrompt,
            messages,
            maxTokens,
        });

        memoryModule.saveMessage(client.slug, customerNumber, 'user', message);
        memoryModule.saveMessage(client.slug, customerNumber, 'assistant', reply);
        console.log(`[${workerName}] (${aiClient.getModelLabel(modelString)}) → ${customerNumber}: "${reply.slice(0, 60)}..."`);
        return reply;
    } catch (e) {
        console.log(`[${workerName}] AI error: ${e.message}`);
        return `Thanks for reaching out to ${biz.name}! We'll get back to you shortly.`;
    }
}

module.exports = { run, isLikelyQuestion, isUpset, getTone };
