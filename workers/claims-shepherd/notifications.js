/**
 * GRIDHAND AI — Claims Shepherd
 * Notification Logic
 *
 * Handles:
 *   - Client (insured) SMS updates at each claim stage
 *   - Agent SMS alerts on status changes or required actions
 *   - Document collection request texts
 *   - AI-powered inbound SMS routing for claim-related replies
 */

'use strict';

const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const filing = require('./filing');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ============================================================
// TWILIO CLIENT (per-client credentials)
// ============================================================

function getTwilioClient(clientConfig) {
    const sid = clientConfig.twilio_sid || process.env.TWILIO_ACCOUNT_SID;
    const token = clientConfig.twilio_token || process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error('Missing Twilio credentials');
    return twilio(sid, token);
}

async function sendSMS(clientConfig, to, body, claimId = null) {
    if (!to || !body) return { ok: false, error: 'Missing to or body' };

    try {
        const twilioClient = getTwilioClient(clientConfig);
        const msg = await twilioClient.messages.create({
            from: clientConfig.twilio_number,
            to,
            body
        });

        // Log to sms_conversations
        await supabase.from('cs_sms_conversations').insert({
            client_id: clientConfig.id,
            claim_id: claimId,
            phone_number: to,
            direction: 'outbound',
            body,
            twilio_sid: msg.sid
        });

        return { ok: true, sid: msg.sid };
    } catch (err) {
        console.error('[Notifications] sendSMS error:', err.message);
        return { ok: false, error: err.message };
    }
}

// ============================================================
// CLIENT (INSURED) SMS MESSAGES — One per claim stage
// ============================================================

const CLIENT_MESSAGES = {
    detected: (claim, agencyName) =>
        `Hi ${firstName(claim.insured_name)}, ${agencyName} received your claim for policy ${claim.policy_number}. We're reviewing it now and will file with ${claim.carrier_name} shortly. Questions? Reply anytime. Ref: ${claim.internal_ref}`,

    fnol_filed: (claim, agencyName) =>
        `Good news — we've filed your ${claim.carrier_name} claim (Ref: ${claim.internal_ref}). They'll assign an adjuster soon. We'll update you at each step. Hang tight!`,

    fnol_filed_email: (claim, agencyName) =>
        `We've submitted your claim to ${claim.carrier_name} via email (Ref: ${claim.internal_ref}). Once they confirm your claim number, we'll send it right over.`,

    acknowledged: (claim, agencyName) =>
        `${claim.carrier_name} confirmed your claim! Your claim number is ${claim.claim_number || 'being assigned'}. Ref: ${claim.internal_ref}. We'll notify you when an adjuster is assigned.`,

    assigned: (claim, agencyName) =>
        `Your adjuster has been assigned${claim.adjuster_name ? ` — ${claim.adjuster_name}` : ''}${claim.adjuster_phone ? ` (${claim.adjuster_phone})` : ''}. They may contact you directly. Ref: ${claim.internal_ref}`,

    docs_requested: (claim, agencyName) =>
        `${claim.carrier_name} needs documents for your claim. ${agencyName} will text you shortly with a list. Please gather these as quickly as possible to keep your claim moving. Ref: ${claim.internal_ref}`,

    docs_received: (claim, agencyName) =>
        `Got it — your documents have been received and submitted to ${claim.carrier_name} for claim ${claim.claim_number || claim.internal_ref}. We'll update you on next steps.`,

    investigating: (claim, agencyName) =>
        `${claim.carrier_name} is actively reviewing your claim (${claim.claim_number || claim.internal_ref}). This typically takes 5-10 business days. We're watching it for you.`,

    appraised: (claim, agencyName) =>
        `The appraisal for your claim is complete! ${claim.carrier_name} will provide their settlement offer soon. Ref: ${claim.internal_ref}`,

    negotiating: (claim, agencyName) =>
        `${claim.carrier_name} has issued a settlement offer on claim ${claim.claim_number || claim.internal_ref}. Your agent will review it and be in touch soon.`,

    approved: (claim, agencyName) =>
        `Great news — your claim has been approved by ${claim.carrier_name}! Payment should be issued within 5-7 business days. Ref: ${claim.internal_ref}`,

    paid: (claim, agencyName) =>
        `Your claim payment has been issued by ${claim.carrier_name}. If you don't receive it within 7 days, reply here or call us. Ref: ${claim.internal_ref}. How would you rate your experience? Reply 1-5.`,

    closed: (claim, agencyName) =>
        `Your claim (${claim.claim_number || claim.internal_ref}) has been closed. If you have any questions or the issue resurfaces, don't hesitate to reach out. Thank you for trusting ${agencyName}.`,

    denied: (claim, agencyName) =>
        `We're sorry — ${claim.carrier_name} has denied your claim. Your agent will reach out to explain your options. You have the right to appeal. Ref: ${claim.internal_ref}`,

    on_hold: (claim, agencyName) =>
        `Your claim (${claim.internal_ref}) is temporarily on hold pending additional review. Your agent has been notified and will reach out to you shortly.`
};

