/**
 * GRIDHAND Lead Incubator — Bull Queue Job Definitions
 *
 * Queues:
 *  li:immediate-response  → Respond to new lead within 60 seconds via SMS
 *  li:qualify-lead        → AI qualification scoring (score + tier)
 *  li:drip-step           → Execute one drip campaign step and schedule next
 *  li:morning-digest      → Daily briefing SMS to agent
 *  li:schedule-showing    → Create FUB task + SMS confirmation after lead agrees
 *
 * Drip step delay schedule:
 *  Step 1 → immediate (day 1)
 *  Step 2 → 2 days after step 1  (day 3)
 *  Step 3 → 4 days after step 2  (day 7)
 *  Step 4 → 7 days after step 3  (day 14)
 *  Step 5 → 16 days after step 4 (day 30)
 */

'use strict';

const Bull    = require('bull');
const twilio  = require('twilio');
const dayjs   = require('dayjs');
const nurture = require('./nurture');
const fub     = require('./followupboss');
const db      = require('./db');

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const immediateResponseQueue = new Bull('li:immediate-response', REDIS_URL);
const qualifyLeadQueue       = new Bull('li:qualify-lead',       REDIS_URL);
const dripStepQueue          = new Bull('li:drip-step',          REDIS_URL);
const morningDigestQueue     = new Bull('li:morning-digest',     REDIS_URL);
const scheduleShowingQueue   = new Bull('li:schedule-showing',   REDIS_URL);

// Drip step → millisecond delay until next step
const DRIP_DELAYS = {
    1: 2  * 24 * 60 * 60 * 1000,  // day 3  (2 days after step 1)
    2: 4  * 24 * 60 * 60 * 1000,  // day 7  (4 days after step 2)
    3: 7  * 24 * 60 * 60 * 1000,  // day 14 (7 days after step 3)
    4: 16 * 24 * 60 * 60 * 1000,  // day 30 (16 days after step 4)
};

const DRIP_MAX_STEPS = 5;

// ─── Twilio Client Factory ────────────────────────────────────────────────────

function getTwilioClient() {
    const sid   = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error('Twilio credentials not configured');
    return twilio(sid, token);
}

/**
 * Send an SMS to a lead. Uses client's twilio_from if set, else env var.
 */
async function sendSms(to, body, client, leadId) {
    const twilioClient = getTwilioClient();
    const from         = client?.twilio_from || process.env.TWILIO_FROM_NUMBER;

    if (!from) throw new Error('No Twilio from number configured');

    const msg = await twilioClient.messages.create({ to, from, body });

    // Log to database
    await db.logSms({
        client_id:   client?.id || null,
        lead_id:     leadId,
        direction:   'outbound',
        to_number:   to,
        from_number: from,
        body,
        twilio_sid:  msg.sid,
    });

    console.log(`[SMS] Sent to ${to} — SID: ${msg.sid}`);
    return msg;
}

// ─── Job: Immediate Response ───────────────────────────────────────────────────
// Must fire within 60 seconds of lead creation. Generates + sends first SMS.

immediateResponseQueue.process(async (job) => {
    const { leadId, clientId } = job.data;
    console.log(`[ImmediateResponse] Processing lead ${leadId}`);

    const [lead, client] = await Promise.all([
        db.getLeadById(leadId),
        db.getClientById(clientId),
    ]);

    if (!lead) throw new Error(`Lead not found: ${leadId}`);
    if (!client) throw new Error(`Client not found: ${clientId}`);

    // Don't double-message if already contacted
    if (lead.status !== 'new') {
        console.log(`[ImmediateResponse] Lead ${leadId} already in status "${lead.status}" — skipping`);
        return { skipped: true, reason: 'already_contacted' };
    }

    // Generate personalized opening SMS
    const { ok, data, error } = await nurture.generateInitialResponse(lead);
    if (!ok) throw new Error(`Failed to generate response: ${error}`);

    const { message } = data;

    // Send SMS to lead
    await sendSms(lead.phone, message, client, leadId);

    // Log conversation
    await db.logConversation({
        lead_id:   leadId,
        client_id: clientId,
        direction: 'outbound',
        message,
        intent:    'initial_contact',
    });

    // Update lead status
    await db.updateLeadStatus(leadId, 'contacted');
    await db.updateLeadLastContact(leadId);

    // Log activity to Follow Up Boss if we have their FUB person ID
    if (lead.fub_person_id && client.fub_api_key) {
        try {
            await fub.logSmsActivity(client.client_slug, lead.fub_person_id, message, 'outbound');
            await fub.createNote(
                client.client_slug,
                lead.fub_person_id,
                `GridHand Lead Incubator — Initial SMS sent within 60 seconds of lead creation.`
            );
        } catch (fubErr) {
            console.warn(`[ImmediateResponse] FUB log failed (non-fatal): ${fubErr.message}`);
        }
    }

    console.log(`[ImmediateResponse] Done — lead ${leadId} contacted`);
    return { leadId, messageSent: message };
});

