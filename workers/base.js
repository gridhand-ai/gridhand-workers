const { createClient }  = require('@supabase/supabase-js');
const aiClient          = require('../lib/ai-client');
const memoryModule      = require('./memory');
const { emit, withRetry, sendTelegramAlert } = require('../lib/events');
const taskCounter       = require('../lib/task-counter');
const clientIntel       = require('../lib/client-intel');
const { stateMachine }  = require('../lib/worker-state');
const industryLearnings = require('../lib/industry-learnings');
const clientPrefs       = require('../lib/client-prefs');
const makeClient        = require('../lib/make-client');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Search the client's knowledge base for relevant entries when a question is detected.
// Injects a <knowledge> block into the system prompt — always non-fatal (try/catch).
async function searchKnowledge(supabaseClientId, query) {
    if (!supabaseClientId) return '';
    try {
        const { data } = await supabase.rpc('search_client_knowledge', {
            client_id: supabaseClientId,
            query,
            limit: 3,
        });
        if (!data?.length) return '';
        const entries = data.map(r => `${r.title}: ${r.content}`).join('\n\n');
        return `\n\n<knowledge>\n${entries}\n</knowledge>`;
    } catch {
        return '';
    }
}

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

    // ─── Task limit check ─────────────────────────────────────────────────────
    const taskCheck = await taskCounter.checkAndCount({ client, workerName, customerNumber });

    if (!taskCheck.allowed) {
        await emit('task_blocked', {
            workerName, clientSlug, customerNumber,
            summary: `Limit reached: ${taskCheck.count}/${taskCheck.limit} tasks (${taskCheck.tier} tier)`,
        });

        // Alert MJ via Telegram (non-blocking)
        sendTelegramAlert([
            `*Task Limit Hit* 🔒`,
            `Client: \`${clientSlug}\``,
            `Tier: ${taskCheck.tier} | Used: ${taskCheck.count}/${taskCheck.limit}`,
            `Worker: ${workerName}`,
            `Customer: ${customerNumber || 'outbound'}`,
        ].join('\n')).catch(() => {});

        return `Thanks for reaching out to ${biz.name}! We'll get back to you soon.`;
    }

    if (taskCheck.isNewTask) {
        stateMachine.start(workerName, clientSlug, customerNumber);
        await emit('task_started', { workerName, clientSlug, customerNumber,
            summary: `Task ${taskCheck.count}/${taskCheck.limit === Infinity ? '∞' : taskCheck.limit} (${taskCheck.tier})`,
        });
    }

    // Escalate if upset
    if (!skipHandoffs && global.escalateOnUpset && isUpset(message)) {
        clientIntel.recordTask(clientSlug, { workerName, wasUpset: true });
        await emit('task_completed', { workerName, clientSlug, customerNumber, summary: 'escalated_upset' });
        return `I understand your concern and want to make sure you're taken care of. Someone from the ${biz.name} team will reach out to you directly very shortly. We appreciate your patience.`;
    }

    // FAQ handoff if question detected
    if (!skipHandoffs && global.faqHandoff && isLikelyQuestion(message)) {
        const faq = require('./faq');
        return faq.run({ client, message, customerNumber });
    }

    // Load conversation history
    const history  = await memoryModule.loadHistory(clientSlug, customerNumber);
    const messages = [
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: message },
    ];

    const modelString   = client.model || 'anthropic/claude-haiku-4-5-20251001';
    const clientApiKeys = client.apiKeys || {};
    const fallbackReply = `Thanks for reaching out to ${biz.name}! We'll get back to you shortly.`;

    // Enrich system prompt with industry learnings, client prefs, and knowledge base.
    // All fetched in parallel. Knowledge search fires only on question-type messages.
    const [industryCtx, prefsCtx, knowledgeCtx] = await Promise.all([
        industryLearnings.get(biz.industry),
        clientPrefs.get(client.clientId, global.tone),
        isLikelyQuestion(message) ? searchKnowledge(client.supabaseClientId, message) : Promise.resolve(''),
    ]);
    const enrichedPrompt = systemPrompt + industryCtx + prefsCtx + knowledgeCtx;

    const reply = await withRetry(
        async () => {
            const r = await aiClient.call({
                modelString,
                clientApiKeys,
                systemPrompt: enrichedPrompt,
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
        await memoryModule.saveMessage(clientSlug, customerNumber, 'user', message);
        await memoryModule.saveMessage(clientSlug, customerNumber, 'assistant', reply);
        clientIntel.recordTask(clientSlug, { workerName, wasUpset: isUpset(message) });
        stateMachine.complete(workerName, clientSlug);
        await emit('task_completed', {
            workerName, clientSlug, customerNumber,
            summary: reply.slice(0, 60),
            provider: aiClient.getModelLabel(modelString),
        });

        // Fire Make.com integration webhook (non-blocking — never fails a worker)
        // Workers that need richer structured data call makeClient directly in their handle()
        // This generic event lets Make.com log every interaction and trigger any automation
        makeClient.fire('task_completed', clientSlug, workerName, {
            customer: { phone: customerNumber },
            data:     { summary: reply.slice(0, 120) },
        }).catch(() => {});
    } else {
        stateMachine.escalate(workerName, clientSlug);
    }

    return reply || fallbackReply;
}

module.exports = { run, isLikelyQuestion, isUpset, getTone };