/**
 * Send a status-based update SMS to the insured
 */
async function sendClientStatusUpdate(clientConfig, claim) {
    const agencyName = clientConfig.agency_name || 'Your Insurance Agency';
    const messageFn = CLIENT_MESSAGES[claim.status];

    if (!messageFn) {
        console.warn(`[Notifications] No client message template for status: ${claim.status}`);
        return { ok: false, error: 'No template for status' };
    }

    const body = messageFn(claim, agencyName);
    const result = await sendSMS(clientConfig, claim.insured_phone, body, claim.id);

    if (result.ok) {
        // Record last_client_update timestamp
        await supabase
            .from('cs_claims')
            .update({ last_client_update: new Date().toISOString() })
            .eq('id', claim.id);

        await filing.logEvent(claim.id, clientConfig.id, 'client_sms_sent', {
            status: claim.status,
            message: body
        });
    }

    return result;
}

// ============================================================
// AGENT SMS ALERTS
// ============================================================

const AGENT_MESSAGES = {
    new_claim: (claim) =>
        `[Claims Shepherd] New claim detected: ${claim.insured_name} — ${claim.carrier_name} — Policy ${claim.policy_number}. Loss: ${claim.loss_description?.substring(0, 80)}... Ref: ${claim.internal_ref}`,

    fnol_filed: (claim) =>
        `[Claims Shepherd] FNOL filed with ${claim.carrier_name} for ${claim.insured_name}. Claim #: ${claim.claim_number || 'pending'}. Ref: ${claim.internal_ref}`,

    fnol_email_sent: (claim) =>
        `[Claims Shepherd] FNOL emailed to ${claim.carrier_name} for ${claim.insured_name} (no API available). Watch for confirmation email. Ref: ${claim.internal_ref}`,

    manual_required: (claim, instructions) =>
        `[Claims Shepherd] ACTION NEEDED: ${claim.carrier_name} requires manual FNOL filing for ${claim.insured_name}. ${instructions} Ref: ${claim.internal_ref}`,

    status_change: (claim, prevStatus) =>
        `[Claims Shepherd] Status update: ${claim.insured_name}'s ${claim.carrier_name} claim moved ${prevStatus} → ${claim.status}. Claim #: ${claim.claim_number || 'N/A'}. Ref: ${claim.internal_ref}`,

    needs_action: (claim, reason) =>
        `[Claims Shepherd] ACTION REQUIRED: ${claim.insured_name} (${claim.carrier_name}). Reason: ${reason}. Ref: ${claim.internal_ref}`,

    denied: (claim) =>
        `[Claims Shepherd] Claim DENIED: ${claim.insured_name} — ${claim.carrier_name} — Policy ${claim.policy_number}. Ref: ${claim.internal_ref}. Client notified. Please review appeal options.`,

    docs_overdue: (claim, overdueCount) =>
        `[Claims Shepherd] ${overdueCount} document(s) overdue for ${claim.insured_name}'s claim. Ref: ${claim.internal_ref}. Client has been reminded.`,

    weekly_report: (stats, agencyName) =>
        `[Claims Shepherd] Weekly Report for ${agencyName}:\n• Open: ${stats.open}\n• New this week: ${stats.newThisWeek}\n• Closed: ${stats.closedThisWeek}\n• Need action: ${stats.needsAction}\n• Avg resolution: ${stats.avgDays || 'N/A'} days\nFull report: ${stats.reportUrl || 'Check dashboard'}`
};

/**
 * Send an alert to the agent
 */
async function alertAgent(clientConfig, messageType, claim, extra) {
    const agentPhone = clientConfig.agent_phone;
    if (!agentPhone) {
        console.warn('[Notifications] No agent_phone configured for client:', clientConfig.slug);
        return { ok: false, error: 'No agent_phone configured' };
    }

    const messageFn = AGENT_MESSAGES[messageType];
    if (!messageFn) {
        return { ok: false, error: `Unknown message type: ${messageType}` };
    }

    const body = messageFn(claim, extra);
    const result = await sendSMS(clientConfig, agentPhone, body, claim?.id || null);

    if (result.ok && claim) {
        await supabase
            .from('cs_claims')
            .update({ last_agent_alert: new Date().toISOString() })
            .eq('id', claim.id);

        await filing.logEvent(claim.id, clientConfig.id, 'agent_alert_sent', {
            type: messageType,
            message: body
        });
    }

    return result;
}

