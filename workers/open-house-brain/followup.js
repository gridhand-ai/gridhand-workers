/**
 * GRIDHAND Open House Brain — Follow-Up Logic & AI Messaging
 *
 * Uses Claude claude-haiku-4-5-20251001 for intent analysis and personalized message generation.
 * All outbound SMS is generated here and dispatched through jobs.js via Twilio.
 */

'use strict';

require('dotenv').config();

const aiClient = require('../../lib/ai-client');
const dayjs    = require('dayjs');
const db       = require('./db');
const crm      = require('./crm');

async function callGroq(messages, maxTokens = 120) {
    return aiClient.call({
        modelString:  'groq/llama-3.3-70b-versatile',
        systemPrompt: '',
        messages,
        maxTokens,
    });
}

// ─── Message Generators ───────────────────────────────────────────────────────

/**
 * Personalized invite to CRM leads in the area.
 * Reference lead's search criteria if available. Under 160 chars.
 */
async function generateInviteMessage(lead, openHouse, clientConfig = {}) {

    const formattedDate = dayjs(openHouse.date).format('ddd, MMM D');
    const startTime     = formatTime(openHouse.start_time);
    const endTime       = formatTime(openHouse.end_time);
    const agentName     = clientConfig.agent_name || 'Your agent';

    const contextLines = [];
    if (lead.city)    contextLines.push(`Lead is looking in ${lead.city}`);
    if (lead.priceMax) contextLines.push(`Budget up to $${lead.priceMax.toLocaleString()}`);
    if (lead.beds)    contextLines.push(`Looking for ${lead.beds}+ beds`);

    const prompt = `You are writing a brief, friendly SMS invite for a real estate open house.

Agent: ${agentName}
Property: ${openHouse.listing_address}
Date/Time: ${formattedDate}, ${startTime}–${endTime}
Lead's name: ${lead.firstName || lead.name}
${contextLines.length ? `Context: ${contextLines.join('. ')}` : ''}

Write a personalized SMS invite. Rules:
- Under 160 characters (strict)
- Reference the lead's name and area interest if available
- Include the address and date/time naturally
- Friendly, not pushy
- End with agent name
- No hashtags, no exclamation spam
- Return ONLY the SMS text, nothing else`;

    try {
        const text = await callGroq([{ role: 'user', content: prompt }], 100) || '';
        // Hard fallback if over limit
        if (text.length > 160) {
            return `Hi ${lead.firstName || lead.name}! Open house ${openHouse.listing_address} on ${formattedDate} ${startTime}–${endTime}. Would love to see you there! – ${agentName}`.slice(0, 160);
        }
        return text;
    } catch (err) {
        console.error(`[Followup] generateInviteMessage failed: ${err.message}`);
        return `Hi ${lead.firstName || lead.name}! Open house at ${openHouse.listing_address} — ${formattedDate} ${startTime}–${endTime}. Stop by! – ${agentName}`.slice(0, 160);
    }
}

/**
 * Same-day thank you SMS after open house visit.
 * Ask one qualifying question. Under 200 chars.
 */
