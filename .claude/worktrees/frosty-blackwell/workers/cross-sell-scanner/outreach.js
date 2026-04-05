'use strict';

/**
 * Outreach Generator + Sender
 *
 * 1. Generates personalized outreach messages via Claude
 * 2. Sends SMS alerts to agents via Twilio
 * 3. Records all outreach to Supabase for tracking
 */

const Anthropic = require('@anthropic-ai/sdk');
const twilio    = require('twilio');

// ---------------------------------------------------------------------------
// Message generation via Claude
// ---------------------------------------------------------------------------

/**
 * Generate a personalized agent alert SMS for a cross-sell opportunity.
 * This message goes to the AGENT, not the client.
 *
 * Format: concise, actionable, includes client name + gap + suggested next step.
 * Max 160 chars so it's a single SMS segment.
 */
async function generateAgentAlert({ client, opportunity, agency, apiKey }) {
    const anthropic = new Anthropic({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY });

    const systemPrompt = `You are an AI assistant for GridHand AI, an insurance agency intelligence platform.
Write a SHORT agent alert SMS (under 160 characters) notifying an insurance agent about a cross-sell opportunity.
Format: "[Client Name] | [Gap] | [Action]"
Be specific and actionable. No fluff. No emojis.
Use plain language an agent can act on immediately.`;

    const userPrompt = `Agency: ${agency.name}
Client: ${client.full_name}
Opportunity: ${opportunity.title}
Estimated premium: $${opportunity.estimated_premium?.toLocaleString() || 'N/A'}/yr
Conversion score: ${opportunity.conversion_score}/100
Gap description: ${opportunity.description || ''}

Write the agent alert SMS now.`;

    try {
        const response = await anthropic.messages.create({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 100,
            system:     systemPrompt,
            messages:   [{ role: 'user', content: userPrompt }],
        });
        return response.content[0]?.text?.trim() || buildFallbackAlert(client, opportunity);
    } catch (e) {
        console.error(`[Outreach] Claude alert generation failed: ${e.message}`);
        return buildFallbackAlert(client, opportunity);
    }
}

function buildFallbackAlert(client, opportunity) {
    const name    = client.full_name;
    const title   = opportunity.title?.replace('No ', '').replace(' Insurance', '') || 'Coverage Gap';
    const premium = opportunity.estimated_premium
        ? ` ~$${opportunity.estimated_premium.toLocaleString()}/yr`
        : '';
    return `Cross-sell: ${name} | ${title}${premium} | Review & reach out`;
}

/**
 * Generate a personalized outreach message from the AGENT to the CLIENT.
 * This is a draft the agent can send or customize — not auto-sent to the client.
 */
async function generateClientOutreach({ client, opportunity, agency, apiKey }) {
    const anthropic = new Anthropic({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY });

    const systemPrompt = `You are an experienced insurance agent writing a brief, friendly outreach text message to a client.
Write a SHORT SMS draft (under 200 characters).
Be warm, consultative — not pushy. Position it as a helpful check-in, not a sales pitch.
Include: their name, a brief mention of the gap, and a soft call to action (reply, call, or schedule a review).
Sign off with the agency name. No emojis unless the agency uses them.`;

    const userPrompt = `Agency: ${agency.name}
Client: ${client.full_name}
Coverage gap: ${opportunity.title}
Why this matters: ${opportunity.description}
Estimated new premium: $${opportunity.estimated_premium?.toLocaleString() || 'varies'}/yr

Write the client SMS draft now.`;

    try {
        const response = await anthropic.messages.create({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 150,
            system:     systemPrompt,
            messages:   [{ role: 'user', content: userPrompt }],
        });
        return response.content[0]?.text?.trim() || buildFallbackClientMessage(client, opportunity, agency);
    } catch (e) {
        console.error(`[Outreach] Claude client message generation failed: ${e.message}`);
        return buildFallbackClientMessage(client, opportunity, agency);
    }
}

function buildFallbackClientMessage(client, opportunity, agency) {
    const firstName = client.full_name?.split(' ')[0] || 'there';
    return `Hi ${firstName}, this is ${agency.name}. We noticed you may have a gap in your coverage — ${opportunity.title}. Worth a quick review? Reply or call us anytime.`;
}

// ---------------------------------------------------------------------------
// SMS delivery via Twilio
// ---------------------------------------------------------------------------

