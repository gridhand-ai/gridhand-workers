/**
 * GRIDHAND Lease Renewal Agent — Main Express Server
 *
 * 60 days before lease expiry: sends renewal offer via email + SMS,
 * handles negotiation, generates DocuSign lease, tracks pipeline.
 *
 * Routes:
 *   GET  /                                    → health check
 *   POST /connect                             → save PMS + DocuSign + email credentials
 *   GET  /auth/docusign?clientSlug=           → start DocuSign OAuth
 *   GET  /auth/docusign/callback              → DocuSign OAuth callback
 *   GET  /pipeline/:clientSlug                → full renewal pipeline
 *   GET  /pipeline/:clientSlug/:status        → filtered by status
 *   POST /renewals/:id/accept                 → tenant accepted — send DocuSign
 *   POST /renewals/:id/decline                → mark declined
 *   POST /renewals/:id/counter                → log counter-offer
 *   GET  /communications/:renewalId           → full comm log for a renewal
 *   GET  /alerts/:clientSlug                  → SMS history
 *   POST /trigger/scan                        → manually scan expiring leases
 *   POST /trigger/offers                      → manually send offers
 *   POST /trigger/envelopes                   → manually check DocuSign status
 *   POST /trigger/pipeline                    → manually send pipeline report
 *   POST /trigger/all                         → trigger job for all clients
 *
 * Environment vars required:
 *   DOCUSIGN_CLIENT_ID, DOCUSIGN_CLIENT_SECRET, DOCUSIGN_REDIRECT_URI
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_EMAIL
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   REDIS_URL
 *   GRIDHAND_API_KEY
 *   PORT (default: 3015)
 */

'use strict';

const express  = require('express');
const cron     = require('node-cron');
const dayjs    = require('dayjs');
const docusign = require('./docusign');
const jobs     = require('./jobs');
const db       = require('./db');

const app = express();
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
        worker:  'Lease Renewal Agent',
        status:  'online',
        version: '1.0.0',
        jobs:    ['scan-expiring-leases', 'send-renewal-offers', 'check-envelope-status', 'weekly-pipeline'],
        integrations: ['AppFolio API', 'Buildium API', 'Nodemailer SMTP', 'DocuSign eSign', 'Twilio SMS'],
    });
});

// ─── Connection Setup ─────────────────────────────────────────────────────────