async function generatePostEventThankYou(visitor, openHouse, clientConfig = {}) {
    const agentName = clientConfig.agent_name || 'Your agent';

    const prompt = `Write a warm, brief same-day thank-you SMS for someone who attended a real estate open house.

Agent: ${agentName}
Visitor's name: ${visitor.name}
Property: ${openHouse.listing_address}
${visitor.agent_notes ? `Agent's notes about this visitor: ${visitor.agent_notes}` : ''}

Rules:
- Under 200 characters (strict)
- Mention their name and the property address briefly
- Ask ONE soft qualifying question (e.g., "Did the layout work for you?" or "Any questions come up after seeing it?")
- Warm, human tone — not salesy
- Sign with agent name
- Return ONLY the SMS text, nothing else`;

    try {
        const text = await callGroq([{ role: 'user', content: prompt }], 120) || '';
        if (text.length > 200) {
            return `Thanks for stopping by ${openHouse.listing_address} today, ${visitor.name}! Did you have any questions after seeing it? – ${agentName}`.slice(0, 200);
        }
        return text;
    } catch (err) {
        console.error(`[Followup] generatePostEventThankYou failed: ${err.message}`);
        return `Hi ${visitor.name}, thanks for visiting ${openHouse.listing_address} today! Did anything stand out to you? Happy to answer questions – ${agentName}`.slice(0, 200);
    }
}

/**
 * Day-after follow-up. Check in, soft next step.
 */
async function generateDayAfterFollowup(visitor, openHouse, clientConfig = {}) {
    const agentName = clientConfig.agent_name || 'Your agent';

    const prompt = `Write a day-after follow-up SMS for a real estate open house visitor.

Agent: ${agentName}
Visitor: ${visitor.name}
Property: ${openHouse.listing_address}
${visitor.ai_notes ? `Previous context: ${visitor.ai_notes}` : ''}

Rules:
- Under 200 characters
- Reference the property by address
- Ask if they had questions after seeing it
- Offer a soft next step (private showing, answer questions)
- Not pushy — they're still in discovery mode
- Return ONLY the SMS text, nothing else`;

    try {
        return await callGroq([{ role: 'user', content: prompt }], 120) || `Hi ${visitor.name}! Just checking in after yesterday's open house at ${openHouse.listing_address}. Any questions? Happy to set up a private showing – ${agentName}`.slice(0, 200);
    } catch (err) {
        console.error(`[Followup] generateDayAfterFollowup failed: ${err.message}`);
        return `Hi ${visitor.name}! Did you have any questions after seeing ${openHouse.listing_address}? I'd love to walk you through it privately – ${agentName}`.slice(0, 200);
    }
}

/**
 * One-week follow-up. Mention similar properties or price reduction if applicable.
 */
async function generateWeekFollowup(visitor, openHouse, clientConfig = {}) {
    const agentName = clientConfig.agent_name || 'Your agent';

    const prompt = `Write a one-week follow-up SMS for a real estate open house visitor.

Agent: ${agentName}
Visitor: ${visitor.name}
Original property: ${openHouse.listing_address}
${visitor.ai_notes ? `Previous conversation notes: ${visitor.ai_notes}` : ''}

Rules:
- Under 200 characters
- Reference the original property briefly
- Either: mention you have similar listings, OR ask if their search criteria has changed
- Keep the door open — they may just need more time
- Genuine, brief, no pressure
- Return ONLY the SMS text, nothing else`;

    try {
        return await callGroq([{ role: 'user', content: prompt }], 120) || `Hi ${visitor.name}! Still thinking about ${openHouse.listing_address}? I have a few similar listings you might like. Interested in a look? – ${agentName}`.slice(0, 200);
    } catch (err) {
        console.error(`[Followup] generateWeekFollowup failed: ${err.message}`);
        return `Hi ${visitor.name}, checking in on your search! Have similar homes to ${openHouse.listing_address} if you're still looking. Want details? – ${agentName}`.slice(0, 200);
    }
}

/**
 * Handle an inbound reply from a visitor. Understand intent, generate a response.
 * Returns { response, intent, shouldNotifyAgent }
 */
async function handleVisitorReply(visitor, openHouse, replyText, clientConfig = {}) {
    const agentName = clientConfig.agent_name || 'Your agent';

    const prompt = `You are handling inbound SMS replies for a real estate agent's open house follow-up system.

Visitor: ${visitor.name}
Property they visited: ${openHouse.listing_address}
Their reply: "${replyText}"
${visitor.ai_notes ? `Previous conversation context: ${visitor.ai_notes}` : ''}
Agent's name: ${agentName}

Analyze the reply and respond with a JSON object (ONLY JSON, no other text):
{
  "intent": "interested" | "not_interested" | "question" | "schedule_showing" | "other",
  "shouldNotifyAgent": true | false,
  "response": "<the SMS response to send back, under 200 chars>",
  "aiNotes": "<brief note to store about this visitor's intent for the agent>"
}

Rules for intent:
- "interested": positive language, wants to see more, mentions price/timeline
- "not_interested": declining, not a fit, stop messaging
- "question": asking about property details, neighborhood, price
- "schedule_showing": explicitly wants a showing or to meet
- shouldNotifyAgent = true if intent is "interested", "schedule_showing", or the question needs the agent's answer`;

    try {
        const raw = await callGroq([{ role: 'user', content: prompt }], 300) || '{}';

        // Parse JSON — strip markdown code fences if present
        const jsonStr = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        const parsed  = JSON.parse(jsonStr);

        return {
            response:          parsed.response || `Thanks for reaching out, ${visitor.name}! I'll have ${agentName} follow up with you shortly.`,
            intent:            parsed.intent || 'other',
            shouldNotifyAgent: parsed.shouldNotifyAgent === true,
            aiNotes:           parsed.aiNotes || '',
        };
    } catch (err) {
        console.error(`[Followup] handleVisitorReply failed: ${err.message}`);
        return {
            response:          `Thanks ${visitor.name}! I'll have ${agentName} get back to you soon.`,
            intent:            'other',
            shouldNotifyAgent: true,
            aiNotes:           `Visitor replied: "${replyText}" — needs agent review`,
        };
    }
}

