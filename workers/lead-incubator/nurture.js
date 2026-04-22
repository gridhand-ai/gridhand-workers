/**
 * GRIDHAND Lead Incubator — AI-Powered Lead Nurturing
 *
 * Uses Claude claude-haiku-4-5-20251001 for all lead intelligence:
 *   - Lead qualification scoring (1-100)
 *   - Personalized initial SMS response
 *   - Intelligent reply handling (intent detection + response)
 *   - Drip campaign message generation
 *   - Morning digest briefings for agents
 *
 * All Claude calls use the client's anthropic_key if set, otherwise falls back
 * to ANTHROPIC_API_KEY environment variable (operator key).
 */

'use strict';

const aiClient = require('../../lib/ai-client');
const db       = require('./db');

async function callGroq(messages, maxTokens = 200) {
    return aiClient.call({
        modelString:  'groq/llama-3.3-70b-versatile',
        systemPrompt: '',
        messages,
        maxTokens,
    });
}

// ─── Lead Qualification ────────────────────────────────────────────────────────

/**
 * Score and tier a lead using Claude.
 * Analyzes source, budget, timeline, inquiry, and any conversation history.
 *
 * @param {object} lead  Lead record from li_leads
 * @returns {{ ok, data: { score, tier, questions, summary }, error }}
 */
async function qualifyLead(lead) {
    const leadContext = buildLeadContext(lead);

    const prompt = `You are a real estate lead qualification expert. Analyze this lead and score their likelihood to transact.

LEAD DATA:
${leadContext}

Evaluate based on:
1. Budget specificity (no budget = lower score, specific range = higher)
2. Timeline urgency (immediately/1-3 months = hot, 6+ months = cold)
3. Inquiry specificity (vague browsing = cold, specific property/neighborhood = hot)
4. Source quality (referral/repeat = hot, portal/generic = warmer scoring needed)
5. Contact completeness (phone + email = better)

Return ONLY valid JSON, no other text:
{
  "score": <integer 1-100>,
  "tier": "<hot|warm|cold>",
  "questions": ["<question to ask this lead>", "<question 2>", "<question 3>"],
  "summary": "<2-3 sentence summary of this lead's situation and buying intent>"
}

Scoring guide:
- hot (70-100): Ready to transact, specific needs, short timeline, reasonable budget
- warm (40-69): Interested but vague timeline or budget, needs nurturing
- cold (1-39): Early stage, just browsing, no urgency, or incomplete info`;

    try {
        const text = await callGroq([{ role: 'user', content: prompt }], 512) || '';

        // Extract JSON from response (handle any surrounding text)
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return { ok: false, data: null, error: 'Claude returned non-JSON qualification response' };
        }

        const result = JSON.parse(jsonMatch[0]);

        // Validate and clamp score
        result.score = Math.min(100, Math.max(1, parseInt(result.score, 10) || 25));
        if (!['hot', 'warm', 'cold'].includes(result.tier)) {
            result.tier = result.score >= 70 ? 'hot' : result.score >= 40 ? 'warm' : 'cold';
        }
        result.questions = Array.isArray(result.questions) ? result.questions.slice(0, 5) : [];
        result.summary   = result.summary || '';

        return { ok: true, data: result, error: null };
    } catch (err) {
        console.error(`[Nurture] qualifyLead error: ${err.message}`);
        return { ok: false, data: null, error: err.message };
    }
}

// ─── Initial Response Generation ──────────────────────────────────────────────

/**
 * Generate a personalized first SMS to send within 60 seconds of lead creation.
 * Must be under 160 characters and reference the lead's specific inquiry.
 *
 * @param {object} lead  Lead record from li_leads
 * @returns {{ ok, data: { message }, error }}
 */