// ─── Job: Qualify Lead ─────────────────────────────────────────────────────────
// Run AI qualification scoring and update lead record. Alert agent if hot.

qualifyLeadQueue.process(async (job) => {
    const { leadId, clientId } = job.data;
    console.log(`[QualifyLead] Scoring lead ${leadId}`);

    const [lead, client] = await Promise.all([
        db.getLeadById(leadId),
        db.getClientById(clientId),
    ]);

    if (!lead) throw new Error(`Lead not found: ${leadId}`);
    if (!client) throw new Error(`Client not found: ${clientId}`);

    // If lead has a desired address, try to enrich with Zillow
    let zillowData = null;
    if (lead.desired_location && client.zillow_wsid) {
        try {
            const zResult = await fub.enrichWithZillow(lead.desired_location, '', client.zillow_wsid);
            if (zResult.ok && zResult.data) {
                zillowData = zResult.data;
                await db.updateLeadZillowData(leadId, zillowData);
                console.log(`[QualifyLead] Enriched lead ${leadId} with Zillow data`);
            }
        } catch (err) {
            console.warn(`[QualifyLead] Zillow enrichment failed (non-fatal): ${err.message}`);
        }
    }

    // Run AI qualification
    const { ok, data, error } = await nurture.qualifyLead(lead);
    if (!ok) throw new Error(`Qualification failed: ${error}`);

    const { score, tier, questions, summary } = data;

    // Update lead with score, tier, and AI summary
    await db.updateLeadQualification(leadId, { score, tier, ai_summary: summary });

    console.log(`[QualifyLead] Lead ${leadId} (${lead.name}) — score: ${score}, tier: ${tier}`);

    // If HOT lead, SMS agent immediately
    if (tier === 'hot') {
        const agentPhone = client.agent_phone;
        if (agentPhone) {
            const hotAlert = `HOT LEAD: ${lead.name} scored ${score}/100. Source: ${lead.source || 'unknown'}. ${summary.slice(0, 100)}. Call now: ${lead.phone}`;
            await sendSms(agentPhone, hotAlert.slice(0, 320), client, leadId);
            console.log(`[QualifyLead] Hot lead alert sent to agent ${agentPhone}`);
        }
    }

    // Log qualification questions to FUB as a note
    if (lead.fub_person_id && client.fub_api_key && questions.length > 0) {
        try {
            const noteText = `GridHand AI Qualification\nScore: ${score}/100 | Tier: ${tier.toUpperCase()}\n\nSuggested questions:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\nSummary: ${summary}`;
            await fub.createNote(client.client_slug, lead.fub_person_id, noteText);
        } catch (fubErr) {
            console.warn(`[QualifyLead] FUB note failed (non-fatal): ${fubErr.message}`);
        }
    }

    return { leadId, score, tier, summary };
});

// ─── Job: Drip Step ────────────────────────────────────────────────────────────
// Execute one drip campaign step. Schedule the next step if appropriate.

