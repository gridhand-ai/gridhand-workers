const base = require('./base');
const sender = require('./twilio-sender');
const memoryModule = require('./memory');

// Outbound: send welcome message to a new customer
async function send({ client, customerNumber, customerName, serviceName }) {
    const biz = client.business;
    const settings = client.settings?.onboarding || {};
    const welcomeMessage = settings.customWelcome || null;

    const nameGreet = customerName ? `Welcome, ${customerName}` : `Welcome`;
    const serviceRef = serviceName ? ` for ${serviceName}` : '';

    const body = welcomeMessage
        ? welcomeMessage.replace('{name}', customerName || 'there').replace('{business}', biz.name)
        : `${nameGreet}! We're thrilled to have you at ${biz.name}${serviceRef}. 🎉 You can reach us anytime by replying to this message. We'll be in touch soon! — ${biz.name}`;

    await sender.sendSMS({
        from: client.twilioNumber,
        to: customerNumber,
        body,
        clientSlug: client.slug,
        clientApiKeys: client.apiKeys || {}
    });
}

// Inbound: guide new customer through onboarding steps
async function run({ client, message, customerNumber }) {
    const biz = client.business;
    const tone = base.getTone(client);
    const settings = client.settings?.onboarding || {};
    const onboardingSteps = settings.steps || [
        'Confirm their contact details',
        'Explain what to expect next',
        'Share key business info (hours, phone, website)',
        'Answer any initial questions'
    ];

    const history = await memoryModule.loadHistory(client.slug, customerNumber);

    const systemPrompt = `You are the onboarding assistant for ${biz.name}, a ${biz.industry} business. A new customer just joined and you're guiding them through getting started. ${tone}

<steps>
${onboardingSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
</steps>

<business>
Hours: ${biz.hours}
Phone: ${biz.phone}
Website: ${biz.website || 'N/A'}
Address: ${biz.address}
Services: ${biz.services?.map(s => s.name).join(', ') || 'N/A'}
</business>

<rules>
- Be warm and welcoming — this is their first impression.
- Cover one step at a time naturally in the conversation.
- Keep each reply to 2-3 sentences max.
- Answer any questions they have along the way.
- Once all steps are covered, let them know they're all set and to reach out anytime.
- Sign off as ${biz.name}.
</rules>

<history>
${history.map(h => `${h.role === 'user' ? 'Customer' : 'You'}: ${h.content}`).join('\n') || 'Just getting started!'}
</history>`;

    return base.run({
        client,
        message,
        customerNumber,
        workerName: 'Onboarding',
        systemPrompt,
        maxTokens: 200,
        skipHandoffs: true
    });
}

module.exports = { send, run };
