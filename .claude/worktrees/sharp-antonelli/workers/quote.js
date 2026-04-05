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
const base = require('./base');
const sender = require('./twilio-sender');

// Outbound: send a quote to a customer
async function send({ client, customerNumber, customerName, serviceName, quoteAmount, validUntil, quoteDetails }) {
    const biz = client.business;
    const nameGreet = customerName ? `Hi ${customerName}` : 'Hi there';
    const validPart = validUntil ? ` (valid until ${validUntil})` : '';
    const detailPart = quoteDetails ? ` — ${quoteDetails}` : '';

    const body = `${nameGreet}, here's your quote from ${biz.name}:\n\n${serviceName}: $${quoteAmount}${detailPart}${validPart}\n\nReady to move forward? Call ${biz.phone} or reply with any questions! — ${biz.name}`;

    await sender.sendSMS({
        from: client.twilioNumber,
        to: customerNumber,
        body,
        clientSlug: client.slug,
        clientApiKeys: client.apiKeys || {}
    });
}

// Inbound: handle quote questions and acceptance
async function run({ client, message, customerNumber }) {
    const biz = client.business;
    const tone = base.getTone(client);

    const systemPrompt = `You are a quoting assistant for ${biz.name}, a ${biz.industry} business.
You sent this customer a quote and they're replying with questions or interest.
${tone}
- Keep replies SHORT — 1-3 sentences max.
- If they accept or want to proceed: great! Direct them to call ${biz.phone} to finalize.
- If they want to negotiate: be professional, say you'll pass that along to the team.
- If they have questions about what's included: answer what you know from the services list.
- If they decline: thank them for considering ${biz.name} and let them know the door is open.
- Services & pricing:
${biz.services?.map(s => `  - ${s.name}: ${s.price}`).join('\n') || '  N/A'}
- Phone: ${biz.phone}
- Sign off as ${biz.name}.`;

    return base.run({ client, message, customerNumber, workerName: 'Quote', systemPrompt, maxTokens: 200 });
}

module.exports = { send, run };