async function generateInitialResponse(lead) {
    let client = null;
    try {
        client = await db.getClientById(lead.client_id);
    } catch {
        // Proceed without client context
    }

    const agentName    = client?.agent_name || 'your agent';
    const leadContext  = buildLeadContext(lead);

    const prompt = `You are ${agentName}, a real estate agent. Write the FIRST text message to send to a new lead.

LEAD INFO:
${leadContext}

RULES (strictly follow all of these):
- Maximum 160 characters total (this is a single SMS — CRITICAL)
- Must reference something specific from their inquiry (location, budget, or property type)
- Warm, professional, human tone — NOT robotic or salesy
- End with a natural open-ended question to start conversation
- Do NOT use emojis
- Do NOT include the agent's phone number
- Do NOT say "automated" or "AI"
- Sign off with: - ${agentName}

Return ONLY the SMS text, nothing else.`;

    try {
        let smsText = (await callGroq([{ role: 'user', content: prompt }], 100) || '').trim();

        // Hard truncate to 160 chars if model disobeyed
        if (smsText.length > 160) {
            smsText = smsText.slice(0, 157) + '...';
        }

        return { ok: true, data: { message: smsText }, error: null };
    } catch (err) {
        console.error(`[Nurture] generateInitialResponse error: ${err.message}`);
        // Fallback message if Claude fails
        const fallback = `Hi ${lead.name?.split(' ')[0] || 'there'}, I saw your inquiry and would love to help you find the right home. What's most important to you in your search? - ${agentName}`;
        return { ok: true, data: { message: fallback.slice(0, 160) }, error: null };
    }
}

// ─── Reply Handling ────────────────────────────────────────────────────────────

/**
 * Handle an inbound SMS reply from a lead.
 * Detects intent and generates an appropriate response.
 *
 * @param {object} lead        Lead record from li_leads
 * @param {string} inboundSms  Text of the lead's reply
 * @returns {{ ok, data: { response, intent, shouldSchedule }, error }}
 */
async function handleReply(lead, inboundSms) {
    let client = null;
    try {
        client = await db.getClientById(lead.client_id);
    } catch {
        // Proceed without client context
    }

    const agentName   = client?.agent_name || 'your agent';
    const leadContext = buildLeadContext(lead);

    // Load recent conversation history for context
    let conversationHistory = '';
    try {
        const conversations = await db.getLeadConversations(lead.id, 10);
        if (conversations.length > 0) {
            conversationHistory = conversations
                .map(c => `${c.direction === 'outbound' ? agentName : lead.name}: ${c.message}`)
                .join('\n');
        }
    } catch {
        // Continue without history
    }

    const prompt = `You are ${agentName}, a real estate agent having a text conversation with a lead.

LEAD INFO:
${leadContext}

RECENT CONVERSATION:
${conversationHistory || '(No prior messages)'}

LEAD JUST REPLIED:
"${inboundSms}"

Your job:
1. Detect their intent (one of: schedule, question, not_interested, more_info)
2. Write a reply that moves them forward in the buying process
3. Determine if they want to schedule a showing

Intent definitions:
- schedule: they want to see a property or meet with an agent
- question: they have a specific question about a property or process
- not_interested: they want to stop, said no thanks, or are opting out
- more_info: they want more details but aren't ready to commit

RESPONSE RULES:
- Maximum 160 characters for the SMS response
- Human, conversational tone
- If intent is "schedule", confirm enthusiasm and ask for their availability
- If intent is "not_interested", be gracious and offer to stay in touch
- If intent is "question", answer concisely or say you'll find out
- Do NOT use emojis
- Do NOT say "automated" or "AI"

Return ONLY valid JSON, no other text:
{
  "response": "<SMS text, max 160 chars>",
  "intent": "<schedule|question|not_interested|more_info>",
  "shouldSchedule": <true|false>
}`;

    try {
        const text = await callGroq([{ role: 'user', content: prompt }], 256) || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);

        if (!jsonMatch) {
            // Fallback if JSON parse fails
            return {
                ok: true,
                data: {
                    response:       `Thanks for reaching out! I'll have ${agentName} follow up with you shortly.`,
                    intent:         'more_info',
                    shouldSchedule: false,
                },
                error: null,
            };
        }

        const result = JSON.parse(jsonMatch[0]);

        // Validate fields
        const validIntents = ['schedule', 'question', 'not_interested', 'more_info'];
        if (!validIntents.includes(result.intent)) result.intent = 'more_info';
        result.shouldSchedule = Boolean(result.shouldSchedule) || result.intent === 'schedule';

        // Truncate SMS if needed
        if (result.response && result.response.length > 160) {
            result.response = result.response.slice(0, 157) + '...';
        }

        return { ok: true, data: result, error: null };
    } catch (err) {
        console.error(`[Nurture] handleReply error: ${err.message}`);
        return {
            ok: false,
            data: {
                response:       `Thanks for your message! ${agentName} will be in touch shortly.`,
                intent:         'more_info',
                shouldSchedule: false,
            },
            error: err.message,
        };
    }
}

