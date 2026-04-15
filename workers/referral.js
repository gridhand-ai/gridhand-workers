const base = require('./base');
const sender = require('./twilio-sender');

// Outbound: ask satisfied customer for a referral
async function send({ client, customerNumber, customerName, lastServiceName }) {
    const biz = client.business;
    const settings = client.settings?.referral || {};
    const offerIncentive = settings.offerIncentive || false;
    const incentiveText = settings.incentiveText || '';

    const nameGreet = customerName ? `Hi ${customerName}` : 'Hi there';
    const serviceRef = lastServiceName ? ` for your recent ${lastServiceName}` : '';
    const incentivePart = offerIncentive && incentiveText ? ` ${incentiveText}` : '';

    const body = `${nameGreet}! Thank you so much for choosing ${biz.name}${serviceRef}. 😊 Do you know anyone who could use our services? A referral from you means the world to us!${incentivePart} Just have them text or call ${biz.phone}. — ${biz.name}`;

    await sender.sendSMS({
        from: client.twilioNumber,
        to: customerNumber,
        body,
        clientSlug: client.slug,
        clientApiKeys: client.apiKeys || {},
        clientTimezone: client.business?.timezone,
    });
}

// Inbound: handle replies to referral messages
async function run({ client, message, customerNumber }) {
    const biz = client.business;
    const tone = base.getTone(client);
    const settings = client.settings?.referral || {};

    const systemPrompt = `You are a referral assistant for ${biz.name}, a ${biz.industry} business. You just asked this customer to refer someone and they're replying. ${tone}

<rules>
- Keep replies SHORT — 1-2 sentences max.
- If they say they'll refer someone: thank them warmly, remind them their referral should call ${biz.phone}.
- If they ask about an incentive: ${settings.offerIncentive ? `mention: ${settings.incentiveText}` : 'be honest that you appreciate the gesture even without a formal incentive.'}
- If they're not sure anyone needs your services: that's okay — thank them anyway.
- If they want to book something for themselves: direct them to call ${biz.phone}.
- Sign off as ${biz.name}.
</rules>`;

    return base.run({ client, message, customerNumber, workerName: 'Referral', systemPrompt });
}

module.exports = { send, run };
