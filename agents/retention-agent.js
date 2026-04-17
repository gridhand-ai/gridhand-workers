/**
 * retention-agent.js
 *
 * Intelligent customer retention agent.
 * Replaces: Recall Worker + Rebooking Worker + Churn Predictor + Birthday Worker
 *
 * Capabilities:
 *   - Track last service date, trigger personalized "we miss you" at industry-specific intervals
 *   - Loyalty appreciation after 3+ visits
 *   - Birthday SMS with offer (if DOB known)
 *   - Churn prediction — flag regulars going silent to client dashboard
 *   - Throttle: never more than 1 retention message per customer per 14 days
 *
 * Cron: daily at 9am per client timezone (Railway cron or setInterval in server.js)
 *
 * Usage:
 *   node agents/retention-agent.js --run <clientId>   — run retention for one client
 *   node agents/retention-agent.js --all              — run for all active clients
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

// How long before we reach out — configurable per industry
// Keys match client.industry values
const INDUSTRY_RETURN_WINDOW_DAYS = {
    'auto repair':       90,
    'auto shop':         90,
    'automotive':        90,
    'barbershop':        30,
    'hair salon':        35,
    'beauty salon':      35,
    'nail salon':        28,
    'spa':               45,
    'restaurant':        14,
    'cafe':              14,
    'coffee shop':       14,
    'fitness':           21,
    'gym':               21,
    'dental':            180,
    'dentist':           180,
    'veterinary':        365,
    'vet':               365,
    'cleaning':          30,
    'cleaning service':  30,
    'plumbing':          90,
    'hvac':              90,
    'electrician':       90,
    'landscaping':       30,
    'default':           60,
};

// Minimum gap between retention messages per customer
const RETENTION_COOLDOWN_DAYS = 14;

// Visit count threshold for loyalty message
const LOYALTY_VISIT_THRESHOLD = 3;

// Churn: regulars with 3+ visits who haven't returned past 2x their normal window
const CHURN_MULTIPLIER = 2;

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
            body: JSON.stringify({ clientId, workerName: 'RetentionAgent', action, summary, metadata }),
        });
    } catch (e) {
        console.log(`[RetentionAgent] Log failed: ${e.message}`);
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
        body: JSON.stringify({ clientId, workerName: 'RetentionAgent', errorMessage: message, context }),
    }).catch(e => console.log(`[RetentionAgent] Error report failed: ${e.message}`));
}

// ─── State helpers ────────────────────────────────────────────────────────────
async function getRetentionState(clientId, customerPhone) {
    const { data } = await supabase
        .from('agent_state')
        .select('state')
        .eq('agent', 'retention')
        .eq('client_id', clientId)
        .eq('entity_id', `customer:${customerPhone}`)
        .single();
    return data?.state || null;
}

async function setRetentionState(clientId, customerPhone, state) {
    await supabase
        .from('agent_state')
        .upsert({
            agent: 'retention',
            client_id: clientId,
            entity_id: `customer:${customerPhone}`,
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

// ─── Load customer activity from Supabase activity_log ────────────────────────
async function getCustomerActivity(clientId, customerPhone) {
    const { data } = await supabase
        .from('activity_log')
        .select('created_at, action, metadata')
        .eq('client_id', clientId)
        // Don't filter by customer phone here — activity_log logs by client_id
        // We rely on agent_state for per-customer tracking seeded by integration events
        .order('created_at', { ascending: false })
        .limit(200);

    // Filter to this customer's records (phone may be in metadata)
    const customerRows = (data || []).filter(row => {
        const meta = row.metadata || {};
        return meta.customerPhone === customerPhone ||
               meta.customer?.phone === customerPhone ||
               meta.phone === customerPhone;
    });

    return customerRows;
}

// ─── Get return window in days for this client's industry ────────────────────
function getReturnWindowDays(industry, settings) {
    // Allow client to override per their settings
    if (settings?.retention?.return_window_days) return settings.retention.return_window_days;

    const key = (industry || '').toLowerCase();
    return INDUSTRY_RETURN_WINDOW_DAYS[key] || INDUSTRY_RETURN_WINDOW_DAYS['default'];
}

// ─── Generate personalized retention message via AI ──────────────────────────
async function generateRetentionMessage({ clientConfig, customerName, msgType, visitCount, lastService, birthdayOffer }) {
    const bizName  = clientConfig.business_name;
    const industry = clientConfig.industry || 'business';
    const settings = clientConfig.settings || {};
    const offerText = settings.retention?.offer_text || '';

    let taskDesc;
    if (msgType === 'birthday') {
        taskDesc = `Write a birthday SMS. Customer name: ${customerName || 'the customer'}. Include a warm birthday wish and ${birthdayOffer || 'a special offer to celebrate'}.`;
    } else if (msgType === 'loyalty') {
        taskDesc = `Write a loyalty appreciation SMS. Customer has visited ${visitCount} times. Express genuine gratitude for their loyalty. ${offerText ? `Include this offer: ${offerText}` : 'No special offer needed.'}`;
    } else {
        // win-back
        taskDesc = `Write a "we miss you" SMS. Customer's last service was: ${lastService || 'a while ago'}. ${offerText ? `Include this offer: ${offerText}` : 'Keep it warm and welcoming.'} Goal: invite them back gently without being pushy.`;
    }

    const systemPrompt = `<business>
Name: ${bizName}
Industry: ${industry}
</business>

<task>
${taskDesc}
</task>

<rules>
- Keep it SHORT — 2-3 sentences max (under 160 chars ideal, 320 max).
- Sound human, warm, specific to the business type.
- Include business name at the end as the sign-off.
- Include "Reply STOP to opt out" only if this is a promotional message (birthday/loyalty with offer).
- Output ONLY the SMS text, no labels, no quotes, no preamble.
</rules>`;

    const reply = await aiClient.call({
        modelString: 'anthropic/claude-haiku-4-5-20251001',
        clientApiKeys: {},
        systemPrompt,
        messages: [{ role: 'user', content: 'Write the SMS.' }],
        maxTokens: 120,
        _workerName: 'RetentionAgent',
    });

    return reply || null;
}

// ─── Send retention SMS ───────────────────────────────────────────────────────
async function sendRetentionSMS({ clientConfig, clientLoader, customerPhone, body }) {
    const twilioNum = clientConfig.twilio_number;
    const timezone  = clientConfig.timezone || 'America/Chicago';

    if (!twilioNum) {
        console.log(`[RetentionAgent] No Twilio number for ${clientConfig.id} — skipping`);
        return false;
    }

    // Compliance
    try {
        optoutManager.guardOutbound(clientConfig.slug, customerPhone);
    } catch (e) {
        console.log(`[RetentionAgent] Opt-out blocked for ${clientConfig.id}: ${e.message}`);
        return false;
    }

    if (tcpaChecker.isQuietHours(timezone)) {
        console.log(`[RetentionAgent] TCPA quiet hours for ${clientConfig.id} — skipping`);
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

// ─── Check birthday today ─────────────────────────────────────────────────────
function isBirthdayToday(dobString) {
    if (!dobString) return false;
    try {
        const dob = new Date(dobString);
        const now = new Date();
        return dob.getMonth() === now.getMonth() && dob.getDate() === now.getDate();
    } catch {
        return false;
    }
}

// ─── Run retention for a single client ───────────────────────────────────────
async function runForClient(clientId, clientLoader = null) {
    let clientConfig;
    try {
        clientConfig = await loadClientConfig(clientId);
    } catch (e) {
        console.log(`[RetentionAgent] Client load failed for ${clientId}: ${e.message}`);
        return;
    }

    if (clientConfig.workers_paused) {
        console.log(`[RetentionAgent] Workers paused for ${clientId} — skipping`);
        return;
    }

    const industry      = clientConfig.industry || '';
    const settings      = clientConfig.settings || {};
    const returnWindow  = getReturnWindowDays(industry, settings);
    const now           = Date.now();

    console.log(`[RetentionAgent] Running for ${clientConfig.business_name} (${clientId}), return window: ${returnWindow}d`);

    // Fetch all customers tracked in agent_state for this client
    const { data: customerStates, error } = await supabase
        .from('agent_state')
        .select('entity_id, state')
        .eq('agent', 'retention')
        .eq('client_id', clientId)
        .like('entity_id', 'customer:%');

    if (error) {
        console.log(`[RetentionAgent] State query error: ${error.message}`);
        return;
    }

    let messagesSent = 0;
    let churnFlagged = 0;

    for (const row of (customerStates || [])) {
        const customerPhone = row.entity_id.replace('customer:', '');
        const state = row.state || {};

        // Throttle: skip if we sent a retention message within cooldown window
        if (state.lastRetentionSent) {
            const daysSince = (now - new Date(state.lastRetentionSent).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSince < RETENTION_COOLDOWN_DAYS) continue;
        }

        const lastServiceDate = state.lastServiceDate ? new Date(state.lastServiceDate) : null;
        const visitCount      = state.visitCount || 0;
        const dob             = state.dob || null;
        const customerName    = state.customerName || null;
        const lastService     = state.lastServiceName || null;

        let msgType = null;
        let birthdayOffer = settings.retention?.birthday_offer || null;

        // Priority 1: Birthday
        if (dob && isBirthdayToday(dob)) {
            msgType = 'birthday';
        }
        // Priority 2: Win-back (past return window)
        else if (lastServiceDate) {
            const daysDormant = (now - lastServiceDate.getTime()) / (1000 * 60 * 60 * 24);

            // Churn detection: regulars (3+ visits) past 2x their window
            if (visitCount >= LOYALTY_VISIT_THRESHOLD && daysDormant > returnWindow * CHURN_MULTIPLIER && !state.churnFlagged) {
                console.log(`[RetentionAgent] Churn flag: ${clientId} customer dormant ${Math.floor(daysDormant)}d`);
                await setRetentionState(clientId, customerPhone, { ...state, churnFlagged: true });
                await logActivity(clientId, 'churn_flagged', `Customer dormant ${Math.floor(daysDormant)}d (${visitCount} visits)`, { daysDormant: Math.floor(daysDormant), visitCount });
                churnFlagged++;
                continue; // Don't send a message if we already flagged — let client decide
            }

            if (daysDormant >= returnWindow) {
                msgType = 'win-back';
            }
        }
        // Priority 3: Loyalty appreciation (hit threshold, never received loyalty msg)
        else if (visitCount >= LOYALTY_VISIT_THRESHOLD && !state.loyaltyMessageSent) {
            msgType = 'loyalty';
        }

        if (!msgType) continue;

        try {
            const body = await generateRetentionMessage({
                clientConfig,
                customerName,
                msgType,
                visitCount,
                lastService,
                birthdayOffer,
            });

            if (!body) {
                console.log(`[RetentionAgent] AI returned empty message for ${clientId} / ${msgType}`);
                continue;
            }

            const sent = await sendRetentionSMS({ clientConfig, clientLoader, customerPhone, body });
            if (!sent) continue;

            // Update state
            const newState = {
                ...state,
                lastRetentionSent: new Date().toISOString(),
                lastRetentionType: msgType,
            };
            if (msgType === 'loyalty') newState.loyaltyMessageSent = true;
            await setRetentionState(clientId, customerPhone, newState);

            await logActivity(clientId, `retention_sent:${msgType}`, `${msgType} message sent`, { msgType });
            await emit('task_completed', {
                workerName: 'RetentionAgent',
                clientSlug: clientConfig.slug,
                summary: `${msgType} retention message sent`,
            });

            messagesSent++;

        } catch (e) {
            console.log(`[RetentionAgent] Error processing ${clientId} customer: ${e.message}`);
            reportError(clientId, e.message, { phase: 'send_retention', msgType });
        }
    }

    if (churnFlagged > 0) {
        const msg = [
            `*Retention Alert* — ${clientConfig.business_name}`,
            `${churnFlagged} regular customer(s) flagged as at-risk of churning`,
            `Check your client dashboard to review and take action`,
        ].join('\n');
        await sendTelegramAlert(msg);
    }

    console.log(`[RetentionAgent] Done for ${clientId}: ${messagesSent} messages sent, ${churnFlagged} churn flags`);
    return { messagesSent, churnFlagged };
}

// ─── Update customer record (called on integration events) ───────────────────
// Used by server.js when a job_complete or similar event fires.
// Upserts the customer's retention state with latest service info.
async function updateCustomerRecord(clientId, { customerPhone, customerName, serviceName, dob }) {
    if (!customerPhone) return;

    const state = await getRetentionState(clientId, customerPhone) || {};

    const visitCount = (state.visitCount || 0) + 1;
    await setRetentionState(clientId, customerPhone, {
        ...state,
        customerName: customerName || state.customerName,
        lastServiceDate: new Date().toISOString(),
        lastServiceName: serviceName || state.lastServiceName,
        visitCount,
        dob: dob || state.dob,
        churnFlagged: false, // reset flag on new visit
    });

    console.log(`[RetentionAgent] Updated customer record for ${clientId} (visit #${visitCount})`);
}

// ─── Primary run() export ─────────────────────────────────────────────────────
async function run(clientId, context = {}, clientLoader = null) {
    const { event, customerPhone, customerName, serviceName, dob } = context;

    if (event === 'update_customer') {
        if (!customerPhone) throw new Error('customerPhone required');
        return updateCustomerRecord(clientId, { customerPhone, customerName, serviceName, dob });
    }

    if (event === 'run_retention' || !event) {
        return runForClient(clientId, clientLoader);
    }

    throw new Error(`Unknown event: ${event}. Use update_customer | run_retention`);
}

// ─── Standalone CLI entry ─────────────────────────────────────────────────────
if (require.main === module) {
    const args     = process.argv.slice(2);
    const mode     = args[0];
    const clientId = args[1];

    if (!clientId && mode !== '--all') {
        console.error('Usage: node agents/retention-agent.js --run <clientId>');
        console.error('       node agents/retention-agent.js --all');
        process.exit(1);
    }

    const task = mode === '--all'
        ? (async () => {
            const { data: clients } = await supabase
                .from('clients')
                .select('id')
                .eq('workers_paused', false);
            for (const c of (clients || [])) {
                await runForClient(c.id, null).catch(e => console.log(`[RetentionAgent] ${c.id} error: ${e.message}`));
            }
        })()
        : runForClient(clientId, null);

    task
        .then(r => console.log('[RetentionAgent] Done:', JSON.stringify(r || {})))
        .catch(e => {
            console.error('[RetentionAgent] Fatal:', e.message);
            process.exit(1);
        });
}

module.exports = { run, runForClient, updateCustomerRecord };
