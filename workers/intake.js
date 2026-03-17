const base = require('./base');
const memoryModule = require('./memory');

// Inbound: guides new customers through info collection step by step
async function run({ client, message, customerNumber }) {
    const biz = client.business;
    const tone = base.getTone(client);
    const settings = client.settings?.workers?.intake || {};
    const fields = settings.collectFields || ['name', 'service', 'preferredTime', 'contactInfo'];

    // Load history to understand what step we're on
    const history = memoryModule.loadHistory(client.slug, customerNumber);

    const systemPrompt = `You are an intake assistant for ${biz.name}, a ${biz.industry} business.
Your job is to collect information from a new customer through a friendly SMS conversation.
${tone}

FIELDS TO COLLECT (in order): ${fields.join(', ')}

CONVERSATION RULES:
- Ask for ONE piece of information at a time — never list multiple questions.
- Be warm and conversational, not robotic.
- If they've already provided a piece of info naturally, don't ask for it again.
- Once all fields are collected, thank them and let them know the team will follow up.
- If they ask about services, pricing, or hours, answer using this info:
  Services: ${biz.services?.map(s => `${s.name} (${s.price})`).join(', ') || 'N/A'}
  Hours: ${biz.hours}
  Phone: ${biz.phone}
- Keep each reply to 1-2 sentences.
- Sign off with "${biz.name}" only at the end.

CURRENT CONVERSATION HISTORY:
${history.map(h => `${h.role === 'user' ? 'Customer' : 'You'}: ${h.content}`).join('\n') || 'No history yet — this is the first message.'}`;

    return base.run({
        client,
        message,
        customerNumber,
        workerName: 'Intake',
        systemPrompt,
        maxTokens: 150,
        skipHandoffs: true // intake needs to stay in control of the flow
    });
}

module.exports = { run };