function getTwilioClient(agency) {
    const sid   = agency.twilio_account_sid || process.env.TWILIO_ACCOUNT_SID;
    const token = agency.twilio_auth_token  || process.env.TWILIO_AUTH_TOKEN;

    if (!sid || !token) {
        throw new Error(`Twilio credentials missing for agency: ${agency.slug}`);
    }
    return twilio(sid, token);
}

/**
 * Send an agent alert SMS.
 * Returns the Twilio SID on success.
 */
async function sendAgentAlert({ agency, messageBody }) {
    const agentPhone   = agency.agent_phone;
    const twilioNumber = agency.twilio_number;

    if (!agentPhone) throw new Error(`No agent_phone configured for agency: ${agency.slug}`);
    if (!twilioNumber) throw new Error(`No twilio_number configured for agency: ${agency.slug}`);

    const client = getTwilioClient(agency);
    const msg    = await client.messages.create({
        body: messageBody,
        from: twilioNumber,
        to:   agentPhone,
    });

    console.log(`[Outreach] Agent alert sent → ${agentPhone} | SID: ${msg.sid}`);
    return msg.sid;
}

// ---------------------------------------------------------------------------
// Supabase tracking helpers
// ---------------------------------------------------------------------------

function buildOutreachRecord({ agencyId, opportunityId, clientId, messageBody, sentTo, twilioSid }) {
    return {
        agency_id:      agencyId,
        opportunity_id: opportunityId,
        client_id:      clientId,
        channel:        'sms',
        message_body:   messageBody,
        sent_to:        sentTo,
        sent_at:        new Date().toISOString(),
        twilio_sid:     twilioSid || null,
        delivered:      null,
        opened:         false,
        replied:        false,
    };
}

// ---------------------------------------------------------------------------
// High-level orchestration
// ---------------------------------------------------------------------------

/**
 * Process a single opportunity end-to-end:
 *   1. Generate agent alert
 *   2. Send SMS to agent
 *   3. Generate client outreach draft
 *   4. Return records to be persisted by the caller (jobs.js handles DB writes)
 */
async function processOpportunity({ agency, client, opportunity, supabase }) {
    const apiKey = agency.anthropic_api_key || process.env.ANTHROPIC_API_KEY;

    // 1. Generate agent alert
    const agentAlertBody = await generateAgentAlert({ client, opportunity, agency, apiKey });

    // 2. Send SMS to agent
    let twilioSid = null;
    try {
        twilioSid = await sendAgentAlert({ agency, messageBody: agentAlertBody });
    } catch (e) {
        console.error(`[Outreach] SMS send failed for opp ${opportunity.id}: ${e.message}`);
    }

    // 3. Generate client outreach draft (stored for agent to review/send)
    const clientDraft = await generateClientOutreach({ client, opportunity, agency, apiKey });

    // 4. Build outreach log record
    const outreachRecord = buildOutreachRecord({
        agencyId:      opportunity.agency_id,
        opportunityId: opportunity.id,
        clientId:      opportunity.client_id,
        messageBody:   agentAlertBody,
        sentTo:        agency.agent_phone,
        twilioSid,
    });

    // 5. Save to Supabase
    if (supabase) {
        const { error } = await supabase
            .from('css_outreach_log')
            .insert(outreachRecord);

        if (error) console.error(`[Outreach] DB insert failed: ${error.message}`);

        // Update opportunity status to outreach_sent
        await supabase
            .from('css_opportunities')
            .update({ status: 'outreach_sent', updated_at: new Date().toISOString() })
            .eq('id', opportunity.id);
    }

    return { agentAlertBody, clientDraft, outreachRecord, twilioSid };
}

/**
 * Bulk outreach for top N opportunities.
 * Used by the daily scan job.
 */
async function sendBulkAlerts({ agency, opportunities, supabase, maxAlerts = 5 }) {
    const toProcess = opportunities.slice(0, maxAlerts);
    const results   = [];

    for (const { opportunity, client } of toProcess) {
        try {
            const result = await processOpportunity({ agency, client, opportunity, supabase });
            results.push({ success: true, opportunityId: opportunity.id, ...result });
        } catch (e) {
            console.error(`[Outreach] Failed opp ${opportunity.id}: ${e.message}`);
            results.push({ success: false, opportunityId: opportunity.id, error: e.message });
        }
    }

    console.log(`[Outreach] Sent ${results.filter(r => r.success).length}/${toProcess.length} alerts for ${agency.slug}`);
    return results;
}

module.exports = {
    generateAgentAlert,
    generateClientOutreach,
    sendAgentAlert,
    processOpportunity,
    sendBulkAlerts,
};
