const base       = require('./base');
const sender     = require('./twilio-sender');
const makeClient = require('../lib/make-client');

// Outbound: send re-engagement message to dormant customer
async function send({ client, customerNumber, customerName, lastServiceName, lastServiceDate }) {
    const biz = client.business;
    const settings = client.settings?.reactivation || {};
    const offerDiscount = settings.offerDiscount || false;
    const discountText = settings.discountText || '';

    const nameGreet = customerName ? `Hi ${customerName}` : 'Hey there';
    const serviceRef = lastServiceName ? ` since your last ${lastServiceName}` : '';
    const offerPart = offerDiscount && discountText ? ` As a thank-you for being a loyal customer, ${discountText}.` : '';

    const body = `${nameGreet}! It's been a while${serviceRef} at ${biz.name} — we'd love to see you again! 😊${offerPart} Ready to book? Reply BOOK or call ${biz.phone}. — ${biz.name}`;

    await sender.sendSMS({
        from: client.twilioNumber,
        to: customerNumber,
        body,
        clientSlug: client.slug,
        clientApiKeys: client.apiKeys || {}
    });

    // Fire Make.com: update CRM contact status, remove from dormant segment
    makeClient.reactivationSent({
        clientSlug:    client.slug,
        customerPhone: customerNumber,
        customerName:  customerName || null,
        daysDormant:   null,
        offerText:     settings.offerDiscount ? settings.discountText : null,
    }).catch(() => {});
}

// Inbound: handle replies to reactivation messages
async function run({ client, message, customerNumber }) {
    const biz = client.business;
    const tone = base.getTone(client);
    const settings = client.settings?.reactivation || {};

    const systemPrompt = `You are a re-engagement assistant for ${biz.name}, a ${biz.industry} business. You just sent this customer a message to bring them back after some time away. ${tone}

<services>
${biz.services?.map(s => `- ${s.name}: ${s.price}`).join('\n') || 'See our website for details'}
Phone: ${biz.phone}
Website: ${biz.website || 'N/A'}
</services>

<rules>
- Keep replies SHORT — 1-3 sentences max.
- If they want to book: direct them to call ${biz.phone} or visit ${biz.website || 'our website'}.
- If they're not interested: be gracious, let them know the door is always open.
- Never be pushy.
${settings.offerDiscount && settings.discountText ? `- If they ask about the offer: ${settings.discountText}` : ''}
- Sign off as ${biz.name}.
</rules>`;

    return base.run({ client, message, customerNumber, workerName: 'Reactivation', systemPrompt });
}

module.exports = { send, run };
