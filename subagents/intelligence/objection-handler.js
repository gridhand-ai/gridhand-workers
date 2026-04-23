// Objection Handler — specialized responses to "too expensive", "not now", etc.
const aiClient = require('../../lib/ai-client');

// Detect common objection types
const OBJECTION_PATTERNS = {
    price:      /\b(too expensive|can't afford|too much|cheaper|discount|lower price|price is high)\b/i,
    timing:     /\b(not right now|not yet|maybe later|someday|busy|not the right time|not ready)\b/i,
    trust:      /\b(not sure|how do I know|can I trust|reviews|legitimate|real|scam)\b/i,
    competitor: /\b(going with|already have|using (someone|another|a different)|competitor)\b/i,
    thinking:   /\b(let me think|need to think|talk to|discuss|get back|consider)\b/i,
    noNeed:     /\b(don't need|not interested|no thanks|already|don't want)\b/i,
};

function detectObjectionType(message) {
    for (const [type, pattern] of Object.entries(OBJECTION_PATTERNS)) {
        if (pattern.test(message)) return type;
    }
    return null;
}

// Pre-built responses for common objections (fast, no API needed)
const QUICK_RESPONSES = {
    price: [
        "We totally understand — budget matters! We do offer flexible options. Would it help to get a custom quote based on exactly what you need?",
        "That's fair! We have different packages at different price points. Want us to find something that fits your budget?",
    ],
    timing: [
        "No rush at all! When would be a better time for us to follow up?",
        "Totally understand — we'll be here when you're ready. Feel free to reach out anytime!",
    ],
    thinking: [
        "Of course, take your time! Feel free to reply with any questions as you think it over.",
        "No pressure at all! We're here whenever you're ready.",
    ],
    noNeed: [
        "Completely understood! If your situation changes, we're always here. Have a great day!",
        "No problem at all! We appreciate you taking the time. Don't hesitate to reach out if you ever need us.",
    ],
};

async function handle(message, businessInfo, customerProfile = null, useQuickResponse = false) {
    const objectionType = detectObjectionType(message);

    if (!objectionType) {
        return null; // Not an objection — caller should handle normally
    }

    // Use quick response if requested (saves API cost)
    if (useQuickResponse && QUICK_RESPONSES[objectionType]) {
        const responses = QUICK_RESPONSES[objectionType];
        const reply = responses[Math.floor(Math.random() * responses.length)];
        console.log(`[ObjectionHandler] Quick response for "${objectionType}" objection`);
        return { objectionType, reply, method: 'quick' };
    }

    const profileContext = customerProfile
        ? `Customer history: ${customerProfile.totalInteractions || 0} interactions, services: ${(customerProfile.services || []).join(', ') || 'none'}`
        : '';

    try {
        const reply = await aiClient.call({
            modelString: 'claude-haiku-4-5-20251001',
            systemPrompt: `You are a compassionate sales assistant handling customer objections via SMS for ${businessInfo.name}, a ${businessInfo.industry} business.
The customer has a "${objectionType}" objection. Write a brief, empathetic response that:
- Acknowledges their concern genuinely (don't dismiss it)
- Offers a soft path forward (not pushy)
- Keeps it to 1-2 sentences
- Never argues or pressures
${profileContext}
Business phone: ${businessInfo.phone}`,
            messages: [{ role: 'user', content: `Customer said: "${message}"` }],
            maxTokens: 120,
        });
        console.log(`[ObjectionHandler] Handled "${objectionType}" objection with Claude`);
        return { objectionType, reply, method: 'claude' };
    } catch (e) {
        console.log(`[ObjectionHandler] Fallback: ${e.message}`);
        const fallbacks = QUICK_RESPONSES[objectionType];
        return {
            objectionType,
            reply: fallbacks
                ? fallbacks[0]
                : `We completely understand! Feel free to reach out whenever the time is right. — ${businessInfo.name}`,
            method: 'fallback'
        };
    }
}

module.exports = { handle, detectObjectionType };
