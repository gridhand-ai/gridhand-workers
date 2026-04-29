/**
 * GRIDHAND Lead Incubator — Main Express Server
 *
 * AI-powered real estate lead qualification and nurturing.
 * Responds to new leads within 60 seconds, runs drip campaigns,
 * qualifies leads via Claude, and sends morning digests to agents.
 *
 * Routes:
 *   GET  /                                   → health check
 *   POST /webhooks/followupboss              → FUB new lead webhook (HMAC-SHA256 verified)
 *   POST /webhooks/twilio                    → Inbound SMS from leads (TwiML response)
 *   POST /trigger/qualify-lead               → manually qualify a lead
 *   POST /trigger/drip-campaign              → start drip campaign for a lead
 *   POST /trigger/morning-digest             → send morning digest to agent
 *   GET  /leads/:clientSlug                  → list leads (status, source, limit, offset)
 *   GET  /leads/:clientSlug/:leadId          → single lead detail
 *   GET  /stats/:clientSlug                  → lead pipeline stats
 *
 * Environment vars required:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 *   REDIS_URL                  (Bull queue backend)
 *   GRIDHAND_API_KEY           (protects admin endpoints)
 *   FUB_WEBHOOK_SECRET         (HMAC-SHA256 verification for Follow Up Boss)
 *   PORT                       (default: 3004)
 */

'use strict';

require('dotenv').config();

const express = require('express');
const crypto  = require('crypto');
const cron    = require('node-cron');
const { validateRequest } = require('twilio/lib/webhooks/webhooks');
const fub     = require('./followupboss');
const nurture = require('./nurture');
const jobs    = require('./jobs');
const db      = require('./db');

const app = express();

// Raw body for FUB webhook HMAC verification — must come before express.json()
app.use('/webhooks/followupboss', express.raw({ type: '*/*' }));

app.use(express.urlencoded({ extended: false })); // for Twilio TwiML
app.use(express.json());

// ─── Auth Middleware ───────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
    const serverKey = process.env.GRIDHAND_API_KEY;
    if (!serverKey) return res.status(503).json({ error: 'GRIDHAND_API_KEY not configured' });
    const provided = (req.headers['authorization'] || '').replace('Bearer ', '');
    if (provided !== serverKey) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.json({
        worker:       'Lead Incubator',
        version:      '1.0.0',
        status:       'online',
        jobs:         [
            'immediate-response',
            'qualify-lead',
            'drip-step',
            'morning-digest',
            'schedule-showing',
        ],
        integrations: ['Follow Up Boss', 'Zillow', 'Twilio'],
    });
});

// ─── Follow Up Boss Webhook ────────────────────────────────────────────────────
// FUB sends a POST when a new lead comes in. We verify the HMAC-SHA256 signature,
// ACK immediately, then process async to stay within FUB's 3-second timeout.