/**
 * Send weekly report SMS to agent
 */
async function sendWeeklyReportSMS(clientConfig, stats) {
    const agentPhone = clientConfig.agent_phone;
    if (!agentPhone) return { ok: false, error: 'No agent_phone configured' };

    const agencyName = clientConfig.agency_name || 'Your Agency';
    const body = AGENT_MESSAGES.weekly_report(stats, agencyName);
    return sendSMS(clientConfig, agentPhone, body);
}

// ============================================================
// DOCUMENT REQUEST SMS
// ============================================================

/**
 * Send a document collection request to the insured
 * Tracks how many times we've asked
 */
async function sendDocumentRequest(clientConfig, claim, missingDocTypes) {
    const agencyName = clientConfig.agency_name || 'Your Insurance Agency';
    const body = filing.buildDocumentRequestSMS(claim, missingDocTypes, agencyName);

    const result = await sendSMS(clientConfig, claim.insured_phone, body, claim.id);

    if (result.ok) {
        // Update request tracking on each document
        for (const docType of missingDocTypes) {
            await supabase
                .from('cs_claim_documents')
                .update({
                    request_sent_to: claim.insured_phone,
                    last_sms_request: new Date().toISOString()
                })
                .eq('claim_id', claim.id)
                .eq('doc_type', docType);

            await supabase.rpc('increment_doc_request_count', {
                p_claim_id: claim.id,
                p_doc_type: docType
            }).catch(() => null); // Non-critical if RPC doesn't exist
        }

        await filing.logEvent(claim.id, clientConfig.id, 'document_requested', {
            docs: missingDocTypes,
            sentTo: claim.insured_phone
        });
    }

    return result;
}

// ============================================================
// INBOUND SMS HANDLER
// AI-powered routing for replies from insured clients
// ============================================================

const INTENT_PATTERNS = {
    status_inquiry: ['status', 'update', 'whats happening', "what's happening", 'where is', 'how is', 'any news', 'check on'],
    document_submit: ['photo', 'picture', 'attached', 'sending', 'here it is', 'got the'],
    confirmation: ['yes', 'ok', 'okay', 'got it', 'understood', 'thanks', 'thank you', 'sounds good'],
    complaint: ['frustrated', 'angry', 'this is wrong', 'unacceptable', 'lawsuit', 'attorney', 'terrible'],
    question: ['?', 'how long', 'when will', 'why', 'what does', 'can i', 'should i'],
    satisfaction: ['1', '2', '3', '4', '5']
};

function detectIntent(text) {
    const lower = text.toLowerCase();
    for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
        if (patterns.some(p => lower.includes(p))) return intent;
    }
    return 'general';
}

/**
 * Handle an inbound SMS from an insured client
 * This is called from the main webhook route in index.js
 */
async function handleInboundSMS(clientConfig, from, body, mediaUrls = []) {
    // Log the inbound message
    const activeClaim = await filing.getClaimsByPhone(clientConfig.id, from);

    await supabase.from('cs_sms_conversations').insert({
        client_id: clientConfig.id,
        claim_id: activeClaim?.id || null,
        phone_number: from,
        direction: 'inbound',
        body,
        media_urls: mediaUrls
    });

    await filing.logEvent(activeClaim?.id || null, clientConfig.id, 'client_sms_received', {
        from,
        body: body.substring(0, 500),
        mediaCount: mediaUrls.length
    });

    const intent = detectIntent(body);

    // Handle photo/document submission
    if (mediaUrls.length > 0 && activeClaim) {
        for (const url of mediaUrls) {
            await filing.markDocumentReceived(activeClaim.id, 'photos', url);
        }
        const reply = `Thank you! We've received your photo(s) and submitted them for your claim. Ref: ${activeClaim.internal_ref}`;
        return sendSMS(clientConfig, from, reply, activeClaim?.id);
    }

    // Satisfaction score after claim paid/closed
    if (intent === 'satisfaction' && activeClaim && ['paid', 'closed'].includes(activeClaim.status)) {
        const score = parseInt(body.trim());
        if (score >= 1 && score <= 5) {
            await supabase
                .from('cs_claims')
                .update({ client_satisfaction: score })
                .eq('id', activeClaim.id);
            const reply = score >= 4
                ? `Thank you for the great rating! We're glad we could help. Don't hesitate to reach out anytime.`
                : `Thank you for your feedback. We're sorry the experience wasn't better. Your agent will follow up.`;
            return sendSMS(clientConfig, from, reply, activeClaim?.id);
        }
    }

    // Status inquiry
    if (intent === 'status_inquiry') {
        if (activeClaim) {
            const statusText = formatStatusForClient(activeClaim.status);
            const reply = `Hi! Your ${activeClaim.carrier_name} claim (${activeClaim.internal_ref}) is currently: ${statusText}. We'll text you as soon as there's an update. Questions? Reply anytime.`;
            return sendSMS(clientConfig, from, reply, activeClaim.id);
        } else {
            const reply = `Hi! I don't see an active claim linked to your number. Please call your agent directly or provide your policy number and we'll look it up.`;
            return sendSMS(clientConfig, from, reply);
        }
    }

    // Escalate complaints to agent
    if (intent === 'complaint') {
        if (activeClaim) {
            await filing.flagForAgentAction(activeClaim.id, `Client expressed frustration: "${body.substring(0, 100)}"`);
            await alertAgent(clientConfig, 'needs_action', activeClaim, `Client complaint: "${body.substring(0, 100)}"`);
        }
        const reply = `I hear you, and I'm sorry for the frustration. Your agent has been notified and will reach out to you personally very soon.`;
        return sendSMS(clientConfig, from, reply, activeClaim?.id);
    }

    // New claim report via SMS
    if (filing.isFNOLText(body) && !activeClaim) {
        const agencyName = clientConfig.agency_name || 'your agent';
        const reply = `It sounds like you may need to report a new claim. Please reply with your policy number and we'll get this started for you. Or call ${agencyName} directly.`;
        return sendSMS(clientConfig, from, reply);
    }

    // General fallback — use Claude for a smart reply
    return handleWithAI(clientConfig, from, body, activeClaim);
}