dripStepQueue.process(async (job) => {
    const { leadId, clientId, step } = job.data;
    console.log(`[DripStep] Executing step ${step} for lead ${leadId}`);

    const [lead, client] = await Promise.all([
        db.getLeadById(leadId),
        db.getClientById(clientId),
    ]);

    if (!lead) throw new Error(`Lead not found: ${leadId}`);
    if (!client) throw new Error(`Client not found: ${clientId}`);

    // Stop drip if lead has converted, unsubscribed, or scheduled a showing
    const stopStatuses = ['converted', 'unsubscribed', 'scheduled'];
    if (stopStatuses.includes(lead.status)) {
        console.log(`[DripStep] Lead ${leadId} status is "${lead.status}" — stopping drip`);
        await db.updateLeadDripActive(leadId, false);
        return { skipped: true, reason: `lead_${lead.status}` };
    }

    // Stop drip if lead replied recently (last_inbound within 24 hours)
    if (lead.last_inbound) {
        const hoursSinceReply = dayjs().diff(dayjs(lead.last_inbound), 'hour');
        if (hoursSinceReply < 24) {
            console.log(`[DripStep] Lead ${leadId} replied ${hoursSinceReply}h ago — pausing drip`);
            return { skipped: true, reason: 'recent_reply' };
        }
    }

    // Check if this step was already sent (prevent duplicates)
    const alreadySent = await db.checkDripStepSent(leadId, step);
    if (alreadySent) {
        console.log(`[DripStep] Step ${step} already sent for lead ${leadId} — skipping`);
        return { skipped: true, reason: 'already_sent' };
    }

    // Generate the drip message
    const { ok, data, error } = await nurture.getDripMessage(lead, step);
    if (!ok) throw new Error(`Failed to generate drip message: ${error}`);

    const { message } = data;

    // Send SMS
    await sendSms(lead.phone, message, client, leadId);

    // Log conversation
    await db.logConversation({
        lead_id:   leadId,
        client_id: clientId,
        direction: 'outbound',
        message,
        intent:    `drip_step_${step}`,
    });

    // Log to drip_log (prevents re-sending)
    await db.logDripStep(leadId, step, message);

    // Update lead drip state
    await db.updateLeadDripStep(leadId, step, true);
    await db.updateLeadLastContact(leadId);

    console.log(`[DripStep] Step ${step} sent to ${lead.name} (${lead.phone})`);

    // Schedule next step if not the last one
    if (step < DRIP_MAX_STEPS) {
        const delayMs = DRIP_DELAYS[step];
        if (delayMs) {
            await dripStepQueue.add(
                { leadId, clientId, step: step + 1 },
                { delay: delayMs, attempts: 2, backoff: 60000 }
            );
            console.log(`[DripStep] Scheduled step ${step + 1} in ${Math.round(delayMs / 86400000)} days`);
        }
    } else {
        // Final step — mark drip complete
        await db.updateLeadDripActive(leadId, false);
        console.log(`[DripStep] Drip campaign complete for lead ${leadId}`);
    }

    return { leadId, step, messageSent: message };
});

// ─── Job: Morning Digest ───────────────────────────────────────────────────────
// Generate and send a morning pipeline briefing to the agent.

morningDigestQueue.process(async (job) => {
    const { clientId } = job.data;
    console.log(`[MorningDigest] Generating digest for client ${clientId}`);

    const client = await db.getClientById(clientId);
    if (!client) throw new Error(`Client not found: ${clientId}`);

    const agentPhone = client.agent_phone;
    if (!agentPhone) throw new Error(`No agent phone for client ${clientId}`);

    // Load all active leads (not converted, not unsubscribed)
    const leads = await db.getActiveLeads(clientId);

    // Generate AI digest
    const { ok, data, error } = await nurture.generateMorningDigest(leads, client);
    if (!ok) throw new Error(`Failed to generate morning digest: ${error}`);

    const { message } = data;

    // Send to agent
    await sendSms(agentPhone, message, client, null);

    console.log(`[MorningDigest] Sent to agent ${agentPhone} for client ${clientId} — ${leads.length} leads`);
    return { clientId, agentPhone, leadCount: leads.length };
});

// ─── Job: Schedule Showing ─────────────────────────────────────────────────────
// Create a Follow Up Boss task and send SMS confirmation to lead.

