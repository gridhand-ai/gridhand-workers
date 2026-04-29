// Profile Context — produces a lean <customer> + <personalization-rules> block
// that inbound workers inject into their system prompts.
//
// Design rule: only include a field when it changes how the worker should respond.
// First-time customers (totalInteractions === 0) get NO block — empty profile shouldn't
// bloat new-customer prompts with "name: null, isVIP: false, …".
//
// Token impact: ~0 on first contact, ~120-180 on returning customers.

const customerProfiler = require('../subagents/customer/customer-profiler');

async function buildPromptBlock(clientSlug, customerNumber) {
    if (!clientSlug || !customerNumber) return '';

    let profile;
    try {
        profile = await customerProfiler.getProfile(clientSlug, customerNumber);
    } catch (e) {
        // Never fail the worker because profile lookup failed
        console.log(`[ProfileContext] lookup failed: ${e.message}`);
        return '';
    }

    // First-time contact — return nothing, let the standard prompt run as-is
    if (!profile || (profile.totalInteractions || 0) === 0) return '';

    const customerLines = [];
    const ruleLines = [];

    if (profile.name) {
        customerLines.push(`Name: ${profile.name}`);
        ruleLines.push(`- Greet by first name (${profile.name.split(' ')[0]}).`);
    }

    customerLines.push(
        `Returning customer: yes (${profile.totalInteractions} prior interaction${profile.totalInteractions === 1 ? '' : 's'})`
    );
    ruleLines.push(`- They've contacted us before — don't ask for info you already have.`);

    if (profile.communicationStyle) {
        customerLines.push(`Tone preference: ${profile.communicationStyle}`);
        ruleLines.push(`- Match their preferred tone (${profile.communicationStyle}).`);
    }

    if (profile.isVIP) {
        customerLines.push(`VIP: yes${profile.vipReason ? ` — ${profile.vipReason}` : ''}`);
        ruleLines.push(`- VIP customer — be extra warm, prioritize their request.`);
    }

    if (Array.isArray(profile.services) && profile.services.length > 0) {
        const last = profile.services[profile.services.length - 1];
        customerLines.push(`Last service used: ${last}`);
    }

    const kept = profile.appointmentsKept || 0;
    const noShow = profile.appointmentsNoShow || 0;
    if (kept > 0 || noShow > 0) {
        customerLines.push(`Appointment reliability: ${kept} kept, ${noShow} no-show`);
        if (noShow >= 2 && noShow >= kept) {
            ruleLines.push(`- Has a no-show pattern — gently confirm they'll make it before booking.`);
        }
    }

    if (profile.lastSentiment === 'negative') {
        ruleLines.push(`- Last interaction was negative — be extra warm and reassuring.`);
    }

    if (customerLines.length === 0) return '';

    return `\n\n<customer>\n${customerLines.join('\n')}\n</customer>\n<personalization-rules>\n${ruleLines.join('\n')}\n</personalization-rules>`;
}

module.exports = { buildPromptBlock };
