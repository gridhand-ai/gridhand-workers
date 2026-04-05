/**
 * GRIDHAND AI — Reconciliation Bot
 * Main Express Server — PORT 3008
 *
 * Accounting industry worker: auto-categorizes transactions, flags discrepancies,
 * and prepares monthly reconciliation reports.
 * Connects to QuickBooks Online API, Xero API, and Plaid for bank feeds.
 *
 * Routes:
 *   GET  /health
 *
 *   OAuth:
 *   GET  /auth/qbo/connect/:slug            → Redirect to QBO OAuth
 *   GET  /auth/qbo/callback                 → QBO OAuth callback
 *   GET  /auth/xero/connect/:slug           → Redirect to Xero OAuth
 *   GET  /auth/xero/callback                → Xero OAuth callback
 *   POST /auth/plaid/link-token             → Create Plaid Link token
 *   POST /auth/plaid/exchange               → Exchange Plaid public token
 *
 *   Clients:
 *   GET  /api/clients                       → List all clients
 *   POST /api/clients                       → Create or update client
 *
 *   Transactions:
 *   GET  /api/clients/:slug/transactions    → List transactions (?source=qbo&reconciled=false&days=30)
 *
 *   Discrepancies:
 *   GET  /api/clients/:slug/discrepancies   → List open discrepancies
 *   PATCH /api/clients/:slug/discrepancies/:id → Resolve or ignore
 *
 *   Reconciliation:
 *   GET  /api/clients/:slug/reconciliation           → Run history
 *   GET  /api/clients/:slug/reconciliation/:runId    → Full report
 *
 *   Webhooks:
 *   POST /webhooks/plaid                    → Plaid webhook (respond 200, process async)
 *
 *   Manual Triggers:
 *   POST /trigger/sync-transactions/:slug           → Pull latest from all sources
 *   POST /trigger/reconcile/:slug                   → Reconcile current month
 *   POST /trigger/reconcile/:slug/:year/:month      → Reconcile specific month
 *   POST /trigger/sync-all                          → Sync all clients
 *
 * Environment vars required:
 *   QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REDIRECT_URI, QB_SANDBOX (optional)
 *   XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REDIRECT_URI
 *   PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox|production)
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, REDIS_TLS (optional, defaults to localhost:6379)
 *   RB_API_KEY           (protects all /api and /trigger routes)
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER (optional global fallback)
 *   PORT                 (default: 3008)
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const dayjs   = require('dayjs');

const qb    = require('./quickbooks');
const xero  = require('./xero');
const plaid = require('./plaid');
const db    = require('./db');
const jobs  = require('./jobs');

const app  = express();
const PORT = process.env.PORT || 3008;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (!key || key !== process.env.RB_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
    try {
        const queueStats = await jobs.getQueueStats();
        res.json({
            worker:       'Reconciliation Bot',
            status:       'online',
            version:      '1.0.0',
            port:         PORT,
            integrations: ['QuickBooks Online v3', 'Xero', 'Plaid', 'Twilio SMS', 'Supabase'],
            queues:       queueStats,
            crons: [
                'Transaction sync: daily @ 2:00am CT',
                'Monthly reconciliation: 1st of month @ 7:00am CT',
            ],
        });
    } catch (err) {
        res.status(500).json({ worker: 'Reconciliation Bot', status: 'error', error: err.message });
    }
});

// ─── QBO OAuth ────────────────────────────────────────────────────────────────

// Step 1: Redirect to QuickBooks authorization page
app.get('/auth/qbo/connect/:slug', (req, res) => {
    const { slug } = req.params;
    try {
        const authUrl = qb.initiateOAuth(slug);
        res.redirect(authUrl);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Step 2: QBO redirects back here with code + realmId
app.get('/auth/qbo/callback', async (req, res) => {
    const { code, state, realmId } = req.query;

    if (!code || !state || !realmId) {
        return res.status(400).send('Missing code, state, or realmId from QuickBooks.');
    }

    try {
        const { clientSlug, tokens, expiresAt } = await qb.handleCallback(code, state);

        await db.updateQboTokens(clientSlug, {
            accessToken:  tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt,
            realmId,
        });

        console.log(`[OAuth/QBO] Connected for ${clientSlug} (realm: ${realmId})`);
        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px">
                <h2>QuickBooks Connected</h2>
                <p><strong>${clientSlug}</strong> is now connected to QuickBooks Online.</p>
                <p>Reconciliation Bot will begin syncing transactions automatically.</p>
            </body></html>
        `);
    } catch (err) {
        console.error(`[OAuth/QBO] Callback error: ${err.message}`);
        res.status(500).send(`OAuth failed: ${err.message}`);
    }
});

// ─── Xero OAuth ───────────────────────────────────────────────────────────────

// Step 1: Redirect to Xero authorization page
app.get('/auth/xero/connect/:slug', (req, res) => {
    const { slug } = req.params;
    try {
        const authUrl = xero.initiateOAuth(slug);
        res.redirect(authUrl);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Step 2: Xero redirects back here with code
app.get('/auth/xero/callback', async (req, res) => {
    const { code, state } = req.query;

    if (!code || !state) {
        return res.status(400).send('Missing code or state from Xero.');
    }

    try {
        const { clientSlug, tenantId } = await xero.handleCallback(code, state);

        console.log(`[OAuth/Xero] Connected for ${clientSlug} (tenant: ${tenantId})`);
        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px">
                <h2>Xero Connected</h2>
                <p><strong>${clientSlug}</strong> is now connected to Xero.</p>
                <p>Reconciliation Bot will begin syncing transactions automatically.</p>
            </body></html>
        `);
    } catch (err) {
        console.error(`[OAuth/Xero] Callback error: ${err.message}`);
        res.status(500).send(`OAuth failed: ${err.message}`);
    }
});

// ─── Plaid Auth ───────────────────────────────────────────────────────────────

// Create Link token for Plaid Link UI
app.post('/auth/plaid/link-token', requireApiKey, async (req, res) => {
    const { clientSlug, userId } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    const result = await plaid.createLinkToken(clientSlug, userId || clientSlug);
    if (!result.ok) return res.status(500).json({ error: result.error });
    res.json(result.data);
});

// Exchange public token after user completes Plaid Link
app.post('/auth/plaid/exchange', requireApiKey, async (req, res) => {
    const { clientSlug, publicToken } = req.body;
    if (!clientSlug || !publicToken) {
        return res.status(400).json({ error: 'clientSlug and publicToken required' });
    }

    const result = await plaid.exchangePublicToken(clientSlug, publicToken);
    if (!result.ok) return res.status(500).json({ error: result.error });
    res.json({ success: true, ...result.data });
});

// ─── Clients API ──────────────────────────────────────────────────────────────

app.get('/api/clients', requireApiKey, async (req, res) => {
    try {
        const clients = await db.getAllClients();
        // Strip sensitive tokens from list response
        const sanitized = clients.map(c => ({
            id:                  c.id,
            client_slug:         c.client_slug,
            business_name:       c.business_name,
            accounting_platform: c.accounting_platform,
            qbo_connected:       !!c.qbo_access_token,
            xero_connected:      !!c.xero_access_token,
            plaid_connected:     !!c.plaid_access_token,
            owner_phone:         c.owner_phone,
            created_at:          c.created_at,
            updated_at:          c.updated_at,
        }));
        res.json({ total: sanitized.length, clients: sanitized });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/clients', requireApiKey, async (req, res) => {
    const { clientSlug, businessName, accountingPlatform, ownerPhone, twilioSid, twilioToken, twilioNumber } = req.body;

    if (!clientSlug || !businessName || !accountingPlatform) {
        return res.status(400).json({ error: 'clientSlug, businessName, and accountingPlatform are required' });
    }
    if (!['qbo', 'xero', 'both'].includes(accountingPlatform)) {
        return res.status(400).json({ error: 'accountingPlatform must be qbo, xero, or both' });
    }

    try {
        await db.upsertClient({ clientSlug, businessName, accountingPlatform, ownerPhone, twilioSid, twilioToken, twilioNumber });
        const client = await db.getClient(clientSlug);
        res.json({ success: true, client });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Transactions API ─────────────────────────────────────────────────────────

app.get('/api/clients/:slug/transactions', requireApiKey, async (req, res) => {
    const { slug } = req.params;
    const { source, reconciled, days, limit } = req.query;

    try {
        const client = await db.getClient(slug);
        if (!client) return res.status(404).json({ error: `Client not found: ${slug}` });

        const transactions = await db.getTransactions(client.id, {
            source,
            reconciled,
            days,
            limit: limit ? parseInt(limit) : 500,
        });

        res.json({ clientSlug: slug, total: transactions.length, transactions });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Discrepancies API ────────────────────────────────────────────────────────

app.get('/api/clients/:slug/discrepancies', requireApiKey, async (req, res) => {
    const { slug } = req.params;
    const { status = 'open' } = req.query;

    try {
        const client = await db.getClient(slug);
        if (!client) return res.status(404).json({ error: `Client not found: ${slug}` });

        const discrepancies = await db.getDiscrepancies(client.id, status === 'all' ? null : status);
        res.json({ clientSlug: slug, total: discrepancies.length, discrepancies });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/clients/:slug/discrepancies/:id', requireApiKey, async (req, res) => {
    const { slug, id } = req.params;
    const { status } = req.body;

    if (!['resolved', 'ignored'].includes(status)) {
        return res.status(400).json({ error: 'status must be resolved or ignored' });
    }

    try {
        const client = await db.getClient(slug);
        if (!client) return res.status(404).json({ error: `Client not found: ${slug}` });

        await db.resolveDiscrepancy(id, status);
        res.json({ success: true, id, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Reconciliation API ───────────────────────────────────────────────────────

app.get('/api/clients/:slug/reconciliation', requireApiKey, async (req, res) => {
    const { slug } = req.params;

    try {
        const client = await db.getClient(slug);
        if (!client) return res.status(404).json({ error: `Client not found: ${slug}` });

        const runs = await db.getReconciliationRuns(client.id);
        // Strip heavy report_data from list view
        const sanitized = runs.map(r => ({
            id:                 r.id,
            period_start:       r.period_start,
            period_end:         r.period_end,
            status:             r.status,
            total_transactions: r.total_transactions,
            reconciled_count:   r.reconciled_count,
            unreconciled_count: r.unreconciled_count,
            discrepancy_count:  r.discrepancy_count,
            total_amount:       r.total_amount,
            discrepancy_amount: r.discrepancy_amount,
            created_at:         r.created_at,
        }));

        res.json({ clientSlug: slug, total: sanitized.length, runs: sanitized });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/clients/:slug/reconciliation/:runId', requireApiKey, async (req, res) => {
    const { slug, runId } = req.params;

    try {
        const client = await db.getClient(slug);
        if (!client) return res.status(404).json({ error: `Client not found: ${slug}` });

        const run = await db.getReconciliationRun(runId);
        if (!run) return res.status(404).json({ error: `Reconciliation run not found: ${runId}` });

        const discrepancies = await db.getDiscrepanciesByRun(runId);

        res.json({ clientSlug: slug, run, discrepancies });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Plaid Webhook ────────────────────────────────────────────────────────────

// Plaid sends real-time webhook events for transaction updates
app.post('/webhooks/plaid', async (req, res) => {
    // Respond immediately — Plaid requires fast ACK
    res.status(200).json({ received: true });

    const payload = req.body;

    setImmediate(async () => {
        try {
            const { webhook_type, webhook_code, item_id } = payload;
            console.log(`[Webhook/Plaid] ${webhook_type}/${webhook_code} for item: ${item_id}`);

            if (webhook_type === 'TRANSACTIONS' && (webhook_code === 'SYNC_UPDATES_AVAILABLE' || webhook_code === 'DEFAULT_UPDATE')) {
                // Find client by plaid_item_id and trigger sync
                const clients = await db.getAllClients();
                const client  = clients.find(c => c.plaid_item_id === item_id);

                if (client) {
                    const endDate   = dayjs().format('YYYY-MM-DD');
                    const startDate = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
                    await jobs.syncTransactions(client.client_slug, startDate, endDate);
                    console.log(`[Webhook/Plaid] Queued sync for ${client.client_slug}`);
                }
            }
        } catch (err) {
            console.error(`[Webhook/Plaid] Processing error: ${err.message}`);
        }
    });
});

// ─── Manual Trigger Endpoints ─────────────────────────────────────────────────

// Pull latest transactions for a client from all connected sources
app.post('/trigger/sync-transactions/:slug', requireApiKey, async (req, res) => {
    const { slug } = req.params;
    const { days = 30 } = req.body;

    try {
        const client = await db.getClient(slug);
        if (!client) return res.status(404).json({ error: `Client not found: ${slug}` });

        const endDate   = dayjs().format('YYYY-MM-DD');
        const startDate = dayjs().subtract(parseInt(days), 'day').format('YYYY-MM-DD');

        const job = await jobs.syncTransactions(slug, startDate, endDate);
        res.json({ success: true, jobId: job.id, clientSlug: slug, startDate, endDate });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Run reconciliation for current month
app.post('/trigger/reconcile/:slug', requireApiKey, async (req, res) => {
    const { slug } = req.params;

    try {
        const client = await db.getClient(slug);
        if (!client) return res.status(404).json({ error: `Client not found: ${slug}` });

        const periodStart = dayjs().startOf('month').format('YYYY-MM-DD');
        const periodEnd   = dayjs().format('YYYY-MM-DD');

        const job = await jobs.runReconciliation(slug, periodStart, periodEnd);
        res.json({ success: true, jobId: job.id, clientSlug: slug, periodStart, periodEnd });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Run reconciliation for a specific year + month (e.g., /trigger/reconcile/acme/2024/11)
app.post('/trigger/reconcile/:slug/:year/:month', requireApiKey, async (req, res) => {
    const { slug, year, month } = req.params;

    try {
        const client = await db.getClient(slug);
        if (!client) return res.status(404).json({ error: `Client not found: ${slug}` });

        const periodDate  = dayjs(`${year}-${month.padStart(2, '0')}-01`);
        const periodStart = periodDate.startOf('month').format('YYYY-MM-DD');
        const periodEnd   = periodDate.endOf('month').format('YYYY-MM-DD');

        const job = await jobs.runReconciliation(slug, periodStart, periodEnd);
        res.json({ success: true, jobId: job.id, clientSlug: slug, periodStart, periodEnd });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Sync all clients
app.post('/trigger/sync-all', requireApiKey, async (req, res) => {
    const { days = 30 } = req.body;

    try {
        const endDate   = dayjs().format('YYYY-MM-DD');
        const startDate = dayjs().subtract(parseInt(days), 'day').format('YYYY-MM-DD');

        const results = await jobs.runForAllClients((clientSlug) =>
            jobs.syncTransactions(clientSlug, startDate, endDate)
        );

        res.json({ success: true, queued: results.length, startDate, endDate, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Cron Schedules ───────────────────────────────────────────────────────────

// Nightly transaction sync — 2:00am CT
cron.schedule('0 2 * * *', async () => {
    console.log('[Cron] Running nightly transaction sync for all clients...');
    const endDate   = dayjs().format('YYYY-MM-DD');
    const startDate = dayjs().subtract(2, 'day').format('YYYY-MM-DD'); // catch any late-posting txns
    await jobs.runForAllClients((clientSlug) =>
        jobs.syncTransactions(clientSlug, startDate, endDate)
    );
}, { timezone: 'America/Chicago' });

// Monthly reconciliation — 1st of every month at 7:00am CT
cron.schedule('0 7 1 * *', async () => {
    console.log('[Cron] Running monthly reconciliation for all clients...');
    const lastMonth   = dayjs().subtract(1, 'month');
    const periodStart = lastMonth.startOf('month').format('YYYY-MM-DD');
    const periodEnd   = lastMonth.endOf('month').format('YYYY-MM-DD');

    await jobs.runForAllClients((clientSlug) =>
        jobs.runReconciliation(clientSlug, periodStart, periodEnd)
    );
}, { timezone: 'America/Chicago' });

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`[ReconciliationBot] Online — port ${PORT}`);
    console.log(`[ReconciliationBot] Crons: nightly sync @ 2am CT | monthly reconciliation @ 1st of month 7am CT`);
});
