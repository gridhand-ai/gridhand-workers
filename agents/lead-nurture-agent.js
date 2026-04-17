/**
 * lead-nurture-agent.js
 *
 * Intelligent lead qualification and nurture agent.
 * Replaces: Lead Follow-up Worker + Lead Qualifier + Re-engagement Worker
 *
 * Capabilities:
 *   - Qualify new leads via 2-3 question SMS conversation
 *   - Score leads: hot / warm / cold
 *   - Hot: follow up within 1 hour, personalized to inquiry
 *   - Warm: day 1, day 3, day 7 sequence — stop on no response
 *   - Cold after 7d: one final re-engagement, then archive
 *   - Hard stop: "stop" / "not interested" → archived immediately
 *
 * Trigger:
 *   POST /agents/lead-nurture { clientId, event: 'new_lead', customerPhone, customerName, inquiryAbout, source }
 *   POST /agents/lead-nurture { clientId, event: 'run_followups' }  — daily cron
 *   POST /agents/lead-nurture { clientId, event: 'inbound_reply', customerPhone, message }  — inbound SMS from lead
 *
 * Usage:
 *   node agents/lead-nurture-agent.js --new <clientId> <phone> <inquiry>
 *   node agents/lead-nurture-agent.js --followups <clientId>
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const aiClient         = require('../lib/ai-client');
const sender           = require('../workers/twilio-sender');
const { emit, sendTelegramAlert } = require('../lib/events');
const optoutManager    = require('../subagents/compliance/optout-manager');
const tcpaChecker      = require('../subagents/compliance/tcpa-checker');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PORTAL_URL     = process.env.PORTAL_URL || 'https://gridhand.ai';
const WORKERS_SECRET = process.env.WORKERS_API_SECRET;

// Follow-up schedule for warm leads (days after initial contact)
const WARM_FOLLOWUP_DAYS = [1, 3, 7];
// After this many days with no response → final re-engagement attempt
const COLD_FINAL_DAY = 7;
// Hot lead: respond within this many minutes
const HOT_LEAD_SLA_MINUTES = 60;

// Stop keywords (beyond standard STOP — lead-specific phrasing)
const NOT_INTERESTED_PATTERNS = /\b(not interested|no thanks|not looking|don't contact|don't call|wrong number|go away|remove me|stop texting)\b/i;

// Hot signal keywords in lead replies
const HOT_SIGNALS = /\b(yes|book|schedule|appointment|price|cost|how much|ready|interested|when|available|let's do it|sign me up|definitely)\b/i;

// ─── Portal API helpers ───────────────────────────────────────────────────────
async function logActivity(clientId, action, summary, metadata = {}) {
    if (!WORKERS_SECRET) return;
    try {
        await fetch(`${PORTAL_URL}/api/workers/log`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WORKERS_SECRET}`,
            },
            body: JSON.stringify({ clientId, workerName: 'LeadNurtureAgent', action, summary, metadata }),
        });
    } catch (e) {
        console.log(`[LeadNurtureAgent] Log failed: ${e.message}`);
    }
}

function reportError(clientId, message, context = {}) {
    if (!WORKERS_SECRET) return;
    fetch(`${PORTAL_URL}/api/workers/error`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${WORKERS_SECRET}`,
        },
        body: JSON.stringify({ clientId, workerName: 'LeadNurtureAgent', errorMessage: message, context }),
    }).catch(e => console.log(`[LeadNurtureAgent] Error report failed: ${e.message}`));
}

// ─── Lead state helpers ───────────────────────────────────────────────────────
async function getLeadState(clientId, customerPhone) {
    const { data } = await supabase
        .from('agent_state')
        .select('state')
        .eq('agent', 'lead_nurture')
        .eq('client_id', clientId)
        .eq('entity_id', `lead:${customerPhone}`)
        .single();
    return data?.state || null;
}

async function setLeadState(clientId, customerPhone, state) {
    await supabase
        .from('agent_state')
        .upsert({
            agent: 'lead_nurture',
            client_id: clientId,
            entity_id: `lead:${customerPhone}`,
            state,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'agent,client_id,entity_id' });
}

// ─── Load client config ───────────────────────────────────────────────────────
async function loadClientConfig(clientId) {
    const { data, error } = await supabase
        .from('clients')
        .select('id, business_name, industry, settings, twilio_number, timezone, slug, workers_paused')
        .eq('id', clientId)
        .single();
    if (error || !data) throw new Error(`Client not found: ${clientId}`);
    return data;
}

// ─── Score lead based on their reply ─────────────────────────────────────────
function scoreLead(message) {
    if (!message) return 'warm';

    const lower = message.toLowerCase();

    // Immediate archive triggers
    if (NOT_INTERESTED_PATTERNS.test(lower)) return 'archive';

    // Hot signals
    if (HOT_SIGNALS.test(lower)) return 'hot';

    // Engaged but no commitment
    if (message.includes('?') || lower.includes('tell me more') || lower.includes('what') || lower.includes('how')) {
        return 'warm';
    }

    return 'warm';
}

// ─── Generate AI-powered lead response ───────────────────────────────────────
async function generateLeadResponse({ clientConfig, leadState, inboundMessage, msgType }) {
    const bizName    = clientConfig.business_name;
    const industry   = clientConfig.industry || 'business';
    const settings   = clientConfig.settings || {};
    const inquiryAbout = leadState.inquiryAbout || 'your services';
    const leadName   = leadState.customerName || null;

    const services = settings.services_summary || '';
    const cta      = settings.lead_cta || `Call us or reply to this message to get started.`;
    const bookingLink = settings.booking_link || '';

    let taskDesc;
    if (msgType === 'qualification') {
        taskDesc = `This is the first message to a new lead who inquired about: "${inquiryAbout}". Ask 1-2 qualifying questions to understand their timeline and needs. Be conversational, not robotic.`;
    } else if (msgType === 'hot_followup') {
        taskDesc = `Hot lead — they replied with interest. Their message: "${inboundMessage}". Answer their question or concern and move them toward booking. ${cta}${bookingLink ? ` Booking: ${bookingLink}` : ''}`;
    } else if (msgType === 'warm_day1') {
        taskDesc = `Day 1 follow-up. Lead hasn't responded yet. Remind them gently about their inquiry for: "${inquiryAbout}". Keep it short and add a specific value point.`;
    } else if (msgType === 'warm_day3') {
        taskDesc = `Day 3 follow-up. No response in 3 days. Be brief, add social proof or a specific benefit, offer to answer any questions.`;
    } else if (msgType === 'warm_day7') {
        taskDesc = `Day 7 follow-up. Last attempt. Keep it very short — just ask if they still need help, no pressure.`;
    } else if (msgType === 'cold_final') {
        taskDesc = `Final re-engagement after no response for 7+ days. Very brief. Offer to reconnect if timing wasn't right. Then we won't reach out again.`;
    }

    const systemPrompt = `<business>
Name: ${bizName}
Industry: ${industry}
${services ? `Services: ${services}` : ''}
</business>

<lead>
Name: ${leadName || 'unknown'}
Inquiry: ${inquiryAbout}
Status: ${leadState.score || 'new'}
</lead>

<task>
${taskDesc}
</task>

<rules>
- 1-3 sentences MAX — never write a wall of text.
- Sound like a real person, not a script.
- Never use generic phrases like "How can I help you today?"
- Sign off as ${bizName} (just the name, no "Team" or "Staff").
- Output ONLY the SMS text. No labels, no quotes, no preamble.
</rules>`;

    const reply = await aiClient.call({
        modelString: 'anthropic/claude-haiku-4-5-20251001',
        clientApiKeys: {},
        systemPrompt,
        messages: [{ role: 'user', content: 'Write the lead message.' }],
        maxTokens: 150,
        _workerName: 'LeadNurtureAgent',
    });

    return reply || null;
}

// ─── Send lead SMS ────────────────────────────────────────────────────────────
async function sendLeadSMS({ clientConfig, clientLoader, customerPhone, body }) {
    const twilioNum = clientConfig.twilio_number;
    const timezone  = clientConfig.timezone || 'America/Chicago';

    if (!twilioNum) {
        console.log(`[LeadNurtureAgent] No Twilio number for ${clientConfig.id} — skipping`);
        return false;
    }

    // Compliance: opt-out
    try {
        optoutManager.guardOutbound(clientConfig.slug, customerPhone);
    } catch (e) {
        console.log(`[LeadNurtureAgent] Opt-out blocked: ${e.message}`);
        return false;
    }

    // Compliance: TCPA
    if (tcpaChecker.isQuietHours(timezone)) {
        console.log(`[LeadNurtureAgent] TCPA quiet hours — skipping`);
        return false;
    }

    const client = clientLoader ? clientLoader(twilioNum) : null;

    await sender.sendSMS({
        from: twilioNum,
        to: customerPhone,
        body,
        clientSlug: clientConfig.slug,
        clientApiKeys: client?.apiKeys || {},
        clientTimezone: timezone,
    });

    return true;
}

// ─── Handle new lead ──────────────────────────────────────────────────────────
async function handleNewLead({ clientId, clientLoader, customerPhone, customerName, inquiryAbout, source }) {
    console.log(`[LeadNurtureAgent] New lead for client ${clientId}`);

    let clientConfig;
    try {
        clientConfig = await loadClientConfig(clientId);
    } catch (e) {
        console.log(`[LeadNurtureAgent] Client load failed: ${e.message}`);
        return;
    }

    if (clientConfig.workers_paused) {
        console.log(`[LeadNurtureAgent] Workers paused for ${clientId}`);
        return;
    }

    // Create lead record
    const now = new Date().toISOString();
    const leadState = {
        customerName:   customerName || null,
        inquiryAbout:   inquiryAbout || 'your services',
        source:         source || 'unknown',
        score:          'new',
        status:         'active',
        createdAt:      now,
        lastContactAt:  null,
        followupsSent:  0,
        followupDays:   [],
        lastInbound:    null,
        lastInboundAt:  null,
        archived:       false,
        archivedReason: null,
    };

    await setLeadState(clientId, customerPhone, leadState);

    // Send qualification message immediately
    try {
        const body = await generateLeadResponse({
            clientConfig,
            leadState,
            inboundMessage: null,
            msgType: 'qualification',
        });

        if (!body) {
            console.log(`[LeadNurtureAgent] AI returned empty for qualification`);
            return;
        }

        const sent = await sendLeadSMS({ clientConfig, clientLoader, customerPhone, body });
        if (sent) {
            await setLeadState(clientId, customerPhone, {
                ...leadState,
                status: 'contacted',
                lastContactAt: new Date().toISOString(),
                followupsSent: 1,
            });

            await logActivity(clientId, 'lead_qualified_outreach', `Initial qualification sent (${inquiryAbout})`, { source, inquiryAbout });
            await emit('task_completed', {
                workerName: 'LeadNurtureAgent',
                clientSlug: clientConfig.slug,
                summary: 'Lead qualification message sent',
            });
        }
    } catch (e) {
        console.log(`[LeadNurtureAgent] Failed to send qualification: ${e.message}`);
        reportError(clientId, e.message, { phase: 'qualification' });
    }
}

// ─── Handle inbound reply from lead ──────────────────────────────────────────
// Called when an inbound SMS comes from a known lead. Server.js must detect this
// and route to this agent instead of the normal worker flow.
async function handleInboundReply({ clientId, clientLoader, customerPhone, message }) {
    let clientConfig;
    try {
        clientConfig = await loadClientConfig(clientId);
    } catch (e) {
        console.log(`[LeadNurtureAgent] Client load failed: ${e.message}`);
        return null;
    }

    const leadState = await getLeadState(clientId, customerPhone);
    if (!leadState || leadState.archived) {
        console.log(`[LeadNurtureAgent] No active lead for ${clientId} / customer`);
        return null; // Fall through to normal worker routing
    }

    // Hard stop
    if (NOT_INTERESTED_PATTERNS.test(message) || /^stop$/i.test(message.trim())) {
        await setLeadState(clientId, customerPhone, {
            ...leadState,
            archived: true,
            archivedReason: 'not_interested',
            status: 'archived',
            lastInbound: message.slice(0, 100),
            lastInboundAt: new Date().toISOString(),
        });
        await logActivity(clientId, 'lead_archived', 'Lead replied not interested', { reason: 'not_interested' });
        return null; // Opt-out handled by optoutManager in server.js
    }

    // Score the reply
    const newScore = scoreLead(message);

    const updatedState = {
        ...leadState,
        score: newScore,
        lastInbound: message.slice(0, 200),
        lastInboundAt: new Date().toISOString(),
        status: newScore === 'archive' ? 'archived' : 'engaged',
        archived: newScore === 'archive',
        archivedReason: newScore === 'archive' ? 'not_interested' : null,
    };
    await setLeadState(clientId, customerPhone, updatedState);

    if (newScore === 'archive') {
        await logActivity(clientId, 'lead_archived', 'Lead expressed no interest', { reason: 'reply_analysis' });
        return null;
    }

    // Generate AI response for hot/warm
    const msgType = newScore === 'hot' ? 'hot_followup' : 'warm_day1';

    try {
        const body = await generateLeadResponse({
            clientConfig,
            leadState: updatedState,
            inboundMessage: message,
            msgType,
        });

        if (!body) return null;

        const sent = await sendLeadSMS({ clientConfig, clientLoader, customerPhone, body });

        if (sent) {
            await setLeadState(clientId, customerPhone, {
                ...updatedState,
                lastContactAt: new Date().toISOString(),
                followupsSent: (leadState.followupsSent || 0) + 1,
            });

            if (newScore === 'hot') {
                await sendTelegramAlert([
                    `*Hot Lead* — ${clientConfig.business_name}`,
                    `Lead replied with buying signal`,
                    `Inquiry: ${leadState.inquiryAbout}`,
                ].join('\n'));
            }

            await logActivity(clientId, 'lead_reply_handled', `Score: ${newScore}, replied with ${msgType}`, { score: newScore });
        }

        return body;
    } catch (e) {
        console.log(`[LeadNurtureAgent] Reply handling failed: ${e.message}`);
        reportError(clientId, e.message, { phase: 'inbound_reply' });
        return null;
    }
}

// ─── Run scheduled follow-ups for a client ───────────────────────────────────
async function runFollowupsForClient(clientId, clientLoader = null) {
    let clientConfig;
    try {
        clientConfig = await loadClientConfig(clientId);
    } catch (e) {
        console.log(`[LeadNurtureAgent] Client load failed for ${clientId}: ${e.message}`);
        return;
    }

    if (clientConfig.workers_paused) {
        console.log(`[LeadNurtureAgent] Workers paused for ${clientId}`);
        return;
    }

    const now = Date.now();

    // Fetch all active leads for this client
    const { data: leads, error } = await supabase
        .from('agent_state')
        .select('entity_id, state')
        .eq('agent', 'lead_nurture')
        .eq('client_id', clientId)
        .like('entity_id', 'lead:%');

    if (error) {
        console.log(`[LeadNurtureAgent] Supabase query error: ${error.message}`);
        return;
    }

    let followupsSent = 0;

    for (const row of (leads || [])) {
        const leadState = row.state || {};
        if (leadState.archived || leadState.status === 'archived') continue;

        const customerPhone  = row.entity_id.replace('lead:', '');
        const createdAt      = leadState.createdAt ? new Date(leadState.createdAt) : null;
        const lastContactAt  = leadState.lastContactAt ? new Date(leadState.lastContactAt) : null;
        const lastInboundAt  = leadState.lastInboundAt ? new Date(leadState.lastInboundAt) : null;
        const followupDays   = leadState.followupDays || [];

        if (!createdAt) continue;

        const daysSinceCreated = (now - createdAt.getTime()) / (1000 * 60 * 60 * 24);
        const daysSinceContact = lastContactAt ? (now - lastContactAt.getTime()) / (1000 * 60 * 60 * 24) : daysSinceCreated;

        // If lead engaged (replied), skip scheduled sequence — handled in real-time
        if (lastInboundAt && leadState.score === 'hot') continue;

        // Determine next scheduled follow-up
        let msgType = null;
        let dayMark = null;

        for (const day of WARM_FOLLOWUP_DAYS) {
            if (daysSinceCreated >= day && !followupDays.includes(day)) {
                dayMark = day;
                if (day === 1) msgType = 'warm_day1';
                else if (day === 3) msgType = 'warm_day3';
                else if (day === 7) msgType = 'warm_day7';
                break;
            }
        }

        // Cold final: 7+ days, sequence done, still no response
        if (!msgType && daysSinceCreated >= COLD_FINAL_DAY && !leadState.coldFinalSent && !lastInboundAt) {
            msgType = 'cold_final';
        }

        if (!msgType) continue;

        // Don't contact if they replied recently (< 12h)
        if (lastInboundAt && (now - lastInboundAt.getTime()) < 12 * 60 * 60 * 1000) continue;

        try {
            const body = await generateLeadResponse({
                clientConfig,
                leadState,
                inboundMessage: null,
                msgType,
            });

            if (!body) continue;

            const sent = await sendLeadSMS({ clientConfig, clientLoader, customerPhone, body });
            if (!sent) continue;

            const newState = {
                ...leadState,
                lastContactAt: new Date().toISOString(),
                followupsSent: (leadState.followupsSent || 0) + 1,
            };

            if (dayMark) newState.followupDays = [...followupDays, dayMark];
            if (msgType === 'cold_final') {
                newState.coldFinalSent = true;
                newState.status = 'archived';
                newState.archived = true;
                newState.archivedReason = 'cold_final_sent';
            }

            await setLeadState(clientId, customerPhone, newState);
            await logActivity(clientId, 'lead_followup_sent', `${msgType} sent (day ${Math.floor(daysSinceCreated)})`, { msgType, daysSinceCreated: Math.floor(daysSinceCreated) });

            followupsSent++;

        } catch (e) {
            console.log(`[LeadNurtureAgent] Follow-up error for ${clientId}: ${e.message}`);
            reportError(clientId, e.message, { phase: 'followup', msgType });
        }
    }

    console.log(`[LeadNurtureAgent] Done for ${clientId}: ${followupsSent} follow-ups sent`);
    return { followupsSent };
}

// ─── Primary run() export ─────────────────────────────────────────────────────
async function run(clientId, context = {}, clientLoader = null) {
    const { event, customerPhone, customerName, inquiryAbout, source, message } = context;

    if (event === 'new_lead') {
        if (!customerPhone) throw new Error('customerPhone required for new_lead');
        return handleNewLead({ clientId, clientLoader, customerPhone, customerName, inquiryAbout, source });
    }

    if (event === 'run_followups') {
        return runFollowupsForClient(clientId, clientLoader);
    }

    if (event === 'inbound_reply') {
        if (!customerPhone || !message) throw new Error('customerPhone and message required for inbound_reply');
        return handleInboundReply({ clientId, clientLoader, customerPhone, message });
    }

    throw new Error(`Unknown event: ${event}. Use new_lead | run_followups | inbound_reply`);
}

// ─── Standalone CLI entry ─────────────────────────────────────────────────────
if (require.main === module) {
    const args     = process.argv.slice(2);
    const mode     = args[0];
    const clientId = args[1];

    if (!clientId) {
        console.error('Usage: node agents/lead-nurture-agent.js --new <clientId> <phone> <inquiry>');
        console.error('       node agents/lead-nurture-agent.js --followups <clientId>');
        process.exit(1);
    }

    const task = mode === '--new'
        ? handleNewLead({ clientId, clientLoader: null, customerPhone: args[2] || '', customerName: null, inquiryAbout: args[3] || '', source: 'cli' })
        : runFollowupsForClient(clientId, null);

    task
        .then(r => console.log('[LeadNurtureAgent] Done:', JSON.stringify(r || {})))
        .catch(e => {
            console.error('[LeadNurtureAgent] Fatal:', e.message);
            process.exit(1);
        });
}

module.exports = { run, handleNewLead, handleInboundReply, runFollowupsForClient };
