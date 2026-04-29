/**
 * GRIDHAND Intake Accelerator — Main Express Server
 *
 * A standalone microservice for law firm client intake automation.
 * Connects to Clio Manage (or PracticePanther) and Twilio SMS.
 *
 * Routes:
 *   POST /webhook/new-inquiry              → capture inbound lead (web form, phone)
 *   POST /webhook/sms                      → Twilio reply handler (questionnaire replies)
 *   GET  /auth/clio                        → start Clio OAuth flow
 *   GET  /auth/clio/callback               → Clio OAuth callback
 *   GET  /auth/practicepanther/callback    → PracticePanther API key onboarding stub
 *   POST /trigger/run-intake               → manually trigger process-inquiry job
 *   POST /trigger/follow-up               → manually trigger follow-up sweep
 *   POST /trigger/daily-report            → manually trigger daily SMS report
 *   GET  /clients/:clientSlug/inquiries   → list inquiries for a client
 *   GET  /health                           → health check
 *
 * Environment vars required:
 *   CLIO_CLIENT_ID, CLIO_CLIENT_SECRET, CLIO_REDIRECT_URI
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   REDIS_URL
 *   GRIDHAND_API_KEY
 *   PORT (default: 3004)
 */

'use strict';

require('dotenv').config();

const express  = require('express');
const cron     = require('node-cron');
const { validateRequest } = require('twilio/lib/webhooks/webhooks');
const clio     = require('./clio');
const intake   = require('./intake');
const jobs     = require('./jobs');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ─── Body Parsers ──────────────────────────────────────────────────────────────

// Raw body needed for Twilio signature validation on the SMS webhook
app.use('/webhook/sms', express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Supabase ─────────────────────────────────────────────────────────────────

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Auth Middleware ───────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
    const serverKey = process.env.GRIDHAND_API_KEY;
    if (!serverKey) return res.status(503).json({ error: 'GRIDHAND_API_KEY not configured' });

    const provided = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (provided !== serverKey) return res.status(401).json({ error: 'Unauthorized' });

    next();
}

/**
 * Validate that an inbound request actually came from Twilio.
 * Uses HMAC-SHA1 signature on the full URL + POST params.
 */
function validateTwilioWebhook(req, res, next) {
    const authToken   = process.env.TWILIO_AUTH_TOKEN;
    const twilioSig   = req.headers['x-twilio-signature'];
    const webhookUrl  = process.env.TWILIO_WEBHOOK_BASE_URL
        ? `${process.env.TWILIO_WEBHOOK_BASE_URL}/webhook/sms`
        : `${req.protocol}://${req.get('host')}/webhook/sms`;

    if (!authToken) {
        console.warn('[Twilio] TWILIO_AUTH_TOKEN not set — skipping signature check (dev mode)');
        return next();
    }

    const isValid = validateRequest(authToken, twilioSig, webhookUrl, req.body);

    if (!isValid) {
        console.warn('[Twilio] Invalid webhook signature — rejected');
        return res.status(403).json({ error: 'Invalid Twilio signature' });
    }

    next();
}

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({
        worker:       'Intake Accelerator',
        status:       'online',
        version:      '1.0.0',
        jobs:         ['process-inquiry', 'send-follow-up', 'schedule-consultation', 'daily-report', 'weekly-report'],
        integrations: ['Clio Manage v4', 'PracticePanther', 'Twilio SMS', 'Supabase'],
        crons: [
            '9am daily — morning intake summary',
            'Every 2 hours — follow-up on stalled intakes',
            'Friday 4pm — weekly intake report',
        ],
    });
});

// ─── Clio OAuth Flow ──────────────────────────────────────────────────────────

