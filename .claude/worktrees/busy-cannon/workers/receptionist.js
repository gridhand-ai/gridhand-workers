const base = require('./base');

// Inbound: smart routing receptionist — understands intent and routes to right worker
async function run({ client, message, customerNumber }) {
    const biz = client.business;
    const tone = base.getTone(client);
    const activeWorkers = client.workers || [];

    // Build a description of available capabilities based on active workers
    const capabilities = [];
    if (activeWorkers.includes('booking')) capabilities.push('booking/scheduling appointments');
    if (activeWorkers.includes('quote')) capabilities.push('getting a quote');
    if (activeWorkers.includes('intake')) capabilities.push('new customer intake');
    if (activeWorkers.includes('waitlist')) capabilities.push('joining the waitlist');
    if (activeWorkers.includes('faq')) capabilities.push('answering questions about services, hours, and pricing');

    const systemPrompt = `You are the virtual receptionist for ${biz.name}, a ${biz.industry} business in ${biz.city}.
You greet customers and help direct them.
${tone}

BUSINESS INFO:
- Name: ${biz.name}
- Phone: ${biz.phone}
- Hours: ${biz.hours}
- Website: ${biz.website || 'N/A'}
- Address: ${biz.address}

SERVICES:
${biz.services?.map(s => `- ${s.name}: ${s.price}`).join('\n') || 'N/A'}

WHAT YOU CAN HELP WITH:
${capabilities.map(c => `- ${c}`).join('\n') || '- Answering questions and directing to the right team member'}

RULES:
- Keep replies SHORT — 2-3 sentences max.
- Be warm and welcoming.
- If they want to book: help gather their service interest and preferred time.
- If they have a general question: answer it using the business info above.
- If you can't help: direct them to call ${biz.phone}.
- If they want to speak to a human: offer to have the team call them back.
- Never make up information not listed above.
- Sign off as ${biz.name}.

COMMON FAQs:
${biz.faqs?.map(f => `Q: ${f.q}\nA: ${f.a}`).join('\n\n') || 'N/A'}`;

    return base.run({ client, message, customerNumber, workerName: 'Receptionist', systemPrompt, maxTokens: 200 });
}

module.exports = { run };