/**
 * AI-powered response for general/complex inbound messages
 */
async function handleWithAI(clientConfig, from, message, activeClaim) {
    const apiKey = clientConfig.anthropic_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        const fallback = `Thanks for your message. Your agent will follow up with you shortly.`;
        return sendSMS(clientConfig, from, fallback, activeClaim?.id);
    }

    const client = new Anthropic({ apiKey });
    const agencyName = clientConfig.agency_name || 'your insurance agency';

    const claimContext = activeClaim
        ? `Active claim: ${activeClaim.carrier_name}, Policy ${activeClaim.policy_number}, Status: ${activeClaim.status}, Ref: ${activeClaim.internal_ref}`
        : 'No active claim on file for this number.';

    const systemPrompt = `You are a professional insurance claims assistant for ${agencyName}.
A client just texted. Respond helpfully and briefly (2-3 sentences max).
Never make up claim numbers or amounts. Be empathetic and professional.
${claimContext}
If you cannot answer, tell them their agent will follow up.`;

    try {
        const response = await client.messages.create({
            model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
            max_tokens: 150,
            messages: [
                { role: 'user', content: message }
            ],
            system: systemPrompt
        });

        const reply = response.content[0]?.text?.trim() || `Thanks for reaching out. Your agent will follow up shortly.`;
        return sendSMS(clientConfig, from, reply, activeClaim?.id);
    } catch (err) {
        console.error('[Notifications] AI reply error:', err.message);
        const fallback = `Thanks for your message! Your agent will follow up with you shortly. Ref: ${activeClaim?.internal_ref || 'N/A'}`;
        return sendSMS(clientConfig, from, fallback, activeClaim?.id);
    }
}

// ============================================================
// HELPERS
// ============================================================

function firstName(fullName) {
    return fullName?.split(' ')[0] || 'there';
}

function formatStatusForClient(status) {
    const STATUS_LABELS = {
        detected: 'received and being processed',
        fnol_pending: 'being filed with your carrier',
        fnol_filed: 'filed with your carrier (awaiting confirmation)',
        acknowledged: 'acknowledged by your carrier',
        assigned: 'assigned to an adjuster',
        investigating: 'under active investigation',
        docs_requested: 'waiting on required documents',
        docs_received: 'documents received and under review',
        appraised: 'appraised — settlement offer coming soon',
        negotiating: 'in settlement negotiation',
        approved: 'approved — payment being processed',
        paid: 'paid and complete',
        closed: 'closed',
        denied: 'denied (speak to your agent about options)',
        disputed: 'under dispute resolution',
        on_hold: 'temporarily on hold'
    };
    return STATUS_LABELS[status] || status.replace(/_/g, ' ');
}

module.exports = {
    sendSMS,
    sendClientStatusUpdate,
    alertAgent,
    sendWeeklyReportSMS,
    sendDocumentRequest,
    handleInboundSMS,
    handleWithAI,
    formatStatusForClient,
    CLIENT_MESSAGES,
    AGENT_MESSAGES
};
