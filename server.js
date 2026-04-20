const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { sendCriticalAlert } = require('./lib/events');

// Lightweight Supabase client for workers_paused checks
const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);
const WebSocket = require('ws');
const { loadClient, loadClientBySlug, loadClientBySupabaseId, NUMBER_MAP } = require('./clients/loader');
const aiClientLib = require('./lib/ai-client');
const { handleVoiceStream } = require('./voice-bridge');
const deployWatch = require('./lib/deploy-watch');

// Workers
const afterHoursWorker      = require('./workers/after-hours');
const faqWorker             = require('./workers/faq');
const receptionistWorker    = require('./workers/receptionist');
const bookingWorker         = require('./workers/booking');
const intakeWorker          = require('./workers/intake');
const waitlistWorker        = require('./workers/waitlist');
const reviewRequesterWorker = require('./workers/review-requester');
const reminderWorker        = require('./workers/reminder');
const reactivationWorker    = require('./workers/reactivation');
const leadFollowupWorker    = require('./workers/lead-followup');
const invoiceChaserWorker   = require('./workers/invoice-chaser');
const quoteWorker           = require('./workers/quote');
const referralWorker        = require('./workers/referral');
const upsellWorker          = require('./workers/upsell');
const onboardingWorker      = require('./workers/onboarding');

// ─── BENCH: Ready to activate (standalone microservices — NOT loadable into this server) ────
//
// These dental/healthcare workers are fully built but run as SEPARATE Express servers
// on their own ports. Each requires external third-party API credentials per client.
// To deploy, run each as an independent Railway/Render service with its own env vars.
//
// workers/recall-commander   — Dental patient recall via SMS (hygiene, exam, x-ray recall)
//   Needs: Dentrix G6+ API key + secret (api.henryschein.com) OR Open Dental REST API key
//   Stored per-client in: Supabase rc_connections table
//   Default port: RECALL_PORT (3007)
//
// workers/no-show-nurse      — Medical appointment no-show detection + waitlist slot filling
//   Needs: Epic FHIR R4 OR Cerner FHIR R4 client credentials (SMART on FHIR)
//   Stored per-client in: Supabase nsn_connections table
//   Default port: NSN_PORT (3011)
//
// workers/treatment-presenter — Dental treatment plan SMS automation + acceptance tracking
//   Needs: Dentrix G6+ OR Open Dental PMS API key per practice
//   Stored per-client in: Supabase tp_connections table
//   Default port: TP_PORT (3009)
//
// workers/prior-auth-bot     — Medical prior authorization automation (Epic/Cerner + payer portals)
//   Needs: Epic/Cerner FHIR credentials + PAB_API_KEY + PAB_WEBHOOK_SECRET + REDIS_URL
//   Stored per-client in: Supabase pab_connections table
//   Default port: PAB_PORT (3010)
//
// workers/vaccine-reminder   — Veterinary vaccine reminder (NOT human dental — vet practices only)
//   Needs: EVET_BASE_URL + EVET_API_KEY (eVetPractice) OR PETDESK_API_KEY + REDIS_URL
//   Default port: 3011
//
// workers/rebook-reminder    — Salon/beauty rebooking reminders (NOT dental — salon vertical)
//   Needs: BOULEVARD_API_KEY + BOULEVARD_BUSINESS_ID OR SQUARE_ACCESS_TOKEN + SQUARE_LOCATION_ID
//   Default port: 3013
//
// ─────────────────────────────────────────────────────────────────────────────────────────────

// Agents — intelligent multi-action coordinators
const reputationAgent   = require('./agents/reputation-agent');
const retentionAgent    = require('./agents/retention-agent');
const leadNurtureAgent  = require('./agents/lead-nurture-agent');
const credentialMonitor = require('./agents/credential-monitor');

// Redis client (Upstash — persistent dedup across Railway cold starts)
const { getRedis } = require('./lib/redis-client');

// Subagents — Intelligence
const sentimentAnalyzer  = require('./subagents/intelligence/sentiment-analyzer');
const intentClassifier   = require('./subagents/intelligence/intent-classifier');
const objectionHandler   = require('./subagents/intelligence/objection-handler');

// Subagents — Customer
const customerProfiler   = require('./subagents/customer/customer-profiler');
const faqExtractor       = require('./subagents/business-intelligence/faq-extractor');

// Subagents — Compliance (run on EVERY message)
const optoutManager      = require('./subagents/compliance/optout-manager');
const tcpaChecker        = require('./subagents/compliance/tcpa-checker');
const spamChecker        = require('./subagents/compliance/spam-score-checker');

