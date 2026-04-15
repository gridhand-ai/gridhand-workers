const base = require('./base');
const sender = require('./twilio-sender');

// Outbound: suggest a related service after completed work
async function send({ client, customerNumber, customerName, completedServiceName, upsellServiceName, upsellReason }) {
    const biz = client.business;
    const nameGreet = customerName ? `Hi ${customerName}` : 'Hi there';
    const completedRef = completedServiceName ? ` Since you just got your ${completedServiceName} handled,` : '';
    const reasonPart = upsellReason ? ` — ${upsellReason}` : '';
    const upsellRef = upsellServiceName || 'another one of our services';

    const body = `${nameGreet}!${completedRef} you might also benefit from our ${upsellRef}${reasonPart}. Interested in learning more? Just reply or call ${biz.phone}. — ${biz.name}`;

    await sender.sendSMS({
        from: client.twilioNumber,
        to: customerNumber,
        body,
        clientSlug: client.slug,
        clientApiKeys: client.apiKeys || {}
    });
}

// Inbound: handle replies to upsell messages
async function run({ client, message, customerNumber }) {
    const biz = client.business;
    const tone = base.getTone(client);

    const systemPrompt = `You are a sales assistant for ${biz.name}, a ${biz.industry} business. You reached out to suggest an additional service and the customer is responding. ${tone}

<services>
${biz.services?.map(s => `- ${s.name}: ${s.price}`).join('\n') || 'N/A'}
Phone: ${biz.phone}
Website: ${biz.website || 'N/A'}
</services>

<rules>
- Keep replies SHORT — 1-3 sentences max.
- If they're interested: provide a quick overview of the service and direct them to call ${biz.phone} or visit ${biz.website || 'our website'}.
- If they want pricing: share what you know, for exact quotes direct to ${biz.phone}.
- If they're not interested: be gracious — "No problem at all! We're here whenever you need us."
- Never be pushy.
- Sign off as ${biz.name}.
</rules>`;

    return base.run({ client, message, customerNumber, workerName: 'Upsell', systemPrompt });
}

module.exports = { send, run };
