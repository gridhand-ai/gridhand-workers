const aiClient     = require('../lib/ai-client');
const memoryModule = require('./memory');

async function run({ client, message, customerNumber }) {
    const biz  = client.business;
    const tone = client.settings?.global?.tone || 'friendly';
    const toneInstruction = tone === 'professional'
        ? 'Be professional and formal.'
        : 'Be warm, friendly, and casual.';

    const systemPrompt = `You are an AI assistant for ${biz.name}, a ${biz.industry} business in ${biz.city}.

BUSINESS INFO:
- Name: ${biz.name}
- Address: ${biz.address}
- Phone: ${biz.phone}
- Hours: ${biz.hours}
- Website: ${biz.website || 'N/A'}

SERVICES & PRICING:
${biz.services.map(s => `- ${s.name}: ${s.price}`).join('\n')}

COMMON FAQs:
${biz.faqs.map(f => `Q: ${f.q}\nA: ${f.a}`).join('\n\n')}

INSTRUCTIONS:
- You are texting with a customer. Keep replies SHORT — 1-3 sentences max.
- ${toneInstruction}
- If you don't know the answer, say "Great question! Let me have someone from our team follow up with you shortly."
- Never make up prices or information not listed above.
- If they want to book an appointment, tell them to call ${biz.phone} or visit ${biz.website || 'our website'}.
- Sign off with "${biz.name}" when ending conversations.`;

    const history  = memoryModule.loadHistory(client.slug, customerNumber);
    const messages = [
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: message },
    ];

    const modelString   = client.model || 'anthropic/claude-haiku-4-5-20251001';
    const clientApiKeys = client.apiKeys || {};

    try {
        const reply = await aiClient.call({
            modelString,
            clientApiKeys,
            systemPrompt,
            messages,
            maxTokens: 150,
        });

        memoryModule.saveMessage(client.slug, customerNumber, 'user', message);
        memoryModule.saveMessage(client.slug, customerNumber, 'assistant', reply);
        console.log(`[FAQ] (${aiClient.getModelLabel(modelString)}) Reply to ${customerNumber}: "${reply.slice(0, 60)}..."`);
        return reply;
    } catch (e) {
        console.log(`[FAQ] AI error: ${e.message}`);
        return `Thanks for reaching out to ${biz.name}! We'll get back to you shortly.`;
    }
}

module.exports = { run };