// Subagents — Automation
const campaignTracker       = require('./subagents/business-intelligence/campaign-tracker');
const bestTimeSender        = require('./subagents/automation/best-time-sender');
const sequenceOrchestrator  = require('./subagents/automation/sequence-orchestrator');
const reengagementScheduler = require('./subagents/automation/reengagement-scheduler');
const sender                = require('./workers/twilio-sender');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Portal error reporter ────────────────────────────────────────────────────
// Fire-and-forget: POSTs worker execution failures to /api/workers/error so
// MJ can see them in the admin dashboard and get SMS alerts from the health cron.
// Never throws — a failed error report must never break the SMS response path.
function reportWorkerError(clientId, workerName, errorMessage, context) {
    const portalUrl = process.env.PORTAL_URL || 'https://gridhand.ai';
    const secret    = process.env.WORKERS_API_SECRET;
    if (!secret) return; // silently skip if not configured

    fetch(`${portalUrl}/api/workers/error`, {
        method:  'POST',
        headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${secret}`,
        },
        body: JSON.stringify({ clientId, workerName, errorMessage, context }),
    }).catch(e => console.log(`[ErrorReporter] Failed to send error report: ${e.message}`));
}

// ─── Make.com two-way sync helper ─────────────────────────────────────────────
// Fires after every inbound customer message so the CRM stays in sync.
// Non-blocking — uses fire-and-forget so it never slows down SMS responses.
function pushOutcomeToMake(client, customerPhone, workerName, customerMessage, workerReply) {
    const url = process.env.MAKE_OUTBOUND_WEBHOOK_URL;
    if (!url) return; // Only runs if Make outbound URL is configured

    // Detect outcome from the worker reply and customer message
    const replyLower = workerReply.toLowerCase();
    const msgLower   = customerMessage.toLowerCase();
    let outcome = 'responded';
    if (/yes|confirm|sure|sounds good|perfect|great|ok|okay|will do|see you|i'll be there/i.test(msgLower))   outcome = 'confirmed';
    else if (/no|cancel|stop|not interested|nevermind|skip|won't|can't make it/i.test(msgLower))               outcome = 'declined';
    else if (/\?|how|what|when|where|why|tell me|can you|do you|is there/i.test(msgLower))                    outcome = 'question';
    else if (/left a review|reviewed|posted|5 star|gave you|did it/i.test(msgLower))                          outcome = 'review_left';
    else if (/paid|sent|transferred|venmo|zelle|i paid/i.test(msgLower))                                      outcome = 'paid';

    const payload = {
        event:          'worker_outcome',
        twilioNumber:   client.twilioNumber || '',
        clientSlug:     client.slug || '',
        businessName:   client.business?.name || '',
        customerPhone,
        worker:         workerName || 'unknown',
        outcome,
        customerMessage,
        workerReply,
        timestamp:      new Date().toISOString(),
    };

    fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
    }).catch(e => console.log(`[Make sync] Pushback failed: ${e.message}`));
}

// ─── XML Escape Helper (used for TwiML interpolation) ─────────────────────────
function escapeXml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// ─── Registry / Config Mutex + Atomic Write Helpers ──────────────────────────
// Both /provision and /provision/update read-modify-write registry.json and
// per-client config files. Two concurrent requests can clobber each other.
// This simple promise-chain lock serializes all writes through a single critical
// section while still letting Express handle other routes concurrently.
let _registryLock = Promise.resolve();
function withRegistryLock(fn) {
    const next = _registryLock.then(() => fn(), () => fn());
    _registryLock = next.catch(() => {}); // don't let a rejection poison the chain
    return next;
}

// Atomic write: write-then-rename. On POSIX filesystems rename(2) is atomic,
// so a concurrent reader never sees a half-written file.
function atomicWriteFileSync(targetPath, contents) {
    const fs = require('fs');
    const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, contents, 'utf8');
    fs.renameSync(tmp, targetPath);
}

// ─── API Key Auth Middleware ───────────────────────────────────────────────────
// Protects admin endpoints.
// Accepts either GRIDHAND_API_KEY (internal/operator use) or WORKERS_API_SECRET
// (portal auto-provisioning). At least one must be set.
function requireApiKey(req, res, next) {
    const serverKey    = process.env.GRIDHAND_API_KEY;
    const portalSecret = process.env.WORKERS_API_SECRET;
    if (!serverKey && !portalSecret) {
        return res.status(503).json({ error: 'Server not configured: no API key set.' });
    }
    const authHeader = req.headers['authorization'] || '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if ((serverKey && provided === serverKey) || (portalSecret && provided === portalSecret)) {
        return next();
    }
    return res.status(401).json({ error: 'Unauthorized.' });
}

// ─── Worker module map (shared between /sms routing and sequence runner) ──────
const workerModules = {
    receptionist:       receptionistWorker,
    faq:                faqWorker,
    booking:            bookingWorker,
    intake:             intakeWorker,
    'after-hours':      afterHoursWorker,
    waitlist:           waitlistWorker,
    'review-requester': reviewRequesterWorker,
    reminder:           reminderWorker,
    reactivation:       reactivationWorker,
    'lead-followup':    leadFollowupWorker,
    'invoice-chaser':   invoiceChaserWorker,
    quote:              quoteWorker,
    referral:           referralWorker,
    upsell:             upsellWorker,
    onboarding:         onboardingWorker,
};

// ─── Sequence Runner (every 60s) ──────────────────────────────────────────────
setInterval(() => {
    sequenceOrchestrator.runDueSequences(workerModules, sender, loadClientBySlug).catch(e =>
        console.log(`[Sequences] Runner error: ${e.message}`)
    );
}, 60000);

// ─── SMS Deduplication Guard ──────────────────────────────────────────────────
// Customers sometimes double-tap. The same phone → number combo within 30s
// produces one AI response only. Prevents duplicate Twilio charges + reply spam.
//
// Primary: Upstash Redis (SETNX with 30s TTL) — survives Railway cold starts.
// Fallback: in-memory Map when UPSTASH_REDIS_REST_URL is not configured.
const _recentSms = new Map(); // fallback only
setInterval(() => {
    const cutoff = Date.now() - 30000;
    for (const [k, ts] of _recentSms.entries()) {
        if (ts < cutoff) _recentSms.delete(k);
    }
}, 60000);

/**
 * SMS dedup check. Returns true if this message is a duplicate (should be dropped).
 * Uses Redis when available, falls back to in-memory Map.
 * @param {string} from  - customer phone (E.164)
 * @param {string} to    - worker phone  (E.164)
 * @param {string} body  - message body (first 30 chars used as key)
 */
async function isSmsDedup(from, to, body) {
    const key    = `sms_dedup:${from}:${to}:${body.slice(0, 30)}`;
    const redis  = getRedis();

    if (redis) {
        try {
            // nx: true → only set if not exists; ex: 30 → TTL in seconds
            // Returns 'OK' when newly set, null when key already existed
            const result = await redis.set(key, '1', { ex: 30, nx: true });
            return result === null; // null → key existed → duplicate
        } catch (e) {
            // Redis error — fall through to in-memory fallback silently
            console.warn('[SMS] Redis dedup error, falling back to in-memory:', e.message);
        }
    }

    // In-memory fallback
    const mapKey = `${from}→${to}:${body}`;
    if (_recentSms.has(mapKey)) return true;
    _recentSms.set(mapKey, Date.now());
    return false;
}

// ─── Credential Monitor (every 6 hours) ──────────────────────────────────────
setInterval(() => credentialMonitor.run().catch(e => console.error('[CredMonitor]', e.message)), 6 * 60 * 60 * 1000);
// Also run once on startup after 30s (gives server time to fully initialize)
setTimeout(() => credentialMonitor.run().catch(e => console.error('[CredMonitor]', e.message)), 30000);

// ─── Public health endpoint (used by Deploy Watch) ────────────────────────────
app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'gridhand-workers', ts: Date.now() });
});

// ─── Authenticated status ──────────────────────────────────────────────────────
app.get('/', requireApiKey, (req, res) => {
    res.json({
        status: 'GRIDHAND Workers online',
        agents: [
            'reputation-agent',  // review requests, responses, velocity monitor
            'retention-agent',   // win-back, loyalty, birthday, churn detection
            'lead-nurture-agent', // qualify, score, multi-step follow-up sequence
        ],
        workers: [
            'faq', 'receptionist', 'booking', 'intake', 'after-hours', 'waitlist',
            'review-requester', 'reminder', 'reactivation', 'lead-followup',
            'invoice-chaser', 'quote', 'referral', 'upsell', 'onboarding'
        ],
        subagents: [
            'sentiment-analyzer', 'intent-classifier', 'lead-scorer', 'churn-predictor',
            'objection-handler', 'customer-profiler', 'conversation-summarizer',
            'personalization-engine', 'vip-detector', 'campaign-tracker', 'faq-extractor',
            'appointment-analyzer', 'payment-intelligence', 'upsell-intelligence',
            'optout-manager', 'tcpa-checker', 'message-quality-scorer', 'spam-score-checker',
            'sequence-orchestrator', 'best-time-sender', 'referral-tracker',
            'reengagement-scheduler', 'google-business-monitor', 'calendar-sync',
            'crm-sync', 'payment-link-generator', 'review-link-fetcher'
        ]
    });
});

// ─── Inbound SMS Webhook ───────────────────────────────────────────────────────
app.post('/sms', async (req, res) => {
    // Validate that the request genuinely came from Twilio
    const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioSignature = req.headers['x-twilio-signature'];
    if (!twilioAuthToken) {
        // Loudly refuse all requests if the token is missing — never silently skip validation
        console.error('[SMS] TWILIO_AUTH_TOKEN not set — rejecting all inbound SMS until configured');
        return res.status(503).send('Service misconfigured');
    }
    if (!twilioSignature) {
        console.warn('[SMS] Missing x-twilio-signature — rejecting unauthenticated request');
        return res.status(403).send('Forbidden');
    }
    const twilio = require('twilio');
    const webhookUrl = process.env.NEXT_PUBLIC_APP_URL
        ? `${process.env.NEXT_PUBLIC_APP_URL}/sms`
        : `https://${req.headers.host}/sms`;
    const valid = twilio.validateRequest(twilioAuthToken, twilioSignature, webhookUrl, req.body);
    if (!valid) {
        console.warn('[SMS] Invalid Twilio signature — rejecting request');
        return res.status(403).send('Forbidden');
    }

    const incomingNumber = req.body.To;
    const customerNumber = req.body.From;
    // Truncate at 1600 chars (10 SMS segments) — prevents AI runaway and Twilio billing surprises
    const message = (req.body.Body?.trim() || '').slice(0, 1600);

    console.log(`[SMS] ${customerNumber} → ${incomingNumber}: "${message}"`);

    // Deduplication: drop exact same message from same sender within 30s
    // Uses Upstash Redis when configured, falls back to in-memory Map.
    if (await isSmsDedup(customerNumber, incomingNumber, message)) {
        console.log(`[SMS] Duplicate detected — dropping (already handled within 30s)`);
        return res.set('Content-Type', 'text/xml').send('<Response></Response>');
    }

    const client = loadClient(incomingNumber);
    if (!client) {
        console.log(`[SMS] No client found for number ${incomingNumber}`);
        return res.set('Content-Type', 'text/xml').send('<Response></Response>');
    }

    // ── workers_paused check — stop processing for cancelled/paused clients ─
    if (client.supabaseClientId) {
        try {
            const { data: clientStatus } = await supabaseAdmin
                .from('clients')
                .select('workers_paused')
                .eq('id', client.supabaseClientId)
                .single();
            if (clientStatus?.workers_paused) {
                console.log(`[SMS] Workers paused for ${client.slug} — dropping inbound`);
                return res.set('Content-Type', 'text/xml').send('<Response></Response>');
            }
        } catch { /* fail open — don't block SMS on DB error */ }
    }

    // ── Step 1: Opt-out check (MUST run first, always) ─────────────────────
    const optout = optoutManager.process(client.slug, customerNumber, message);
    if (optout.action === 'opted-out' || optout.blocked) {
        campaignTracker.trackOptOut(client.slug, 'inbound');
        const reply = optout.reply || '';
        return res.set('Content-Type', 'text/xml').send(
            reply ? `<Response><Message>${escapeXml(reply)}</Message></Response>` : `<Response></Response>`
        );
    }

    // ── Step 2: Track response time (best-time learning) ──────────────────
    bestTimeSender.recordResponse(client.slug, customerNumber);

    // ── Step 3: Cancel any re-engagement sequences if they replied ─────────
    reengagementScheduler.removeFromQueue(client.slug, customerNumber);

    // ── Step 4: Intent classification (async, don't await to keep it fast) ─
    let intent = null;
    try {
        intent = await intentClassifier.classify(message, client.workers || []);
    } catch (e) {
        console.log(`[SMS] Intent classification failed: ${e.message}`);
    }

    // ── Step 5: Route to worker ────────────────────────────────────────────
    // Twilio requires a response within 10s or it retries (causing duplicate replies + charges).
    // Race the worker against an 8s deadline — deliver a graceful fallback if it loses.
    const workers = client.workers || [];
    let reply = '';
    const WORKER_TIMEOUT_MS = 8000;
    const timeoutReply = `Thanks for reaching out to ${client.business?.name || 'us'}! We're on it and will follow up shortly.`;

    const _workerRace = async () => {
        // After-hours overrides everything
        if (workers.includes('after-hours') && !afterHoursWorker.isBusinessOpen(client.business.hours)) {
            campaignTracker.trackReceived(client.slug, 'after-hours');
            return afterHoursWorker.run({ client, message, customerNumber });
        }
        // Route by detected intent
        if (intent?.suggestedWorker && workers.includes(intent.suggestedWorker)) {
            const workerMap = {
                'receptionist':   receptionistWorker,
                'booking':        bookingWorker,
                'intake':         intakeWorker,
                'waitlist':       waitlistWorker,
                'faq':            faqWorker,
                'invoice-chaser': invoiceChaserWorker,
                'quote':          quoteWorker,
                'reminder':       reminderWorker,
                'review-requester': reviewRequesterWorker,
                'referral':       referralWorker,
            };
            const w = workerMap[intent.suggestedWorker];
            if (w) {
                campaignTracker.trackReceived(client.slug, intent.suggestedWorker);
                return w.run({ client, message, customerNumber });
            }
        }
        // Fallback priority order
        if (workers.includes('receptionist')) {
            campaignTracker.trackReceived(client.slug, 'receptionist');
            return receptionistWorker.run({ client, message, customerNumber });
        }
        if (workers.includes('faq')) {
            campaignTracker.trackReceived(client.slug, 'faq');
            return faqWorker.run({ client, message, customerNumber });
        }
        return '';
    };

    try {
        const timeout = new Promise(resolve => setTimeout(() => resolve('__timeout__'), WORKER_TIMEOUT_MS));
        const result = await Promise.race([_workerRace(), timeout]);
        if (result === '__timeout__') {
            console.warn(`[SMS] Worker timed out after ${WORKER_TIMEOUT_MS}ms — sending fallback`);
            reply = timeoutReply;
        } else {
            reply = result || '';
        }
    } catch (e) {
        console.log(`[SMS] Worker error: ${e.message}`);
        reply = timeoutReply;
        // Report to portal so MJ sees it in the admin error log and health alerts
        reportWorkerError(
            client.supabaseClientId || client.slug,
            intent?.suggestedWorker || 'unknown',
            e.message,
            { customerPhone: customerNumber, incomingNumber }
        );
    }

    // ── Step 6: Update customer profile (async) ────────────────────────────
    setImmediate(async () => {
        try {
            customerProfiler.recordInteraction(client.slug, customerNumber, {
                workerName: intent?.suggestedWorker || 'unknown',
            });
            // Extract FAQs from conversation (background)
            const memory = require('./workers/memory');
            const history = await memory.loadHistory(client.slug, customerNumber);
            faqExtractor.extractFromConversation(history, client.slug, client.business.name);
        } catch (e) {
            console.log(`[SMS] Post-processing error: ${e.message}`);
        }
    });

    // ── Step 7: Push outcome back to Make.com (two-way CRM sync) ──────────
    if (reply) {
        pushOutcomeToMake(client, customerNumber, intent?.suggestedWorker || 'receptionist', message, reply);
    }

    const twiml = reply
        ? `<Response><Message>${escapeXml(reply)}</Message></Response>`
        : `<Response></Response>`;

    res.set('Content-Type', 'text/xml').send(twiml);
});

// ─── Outbound Trigger Routes ───────────────────────────────────────────────────

function outboundGuard(clientSlug, customerNumber, client = null) {
    // Opt-out guard
    optoutManager.guardOutbound(clientSlug, customerNumber);
    // TCPA quiet hours check — use the client's own timezone, not server local.
    const tz = client?.business?.timezone || 'America/Chicago';
    const tcpa = tcpaChecker.isQuietHours(tz);
    if (tcpa) throw new Error(`TCPA quiet hours (${tz}) — message blocked. Retry after 8am.`);
}

app.post('/trigger/review-requester', requireApiKey, async (req, res) => {
    const { twilioNumber, customerNumber, customerName, serviceName } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        outboundGuard(client.slug, customerNumber, client);
        await reviewRequesterWorker.send({ client, customerNumber, customerName, serviceName });
        campaignTracker.trackSent(client.slug, 'review-requester');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/trigger/reminder', requireApiKey, async (req, res) => {
    const { twilioNumber, customerNumber, customerName, appointmentTime, serviceName, reminderType } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        outboundGuard(client.slug, customerNumber, client);
        await reminderWorker.send({ client, customerNumber, customerName, appointmentTime, serviceName, reminderType });
        campaignTracker.trackSent(client.slug, 'reminder');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/trigger/reactivation', requireApiKey, async (req, res) => {
    const { twilioNumber, customerNumber, customerName, lastServiceName } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        outboundGuard(client.slug, customerNumber, client);
        await reactivationWorker.send({ client, customerNumber, customerName, lastServiceName });
        campaignTracker.trackSent(client.slug, 'reactivation');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/trigger/lead-followup', requireApiKey, async (req, res) => {
    const { twilioNumber, customerNumber, customerName, inquiryAbout, followUpNumber } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        outboundGuard(client.slug, customerNumber, client);
        await leadFollowupWorker.send({ client, customerNumber, customerName, inquiryAbout, followUpNumber });
        campaignTracker.trackSent(client.slug, 'lead-followup');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/trigger/invoice-chaser', requireApiKey, async (req, res) => {
    const { twilioNumber, customerNumber, customerName, invoiceNumber, amount, dueDate, paymentLink, chaseNumber } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        outboundGuard(client.slug, customerNumber, client);
        await invoiceChaserWorker.send({ client, customerNumber, customerName, invoiceNumber, amount, dueDate, paymentLink, chaseNumber });
        campaignTracker.trackSent(client.slug, 'invoice-chaser');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/trigger/quote', requireApiKey, async (req, res) => {
    const { twilioNumber, customerNumber, customerName, serviceName, quoteAmount, validUntil, quoteDetails } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        outboundGuard(client.slug, customerNumber, client);
        await quoteWorker.send({ client, customerNumber, customerName, serviceName, quoteAmount, validUntil, quoteDetails });
        campaignTracker.trackSent(client.slug, 'quote');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/trigger/waitlist-notify', requireApiKey, async (req, res) => {
    const { twilioNumber, customerNumber, customerName, serviceName, availableTime } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        outboundGuard(client.slug, customerNumber, client);
        await waitlistWorker.sendSpotAvailable({ client, customerNumber, customerName, serviceName, availableTime });
        campaignTracker.trackSent(client.slug, 'waitlist');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/trigger/referral', requireApiKey, async (req, res) => {
    const { twilioNumber, customerNumber, customerName, lastServiceName } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        outboundGuard(client.slug, customerNumber, client);
        await referralWorker.send({ client, customerNumber, customerName, lastServiceName });
        campaignTracker.trackSent(client.slug, 'referral');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/trigger/upsell', requireApiKey, async (req, res) => {
    const { twilioNumber, customerNumber, customerName, completedServiceName, upsellServiceName, upsellReason } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        outboundGuard(client.slug, customerNumber, client);
        await upsellWorker.send({ client, customerNumber, customerName, completedServiceName, upsellServiceName, upsellReason });
        campaignTracker.trackSent(client.slug, 'upsell');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/trigger/onboarding', requireApiKey, async (req, res) => {
    const { twilioNumber, customerNumber, customerName, serviceName } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        outboundGuard(client.slug, customerNumber, client);
        await onboardingWorker.send({ client, customerNumber, customerName, serviceName });
        campaignTracker.trackSent(client.slug, 'onboarding');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Intelligent Agent Routes ────────────────────────────────────────────────
//
// POST /agents/reputation  — Reputation Agent (review requests, responses, velocity monitor)
// POST /agents/retention   — Retention Agent (win-back, loyalty, birthday, churn)
// POST /agents/lead-nurture — Lead Nurture Agent (qualify, score, sequence)
//
// Body: { clientId, event, ...eventParams }
// Auth: GRIDHAND_API_KEY or WORKERS_API_SECRET bearer token

// ── Reputation Agent ──────────────────────────────────────────────────────────
app.post('/agents/reputation', requireApiKey, async (req, res) => {
    const { clientId, event, customerPhone, customerName, serviceName } = req.body;
    if (!clientId || !event) return res.status(400).json({ error: 'clientId and event are required' });

    try {
        const result = await reputationAgent.run(clientId, {
            event,
            customerPhone,
            customerName,
            serviceName,
        });
        res.json({ success: true, event, result: result || {} });
    } catch (e) {
        console.error(`[ReputationAgent] Route error: ${e.message}`);
        reportWorkerError(clientId, 'ReputationAgent', e.message, { event });
        res.status(500).json({ error: e.message });
    }
});

// ── Retention Agent ───────────────────────────────────────────────────────────
app.post('/agents/retention', requireApiKey, async (req, res) => {
    const { clientId, event, customerPhone, customerName, serviceName, dob } = req.body;
    if (!clientId || !event) return res.status(400).json({ error: 'clientId and event are required' });

    try {
        const result = await retentionAgent.run(clientId, {
            event,
            customerPhone,
            customerName,
            serviceName,
            dob,
        }, loadClient);
        res.json({ success: true, event, result: result || {} });
    } catch (e) {
        console.error(`[RetentionAgent] Route error: ${e.message}`);
        reportWorkerError(clientId, 'RetentionAgent', e.message, { event });
        res.status(500).json({ error: e.message });
    }
});

// ── Lead Nurture Agent ────────────────────────────────────────────────────────
app.post('/agents/lead-nurture', requireApiKey, async (req, res) => {
    const { clientId, event, customerPhone, customerName, inquiryAbout, source, message } = req.body;
    if (!clientId || !event) return res.status(400).json({ error: 'clientId and event are required' });

    try {
        const result = await leadNurtureAgent.run(clientId, {
            event,
            customerPhone,
            customerName,
            inquiryAbout,
            source,
            message,
        }, loadClient);
        res.json({ success: true, event, result: result || {} });
    } catch (e) {
        console.error(`[LeadNurtureAgent] Route error: ${e.message}`);
        reportWorkerError(clientId, 'LeadNurtureAgent', e.message, { event });
        res.status(500).json({ error: e.message });
    }
});

// ── Credential Monitor (manual trigger) ──────────────────────────────────────
// Runs automatically every 6h via setInterval above.
// This route lets MJ trigger a manual check from the portal or CLI.
app.post('/agents/credential-monitor', requireApiKey, async (req, res) => {
    try {
        const results = await credentialMonitor.run();
        res.json({ success: true, ...results });
    } catch (e) {
        console.error('[CredMonitor] Route error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── Reputation pending requests runner (every 30 min) ───────────────────────
// Checks for any review requests that have passed their 3-hour delay and fires them.
setInterval(() => {
    reputationAgent.runPendingRequests(loadClient).catch(e =>
        console.log(`[ReputationAgent] Pending runner error: ${e.message}`)
    );
}, 30 * 60 * 1000);

// ─── Retention daily cron (9am check, every hour) ────────────────────────────
// Each client has a timezone — check every hour if any client's local time is 9am.
setInterval(async () => {
    const nowUTC = new Date();
    try {
        const { data: clients } = await supabaseAdmin
            .from('clients')
            .select('id, timezone, workers_paused')
            .eq('workers_paused', false);

        for (const client of (clients || [])) {
            const tz = client.timezone || 'America/Chicago';
            try {
                const localHour = parseInt(
                    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(nowUTC),
                    10
                );
                // Only run at 9am local time (within this hourly window)
                if (localHour === 9) {
                    retentionAgent.runForClient(client.id, loadClient).catch(e =>
                        console.log(`[RetentionAgent] Client ${client.id} error: ${e.message}`)
                    );
                }
            } catch (_) {}
        }
    } catch (e) {
        console.log(`[RetentionAgent] Cron query error: ${e.message}`);
    }
}, 60 * 60 * 1000);

// ─── Lead nurture follow-up runner (every 30 min) ────────────────────────────
// Checks for warm/cold leads that need their next scheduled follow-up.
setInterval(async () => {
    try {
        const { data: clients } = await supabaseAdmin
            .from('clients')
            .select('id')
            .eq('workers_paused', false);

        for (const client of (clients || [])) {
            leadNurtureAgent.runFollowupsForClient(client.id, loadClient).catch(e =>
                console.log(`[LeadNurtureAgent] Client ${client.id} error: ${e.message}`)
            );
        }
    } catch (e) {
        console.log(`[LeadNurtureAgent] Follow-up runner error: ${e.message}`);
    }
}, 30 * 60 * 1000);

// ─── Integration Event Dispatcher ────────────────────────────────────────────
//
// POST /events/integration
// Receives events from Make.com scenarios (Calendly, Stripe, Shopify, etc.)
// and routes each to the correct worker so real action fires — SMS, review
// request, re-engagement, etc.
//
// Body: { clientId, platform, event, data, source, fired_at }
// Auth: WORKERS_API_KEY or WORKERS_API_SECRET bearer token

const integrationDispatcher = require('./workers/integration-dispatcher');

app.post('/events/integration', requireApiKey, async (req, res) => {
    const { clientId, platform, event, data } = req.body;

    if (!clientId || !platform) {
        return res.status(400).json({ error: 'clientId and platform are required' });
    }

    const client = loadClientBySupabaseId(clientId);
    if (!client) {
        // Client may not be provisioned in workers yet — log and return 200 so
        // Make.com doesn't retry endlessly
        console.log(`[Integration] Client ${clientId} not found in workers — event dropped (${platform}/${event})`);
        return res.json({ success: false, reason: 'client_not_provisioned' });
    }

    try {
        const result = await integrationDispatcher.dispatchEvent(client, platform, event, data || {});
        console.log(`[Integration] ${platform}/${event} → ${result.worker || 'none'} (${result.action})`);
        return res.json({ success: true, ...result });
    } catch (err) {
        console.error(`[Integration] Dispatch error for ${platform}/${event}:`, err.message);
        reportWorkerError(clientId, `integration:${platform}`, err.message, { platform, event });
        return res.status(500).json({ error: err.message });
    }
});

// POST /test-dispatch
// Dry-run integration test — runs the full dispatcher logic (client lookup,
// phone extraction, worker routing) but NEVER fires real SMS or any action.
// Used by the portal's integration-tester.ts to validate end-to-end routing.
//
// Body: { clientId, platform, event, dryRun: true }
// Returns: { clientFound, phone, worker, action, tcpa, dryRun: true }

app.post('/test-dispatch', requireApiKey, async (req, res) => {
    const { clientId, platform, event: eventPayload, dryRun } = req.body;

    if (!clientId || !platform) {
        return res.status(400).json({ error: 'clientId and platform are required' });
    }
    if (!dryRun) {
        return res.status(400).json({ error: 'This endpoint is dry-run only. Pass dryRun: true.' });
    }

    // 1. Find the client
    const client = loadClientBySupabaseId(clientId);
    if (!client) {
        return res.json({
            dryRun: true,
            clientFound: false,
            phone: null,
            worker: null,
            action: 'client_not_found',
            detail: `No client config found for supabaseClientId=${clientId}`,
        });
    }

    // 2. Run dispatcher logic without executing workers
    try {
        // Use the dispatcher's extractPhone and routing logic directly
        const platformKey = (platform || '').toLowerCase().replace(/[\s-]/g, '_');
        const data = eventPayload || {};

        // Extract phone using the real dispatcher
        const phone = integrationDispatcher.extractPhone(platformKey, data?.event || 'test', data);

        // Determine which worker would handle this
        const PLATFORM_CATEGORY = integrationDispatcher.PLATFORM_CATEGORY || {};
        const category = PLATFORM_CATEGORY[platformKey] || 'default';

        // Map category to worker name (mirrors dispatchEvent logic)
        const CATEGORY_TO_WORKER = {
            appointment: 'Review Requester',
            payment: 'Review Requester',
            ecommerce: 'SMS Worker',
            crm: 'SMS Worker',
            marketing: 'Re-engagement',
            fieldservice: 'Review Requester',
            restaurant: 'Review Requester',
            leadgen: 'SMS Worker',
            accounting: 'Review Requester',
            helpdesk: 'SMS Worker',
            social: 'SMS Worker',
            review: 'Review Responder',
        };
        const worker = CATEGORY_TO_WORKER[category] || 'SMS Worker';

        // Check TCPA hours (same check the real dispatcher uses)
        const now = new Date();
        const hour = now.getHours();
        const tcpa = (hour >= 8 && hour < 21) ? 'allowed' : 'blocked_quiet_hours';

        let action = 'would_send';
        if (!phone) action = 'no_phone';
        else if (tcpa !== 'allowed') action = 'tcpa_blocked';
        else if (!client.assignedWorkers || client.assignedWorkers.length === 0) action = 'no_workers_assigned';

        return res.json({
            dryRun: true,
            clientFound: true,
            clientName: client.businessName || client.business_name,
            phone: phone ? `${phone.slice(0, 4)}****${phone.slice(-2)}` : null,  // mask for logs
            worker,
            category,
            platform: platformKey,
            action,
            tcpa,
            assignedWorkers: client.assignedWorkers || [],
        });

    } catch (err) {
        return res.status(500).json({
            dryRun: true,
            clientFound: true,
            error: err.message,
            action: 'dispatcher_threw',
        });
    }
});

// ─── Operator Validation ──────────────────────────────────────────────────────

// GET /validate/:twilioNumber — check if a client config is ready to go live
app.get('/validate/:twilioNumber', requireApiKey, (req, res) => {
    const twilioNumber = decodeURIComponent(req.params.twilioNumber);
    const client = loadClient(twilioNumber);
    if (!client) {
        return res.status(404).json({
            valid: false,
            error: `No client found for ${twilioNumber}. Add it to clients/loader.js NUMBER_MAP.`,
        });
    }

    const aiCheck = aiClientLib.validate(client);
    const issues  = [...aiCheck.issues];

    // Check required business fields
    const biz = client.business || {};
    if (!biz.name)     issues.push('business.name is required');
    if (!biz.phone)    issues.push('business.phone is required');
    if (!biz.hours)    issues.push('business.hours is required');
    if (!biz.services?.length) issues.push('business.services must have at least one entry');
    if (!biz.faqs?.length)     issues.push('business.faqs must have at least one entry');

    // Check workers are valid
    const validWorkers = ['receptionist','faq','booking','intake','after-hours','waitlist',
        'review-requester','reminder','reactivation','lead-followup',
        'invoice-chaser','quote','referral','upsell','onboarding'];
    for (const w of (client.workers || [])) {
        if (!validWorkers.includes(w)) issues.push(`Unknown worker: "${w}"`);
    }

    res.json({
        valid:       issues.length === 0,
        slug:        client.slug,
        model:       aiCheck.model,
        workers:     client.workers || [],
        issues,
        readyToGo:   issues.length === 0 ? '✅ This client is ready to go live.' : `❌ Fix ${issues.length} issue(s) before going live.`,
    });
});

// GET /validate — list all registered clients and their status
app.get('/validate', requireApiKey, (req, res) => {
    const results = [];
    for (const [number, slug] of Object.entries(NUMBER_MAP)) {
        const client = loadClient(number);
        if (!client) { results.push({ number, slug, valid: false, error: 'Config file missing' }); continue; }
        const aiCheck = aiClientLib.validate(client);
        results.push({
            number,
            slug,
            model:   aiCheck.model,
            workers: client.workers || [],
            valid:   aiCheck.valid && !!client.business?.name,
            issues:  aiCheck.issues,
        });
    }
    res.json({ total: results.length, clients: results });
});

// ─── Agent Test Endpoint ──────────────────────────────────────────────────────
// POST /test — run a worker with a test message, no Twilio, no SMS sent
// Body: { workerName, clientSlug, message, customerNumber? }
app.options('/test', requireApiKey, (req, res) => {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }).sendStatus(204);
});
app.post('/test', requireApiKey, async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    const { workerName, clientSlug, message, customerNumber = '+10000000000' } = req.body;

    if (!workerName || !clientSlug || !message) {
        return res.status(400).json({ error: 'workerName, clientSlug, and message are required' });
    }

    const client = loadClientBySlug(clientSlug);
    if (!client) return res.status(404).json({ error: `No client config found for slug: ${clientSlug}` });

    const workerMap = {
        'receptionist':     receptionistWorker,
        'faq':              faqWorker,
        'booking':          bookingWorker,
        'intake':           intakeWorker,
        'after-hours':      afterHoursWorker,
        'waitlist':         waitlistWorker,
        'review-requester': reviewRequesterWorker,
        'reminder':         reminderWorker,
        'reactivation':     reactivationWorker,
        'lead-followup':    leadFollowupWorker,
        'invoice-chaser':   invoiceChaserWorker,
        'quote':            quoteWorker,
        'referral':         referralWorker,
        'upsell':           upsellWorker,
        'onboarding':       onboardingWorker,
    };

    const worker = workerMap[workerName];
    if (!worker) return res.status(400).json({ error: `Unknown worker: ${workerName}` });
    if (!worker.run) return res.status(400).json({ error: `Worker "${workerName}" is outbound-only and has no inbound run() handler` });

    try {
        const reply = await worker.run({ client, message, customerNumber });
        res.json({ success: true, reply, worker: workerName, client: clientSlug });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Analytics & Reports ───────────────────────────────────────────────────────

// ── Worker state machine snapshot ─────────────────────────────────────────────
app.get('/worker-states', requireApiKey, (req, res) => {
    const { stateMachine } = require('./lib/worker-state');
    const clientSlug = req.query.client || null;
    const states = clientSlug
        ? stateMachine.getClientStates(clientSlug)
        : stateMachine.snapshot();
    res.json({ active: stateMachine.getActive().length, states });
});

// ── Client intelligence summary ───────────────────────────────────────────────
app.get('/intel/:slug', requireApiKey, (req, res) => {
    const clientIntel = require('./lib/client-intel');
    const summary = clientIntel.getSummary(req.params.slug);
    res.json(summary);
});

// ── Doctor health check ───────────────────────────────────────────────────────
app.get('/doctor/:slug', requireApiKey, async (req, res) => {
    const { execFile } = require('child_process');
    const path = require('path');
    execFile('node', [path.join(__dirname, 'lib/doctor.js'), req.params.slug, '--json'], (err, stdout) => {
        try { res.json(JSON.parse(stdout)); }
        catch { res.status(500).json({ error: err?.message || 'Doctor failed' }); }
    });
});

app.get('/reports/:twilioNumber', requireApiKey, (req, res) => {
    const client = loadClient(req.params.twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const report = campaignTracker.getReport(client.slug);
    res.json(report);
});

app.get('/customers/:twilioNumber', requireApiKey, (req, res) => {
    const client = loadClient(req.params.twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const customers = customerProfiler.getAllCustomers(client.slug);
    res.json({ total: Object.keys(customers).length, customers });
});

app.get('/queue/:twilioNumber', requireApiKey, (req, res) => {
    const client = loadClient(req.params.twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const stats = reengagementScheduler.getQueueStats(client.slug);
    const due = reengagementScheduler.getDueForReengagement(client.slug);
    res.json({ stats, dueNow: due });
});

// ─── Inbound Voice Webhook ────────────────────────────────────────────────────
// Twilio calls this when someone dials the client's number.
// Returns TwiML that opens a Media Stream WebSocket → voice-bridge.js → ElevenLabs.
app.post('/voice/:slug', async (req, res) => {
    const twilio = require('twilio');
    const { VoiceResponse } = twilio.twiml;

    const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioSignature = req.headers['x-twilio-signature'];

    if (!twilioAuthToken || !twilioSignature) {
        console.warn('[Voice] Missing auth token or signature — rejecting');
        return res.status(403).send('Forbidden');
    }

    const webhookUrl = `${process.env.NEXT_PUBLIC_WORKERS_URL || `https://${req.headers.host}`}/voice/${req.params.slug}`;
    const valid = twilio.validateRequest(twilioAuthToken, twilioSignature, webhookUrl, req.body);
    if (!valid) {
        console.warn('[Voice] Invalid Twilio signature — rejecting');
        return res.status(403).send('Forbidden');
    }

    const slug     = req.params.slug;
    const caller   = req.body.From || '';
    const client   = loadClientBySlug(slug);

    if (!client?.supabaseClientId) {
        console.warn(`[Voice] No client found for slug "${slug}"`);
        const twiml = new VoiceResponse();
        twiml.say('Sorry, this number is not currently in service.');
        return res.set('Content-Type', 'text/xml').send(twiml.toString());
    }

    // Build WebSocket URL — wss:// from the workers host
    const workersHost = (process.env.NEXT_PUBLIC_WORKERS_URL || `https://${req.headers.host}`)
        .replace(/^https?:\/\//, '')
        .replace(/\/$/, '')
    const streamUrl = `wss://${workersHost}/voice-stream`

    const twiml = new VoiceResponse();
    const connect = twiml.connect();
    const stream  = connect.stream({ url: streamUrl });
    stream.parameter({ name: 'clientId', value: client.supabaseClientId });
    stream.parameter({ name: 'caller',   value: encodeURIComponent(caller) });

    console.log(`[Voice] Routing call from ${caller} → ${slug} (clientId=${client.supabaseClientId})`)
    res.set('Content-Type', 'text/xml').send(twiml.toString());
});

// ─── Client Auto-Provisioning ─────────────────────────────────────────────────
// POST /provision — create a new client config from the portal on signup
// Body: { slug, businessName, clientId?, twilioNumber?, industry?, city?, phone?, hours?, services?, workers? }
// twilioNumber is optional at signup — clients are added to the registry only when a real number is assigned.
app.post('/provision', requireApiKey, async (req, res) => {
    const fs   = require('fs');
    const path = require('path');

    const {
        slug,
        twilioNumber,   // optional at signup — can be empty string or omitted
        businessName,
        clientId,       // Supabase user ID — stored for future portal↔workers linkage
        industry,
        city,
        phone,
        hours,
        services,
        workers,
    } = req.body;

    // Validate required fields (twilioNumber is no longer required at signup)
    if (!slug || !businessName) {
        return res.status(400).json({ error: 'slug and businessName are required' });
    }

    // Sanitize slug: lowercase alphanumeric + hyphens only
    const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!safeSlug) {
        return res.status(400).json({ error: 'slug produced an invalid filename after sanitization' });
    }

    const clientsDir    = path.join(__dirname, 'clients');
    const configPath    = path.join(clientsDir, `${safeSlug}.json`);
    const registryPath  = path.join(clientsDir, 'registry.json');

    // Build the client config based on the operator template structure
    const serviceList = Array.isArray(services) && services.length
        ? services.map(s => (typeof s === 'string' ? { name: s, price: 'Contact us' } : s))
        : [{ name: 'General Service', price: 'Contact us' }];

    const workerList = Array.isArray(workers) && workers.length
        ? workers
        : ['receptionist', 'faq', 'after-hours'];

    const safeNumber = (typeof twilioNumber === 'string' && twilioNumber.trim()) ? twilioNumber.trim() : '';

    const config = {
        slug:         safeSlug,
        id:           safeSlug,
        twilioNumber: safeNumber,

        // Portal client ID (Supabase UUID) — used to link this config back to the portal client record.
        // MUST be "supabaseClientId" — loadClientBySupabaseId() in loader.js searches for this field.
        ...(clientId ? { supabaseClientId: clientId } : {}),

        model: 'anthropic/claude-haiku-4-5-20251001',

        apiKeys: {
            anthropic:    null,
            twilio:       { accountSid: null, authToken: null },
            moonshot:     null,
            ollamaBaseUrl: null,
            openai:       null,
        },

        workers: workerList,

        business: {
            name:     businessName,
            industry: industry || 'General',
            city:     city || '',
            address:  '',
            phone:    phone || '',
            website:  '',
            hours:    hours || 'Mon-Fri 9am-5pm',
            services: serviceList,
            faqs: [
                { q: 'What are your hours?',      a: `We're open ${hours || 'Mon-Fri 9am-5pm'}.` },
                { q: 'Do you offer free quotes?', a: 'Yes! Contact us to get started.' },
            ],
        },

        settings: {
            global: {
                tone:              'friendly',
                faqHandoff:        true,
                escalateOnUpset:   true,
                escalationNumber:  phone || '',
            },
            'review-requester': { delayHours: 2, reviewLink: '' },
            reminder:           { firstReminderHours: 24, secondReminderHours: 1, includeAddress: true, includeCancellationInfo: true },
            'after-hours':      { captureLeadInfo: true },
            reactivation:       { dormantDays: 90, offerDiscount: false, discountText: '' },
            'lead-followup':    { followUpCount: 2, daysBetweenFollowUps: 3 },
            intake:             { collectFields: ['name', 'service', 'preferredTime', 'contactInfo'] },
            'invoice-chaser':   { firstChaseAfterDays: 3, followUpDays: 7, maxFollowUps: 3 },
            referral:           { offerIncentive: false, incentiveText: '' },
            upsell:             { triggerAfterCompletion: true },
            booking:            { bookingMethod: 'phone', bookingLink: null },
            onboarding: {
                customWelcome: null,
                steps: [
                    'Confirm their contact details',
                    'Explain what to expect next',
                    `Share key business info for ${businessName} (hours, phone, website)`,
                    'Answer any initial questions',
                ],
            },
        },

        integrations: {
            googleBusiness: { placeId: null, apiKey: null },
            calendar:       { provider: null, credentials: {} },
            crm:            { provider: null, credentials: {} },
            payments:       { provider: null, credentials: {} },
        },
    };

    // Prevent overwriting an existing client config
    if (fs.existsSync(configPath)) {
        return res.status(409).json({
            error: 'Client already provisioned. Use POST /provision/update to modify.',
            slug: safeSlug,
        });
    }

    try {
        await withRegistryLock(async () => {
            // Re-check existence INSIDE the lock to close the TOCTOU window
            if (fs.existsSync(configPath)) {
                const err = new Error('Client already provisioned');
                err.statusCode = 409;
                throw err;
            }

            // Stamp revision so /provision/update can do compare-and-set later
            config.revision = 1;

            // 1. Write the client config file (atomic)
            atomicWriteFileSync(configPath, JSON.stringify(config, null, 2));
            console.log(`[Provision] Wrote config: ${configPath}`);

            // 1b. Persist to Supabase so config survives Railway container restarts
            if (config.supabaseClientId) {
                supabaseAdmin.from('clients')
                    .update({ worker_config: config })
                    .eq('id', config.supabaseClientId)
                    .then(() => console.log(`[Provision] Config saved to Supabase: ${config.supabaseClientId}`))
                    .catch(e => console.warn(`[Provision] Supabase save failed (non-fatal): ${e.message}`));
            }

            // 2. Update registry.json with the twilioNumber → slug mapping
            if (safeNumber) {
                let registry = {};
                try {
                    if (fs.existsSync(registryPath)) {
                        registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
                    }
                } catch (e) {
                    console.log(`[Provision] Could not read existing registry, starting fresh: ${e.message}`);
                }
                registry[safeNumber] = safeSlug;
                atomicWriteFileSync(registryPath, JSON.stringify(registry, null, 2));
                console.log(`[Provision] Registry updated: ${safeNumber} → ${safeSlug}`);
            } else {
                console.log(`[Provision] No Twilio number supplied — skipping registry entry for "${safeSlug}". Update via /provision/update when number is assigned.`);
            }
        });

        res.json({
            success:      true,
            slug:         safeSlug,
            twilioNumber: safeNumber || null,
            configPath:   `clients/${safeSlug}.json`,
            workers:      workerList,
            revision:     1,
            note:         safeNumber ? undefined : 'No Twilio number assigned yet. POST to /provision/update when ready.',
        });
    } catch (e) {
        console.log(`[Provision] Error: ${e.message}`);
        const code = e.statusCode || 500;
        res.status(code).json({ error: code === 409 ? e.message : `Failed to provision client: ${e.message}`, slug: safeSlug });
    }
});

// ─── Provision Update — assign/update Twilio number for an existing client ────
// POST /provision/update — called from portal admin when a Twilio number is assigned to a client
// Body: { slug, twilioNumber, [any config fields to patch] }
app.post('/provision/update', requireApiKey, async (req, res) => {
    const fs   = require('fs');
    const path = require('path');

    const { slug, twilioNumber, revision: callerRevision, ...patches } = req.body;

    if (!slug) {
        return res.status(400).json({ error: 'slug is required' });
    }

    const safeSlug   = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const safeNumber = twilioNumber ? twilioNumber.trim() : null;

    const clientsDir   = path.join(__dirname, 'clients');
    const configPath   = path.join(clientsDir, `${safeSlug}.json`);
    const registryPath = path.join(clientsDir, 'registry.json');

    if (!fs.existsSync(configPath)) {
        return res.status(404).json({ error: `No config found for slug "${safeSlug}". Call /provision first.` });
    }

    try {
        let newRevision;
        await withRegistryLock(async () => {
            // Patch config file with the new twilioNumber and any other supplied fields
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

            // Compare-and-set: if the caller supplied a revision, it must match
            // the on-disk revision, otherwise another writer beat us to it.
            if (typeof callerRevision === 'number' && (config.revision || 0) !== callerRevision) {
                const err = new Error(`revision mismatch: expected ${config.revision || 0}, got ${callerRevision}`);
                err.statusCode = 409;
                throw err;
            }

            if (safeNumber) config.twilioNumber = safeNumber;

            // Apply any additional top-level patches (e.g. city, phone, hours, clientId)
            const allowedPatches = ['city', 'phone', 'hours', 'clientId'];
            for (const key of allowedPatches) {
                if (patches[key] !== undefined) {
                    if (key === 'city' || key === 'phone' || key === 'hours') {
                        config.business = config.business || {};
                        config.business[key] = patches[key];
                    } else if (key === 'clientId') {
                        // clientId in the API maps to supabaseClientId in the config
                        // (same convention used in POST /provision)
                        config.supabaseClientId = patches[key];
                    } else {
                        config[key] = patches[key];
                    }
                }
            }

            // Bump revision then write atomically
            config.revision = (config.revision || 0) + 1;
            newRevision = config.revision;
            atomicWriteFileSync(configPath, JSON.stringify(config, null, 2));

            // Also persist to Supabase (keep in sync with filesystem)
            if (config.supabaseClientId) {
                supabaseAdmin.from('clients')
                    .update({ worker_config: config })
                    .eq('id', config.supabaseClientId)
                    .then(() => {})
                    .catch(e => console.warn(`[Provision/Update] Supabase sync failed (non-fatal): ${e.message}`));
            }

            // Update registry atomically
            let registry = {};
            try {
                if (fs.existsSync(registryPath)) registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
            } catch (e) { /* start fresh */ }
            if (safeNumber) {
                registry[safeNumber] = safeSlug;
                atomicWriteFileSync(registryPath, JSON.stringify(registry, null, 2));
            }
        });

        console.log(`[Provision/Update] ${safeSlug} → ${safeNumber || '(no number change)'} (rev ${newRevision})`);
        res.json({ success: true, slug: safeSlug, twilioNumber: safeNumber, revision: newRevision });
    } catch (e) {
        console.log(`[Provision/Update] Error: ${e.message}`);
        const code = e.statusCode || 500;
        res.status(code).json({ error: code === 409 ? e.message : `Failed to update client: ${e.message}` });
    }
});

// ─── Startup Config Restore — pull worker configs from Supabase ──────────────
// Railway containers start with an empty /app/clients directory on every deploy.
// This syncs all previously provisioned configs back from Supabase before the
// server begins accepting traffic, so workers always have their client data.
async function restoreConfigsFromSupabase() {
    const fs   = require('fs');
    const path = require('path');
    const clientsDir  = path.join(__dirname, 'clients');
    const registryPath = path.join(clientsDir, 'registry.json');

    try {
        const { data: rows, error } = await supabaseAdmin
            .from('clients')
            .select('id, worker_config')
            .not('worker_config', 'is', null);

        if (error) {
            console.warn('[Startup] Supabase config restore failed:', error.message);
            return;
        }
        if (!rows || rows.length === 0) {
            console.log('[Startup] No saved worker configs in Supabase.');
            return;
        }

        let registry = {};
        try {
            if (fs.existsSync(registryPath)) registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        } catch { /* start fresh */ }

        let restored = 0;
        for (const row of rows) {
            const cfg = row.worker_config;
            if (!cfg?.slug) continue;
            const safeSlug   = cfg.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
            const configPath = path.join(clientsDir, `${safeSlug}.json`);
            if (!fs.existsSync(configPath)) {
                atomicWriteFileSync(configPath, JSON.stringify(cfg, null, 2));
                console.log(`[Startup] Restored: clients/${safeSlug}.json`);
                restored++;
            }
            if (cfg.twilioNumber) registry[cfg.twilioNumber] = safeSlug;
        }

        if (restored > 0) {
            atomicWriteFileSync(registryPath, JSON.stringify(registry, null, 2));
            console.log(`[Startup] Restored ${restored} client config(s) from Supabase.`);
        }
    } catch (err) {
        console.warn('[Startup] Config restore error (non-fatal):', err.message);
    }
}

// ─── Start Server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// ─── WebSocket Server (Voice Bridge) ──────────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });

// Verify a short-lived HMAC token issued by the portal no-answer handler.
// Tokens sign `${sid}.${cid}.${exp}` with VOICE_BRIDGE_HMAC_SECRET.
function verifyVoiceBridgeToken(url) {
    const secret = process.env.VOICE_BRIDGE_HMAC_SECRET;
    if (!secret) {
        console.warn('[VoiceBridge] VOICE_BRIDGE_HMAC_SECRET not set — refusing connection');
        return null;
    }
    const token = url.searchParams.get('token') || '';
    const exp   = url.searchParams.get('exp')   || '';
    const sid   = url.searchParams.get('sid')   || '';
    const cid   = url.searchParams.get('cid')   || '';
    if (!token || !exp || !sid || !cid) return null;

    const expNum = parseInt(exp, 10);
    if (!Number.isFinite(expNum) || expNum * 1000 < Date.now()) {
        console.warn('[VoiceBridge] token expired');
        return null;
    }

    const expected = crypto.createHmac('sha256', secret).update(`${sid}.${cid}.${exp}`).digest('hex');
    let ok = false;
    try {
        const a = Buffer.from(token, 'hex');
        const b = Buffer.from(expected, 'hex');
        ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { ok = false; }
    if (!ok) {
        console.warn('[VoiceBridge] token signature mismatch');
        return null;
    }
    return { callSid: sid, clientId: cid };
}

server.on('upgrade', (req, socket, head) => {
    console.log(`[WS Upgrade] req.url="${req.url}" host="${req.headers.host}"`)
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/voice-stream') {
        // Railway's proxy strips query strings from WebSocket Upgrade requests,
        // so HMAC tokens in query params never arrive. Auth is handled inside
        // handleVoiceStream once the Twilio 'start' event delivers the clientId.
        wss.handleUpgrade(req, socket, head, (ws) => {
            handleVoiceStream(ws, null).catch(err => {
                console.error(`[VoiceBridge] Unhandled error: ${err.message}`);
                ws.close();
            });
        });
    } else {
        socket.destroy();
    }
});

// Restore persisted client configs from Supabase before accepting traffic
restoreConfigsFromSupabase().finally(() => {
    server.listen(PORT, () => {
        console.log(`GRIDHAND Workers running on port ${PORT}`);
        console.log(`${15} workers | ${24} subagents | voice bridge active | fully operational`);
        deployWatch.start();
    });
});

// ─── Top-level unhandled error hooks ─────────────────────────────────────────
// These are last-resort safety nets. Railway restarts the process on crash,
// but we alert MJ first so he knows it happened.
process.on('uncaughtException', (err) => {
    sendCriticalAlert('server:uncaughtException', err.message, {}).catch(() => {});
    console.error('[FATAL] uncaughtException — process will exit:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    sendCriticalAlert('server:unhandledRejection', msg, {}).catch(() => {});
    console.error('[FATAL] unhandledRejection:', reason);
    // Do not exit — unhandled rejections are usually recoverable
});