scheduleShowingQueue.process(async (job) => {
    const { leadId, clientId } = job.data;
    console.log(`[ScheduleShowing] Processing showing request for lead ${leadId}`);

    const [lead, client] = await Promise.all([
        db.getLeadById(leadId),
        db.getClientById(clientId),
    ]);

    if (!lead) throw new Error(`Lead not found: ${leadId}`);
    if (!client) throw new Error(`Client not found: ${clientId}`);

    // Create a follow-up task in FUB for the agent to schedule the showing
    if (lead.fub_person_id && client.fub_api_key) {
        try {
            const dueDate = dayjs().add(1, 'hour').toISOString();
            await fub.createTask(client.client_slug, lead.fub_person_id, {
                description: `SHOWING REQUEST: ${lead.name} (${lead.phone}) wants to schedule a showing. Score: ${lead.score}/100 | Tier: ${lead.tier?.toUpperCase()}. Desired: ${lead.desired_location || 'unknown area'}.`,
                dueDate,
            });
            console.log(`[ScheduleShowing] FUB task created for lead ${leadId}`);
        } catch (fubErr) {
            console.warn(`[ScheduleShowing] FUB task creation failed (non-fatal): ${fubErr.message}`);
        }
    }

    // Send confirmation SMS to lead
    const agentName   = client.agent_name || 'your agent';
    const confirmText = `Great news! ${agentName} will reach out shortly to schedule your showing. We'll confirm a time that works for you. Looking forward to it!`;

    await sendSms(lead.phone, confirmText.slice(0, 160), client, leadId);

    // Log conversation
    await db.logConversation({
        lead_id:   leadId,
        client_id: clientId,
        direction: 'outbound',
        message:   confirmText,
        intent:    'showing_confirmation',
    });

    // Alert agent via SMS
    const alertText = `SHOWING REQUEST: ${lead.name} wants to see a property! Score: ${lead.score}/100. Call them: ${lead.phone}`;
    await sendSms(client.agent_phone, alertText.slice(0, 160), client, leadId);

    // Update showing_scheduled_at
    await db.updateLeadShowingScheduled(leadId, new Date().toISOString());

    console.log(`[ScheduleShowing] Done for lead ${leadId} (${lead.name})`);
    return { leadId, confirmationSent: true };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

const queues = [
    ['immediate-response', immediateResponseQueue],
    ['qualify-lead',       qualifyLeadQueue],
    ['drip-step',          dripStepQueue],
    ['morning-digest',     morningDigestQueue],
    ['schedule-showing',   scheduleShowingQueue],
];

for (const [name, queue] of queues) {
    queue.on('failed', (job, err) => {
        const id = job.data.leadId || job.data.clientId || 'unknown';
        console.error(`[Jobs] li:${name} job failed (${id}): ${err.message}`);
    });
    queue.on('completed', (job) => {
        const id = job.data.leadId || job.data.clientId || 'unknown';
        console.log(`[Jobs] li:${name} completed (${id})`);
    });
}

// ─── Job Dispatcher Functions ─────────────────────────────────────────────────

/**
 * Queue an immediate response job. Use delay=0 for sub-60-second delivery.
 */
async function dispatchImmediateResponse(leadId, clientId) {
    return immediateResponseQueue.add(
        { leadId, clientId },
        { attempts: 3, backoff: 5000, priority: 1 } // priority 1 = highest
    );
}

async function dispatchQualifyLead(leadId, clientId) {
    return qualifyLeadQueue.add(
        { leadId, clientId },
        { attempts: 2, backoff: 30000, delay: 5000 } // slight delay after immediate response
    );
}

async function dispatchDripStep(leadId, clientId, step = 1) {
    return dripStepQueue.add(
        { leadId, clientId, step },
        { attempts: 2, backoff: 60000 }
    );
}

async function dispatchMorningDigest(clientId) {
    return morningDigestQueue.add(
        { clientId },
        { attempts: 2, backoff: 60000 }
    );
}

async function dispatchScheduleShowing(leadId, clientId) {
    return scheduleShowingQueue.add(
        { leadId, clientId },
        { attempts: 2, backoff: 30000 }
    );
}

/**
 * Run a job function for all active clients.
 * Called by cron triggers in index.js.
 */
async function runForAllClients(jobFn) {
    const clients = await db.getAllActiveClients();
    const results = [];
    for (const client of clients) {
        try {
            const job = await jobFn(client.id);
            results.push({ clientId: client.id, clientSlug: client.client_slug, jobId: job.id });
        } catch (err) {
            console.error(`[Jobs] Failed to queue job for client ${client.client_slug}: ${err.message}`);
        }
    }
    return results;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    dispatchImmediateResponse,
    dispatchQualifyLead,
    dispatchDripStep,
    dispatchMorningDigest,
    dispatchScheduleShowing,
    runForAllClients,
    immediateResponseQueue,
    qualifyLeadQueue,
    dripStepQueue,
    morningDigestQueue,
    scheduleShowingQueue,
};