// ─── Drip Campaign Messages ────────────────────────────────────────────────────

/**
 * Generate a drip campaign SMS for a specific step.
 * Steps: 1=day1, 2=day3, 3=day7, 4=day14, 5=day30
 *
 * @param {object} lead        Lead record from li_leads
 * @param {number} stepNumber  1-5
 * @returns {{ ok, data: { message }, error }}
 */
async function getDripMessage(lead, stepNumber) {
    let client = null;
    try {
        client = await db.getClientById(lead.client_id);
    } catch {
        // Proceed without client context
    }

    const agentName  = client?.agent_name || 'your agent';
    const leadContext = buildLeadContext(lead);

    const stepContextMap = {
        1:  'Day 1 — Initial follow-up. They may not have responded yet. Re-engage warmly.',
        2:  'Day 3 — Second touch. Reference their original inquiry. Share something valuable (market insight, similar listing).',
        3:  'Day 7 — One week in. Check if their search criteria has changed. Keep it helpful.',
        4:  'Day 14 — Two weeks. Light urgency. Market is moving. Ask if they found something or still looking.',
        5:  'Day 30 — One month. Long re-engagement. Keep it brief and genuine. Open door if they\'re ready.',
    };

    const stepContext = stepContextMap[stepNumber] || `Follow-up step ${stepNumber}`;

    const prompt = `You are ${agentName}, a real estate agent running a follow-up sequence with a lead.

LEAD INFO:
${leadContext}

DRIP STEP: ${stepNumber} of 5
CONTEXT: ${stepContext}

Write a follow-up SMS for this step.

RULES:
- Maximum 160 characters
- Must feel personal and relevant to THIS lead's situation
- Do NOT be repetitive with generic phrases
- Do NOT sound automated or templated
- Do NOT use emojis
- Provide real value — a question, insight, or helpful nudge
- Sign with: - ${agentName}

Return ONLY the SMS text, nothing else.`;

    try {
        let smsText = (await callGroq([{ role: 'user', content: prompt }], 100) || '').trim();
        if (smsText.length > 160) smsText = smsText.slice(0, 157) + '...';

        return { ok: true, data: { message: smsText }, error: null };
    } catch (err) {
        console.error(`[Nurture] getDripMessage step ${stepNumber} error: ${err.message}`);

        // Fallback messages per step
        const fallbacks = {
            1: `Hi ${lead.name?.split(' ')[0] || 'there'}, wanted to follow up on your home search. Any questions I can answer? - ${agentName}`,
            2: `Still looking for the right home? I have a few new listings that might fit what you're after. - ${agentName}`,
            3: `Just checking in — has your search criteria changed at all? Happy to refine what I'm showing you. - ${agentName}`,
            4: `The market is moving fast this week. Are you still actively looking? I'd hate for you to miss out. - ${agentName}`,
            5: `Hi ${lead.name?.split(' ')[0] || 'there'}, reaching out one more time. If you're ready to start your home search, I'm here. - ${agentName}`,
        };

        const fallback = (fallbacks[stepNumber] || fallbacks[1]).slice(0, 160);
        return { ok: true, data: { message: fallback }, error: null };
    }
}

// ─── Morning Digest ────────────────────────────────────────────────────────────

/**
 * Generate a morning briefing for the agent summarizing their lead pipeline.
 *
 * @param {object[]} leads  Array of lead records with relevant fields
 * @param {object}   client Client record (agent_name, etc.)
 * @returns {{ ok, data: { message }, error }}
 */
