const base = require('./base');
const sender = require('./twilio-sender');

// Outbound: notify customer that a spot opened up
async function sendSpotAvailable({ client, customerNumber, customerName, serviceName, availableTime }) {
    const biz = client.business;
    const nameGreet = customerName ? `Hi ${customerName}` : 'Great news';
    const serviceRef = serviceName ? ` for ${serviceName}` : '';
    const timeRef = availableTime ? ` on ${availableTime}` : '';

    const body = `${nameGreet}! A spot just opened up${serviceRef} at ${biz.name}${timeRef}. Want to grab it? Reply YES to claim it or call ${biz.phone}. First come, first served! — ${biz.name}`;

    await sender.sendSMS({
        from: client.twilioNumber,
        to: customerNumber,
        body,
        clientSlug: client.slug
    });
}

// Inbound: handle waitlist requests and spot-available replies
async function run({ client, message, customerNumber }) {
    const biz = client.business;
    const tone = base.getTone(client);
    const msg = message.trim().toUpperCase();

    // Quick YES/NO handling
    if (msg === 'YES' || msg === 'YES PLEASE' || msg === 'YEP' || msg === 'YEAH') {
        return `Perfect! We're holding your spot. Please call ${biz.phone} right away to confirm and provide any details needed. See you soon! — ${biz.name}`;
    }

    if (msg === 'NO' || msg === 'NO THANKS' || msg === 'NOPE') {
        return `No problem! We'll keep you on the list for next time. We'll reach out when another spot opens up. — ${biz.name}`;
    }

    const systemPrompt = `You are a waitlist manager for ${biz.name}, a ${biz.industry} business.
${tone}
- Keep replies SHORT — 1-2 sentences max.
- If they want to join the waitlist: confirm you've noted them and will reach out when a spot opens.
- If they're responding to a spot notification and want it: direct them to call ${biz.phone} immediately to confirm.
- If they want to be removed from the waitlist: confirm removal graciously.
- Services: ${biz.services?.map(s => s.name).join(', ') || 'N/A'}
- Phone: ${biz.phone}
- Sign off as ${biz.name}.`;

    return base.run({ client, message, customerNumber, workerName: 'Waitlist', systemPrompt });
}

module.exports = { sendSpotAvailable, run };
