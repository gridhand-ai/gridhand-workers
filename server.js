const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { loadClient, loadClientBySlug, NUMBER_MAP } = require('./clients/loader');
const aiClientLib = require('./lib/ai-client');
const { handleVoiceStream } = require('./voice-bridge');

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

// ─── API Key Auth Middleware ───────────────────────────────────────────────────
// Protects admin endpoints. Set GRIDHAND_API_KEY in Railway env vars.
function requireApiKey(req, res, next) {
    const serverKey = process.env.GRIDHAND_API_KEY;
    if (!serverKey) {
        // If no key is configured, block all access to protected routes
        return res.status(503).json({ error: 'Server not configured: GRIDHAND_API_KEY not set.' });
    }
    const authHeader = req.headers['authorization'] || '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (provided !== serverKey) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
    next();
}

// ─── Sequence Runner (every 60s) ──────────────────────────────────────────────
setInterval(() => {
    sequenceOrchestrator.runDueSequences({}, sender).catch(e =>
        console.log(`[Sequences] Runner error: ${e.message}`)
    );
}, 60000);

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        status: 'GRIDHAND Workers online',
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
    const incomingNumber = req.body.To;
    const customerNumber = req.body.From;
    const message        = req.body.Body?.trim();

    console.log(`[SMS] ${customerNumber} → ${incomingNumber}: "${message}"`);

    const client = loadClient(incomingNumber);
    if (!client) {
        console.log(`[SMS] No client found for number ${incomingNumber}`);
        return res.set('Content-Type', 'text/xml').send('<Response></Response>');
    }

    // ── Step 1: Opt-out check (MUST run first, always) ─────────────────────
    const optout = optoutManager.process(client.slug, customerNumber, message);
    if (optout.action === 'opted-out' || optout.blocked) {
        campaignTracker.trackOptOut(client.slug, 'inbound');
        const reply = optout.reply || '';
        return res.set('Content-Type', 'text/xml').send(
            reply ? `<Response><Message>${reply}</Message></Response>` : `<Response></Response>`
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
    const workers = client.workers || [];
    let reply = '';

    try {
        // After-hours overrides everything
        if (workers.includes('after-hours') && !afterHoursWorker.isBusinessOpen(client.business.hours)) {
            reply = await afterHoursWorker.run({ client, message, customerNumber });
            campaignTracker.trackReceived(client.slug, 'after-hours');
        }
        // Route by detected intent
        else if (intent?.suggestedWorker && workers.includes(intent.suggestedWorker)) {
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
                reply = await w.run({ client, message, customerNumber });
                campaignTracker.trackReceived(client.slug, intent.suggestedWorker);
            }
        }
        // Fallback priority order
        else if (workers.includes('receptionist')) {
            reply = await receptionistWorker.run({ client, message, customerNumber });
            campaignTracker.trackReceived(client.slug, 'receptionist');
        } else if (workers.includes('faq')) {
            reply = await faqWorker.run({ client, message, customerNumber });
            campaignTracker.trackReceived(client.slug, 'faq');
        }
    } catch (e) {
        console.log(`[SMS] Worker error: ${e.message}`);
        reply = `Thanks for reaching out to ${client.business.name}! We'll get back to you shortly.`;
    }

    // ── Step 6: Update customer profile (async) ────────────────────────────
    setImmediate(async () => {
        try {
            customerProfiler.recordInteraction(client.slug, customerNumber, {
                workerName: intent?.suggestedWorker || 'unknown',
            });
            // Extract FAQs from conversation (background)
            const memory = require('./workers/memory');
            const history = memory.loadHistory(client.slug, customerNumber);
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
        ? `<Response><Message>${reply}</Message></Response>`
        : `<Response></Response>`;

    res.set('Content-Type', 'text/xml').send(twiml);
});

// ─── Outbound Trigger Routes ───────────────────────────────────────────────────

function outboundGuard(clientSlug, customerNumber) {
    // Opt-out guard
    optoutManager.guardOutbound(clientSlug, customerNumber);
    // TCPA quiet hours check
    const tcpa = tcpaChecker.isQuietHours();
    if (tcpa) throw new Error('TCPA quiet hours — message blocked. Retry after 8am.');
}

app.post('/trigger/review-requester', requireApiKey, async (req, res) => {
    const { twilioNumber, customerNumber, customerName, serviceName } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        outboundGuard(client.slug, customerNumber);
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
        outboundGuard(client.slug, customerNumber);
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
        outboundGuard(client.slug, customerNumber);
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
        outboundGuard(client.slug, customerNumber);
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
        outboundGuard(client.slug, customerNumber);
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
        outboundGuard(client.slug, customerNumber);
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
        outboundGuard(client.slug, customerNumber);
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
        outboundGuard(client.slug, customerNumber);
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
        outboundGuard(client.slug, customerNumber);
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
        outboundGuard(client.slug, customerNumber);
        await onboardingWorker.send({ client, customerNumber, customerName, serviceName });
        campaignTracker.trackSent(client.slug, 'onboarding');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
app.options('/test', (req, res) => {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    }).sendStatus(204);
});
app.post('/test', async (req, res) => {
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

// ─── Start Server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// ─── WebSocket Server (Voice Bridge) ──────────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/voice-stream') {
        wss.handleUpgrade(req, socket, head, (ws) => {
            handleVoiceStream(ws, url).catch(err => {
                console.error(`[VoiceBridge] Unhandled error: ${err.message}`);
                ws.close();
            });
        });
    } else {
        socket.destroy();
    }
});

server.listen(PORT, () => {
    console.log(`GRIDHAND Workers running on port ${PORT}`);
    console.log(`${15} workers | ${24} subagents | voice bridge active | fully operational`);
});
