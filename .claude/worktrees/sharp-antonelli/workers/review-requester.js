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

// Outbound: send a review request to a customer after service completion
async function send({ client, customerNumber, customerName, serviceName }) {
    const biz = client.business;
    const settings = client.settings?.['review-requester'] || {};
    const reviewLink = settings.reviewLink || biz.website || '';
    const tone = base.getTone(client);

    const nameGreet = customerName ? `Hi ${customerName}` : 'Hi there';
    const serviceRef = serviceName ? ` for your ${serviceName}` : '';
    const linkPart = reviewLink ? ` ${reviewLink}` : '';

    const body = `${nameGreet}! Thank you for choosing ${biz.name}${serviceRef}. We hope everything went great! Would you mind leaving us a quick review?${linkPart} It really helps our small business. 🙏 — ${biz.name}`;

    await sender.sendSMS({
        from: client.twilioNumber,
        to: customerNumber,
        body,
        clientSlug: client.slug,
        clientApiKeys: client.apiKeys || {}
    });
}

// Inbound: handle customer replies to a review request
async function run({ client, message, customerNumber }) {
    const biz = client.business;
    const settings = client.settings?.['review-requester'] || {};
    const tone = base.getTone(client);
    const reviewLink = settings.reviewLink || biz.website || '';

    const systemPrompt = `You are a friendly assistant for ${biz.name}, a ${biz.industry} business.
You just sent this customer a request to leave a Google review.
${tone}
- Keep replies SHORT — 1-2 sentences max.
- If they say they left a review or will leave one: thank them warmly.
- If they say they won't or ask why: be understanding, never push.
- If they have a service question: answer helpfully using this info:
  Hours: ${biz.hours} | Phone: ${biz.phone} | Website: ${biz.website || 'N/A'}
- Review link (if needed): ${reviewLink}
- Sign off as ${biz.name}.`;

    return base.run({ client, message, customerNumber, workerName: 'ReviewRequester', systemPrompt });
}

module.exports = { send, run };