app.post('/connect', requireApiKey, async (req, res) => {
    const {
        clientSlug, ownerPhone, ownerEmail, businessName, pmsType,
        appfolioDatabaseName, appfolioUsername, appfolioPassword,
        buildiumClientId, buildiumClientSecret,
        smtpHost, smtpPort, smtpUser, smtpPass, fromEmail,
        docusignTemplateId,
        renewalNoticeDays, rentIncreasePct,
    } = req.body;
    if (!clientSlug || !ownerPhone) return res.status(400).json({ error: 'clientSlug and ownerPhone required' });

    try {
        await db.upsertConnection({
            client_slug:             clientSlug,
            owner_phone:             ownerPhone,
            owner_email:             ownerEmail || null,
            business_name:           businessName || null,
            pms_type:                pmsType || 'appfolio',
            appfolio_database_name:  appfolioDatabaseName || null,
            appfolio_api_username:   appfolioUsername || null,
            appfolio_api_password:   appfolioPassword || null,
            buildium_client_id:      buildiumClientId || null,
            buildium_client_secret:  buildiumClientSecret || null,
            smtp_host:               smtpHost || null,
            smtp_port:               smtpPort || 587,
            smtp_user:               smtpUser || null,
            smtp_pass:               smtpPass || null,
            from_email:              fromEmail || null,
            docusign_template_id:    docusignTemplateId || null,
            renewal_notice_days:     renewalNoticeDays || 60,
            rent_increase_pct:       rentIncreasePct || 0.03,
        });
        res.json({ success: true, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── DocuSign OAuth ───────────────────────────────────────────────────────────

app.get('/auth/docusign', (req, res) => {
    const { clientSlug } = req.query;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });
    const state = Buffer.from(JSON.stringify({ clientSlug, ts: Date.now() })).toString('base64');
    res.redirect(docusign.getAuthorizationUrl(state));
});

app.get('/auth/docusign/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing code or state.');

    let clientSlug;
    try {
        clientSlug = JSON.parse(Buffer.from(state, 'base64').toString('utf8')).clientSlug;
    } catch { return res.status(400).send('Invalid state.'); }

    try {
        await docusign.exchangeCode(clientSlug, { code });
        console.log(`[OAuth] Connected DocuSign for ${clientSlug}`);
        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px">
                <h2>✅ DocuSign Connected!</h2>
                <p><strong>${clientSlug}</strong> can now send lease renewal documents for e-signature.</p>
            </body></html>
        `);
    } catch (err) {
        res.status(500).send(`DocuSign OAuth failed: ${err.message}`);
    }
});

// ─── Pipeline Endpoints ───────────────────────────────────────────────────────

app.get('/pipeline/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { status } = req.query;
    try {
        const renewals = await db.getPipelineByStatus(clientSlug, status || null);
        const stats = {
            total:     renewals.length,
            pending:   renewals.filter(r => r.status === 'pending').length,
            offerSent: renewals.filter(r => r.status === 'offer_sent').length,
            signed:    renewals.filter(r => r.status === 'signed').length,
            declined:  renewals.filter(r => r.status === 'declined').length,
        };
        res.json({ clientSlug, stats, renewals });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Renewal Action Endpoints ─────────────────────────────────────────────────

// Tenant accepted — send DocuSign
app.post('/renewals/:id/accept', requireApiKey, async (req, res) => {
    const { id } = req.params;
    const { templateId } = req.body;

    try {
        const renewal = await db.getRenewalById(id);
        if (!renewal) return res.status(404).json({ error: 'Renewal not found' });

        const conn = await db.getConnection(renewal.client_slug);
        if (!conn) return res.status(404).json({ error: 'Client not found' });

        await db.updateRenewal(id, { status: 'accepted', response_received_at: new Date().toISOString(), tenant_response: 'accepted' });

        let envelopeId = null;
        if (conn.docusign_access_token && renewal.tenant_email) {
            envelopeId = await docusign.sendLeaseRenewalEnvelope(renewal.client_slug, { renewal, templateId });
            if (envelopeId) {
                await db.updateRenewal(id, { docusign_envelope_id: envelopeId, docusign_sent_at: new Date().toISOString() });
            }
        }

        res.json({ success: true, renewalId: id, envelopeId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/renewals/:id/decline', requireApiKey, async (req, res) => {
    const { id } = req.params;
    try {
        await db.updateRenewal(id, { status: 'declined', response_received_at: new Date().toISOString(), tenant_response: 'declined' });
        res.json({ success: true, renewalId: id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/renewals/:id/counter', requireApiKey, async (req, res) => {
    const { id } = req.params;
    const { counterRent, notes } = req.body;
    if (!counterRent) return res.status(400).json({ error: 'counterRent required' });
    try {
        await db.updateRenewal(id, {
            status:                  'negotiating',
            tenant_response:         'counter_offer',
            counter_rent:            counterRent,
            response_received_at:    new Date().toISOString(),
        });
        res.json({ success: true, renewalId: id, counterRent });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/communications/:renewalId', requireApiKey, async (req, res) => {
    const { renewalId } = req.params;
    try {
        const comms = await db.getCommunications(renewalId);
        res.json({ renewalId, total: comms.length, communications: comms });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Manual Trigger Endpoints ─────────────────────────────────────────────────

app.post('/trigger/scan', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });
    try {
        const job = await jobs.runScanLeases(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/offers', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });
    try {
        const job = await jobs.runSendOffers(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/envelopes', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });
    try {
        const job = await jobs.runCheckEnvelopes(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/pipeline', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });
    try {
        const job = await jobs.runWeeklyPipeline(clientSlug);
        res.json({ success: true, jobId: job.id, clientSlug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/all', requireApiKey, async (req, res) => {
    const { job } = req.body;
    const jobMap = {
        'scan':      jobs.runScanLeases,
        'offers':    jobs.runSendOffers,
        'envelopes': jobs.runCheckEnvelopes,
        'pipeline':  jobs.runWeeklyPipeline,
    };
    if (!jobMap[job]) return res.status(400).json({ error: `Unknown job: ${job}` });
    try {
        const results = await jobs.runForAllClients(jobMap[job]);
        res.json({ success: true, queued: results.length, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Cron Schedules ────────────────────────────────────────────────────────────

// Scan for expiring leases — daily at 7am
cron.schedule('0 7 * * *', async () => {
    console.log('[Cron] Scanning expiring leases for all clients...');
    await jobs.runForAllClients(jobs.runScanLeases);
}, { timezone: 'America/Chicago' });

// Send renewal offers — daily at 9am
cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] Sending renewal offers for all clients...');
    await jobs.runForAllClients(jobs.runSendOffers);
}, { timezone: 'America/Chicago' });

// Check DocuSign envelope status — daily at 2pm
cron.schedule('0 14 * * *', async () => {
    console.log('[Cron] Checking DocuSign envelopes for all clients...');
    await jobs.runForAllClients(jobs.runCheckEnvelopes);
}, { timezone: 'America/Chicago' });

// Weekly pipeline report — Monday 8am
cron.schedule('0 8 * * 1', async () => {
    console.log('[Cron] Running weekly pipeline reports for all clients...');
    await jobs.runForAllClients(jobs.runWeeklyPipeline);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3015;
app.listen(PORT, () => {
    console.log(`[LeaseRenewalAgent] Online — port ${PORT}`);
    console.log(`[LeaseRenewalAgent] Crons: scan 7am | offers 9am | envelopes 2pm | pipeline Mon 8am`);
});
