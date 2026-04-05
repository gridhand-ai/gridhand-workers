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

// Outbound: send appointment reminder
async function send({ client, customerNumber, customerName, appointmentTime, serviceName, reminderType = '24hr' }) {
    const biz = client.business;
    const settings = client.settings?.reminder || {};
    const includeAddress = settings.includeAddress !== false;
    const includeCancellation = settings.includeCancellationInfo !== false;

    const nameGreet = customerName ? `Hi ${customerName}` : 'Hi there';
    const serviceRef = serviceName ? ` for ${serviceName}` : '';
    const timeLabel = reminderType === '1hr' ? 'in about 1 hour' : 'tomorrow';
    const addressPart = includeAddress && biz.address ? ` at ${biz.address}` : '';
    const cancelPart = includeCancellation ? ` Reply C to confirm or call ${biz.phone} to reschedule.` : ` Reply C to confirm.`;

    const body = `${nameGreet}, reminder: your appointment${serviceRef} with ${biz.name} is ${timeLabel} (${appointmentTime})${addressPart}.${cancelPart} — ${biz.name}`;

    await sender.sendSMS({
        from: client.twilioNumber,
        to: customerNumber,
        body,
        clientSlug: client.slug,
        clientApiKeys: client.apiKeys || {}
    });
}

// Inbound: handle replies to reminders (C = confirm, R = reschedule, questions)
async function run({ client, message, customerNumber }) {
    const biz = client.business;
    const tone = base.getTone(client);
    const msg = message.trim().toUpperCase();

    // Simple keyword handling
    if (msg === 'C' || msg === 'CONFIRM' || msg === 'YES') {
        return `Great, you're confirmed! We'll see you soon at ${biz.name}. See you there! 👋`;
    }

    if (msg === 'R' || msg === 'RESCHEDULE') {
        return `No problem! Please call us at ${biz.phone} or visit ${biz.website || 'our website'} to reschedule. We'll find a time that works for you. — ${biz.name}`;
    }

    const systemPrompt = `You are an appointment assistant for ${biz.name}, a ${biz.industry} business.
You sent this customer an appointment reminder and they're replying.
${tone}
- Keep replies SHORT — 1-2 sentences max.
- If they want to confirm: confirm happily.
- If they want to reschedule: direct them to call ${biz.phone}.
- If they want to cancel: be understanding, ask them to call ${biz.phone} to cancel officially.
- Hours: ${biz.hours} | Address: ${biz.address}
- Sign off as ${biz.name}.`;

    return base.run({ client, message, customerNumber, workerName: 'Reminder', systemPrompt });
}

module.exports = { send, run };
