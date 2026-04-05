// Upsell Intelligence — recommends the right upsell for each customer
const Anthropic = require('@anthropic-ai/sdk');
const customerProfiler = require('../customer/customer-profiler');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Rule-based upsell map (can be overridden per client)
const DEFAULT_UPSELL_LOGIC = {
    // "If they have X, suggest Y"
    'Auto Insurance':     ['Home Insurance', 'Life Insurance'],
    'Home Insurance':     ['Auto Insurance', 'Life Insurance'],
    'Life Insurance':     ['Home Insurance', 'Business Insurance'],
    'Business Insurance': ['Life Insurance', 'Home Insurance'],
};

function getRuleBasedUpsell(services, availableServices) {
    for (const service of services) {
        const suggestions = DEFAULT_UPSELL_LOGIC[service] || [];
        for (const suggestion of suggestions) {
            const match = availableServices.find(s => s.name === suggestion);
            if (match) {
                return { service: match, reason: `Since they already have ${service}`, method: 'rule' };
            }
        }
    }
    // Default: suggest most popular service they don't have
    const unowned = availableServices.filter(s => !services.includes(s.name));
    return unowned.length ? { service: unowned[0], reason: 'Most popular service they haven\'t tried', method: 'rule' } : null;
}

async function recommend(clientSlug, customerNumber, availableServices, completedServiceName = null, clientUpsellLogic = null) {
    const profile = customerProfiler.getProfile(clientSlug, customerNumber);
    const existingServices = profile.services || [];

    // Try rule-based first
    const ruleResult = getRuleBasedUpsell(existingServices, availableServices);

    // If client provided custom upsell logic, use Claude to reason through it
    if (clientUpsellLogic || existingServices.length > 0) {
        const servicesContext = availableServices.map(s => `- ${s.name}: ${s.price}`).join('\n');
        const historyContext = `Customer has used: ${existingServices.join(', ') || 'none yet'}`;
        const completedContext = completedServiceName ? `Just completed: ${completedServiceName}` : '';

        try {
            const response = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 150,
                system: `You are an upsell recommendation engine for a service business. Return ONLY valid JSON:
{
  "recommendedService": "exact service name",
  "reason": "one sentence why this makes sense for this customer",
  "urgency": "high|medium|low",
  "messageHook": "a 1-sentence SMS hook to introduce the upsell"
}
Only recommend services the customer does NOT already have. Pick the highest-value, most relevant one.`,
                messages: [{
                    role: 'user',
                    content: `Available services:\n${servicesContext}\n\n${historyContext}\n${completedContext}\n${clientUpsellLogic ? `Business upsell rules: ${clientUpsellLogic}` : ''}`
                }]
            });

            const result = JSON.parse(response.content[0]?.text?.trim());
            const matched = availableServices.find(s => s.name === result.recommendedService);
            console.log(`[UpsellIntelligence] Recommending "${result.recommendedService}" for ${customerNumber}`);
            return { ...result, service: matched || { name: result.recommendedService }, method: 'claude' };
        } catch (e) {
            console.log(`[UpsellIntelligence] Fallback to rule: ${e.message}`);
        }
    }

    return ruleResult;
}

module.exports = { recommend };
