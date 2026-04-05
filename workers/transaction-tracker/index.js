/**
 * GRIDHAND Transaction Tracker — Express Server
 *
 * Port: 3005
 * Integrations: Dotloop, DocuSign, Twilio SMS
 *
 * Routes:
 *   GET  /                                 — health check
 *   POST /webhooks/dotloop                 — Dotloop loop activity events
 *   POST /webhooks/docusign                — DocuSign Connect envelope events
 *   POST /trigger/deadline-check           — scan all transactions for deadlines
 *   POST /trigger/missing-docs             — check missing documents on a transaction
 *   POST /trigger/status-update            — send status SMS to buyer/seller
 *   POST /trigger/closing-checklist        — generate and SMS closing checklist
 *   GET  /transactions/:clientSlug         — list transactions
 *   GET  /transactions/:clientSlug/:id     — transaction detail with milestones + docs
 *   GET  /reports/pipeline/:clientSlug     — pipeline overview report
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cron    = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const dayjs   = require('dayjs');

const db       = require('./db');
const dotloop  = require('./dotloop');
const docusign = require('./docusign');
const tracker  = require('./tracker');
const jobs     = require('./jobs');

const app  = express();
const PORT = process.env.PORT || 3005;

// ─── Middleware ───────────────────────────────────────────────────────────────

// Capture raw body for webhook signature verification before JSON parsing
app.use((req, res, next) => {
    if (req.path.startsWith('/webhooks/')) {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            req.rawBody = raw;
            try {
                req.body = JSON.parse(raw);
            } catch {
                req.body = {};
            }
            next();
        });
    } else {
        next();
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.json({
        worker:       'Transaction Tracker',
        version:      '1.0.0',
        status:       'online',
        jobs: [
            'tt:milestone-alert',
            'tt:deadline-warning',
            'tt:missing-docs-alert',
            'tt:buyer-seller-update',
            'tt:daily-pipeline-scan',
            'tt:closing-checklist',
        ],
        integrations: ['Dotloop', 'DocuSign', 'Twilio'],
        timestamp:    new Date().toISOString(),
    });
});

// ─── Webhook: Dotloop ─────────────────────────────────────────────────────────

app.post('/webhooks/dotloop', async (req, res) => {
    // Fast ACK — process async
    res.status(200).json({ received: true });

    try {
        const sig     = req.headers['x-dotloop-signature'];
        const payload = req.body;

        if (!payload || !payload.loopId) {
            console.log('[Webhook/Dotloop] Missing loopId in payload');
            return;
        }

        // Identify which client this loop belongs to
        // Dotloop sends the profileId in the payload
        const profileId  = payload.profileId || payload.profile_id;
        const loopId     = String(payload.loopId || payload.loop_id);
        const clientSlug = payload.clientSlug || payload.client_slug || null;

        if (!clientSlug) {
            console.log(`[Webhook/Dotloop] No clientSlug in payload for loop ${loopId} — cannot route`);
            return;
        }

        // Verify signature
        const settings = await db.getClientSettings(clientSlug);
        if (settings?.dotloop_webhook_secret) {
            const valid = dotloop.verifyWebhookSignature(req.rawBody, sig, settings.dotloop_webhook_secret);
            if (!valid) {
                console.warn(`[Webhook/Dotloop] Invalid signature for ${clientSlug}`);
                return;
            }
        }

        // Look up or create transaction
        let transaction = await db.getTransactionByLoopId(clientSlug, loopId);

        if (!transaction) {
            // First time we see this loop — pull full loop data from Dotloop
            const loopResult = await dotloop.getLoop(clientSlug, loopId);
            if (!loopResult.ok) {
                console.error(`[Webhook/Dotloop] Could not fetch loop ${loopId}: ${loopResult.error}`);
                return;
            }

            const loop = loopResult.data;
            const id   = uuidv4();

            transaction = await db.upsertTransaction(clientSlug, {
                id,
                dotloopLoopId: loopId,
                address:       loop.name || loop.address || `Loop ${loopId}`,
                status:        'active',
                closingDate:   loop.closing_date || null,
                contractDate:  loop.contract_date || null,
                rawData:       loop,
            });

            // Seed milestones from loop
            const milestones = dotloop.parseMilestones(loop);
            for (const m of milestones) {
                await db.upsertMilestone(id, {
                    id:          uuidv4(),
                    name:        m.name,
                    dueDate:     m.date || null,
                    completedAt: m.completed ? (m.date || new Date().toISOString()) : null,
                    required:    m.required,
                    category:    m.category,
                });
            }

            // Seed participants
            const participantsResult = await dotloop.getLoopParticipants(clientSlug, loopId);
            if (participantsResult.ok && participantsResult.data?.data) {
                for (const p of participantsResult.data.data) {
                    await db.upsertParticipant(id, {
                        id:    uuidv4(),
                        role:  (p.role || 'agent').toLowerCase(),
                        name:  `${p.firstName || ''} ${p.lastName || ''}`.trim() || null,
                        phone: p.phone || null,
                        email: p.email || null,
                    });
                }
            }

            console.log(`[Webhook/Dotloop] Created new transaction ${id} for loop ${loopId}`);
        }

        // Process the event type
        const eventType = payload.eventType || payload.event_type || 'activity';

        if (eventType === 'document_signed' || eventType === 'document_updated') {
            // Update document status
            const docId   = payload.documentId || payload.document_id;
            const docName = payload.documentName || payload.document_name || `Document ${docId}`;

            if (docId) {
                await db.upsertDocument(transaction.id, {
                    id:         uuidv4(),
                    name:       docName,
                    uploadedAt: new Date().toISOString(),
                    rawData:    payload,
                });
            }
        }

        if (eventType === 'loop_status_changed') {
            const newStatus = mapDotloopStatus(payload.status || payload.loop_status);
            await db.updateTransactionStatus(transaction.id, newStatus);
        }

        // Queue milestone alert for any activity
        if (payload.milestoneName || payload.milestone_name) {
            const milestoneName   = payload.milestoneName || payload.milestone_name;
            const milestoneStatus = payload.milestoneStatus || payload.milestone_status || 'updated';

            await jobs.runMilestoneAlert(transaction.id, clientSlug, milestoneName, milestoneStatus);
        }

        // Queue deadline check
        await jobs.runDeadlineCheck(transaction.id, clientSlug);

        console.log(`[Webhook/Dotloop] Processed ${eventType} for loop ${loopId}`);
    } catch (err) {
        console.error('[Webhook/Dotloop] Processing error:', err.message);
    }
});

// ─── Webhook: DocuSign ────────────────────────────────────────────────────────

app.post('/webhooks/docusign', async (req, res) => {
    // Fast ACK
    res.status(200).json({ received: true });

    try {
        const sig     = req.headers['x-docusign-signature-1'];
        const payload = req.body;

        // DocuSign Connect sends envelope data at top level or in EnvelopeStatus
        const envelopeId = payload.envelopeId ||
                           payload.EnvelopeStatus?.EnvelopeID ||
                           payload.data?.envelopeId;

        if (!envelopeId) {
            console.log('[Webhook/DocuSign] Missing envelopeId in payload');
            return;
        }

        const clientSlug = payload.clientSlug || payload.client_slug || null;
        if (!clientSlug) {
            console.log(`[Webhook/DocuSign] No clientSlug for envelope ${envelopeId}`);
            return;
        }

        // Verify signature
        const settings = await db.getClientSettings(clientSlug);
        if (settings?.docusign_webhook_key) {
            const valid = docusign.verifyWebhookSignature(req.rawBody, sig, settings.docusign_webhook_key);
            if (!valid) {
                console.warn(`[Webhook/DocuSign] Invalid signature for ${clientSlug}`);
                return;
            }
        }

        // Normalize envelope status
        const envelopeData   = payload.data?.envelopeSummary || payload;
        const parsedEnvelope = docusign.parseEnvelopeStatus(envelopeData);

        // Find transaction linked to this envelope
        let transaction = await db.getTransactionByEnvelopeId(clientSlug, envelopeId);

        if (transaction) {
            // Update document status for each document in the envelope
            const docsResult = await docusign.getEnvelopeDocuments(clientSlug, envelopeId);
            if (docsResult.ok && docsResult.data?.envelopeDocuments) {
                for (const doc of docsResult.data.envelopeDocuments) {
                    if (doc.documentId === 'certificate') continue; // skip cert of completion

                    await db.upsertDocument(transaction.id, {
                        id:              uuidv4(),
                        name:            doc.name || `DocuSign Document ${doc.documentId}`,
                        required:        false,
                        uploadedAt:      parsedEnvelope.completedAt || new Date().toISOString(),
                        docusignStatus:  parsedEnvelope.status,
                        envelopeId,
                        rawData:         doc,
                    });
                }
            }

            // Queue deadline check after document update
            await jobs.runDeadlineCheck(transaction.id, clientSlug);

            // If envelope is completed, fire milestone alert
            if (parsedEnvelope.status === 'completed') {
                await jobs.runMilestoneAlert(
                    transaction.id,
                    clientSlug,
                    'Documents Signed',
                    'completed'
                );
            }
        } else {
            console.log(`[Webhook/DocuSign] No transaction found for envelope ${envelopeId} — storing for later`);
        }

        console.log(`[Webhook/DocuSign] Processed envelope ${envelopeId} status: ${parsedEnvelope.status}`);
    } catch (err) {
        console.error('[Webhook/DocuSign] Processing error:', err.message);
    }
});

// ─── Trigger: Deadline Check ──────────────────────────────────────────────────

app.post('/trigger/deadline-check', async (req, res) => {
    try {
        const { client_id } = req.body;

        if (client_id) {
            const transactions = await db.getActiveTransactions(client_id);
            const queued = [];
            for (const tx of transactions) {
                const job = await jobs.runDeadlineCheck(tx.id, client_id);
                queued.push({ transactionId: tx.id, jobId: job.id });
            }
            return res.json({ ok: true, queued });
        }

        // Run for all clients
        const results = await jobs.runForAllClients(async (clientSlug) => {
            const transactions = await db.getActiveTransactions(clientSlug);
            const inner = [];
            for (const tx of transactions) {
                const job = await jobs.runDeadlineCheck(tx.id, clientSlug);
                inner.push(job.id);
            }
            return { id: inner[0] || 'batch' };
        });

        res.json({ ok: true, results });
    } catch (err) {
        console.error('[Trigger/DeadlineCheck]', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Trigger: Missing Docs ────────────────────────────────────────────────────

app.post('/trigger/missing-docs', async (req, res) => {
    try {
        const { transaction_id, client_id } = req.body;
        if (!transaction_id || !client_id) {
            return res.status(400).json({ ok: false, error: 'transaction_id and client_id required' });
        }

        const job = await jobs.runMissingDocsAlert(transaction_id, client_id);
        res.json({ ok: true, jobId: job.id });
    } catch (err) {
        console.error('[Trigger/MissingDocs]', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Trigger: Status Update ───────────────────────────────────────────────────

app.post('/trigger/status-update', async (req, res) => {
    try {
        const { transaction_id, client_id, recipient } = req.body;
        if (!transaction_id || !client_id) {
            return res.status(400).json({ ok: false, error: 'transaction_id and client_id required' });
        }

        const targets   = [];
        const recipients = recipient ? [recipient] : ['buyer', 'seller'];

        for (const r of recipients) {
            const job = await jobs.runBuyerSellerUpdate(transaction_id, client_id, r);
            targets.push({ recipient: r, jobId: job.id });
        }

        res.json({ ok: true, queued: targets });
    } catch (err) {
        console.error('[Trigger/StatusUpdate]', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Trigger: Closing Checklist ───────────────────────────────────────────────

app.post('/trigger/closing-checklist', async (req, res) => {
    try {
        const { transaction_id, client_id } = req.body;
        if (!transaction_id || !client_id) {
            return res.status(400).json({ ok: false, error: 'transaction_id and client_id required' });
        }

        const job = await jobs.runClosingChecklist(transaction_id, client_id);
        res.json({ ok: true, jobId: job.id });
    } catch (err) {
        console.error('[Trigger/ClosingChecklist]', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Transactions: List ───────────────────────────────────────────────────────

app.get('/transactions/:clientSlug', async (req, res) => {
    try {
        const { clientSlug }        = req.params;
        const { status, limit, offset } = req.query;

        const transactions = await db.listTransactions(clientSlug, {
            status: status || null,
            limit:  parseInt(limit, 10)  || 50,
            offset: parseInt(offset, 10) || 0,
        });

        res.json({ ok: true, data: transactions, count: transactions.length });
    } catch (err) {
        console.error('[GET /transactions]', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Transactions: Detail ─────────────────────────────────────────────────────

app.get('/transactions/:clientSlug/:transactionId', async (req, res) => {
    try {
        const { transactionId } = req.params;

        const [transaction, milestones, documents, participants] = await Promise.all([
            db.getTransaction(transactionId),
            db.getMilestones(transactionId),
            db.getDocuments(transactionId),
            db.getParticipants(transactionId),
        ]);

        if (!transaction) {
            return res.status(404).json({ ok: false, error: 'Transaction not found' });
        }

        const txWithData = { ...transaction, milestones, documents };
        const risk       = tracker.assessRisk(txWithData);
        const deadlines  = tracker.checkDeadlines(txWithData);
        const missing    = tracker.findMissingDocuments(txWithData, documents);

        res.json({
            ok:   true,
            data: {
                ...transaction,
                milestones,
                documents,
                participants,
                risk,
                deadlines,
                missingDocuments: missing,
            },
        });
    } catch (err) {
        console.error('[GET /transactions/:id]', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Reports: Pipeline ────────────────────────────────────────────────────────

app.get('/reports/pipeline/:clientSlug', async (req, res) => {
    try {
        const { clientSlug } = req.params;

        const [stats, transactions] = await Promise.all([
            db.getPipelineStats(clientSlug),
            db.getActiveTransactions(clientSlug),
        ]);

        // Count by status
        const countByStatus = {};
        for (const row of stats) {
            countByStatus[row.status] = (countByStatus[row.status] || 0) + 1;
        }

        // Count by risk level
        const countByRisk = { low: 0, medium: 0, high: 0 };
        for (const row of stats) {
            if (row.risk_level && countByRisk[row.risk_level] !== undefined) {
                countByRisk[row.risk_level]++;
            }
        }

        // Average days from contract to closing
        const closedWithDates = stats.filter(r => r.status === 'closed' && r.closing_date && r.contract_date);
        const avgDaysToClose  = closedWithDates.length > 0
            ? Math.round(
                closedWithDates.reduce((sum, r) => {
                    return sum + dayjs(r.closing_date).diff(dayjs(r.contract_date), 'day');
                }, 0) / closedWithDates.length
              )
            : null;

        // At-risk transactions (closing within 7 days with open items)
        const atRisk = [];
        for (const tx of transactions) {
            if (!tx.closing_date) continue;
            const daysToClose = dayjs(tx.closing_date).diff(dayjs(), 'day');
            if (daysToClose <= 7 && daysToClose >= 0 && tx.risk_level === 'high') {
                atRisk.push({
                    id:           tx.id,
                    address:      tx.address,
                    closingDate:  tx.closing_date,
                    daysToClose,
                    riskLevel:    tx.risk_level,
                });
            }
        }

        // Upcoming closings (next 14 days)
        const upcomingClosings = transactions
            .filter(tx => tx.closing_date)
            .map(tx => ({
                id:          tx.id,
                address:     tx.address,
                closingDate: tx.closing_date,
                daysOut:     dayjs(tx.closing_date).diff(dayjs(), 'day'),
                status:      tx.status,
                riskLevel:   tx.risk_level,
            }))
            .filter(tx => tx.daysOut >= 0 && tx.daysOut <= 14)
            .sort((a, b) => a.daysOut - b.daysOut);

        res.json({
            ok:   true,
            data: {
                clientSlug,
                reportDate:       new Date().toISOString(),
                totals: {
                    active:        countByStatus.active        || 0,
                    under_contract: countByStatus.under_contract || 0,
                    closing:       countByStatus.closing       || 0,
                    closed:        countByStatus.closed        || 0,
                    total:         stats.length,
                },
                riskSummary:      countByRisk,
                avgDaysToClose,
                atRisk,
                upcomingClosings,
            },
        });
    } catch (err) {
        console.error('[GET /reports/pipeline]', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Cron Schedules ───────────────────────────────────────────────────────────

// 7:30 AM Chicago — Daily pipeline scan
cron.schedule('30 7 * * *', async () => {
    console.log('[Cron] 7:30 AM — Daily pipeline scan starting');
    try {
        const results = await jobs.runForAllClients(jobs.runDailyScan);
        console.log(`[Cron] Daily scan queued for ${results.length} client(s)`);
    } catch (err) {
        console.error('[Cron] Daily scan error:', err.message);
    }
}, { timezone: 'America/Chicago' });

// 9:00 AM Chicago — Deadline check
cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] 9:00 AM — Deadline check starting');
    try {
        const clients = await db.getAllActiveClients();
        for (const { client_slug } of clients) {
            const txs = await db.getActiveTransactions(client_slug);
            for (const tx of txs) {
                await jobs.runDeadlineCheck(tx.id, client_slug);
            }
        }
        console.log('[Cron] Deadline checks queued');
    } catch (err) {
        console.error('[Cron] Deadline check error:', err.message);
    }
}, { timezone: 'America/Chicago' });

// 5:00 PM Chicago — EOD transaction summary to agent
cron.schedule('0 17 * * *', async () => {
    console.log('[Cron] 5:00 PM — EOD transaction summary starting');
    try {
        const clients = await db.getAllActiveClients();
        for (const { client_slug } of clients) {
            const txs = await db.getActiveTransactions(client_slug);
            // Queue missing docs check as EOD summary mechanism
            for (const tx of txs) {
                await jobs.runMissingDocsAlert(tx.id, client_slug);
            }
        }
        console.log('[Cron] EOD summaries queued');
    } catch (err) {
        console.error('[Cron] EOD summary error:', err.message);
    }
}, { timezone: 'America/Chicago' });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapDotloopStatus(dotloopStatus) {
    const statusMap = {
        1: 'active',
        2: 'under_contract',
        3: 'closing',
        4: 'closed',
        5: 'cancelled',
        ACTIVE:          'active',
        UNDER_CONTRACT:  'under_contract',
        CLOSED:          'closed',
        CANCELLED:       'cancelled',
    };
    return statusMap[dotloopStatus] || 'active';
}

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`[Transaction Tracker] Running on port ${PORT}`);
    console.log(`[Transaction Tracker] Integrations: Dotloop, DocuSign, Twilio`);
    console.log(`[Transaction Tracker] Crons: 7:30 AM scan | 9:00 AM deadlines | 5:00 PM EOD`);
});

module.exports = app;
