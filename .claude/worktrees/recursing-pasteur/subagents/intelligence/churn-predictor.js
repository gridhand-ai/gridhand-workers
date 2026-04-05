// Churn Predictor — identifies customers about to leave before they do
const Anthropic = require('@anthropic-ai/sdk');
const store = require('../store');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getDaysSince(isoDate) {
    if (!isoDate) return 999;
    return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

// Rule-based churn signals
function getRuleBasedRisk(profile, settings) {
    const dormantDays = settings?.reactivation?.dormantDays || 90;
    const daysSinceContact = getDaysSince(profile?.lastContact);
    const interactions = profile?.totalInteractions || 0;
    const sentiment = profile?.lastSentiment || 'neutral';

    let risk = 'low';
    const signals = [];

    if (daysSinceContact > dormantDays * 1.5) { risk = 'high'; signals.push(`No contact in ${daysSinceContact} days`); }
    else if (daysSinceContact > dormantDays) { risk = 'medium'; signals.push(`Inactive for ${daysSinceContact} days`); }

    if (sentiment === 'negative') { risk = 'high'; signals.push('Last sentiment was negative'); }
    if (interactions < 2) signals.push('Very low engagement history');

    return { risk, signals };
}

async function predict(customerProfile, conversationHistory = [], clientSettings = {}) {
    const ruleCheck = getRuleBasedRisk(customerProfile, clientSettings);

    // If already high risk from rules, skip Claude to save cost
    if (ruleCheck.risk === 'high') {
        console.log(`[ChurnPredictor] High risk (rule-based): ${ruleCheck.signals.join(', ')}`);
        return {
            risk: 'high',
            reason: ruleCheck.signals.join('. '),
            recommendedAction: 'Trigger reactivation worker immediately with personalized offer',
            daysSinceContact: getDaysSince(customerProfile?.lastContact)
        };
    }

    const profileContext = customerProfile ? `
Customer profile:
- Total interactions: ${customerProfile.totalInteractions || 0}
- Last contact: ${customerProfile.lastContact || 'unknown'}
- Services used: ${(customerProfile.services || []).join(', ') || 'none recorded'}
- Last sentiment: ${customerProfile.lastSentiment || 'unknown'}
- Is VIP: ${customerProfile.isVIP || false}` : 'No profile available.';

    const recentMessages = conversationHistory.slice(-4).map(h => `${h.role}: ${h.content}`).join('\n') || 'No recent messages.';

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            system: `You are a customer churn prediction engine. Analyze and return ONLY valid JSON:
{
  "risk": "high|medium|low",
  "reason": "one sentence explanation",
  "recommendedAction": "what to do about it",
  "daysSinceContact": number_or_null
}`,
            messages: [{
                role: 'user',
                content: `${profileContext}\n\nRecent messages:\n${recentMessages}\n\nRule-based signals: ${ruleCheck.signals.join(', ') || 'none'}`
            }]
        });

        const result = JSON.parse(response.content[0]?.text?.trim());
        console.log(`[ChurnPredictor] Risk: ${result.risk} — ${result.reason}`);
        return result;
    } catch (e) {
        console.log(`[ChurnPredictor] Fallback: ${e.message}`);
        return {
            risk: ruleCheck.risk,
            reason: ruleCheck.signals.join('. ') || 'Unknown',
            recommendedAction: ruleCheck.risk !== 'low' ? 'Consider reactivation outreach' : 'Continue normal engagement',
            daysSinceContact: getDaysSince(customerProfile?.lastContact)
        };
    }
}

// Batch scan — check all customers for a client and flag high-risk ones
function scanAllCustomers(clientSlug, clientSettings) {
    const profiles = store.readGlobal('profiles', `${clientSlug}_index.json`) || {};
    const highRisk = [];

    for (const [customerNumber, profileSummary] of Object.entries(profiles)) {
        const { risk, signals } = getRuleBasedRisk(profileSummary, clientSettings);
        if (risk !== 'low') {
            highRisk.push({ customerNumber, risk, signals, ...profileSummary });
        }
    }

    console.log(`[ChurnPredictor] Scanned ${Object.keys(profiles).length} customers for ${clientSlug} — ${highRisk.length} at risk`);
    return highRisk;
}

module.exports = { predict, scanAllCustomers };
