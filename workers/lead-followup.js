const base       = require('./base');
const sender     = require('./twilio-sender');
const makeClient = require('../lib/make-client');

// Outbound: follow up with a new lead
async function send({ client, customerNumber, customerName, inquiryAbout, followUpNumber = 1 }) {
    const biz = client.business;
    const nameGreet = customerName ? `Hi ${customerName}` : 'Hi there';
    const serviceRef = inquiryAbout ? ` about ${inquiryAbout}` : '';

    let body;
    if (followUpNumber === 1) {
        body = `${nameGreet}! This is ${biz.name} following up on your recent inquiry${serviceRef}. Do you have any questions we can answer? We'd love to help! — ${biz.name}`;
    } else {
        body = `${nameGreet}, just checking in one more time from ${biz.name}. We're here when you're ready — no pressure! Call us at ${biz.phone} anytime. — ${biz.name}`;
    }

    await sender.sendSMS({
        from: client.twilioNumber,
        to: customerNumber,
        body,
        clientSlug: client.slug,
        clientApiKeys: client.apiKeys || {},
        clientTimezone: client.business?.timezone,
    });

    // Fire Make.com: update lead status in CRM, trigger next step in nurture sequence
    makeClient.leadFollowupSent({
        clientSlug:    client.slug,
        customerPhone: customerNumber,
        customerName:  customerName || null,
        followupNumber: followUpNumber,
        source:        inquiryAbout || null,
    }).catch(() => {});
}

// Inbound: handle lead replies
async function run({ client, message, customerNumber }) {
    const biz = client.business;
    const tone = base.getTone(client);

    const systemPrompt = `You are a lead follow-up assistant for ${biz.name}, a ${biz.industry} business. This person showed interest in ${biz.name} and you're following up. ${tone}

<services>
${biz.services?.map(s => `- ${s.name}: ${s.price}`).join('\n') || 'N/A'}
Hours: ${biz.hours}
Phone: ${biz.phone}
Website: ${biz.website || 'N/A'}
</services>

<faqs>
${biz.faqs?.map(f => `Q: ${f.q}\nA: ${f.a}`).join('\n\n') || 'N/A'}
</faqs>

<rules>
- Keep replies SHORT — 1-3 sentences max.
- Goal: answer their questions and move them toward booking/calling.
- To book or get a quote: call ${biz.phone} or visit ${biz.website || 'our website'}.
- Never be pushy — be helpful and let them lead.
- Sign off as ${biz.name}.
</rules>`;

    return base.run({ client, message, customerNumber, workerName: 'LeadFollowup', systemPrompt, maxTokens: 200 });
}

module.exports = { send, run };
