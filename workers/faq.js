const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function run({ client, message, customerNumber }) {
    const biz = client.business;

    const systemPrompt = `You are an AI assistant for ${biz.name}, a ${biz.industry} business in ${biz.city}.

BUSINESS INFO:
- Name: ${biz.name}
- Address: ${biz.address}
- Phone: ${biz.phone}
- Hours: ${biz.hours}
- Website: ${biz.website || 'N/A'}

SERVICES & PRICING:
${biz.services.map(s => `- ${s.name}: ${s.price}`).join('\n')}

COMMON FAQs:
${biz.faqs.map(f => `Q: ${f.q}\nA: ${f.a}`).join('\n\n')}

INSTRUCTIONS:
- You are texting with a customer. Keep replies SHORT — 1-3 sentences max.
- Be friendly, professional, and helpful.
- If you don't know the answer, say "Great question! Let me have someone from our team follow up with you shortly."
- Never make up prices or information not listed above.
- If they want to book an appointment, tell them to call ${biz.phone} or visit ${biz.website || 'our website'}.
- Sign off with "${biz.name}" when ending conversations.`;

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 150,
            system: systemPrompt,
            messages: [{ role: 'user', content: message }]
        });

        const reply = response.content[0]?.text?.trim() || '';
        console.log(`[FAQ] Reply to ${customerNumber}: "${reply}"`);
        return reply;
    } catch (e) {
        console.log(`[FAQ] Claude error: ${e.message}`);
        return `Thanks for reaching out to ${biz.name}! We'll get back to you shortly.`;
    }
}

module.exports = { run };
