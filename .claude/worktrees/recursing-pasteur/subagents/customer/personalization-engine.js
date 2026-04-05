// Personalization Engine — crafts messages tailored to each specific customer
const Anthropic = require('@anthropic-ai/sdk');
const customerProfiler = require('./customer-profiler');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Replace simple template variables
function applyTemplateVars(template, vars) {
    return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || '');
}

// Build personalization context from profile
function buildContext(profile, conversationSummary) {
    const parts = [];

    if (profile.name) parts.push(`Customer's name: ${profile.name}`);
    if (profile.communicationStyle) parts.push(`They prefer ${profile.communicationStyle} communication`);
    if (profile.services?.length) parts.push(`Has used: ${profile.services.join(', ')}`);
    if (profile.isVIP) parts.push(`VIP customer — treat with extra care`);
    if (profile.lastSentiment === 'negative') parts.push(`Last interaction had negative sentiment — be extra warm`);
    if (profile.appointmentsNoShow > 0) parts.push(`Has ${profile.appointmentsNoShow} no-show(s) — may need extra reminder`);
    if (profile.referralCount > 0) parts.push(`Has referred ${profile.referralCount} customer(s) — acknowledge loyalty`);
    if (conversationSummary?.keyFacts?.length) {
        parts.push(`Key context: ${conversationSummary.keyFacts.join('; ')}`);
    }

    return parts.join('\n');
}

async function personalize(baseMessage, clientSlug, customerNumber, businessInfo, conversationSummary = null) {
    const profile = customerProfiler.getProfile(clientSlug, customerNumber);
    const context = buildContext(profile, conversationSummary);

    // If no profile context available, return base message as-is
    if (!context) {
        return { message: baseMessage, personalized: false };
    }

    // Apply simple variable substitution first
    const withVars = applyTemplateVars(baseMessage, {
        name: profile.name || 'there',
        firstName: profile.name?.split(' ')[0] || 'there',
    });

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            system: `You personalize SMS messages for a customer service business.
Rewrite the given message to feel personal and tailored to this specific customer.
Keep the same meaning and length. Don't add fluff. Return ONLY the rewritten message text.`,
            messages: [{
                role: 'user',
                content: `Original message: "${withVars}"\n\nCustomer context:\n${context}\n\nRewrite to feel personal:`
            }]
        });

        const personalized = response.content[0]?.text?.trim();
        console.log(`[PersonalizationEngine] Personalized message for ${customerNumber}`);
        return { message: personalized, personalized: true, profile };
    } catch (e) {
        console.log(`[PersonalizationEngine] Fallback: ${e.message}`);
        return { message: withVars, personalized: false, profile };
    }
}

// Detect communication style from conversation history
async function detectCommunicationStyle(conversationHistory, clientSlug, customerNumber) {
    if (!conversationHistory || conversationHistory.length < 3) return null;

    const customerMessages = conversationHistory
        .filter(h => h.role === 'user')
        .map(h => h.content)
        .join(' | ');

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 50,
            system: `Analyze the customer's messages and return ONLY one word: casual, formal, brief, or detailed.`,
            messages: [{ role: 'user', content: customerMessages }]
        });

        const style = response.content[0]?.text?.trim().toLowerCase();
        if (['casual', 'formal', 'brief', 'detailed'].includes(style)) {
            customerProfiler.updateProfile(clientSlug, customerNumber, { communicationStyle: style });
            return style;
        }
    } catch (e) {
        console.log(`[PersonalizationEngine] Style detection error: ${e.message}`);
    }
    return null;
}

module.exports = { personalize, detectCommunicationStyle };
