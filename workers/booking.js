const base = require('./base');
const memoryModule = require('./memory');
const profileContext = require('./profile-context');

// Inbound: help a customer book an appointment
async function run({ client, message, customerNumber }) {
    const biz = client.business;
    const tone = base.getTone(client);
    const settings = client.settings?.booking || {};
    const bookingMethod = settings.bookingMethod || 'phone'; // 'phone', 'website', 'both'
    const bookingLink = settings.bookingLink || biz.website || '';

    const [history, customerBlock] = await Promise.all([
        memoryModule.loadHistory(client.slug, customerNumber),
        profileContext.buildPromptBlock(client.slug, customerNumber),
    ]);

    let bookingInstruction;
    if (bookingMethod === 'website' && bookingLink) {
        bookingInstruction = `To complete the booking, direct them to: ${bookingLink}`;
    } else if (bookingMethod === 'both') {
        bookingInstruction = `To complete the booking: call ${biz.phone} or visit ${bookingLink || biz.website || 'our website'}`;
    } else {
        bookingInstruction = `To complete the booking, they need to call ${biz.phone}`;
    }

    const systemPrompt = `You are a booking assistant for ${biz.name}, a ${biz.industry} business. Your job is to help this customer book an appointment via SMS. ${tone}

<steps>
1. Find out what service they want.
2. Find out their preferred date and time.
3. Note any special requests or details.
4. ${bookingInstruction} — let them know this is the final step.
</steps>

<services>
${biz.services?.map(s => `- ${s.name}: ${s.price}`).join('\n') || 'N/A'}
Hours: ${biz.hours}
</services>

<rules>
- Ask ONE question at a time.
- Keep replies to 1-2 sentences.
- Don't confirm a specific appointment time — you can't access the real calendar.
- Never make up availability.
</rules>

<history>
${history.map(h => `${h.role === 'user' ? 'Customer' : 'You'}: ${h.content}`).join('\n') || 'New conversation.'}
</history>${customerBlock}`;

    return base.run({
        client,
        message,
        customerNumber,
        workerName: 'Booking',
        systemPrompt,
        maxTokens: 150,
        skipHandoffs: true
    });
}

module.exports = { run };