/**
 * Weekly performance summary for the agent.
 */
async function generateWeeklyReport(openHouses, visitors, clientConfig = {}) {
    const agentName = clientConfig.agent_name || 'Your team';

    const completed     = openHouses.filter(oh => oh.status === 'completed');
    const totalVisitors = visitors.length;
    const highInterest  = visitors.filter(v => v.interest_level === 'high').length;
    const scheduled     = visitors.filter(v => v.followup_status === 'converted' ||
        (v.ai_notes || '').toLowerCase().includes('showing')).length;
    const thankyousSent = visitors.filter(v => ['thankyou_sent','day_after_sent','week_sent','converted'].includes(v.followup_status)).length;

    const weekOf = dayjs().subtract(7, 'day').format('MMM D');

    const lines = [
        `📊 Open House Report — Week of ${weekOf}`,
        `${agentName}`,
        ``,
        `Events: ${completed.length} open houses`,
        `Visitors: ${totalVisitors} registered`,
        `Hot leads: ${highInterest} high interest`,
        `Showings queued: ${scheduled}`,
        `Follow-ups sent: ${thankyousSent}`,
    ];

    if (completed.length) {
        lines.push('');
        lines.push('Properties:');
        for (const oh of completed.slice(0, 5)) {
            lines.push(`• ${oh.listing_address} (${oh.visitor_count || 0} visitors)`);
        }
    }

    // Split into ≤320 char chunks for SMS
    const full    = lines.join('\n');
    const chunks  = [];
    const maxLen  = 320;
    let   current = '';

    for (const line of lines) {
        if ((current + '\n' + line).length > maxLen && current) {
            chunks.push(current.trim());
            current = line;
        } else {
            current = current ? current + '\n' + line : line;
        }
    }
    if (current) chunks.push(current.trim());

    return { full, chunks };
}

/**
 * Pull leads from CRM matching the property area.
 * Max 100 per open house.
 */
async function getInviteTargets(clientSlug, openHouse) {
    // Extract zip codes near the listing
    // In production you'd geocode the address — for now we parse zip from address string
    const zipMatch = (openHouse.listing_address || '').match(/\b\d{5}\b/);
    const zip      = zipMatch ? zipMatch[0] : null;

    if (!zip) {
        console.warn(`[Followup] Could not extract zip from: ${openHouse.listing_address}`);
        return [];
    }

    // Generate nearby zip codes (simplified — same zip for now)
    const zipCodes = [zip];

    try {
        const leads = await crm.getLeadsInArea(clientSlug, zipCodes, 10);

        // Filter by price range and bed count if listing data available
        return leads
            .filter(l => l.phone) // must have a phone
            .slice(0, 100);
    } catch (err) {
        console.error(`[Followup] getInviteTargets failed: ${err.message}`);
        return [];
    }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatTime(timeStr) {
    // "14:00:00" → "2:00 PM"
    if (!timeStr) return '';
    const [h, m] = timeStr.split(':').map(Number);
    const period  = h >= 12 ? 'PM' : 'AM';
    const hour    = h % 12 || 12;
    return m > 0 ? `${hour}:${String(m).padStart(2, '0')} ${period}` : `${hour} ${period}`;
}

module.exports = {
    generateInviteMessage,
    generatePostEventThankYou,
    generateDayAfterFollowup,
    generateWeekFollowup,
    handleVisitorReply,
    generateWeeklyReport,
    getInviteTargets,
    formatTime,
};