async function generateMorningDigest(leads, client) {
    const agentName = client?.agent_name || 'Agent';

    if (!leads || leads.length === 0) {
        return {
            ok:   true,
            data: { message: `Good morning ${agentName}! No active leads right now. Check back later.` },
            error: null,
        };
    }

    // Summarize leads for the prompt
    const hot   = leads.filter(l => l.tier === 'hot');
    const warm  = leads.filter(l => l.tier === 'warm');
    const cold  = leads.filter(l => l.tier === 'cold');
    const newToday = leads.filter(l => {
        const created = new Date(l.created_at);
        const now     = new Date();
        return (now - created) < 24 * 60 * 60 * 1000;
    });

    const leadSummary = leads.slice(0, 10).map(l =>
        `- ${l.name} | ${l.tier?.toUpperCase()} | ${l.status} | Score: ${l.score} | Source: ${l.source || 'unknown'} | Last contact: ${l.last_contact ? new Date(l.last_contact).toLocaleDateString() : 'never'}`
    ).join('\n');

    const prompt = `Generate a brief morning SMS digest for a real estate agent.

AGENT: ${agentName}
DATE: ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}

PIPELINE SUMMARY:
- Total active leads: ${leads.length}
- Hot leads: ${hot.length}
- Warm leads: ${warm.length}
- Cold leads: ${cold.length}
- New leads today: ${newToday.length}

TOP LEADS (up to 10):
${leadSummary}

Write a concise morning briefing SMS. Include:
1. Quick pipeline summary (numbers only)
2. 1-2 specific hot leads to call today (name + why they're hot)
3. One actionable focus for the day

Keep it under 320 characters (2 SMS). Direct, practical, no fluff. No emojis.
Return ONLY the SMS text.`;

    try {
        const digestText = (await callGroq([{ role: 'user', content: prompt }], 200) || '').trim();
        return { ok: true, data: { message: digestText }, error: null };
    } catch (err) {
        console.error(`[Nurture] generateMorningDigest error: ${err.message}`);

        // Fallback digest
        const fallback = `Good morning ${agentName}! Pipeline: ${leads.length} leads (${hot.length} hot, ${warm.length} warm). ${hot.length > 0 ? `Priority: ${hot[0].name} — follow up today.` : 'No hot leads — nurture your warm pipeline.'}`;
        return { ok: true, data: { message: fallback.slice(0, 320) }, error: null };
    }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Build a concise lead context string for use in Claude prompts.
 */
function buildLeadContext(lead) {
    const lines = [];
    lines.push(`Name: ${lead.name || 'Unknown'}`);
    lines.push(`Phone: ${lead.phone || 'N/A'}`);
    lines.push(`Source: ${lead.source || 'Unknown'}`);
    if (lead.inquiry)          lines.push(`Inquiry: ${lead.inquiry}`);
    if (lead.desired_location) lines.push(`Desired location: ${lead.desired_location}`);
    if (lead.budget_min || lead.budget_max) {
        const budgetStr = [
            lead.budget_min ? `$${Number(lead.budget_min).toLocaleString()}` : null,
            lead.budget_max ? `$${Number(lead.budget_max).toLocaleString()}` : null,
        ].filter(Boolean).join(' – ');
        lines.push(`Budget: ${budgetStr}`);
    }
    if (lead.timeline)         lines.push(`Timeline: ${lead.timeline}`);
    if (lead.bedrooms)         lines.push(`Bedrooms needed: ${lead.bedrooms}`);
    if (lead.status)           lines.push(`Current status: ${lead.status}`);
    if (lead.score)            lines.push(`Lead score: ${lead.score}/100`);
    if (lead.tier)             lines.push(`Tier: ${lead.tier}`);
    if (lead.ai_summary)       lines.push(`AI summary: ${lead.ai_summary}`);
    return lines.join('\n');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    qualifyLead,
    generateInitialResponse,
    handleReply,
    getDripMessage,
    generateMorningDigest,
};