app.post('/webhooks/followupboss', async (req, res) => {
    const signature = req.headers['x-fub-signature'] || '';
    const rawBody   = req.body; // Buffer from express.raw()

    const secret = process.env.FUB_WEBHOOK_SECRET;
    if (!secret) {
        console.warn('[FUBWebhook] FUB_WEBHOOK_SECRET not set — rejecting');
        return res.status(503).json({ error: 'Webhook secret not configured' });
    }

    if (!fub.verifyWebhookSignature(rawBody, signature, secret)) {
        console.warn('[FUBWebhook] Invalid signature — rejected');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    // Fast ACK — FUB requires response within 3 seconds
    res.status(200).json({ received: true });

    let payload;
    try {
        payload = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
        console.error(`[FUBWebhook] Failed to parse body: ${err.message}`);
        return;
    }

    setImmediate(async () => {
        try {
            // FUB sends event type in payload — only handle new people/leads
            const eventType = payload.event || payload.type || 'person.created';
            if (!eventType.includes('person') && !eventType.includes('lead')) {
                console.log(`[FUBWebhook] Ignoring event type: ${eventType}`);
                return;
            }

            const person = payload.person || payload.data || payload;

            if (!person || !person.id) {
                console.warn('[FUBWebhook] No person data in payload');
                return;
            }

            // Determine which client this belongs to via the FUB team/system user
            // In production, map FUB system user or tag to client_slug
            // For now we look up the client whose fub_team_id matches the payload
            const teamId = payload.system?.teamId || payload.teamId || null;
            const client = await db.getClientByFubTeamId(teamId);
            if (!client) {
                console.warn(`[FUBWebhook] No client matched for teamId: ${teamId}`);
                return;
            }

            // Normalize FUB person into our lead schema
            const phones = (person.phones || []).find(p => p.value) || {};
            const emails = (person.emails || []).find(e => e.value) || {};

            if (!phones.value) {
                console.log(`[FUBWebhook] Lead ${person.id} has no phone — skipping`);
                return;
            }

            const leadData = {
                client_id:        client.id,
                fub_person_id:    String(person.id),
                name:             person.name || `${person.firstName || ''} ${person.lastName || ''}`.trim() || 'Unknown',
                phone:            phones.value,
                email:            emails.value || null,
                source:           person.source?.name || person.sourceUrl || null,
                inquiry:          person.message || person.tags?.join(', ') || null,
                budget_min:       person.price?.min || null,
                budget_max:       person.price?.max || null,
                timeline:         person.timeline || null,
                desired_location: person.addresses?.[0]?.city || null,
                bedrooms:         person.beds || null,
                fub_raw:          person,
                status:           'new',
            };

            const lead = await db.upsertLead(leadData);
            console.log(`[FUBWebhook] Upserted lead ${lead.id} (${lead.name}) for client ${client.client_slug}`);

            // Queue immediate response — target under 60 seconds
            await jobs.dispatchImmediateResponse(lead.id, client.id);

            // Queue qualification scoring
            await jobs.dispatchQualifyLead(lead.id, client.id);

        } catch (err) {
            console.error(`[FUBWebhook] Processing error: ${err.message}`, err.stack);
        }
    });
});

// ─── Twilio Inbound SMS Webhook ────────────────────────────────────────────────
// Twilio POSTs here when a lead replies to an SMS. We respond with TwiML.

app.post('/webhooks/twilio', async (req, res) => {
    // In production: validate Twilio signature
    if (process.env.NODE_ENV === 'production') {
        const twilioSignature = req.headers['x-twilio-signature'] || '';
        const authToken       = process.env.TWILIO_AUTH_TOKEN;
        const webhookUrl      = process.env.TWILIO_WEBHOOK_URL; // full public URL of this endpoint

        if (authToken && webhookUrl) {
            const isValid = validateRequest(authToken, twilioSignature, webhookUrl, req.body);
            if (!isValid) {
                console.warn('[TwilioWebhook] Invalid Twilio signature — rejected');
                res.set('Content-Type', 'text/xml');
                return res.status(403).send('<Response></Response>');
            }
        }
    }

    const inboundBody = req.body.Body || '';
    const fromNumber  = req.body.From || '';

    if (!fromNumber) {
        res.set('Content-Type', 'text/xml');
        return res.send('<Response></Response>');
    }

    let responseText = '';

    try {
        // Find which lead this phone belongs to
        const lead = await db.getLeadByPhone(fromNumber);

        if (!lead) {
            console.log(`[TwilioWebhook] Unknown number ${fromNumber} — no lead found`);
            responseText = '';
        } else {
            // Log inbound message
            await db.logConversation({
                lead_id:   lead.id,
                client_id: lead.client_id,
                direction: 'inbound',
                message:   inboundBody,
            });

            // Update lead's last_inbound timestamp
            await db.updateLeadLastInbound(lead.id);

            // Use AI to handle the reply
            const { response, intent, shouldSchedule } = await nurture.handleReply(lead, inboundBody);

            responseText = response;

            // Log AI's outbound response
            await db.logConversation({
                lead_id:   lead.id,
                client_id: lead.client_id,
                direction: 'outbound',
                message:   response,
                intent,
            });

            // If lead wants to schedule a showing, queue it
            if (shouldSchedule) {
                await jobs.dispatchScheduleShowing(lead.id, lead.client_id);
            }

            // Update lead status based on intent
            if (intent === 'not_interested') {
                await db.updateLeadStatus(lead.id, 'cold');
            } else if (intent === 'schedule' || shouldSchedule) {
                await db.updateLeadStatus(lead.id, 'scheduled');
            } else if (lead.status === 'new' || lead.status === 'contacted') {
                await db.updateLeadStatus(lead.id, 'qualifying');
            }
        }
    } catch (err) {
        console.error(`[TwilioWebhook] Error handling reply from ${fromNumber}: ${err.message}`);
        responseText = 'Thanks for your message! I\'ll have an agent reach out to you shortly.';
    }

    res.set('Content-Type', 'text/xml');
    if (responseText) {
        res.send(`<Response><Message>${escapeXml(responseText)}</Message></Response>`);
    } else {
        res.send('<Response></Response>');
    }
});

// ─── Manual Trigger Endpoints ─────────────────────────────────────────────────

app.post('/trigger/qualify-lead', requireApiKey, async (req, res) => {
    const { lead_id, client_id } = req.body;
    if (!lead_id || !client_id) {
        return res.status(400).json({ error: 'lead_id and client_id required' });
    }

    try {
        const job = await jobs.dispatchQualifyLead(lead_id, client_id);
        res.json({ success: true, jobId: job.id, lead_id, client_id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/drip-campaign', requireApiKey, async (req, res) => {
    const { lead_id, client_id } = req.body;
    if (!lead_id || !client_id) {
        return res.status(400).json({ error: 'lead_id and client_id required' });
    }

    try {
        const job = await jobs.dispatchDripStep(lead_id, client_id, 1);
        res.json({ success: true, jobId: job.id, lead_id, client_id, step: 1 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/morning-digest', requireApiKey, async (req, res) => {
    const { client_id } = req.body;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });

    try {
        const job = await jobs.dispatchMorningDigest(client_id);
        res.json({ success: true, jobId: job.id, client_id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Lead Data Endpoints ───────────────────────────────────────────────────────

app.get('/leads/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { status, source, limit = 50, offset = 0 } = req.query;

    try {
        const client = await db.getClientBySlug(clientSlug);
        if (!client) return res.status(404).json({ error: `No client found: ${clientSlug}` });

        const leads = await db.getLeads(client.id, {
            status: status || null,
            source: source || null,
            limit:  parseInt(limit),
            offset: parseInt(offset),
        });

        res.json({ clientSlug, total: leads.length, leads });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/leads/:clientSlug/:leadId', requireApiKey, async (req, res) => {
    const { clientSlug, leadId } = req.params;

    try {
        const client = await db.getClientBySlug(clientSlug);
        if (!client) return res.status(404).json({ error: `No client found: ${clientSlug}` });

        const lead = await db.getLeadById(leadId);
        if (!lead || lead.client_id !== client.id) {
            return res.status(404).json({ error: `Lead not found: ${leadId}` });
        }

        const conversations = await db.getLeadConversations(leadId);
        const dripLog       = await db.getLeadDripLog(leadId);

        res.json({ lead, conversations, dripLog });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/stats/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;

    try {
        const client = await db.getClientBySlug(clientSlug);
        if (!client) return res.status(404).json({ error: `No client found: ${clientSlug}` });

        const stats = await db.getLeadStats(client.id);
        res.json({ clientSlug, stats });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Cron Schedules ────────────────────────────────────────────────────────────

// Morning digest — 8:00 AM Chicago daily
cron.schedule('0 8 * * *', async () => {
    console.log('[Cron] Sending morning digest to all clients...');
    await jobs.runForAllClients(jobs.dispatchMorningDigest);
}, { timezone: 'America/Chicago' });

// Drip campaign check — 9:00 AM Chicago daily (find leads with no drip started)
cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] Checking for leads needing drip campaign start...');
    try {
        const leads = await db.getLeadsNeedingDripStart();
        for (const lead of leads) {
            await jobs.dispatchDripStep(lead.id, lead.client_id, 1);
            console.log(`[Cron] Started drip for lead ${lead.id} (${lead.name})`);
        }
    } catch (err) {
        console.error(`[Cron] Drip start check failed: ${err.message}`);
    }
}, { timezone: 'America/Chicago' });

// Cold lead re-engagement — Mondays 10:00 AM Chicago
cron.schedule('0 10 * * 1', async () => {
    console.log('[Cron] Running cold lead re-engagement...');
    try {
        const coldLeads = await db.getColdLeadsForReengagement(30);
        for (const lead of coldLeads) {
            await jobs.dispatchDripStep(lead.id, lead.client_id, 1);
            console.log(`[Cron] Re-engaging cold lead ${lead.id} (${lead.name})`);
        }
    } catch (err) {
        console.error(`[Cron] Cold re-engagement failed: ${err.message}`);
    }
}, { timezone: 'America/Chicago' });

// ─── Utility ──────────────────────────────────────────────────────────────────

function escapeXml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3004;
app.listen(PORT, () => {
    console.log(`[LeadIncubator] Online — port ${PORT}`);
    console.log(`[LeadIncubator] Crons: morning digest @ 8am | drip check @ 9am | cold re-engage @ Mon 10am`);
});