// Step 1 — redirect attorney to Clio authorization page
app.get('/auth/clio', (req, res) => {
    const { clientSlug, ownerPhone, attorneyPhone, practiceName } = req.query;

    if (!clientSlug || !ownerPhone) {
        return res.status(400).json({ error: 'clientSlug and ownerPhone are required' });
    }

    // Pre-populate the connection row with phone numbers and practice name
    supabase.from('clio_connections').upsert({
        client_slug:    clientSlug,
        owner_phone:    ownerPhone,
        attorney_phone: attorneyPhone || null,
        practice_name:  practiceName || null,
        updated_at:     new Date().toISOString(),
    }, { onConflict: 'client_slug' }).then(({ error }) => {
        if (error) console.error(`[Auth] Failed to pre-populate connection for ${clientSlug}: ${error.message}`);
    });

    try {
        const authUrl = clio.getAuthUrl(clientSlug);
        res.redirect(authUrl);
    } catch (err) {
        res.status(500).send(`Failed to build Clio auth URL: ${err.message}`);
    }
});

// Step 2 — Clio redirects back with the auth code
app.get('/auth/clio/callback', async (req, res) => {
    const { code, state } = req.query;

    if (!code || !state) {
        return res.status(400).send('Missing code or state from Clio.');
    }

    let clientSlug;
    try {
        const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
        clientSlug = decoded.clientSlug;
    } catch {
        return res.status(400).send('Invalid state parameter.');
    }

    try {
        const result = await clio.exchangeCode(code, clientSlug);
        const conn   = await clio.getConnection(clientSlug);

        console.log(`[Auth] Clio connected for ${clientSlug} (user: ${result.clioUserId})`);

        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#09090b;color:#fff">
                <h2 style="color:#22d3ee">Clio Connected</h2>
                <p><strong>${conn?.practice_name || clientSlug}</strong> is now connected to Clio Manage.</p>
                <p>GRIDHAND Intake Accelerator will begin processing leads and sending questionnaires automatically.</p>
                <p style="color:#4ade80">Attorney phone: ${conn?.attorney_phone || conn?.owner_phone || 'not set'}</p>
            </body></html>
        `);
    } catch (err) {
        console.error(`[Auth] Clio token exchange failed for ${clientSlug}: ${err.message}`);
        res.status(500).send(`OAuth failed: ${err.message}`);
    }
});

// PracticePanther uses API key auth — this endpoint lets the admin store it
app.get('/auth/practicepanther/callback', requireApiKey, async (req, res) => {
    const { clientSlug, apiKey, ownerPhone, attorneyPhone, practiceName } = req.query;

    if (!clientSlug || !apiKey || !ownerPhone) {
        return res.status(400).json({ error: 'clientSlug, apiKey, and ownerPhone are required' });
    }

    try {
        const { error } = await supabase
            .from('clio_connections')
            .upsert({
                client_slug:          clientSlug,
                practicepanther_key:  apiKey,
                owner_phone:          ownerPhone,
                attorney_phone:       attorneyPhone || null,
                practice_name:        practiceName || null,
                updated_at:           new Date().toISOString(),
            }, { onConflict: 'client_slug' });

        if (error) throw error;

        console.log(`[Auth] PracticePanther key stored for ${clientSlug}`);
        res.json({ success: true, clientSlug, message: 'PracticePanther API key stored.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Inbound Inquiry Webhook ──────────────────────────────────────────────────

// Called by web forms, phone capture systems, or any lead source
app.post('/webhook/new-inquiry', async (req, res) => {
    const {
        clientSlug,
        contactName,
        contactPhone,
        contactEmail,
        practiceArea,
        inquirySource,
        inquiryText,
    } = req.body;

    if (!clientSlug || !contactPhone) {
        return res.status(400).json({ error: 'clientSlug and contactPhone are required' });
    }

    // ACK immediately; process in background via Bull
    res.status(202).json({ received: true, clientSlug });

    setImmediate(async () => {
        try {
            await jobs.runProcessInquiry(clientSlug, {
                contactName,
                contactPhone,
                contactEmail,
                practiceArea,
                inquirySource: inquirySource || 'web_form',
                inquiryText,
            });
        } catch (err) {
            console.error(`[Webhook] Failed to queue inquiry for ${clientSlug}: ${err.message}`);
        }
    });
});

// ─── Twilio SMS Reply Webhook ──────────────────────────────────────────────────

// Twilio POSTs here when a client texts back during the questionnaire
app.post('/webhook/sms', validateTwilioWebhook, async (req, res) => {
    // Twilio sends URL-encoded form data; already parsed by express.urlencoded above
    const from       = req.body.From;   // Prospect's phone number
    const body       = req.body.Body;   // Their reply text
    const toNumber   = req.body.To;     // Our Twilio number (used to find clientSlug)

    // ACK Twilio immediately with an empty TwiML response
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');

    // Resolve clientSlug from the Twilio "To" number
    // Each law firm should have a dedicated Twilio number mapped to their clientSlug
    setImmediate(async () => {
        try {
            // Look up which firm owns this Twilio number
            const { data: conn } = await supabase
                .from('clio_connections')
                .select('client_slug')
                .eq('owner_phone', toNumber)
                .maybeSingle();

            // Fallback: check attorney_phone
            let clientSlug = conn?.client_slug;

            if (!clientSlug) {
                const { data: conn2 } = await supabase
                    .from('clio_connections')
                    .select('client_slug')
                    .eq('attorney_phone', toNumber)
                    .maybeSingle();
                clientSlug = conn2?.client_slug;
            }

            if (!clientSlug) {
                // Last resort: try GRIDHAND_DEFAULT_CLIENT env var (single-firm installs)
                clientSlug = process.env.GRIDHAND_DEFAULT_CLIENT;
            }

            if (!clientSlug) {
                console.warn(`[SMS] Cannot resolve clientSlug for Twilio number ${toNumber} — ignoring reply from ${from}`);
                return;
            }

            await intake.handleSmsReply(clientSlug, from, body);
        } catch (err) {
            console.error(`[SMS] Reply handling error from ${from}: ${err.message}`);
        }
    });
});

// ─── Manual Trigger Endpoints ─────────────────────────────────────────────────

app.post('/trigger/run-intake', requireApiKey, async (req, res) => {
    const { clientSlug, contactPhone, contactName, practiceArea, inquirySource, inquiryText } = req.body;

    if (!clientSlug || !contactPhone) {
        return res.status(400).json({ error: 'clientSlug and contactPhone required' });
    }

    try {
        const job = await jobs.runProcessInquiry(clientSlug, {
            contactPhone,
            contactName,
            practiceArea,
            inquirySource: inquirySource || 'web_form',
            inquiryText,
        });
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/follow-up', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runSendFollowUp(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/daily-report', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runDailyReport(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

app.get('/clients/:clientSlug/inquiries', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { status, limit = 50, offset = 0 } = req.query;

    try {
        let query = supabase
            .from('inquiries')
            .select('*')
            .eq('client_slug', clientSlug)
            .order('created_at', { ascending: false })
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (status) query = query.eq('status', status);

        const { data, error, count } = await query;
        if (error) throw error;

        res.json({ clientSlug, total: count, inquiries: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Cron Schedules ────────────────────────────────────────────────────────────

// 9:00am daily — morning intake summary to attorneys
cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] Running daily intake report for all clients...');
    await jobs.runForAllClients(jobs.runDailyReport);
}, { timezone: 'America/Chicago' });

// Every 2 hours — follow up on stalled intakes (no response after 4+ hours)
cron.schedule('0 */2 * * *', async () => {
    console.log('[Cron] Running follow-up sweep for all clients...');
    await jobs.runForAllClients(jobs.runSendFollowUp);
}, { timezone: 'America/Chicago' });

// Friday 4:00pm — weekly intake report
cron.schedule('0 16 * * 5', async () => {
    console.log('[Cron] Running weekly intake report for all clients...');
    await jobs.runForAllClients(jobs.runWeeklyReport);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3004;

app.listen(PORT, () => {
    console.log(`[IntakeAccelerator] Online — port ${PORT}`);
    console.log(`[IntakeAccelerator] Crons: daily report @ 9am | follow-up every 2h | weekly report Fri 4pm`);
    console.log(`[IntakeAccelerator] Integrations: Clio Manage v4 | PracticePanther | Twilio SMS`);
});
