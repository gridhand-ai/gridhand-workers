'use strict';

const express = require('express');
const cron = require('node-cron');
const { config, validateConfig } = require('./config');

// Validate env before anything else
validateConfig();

const { handleRepairOrderCompleted } = require('./workers/review-closer');
const { validateWebhookSignature } = require('./integrations/tekmetric');
const { runMonitorForAllShops } = require('./services/review-monitor');
const { getQueueStatus } = require('./services/review-request');

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────

// Parse JSON but keep raw body for webhook signature validation
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

// Admin API key auth for status/health endpoints
function requireApiKey(req, res, next) {
  if (!config.server.apiKey) return next(); // disabled if not set
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key !== config.server.apiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Tekmetric Webhook ─────────────────────────────────────────────────────────

/**
 * POST /webhook/tekmetric
 *
 * Receives Repair Order lifecycle events from Tekmetric.
 * Only processes "repair_order.completed" (or equivalent statuses).
 *
 * Tekmetric sends event type in:
 *   - payload.event (newer versions)
 *   - payload.type
 *   - payload.eventType
 *   - OR inferred from the endpoint path
 */
app.post('/webhook/tekmetric', async (req, res) => {
  // ── Signature validation ────────────────────────────────────────────────────
  const signature = req.headers['x-tekmetric-signature'] || req.headers['x-signature'];
  if (config.tekmetric.webhookSecret && !validateWebhookSignature(req.rawBody, signature)) {
    console.warn('[Webhook] Invalid Tekmetric signature — rejected');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const payload = req.body;
  const eventType = payload.event || payload.type || payload.eventType || '';

  console.log(`[Webhook] Tekmetric event received: "${eventType}"`);

  // ── Route by event type ─────────────────────────────────────────────────────
  const isRoCompleted =
    eventType === 'repair_order.completed' ||
    eventType === 'REPAIR_ORDER_COMPLETED' ||
    eventType === 'repairOrder.completed' ||
    // Some Tekmetric setups send status changes — handle closed/completed status
    (eventType.includes('repair_order') && payload?.data?.status === 'CLOSED') ||
    (eventType.includes('repair_order') && payload?.data?.status === 'COMPLETED');

  if (!isRoCompleted) {
    // Acknowledge non-targeted events without processing
    return res.status(200).json({ status: 'ignored', event: eventType });
  }

  // ── Process asynchronously — respond 200 immediately to Tekmetric ──────────
  res.status(200).json({ status: 'received' });

  try {
    const result = await handleRepairOrderCompleted(payload);
    console.log(`[Webhook] RO processed: ${JSON.stringify(result)}`);
  } catch (err) {
    console.error(`[Webhook] Unhandled error processing RO: ${err.message}`, err);
  }
});

// ── Health & Status ───────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'gridhand-review-closer',
    version: '1.0.0',
    env: config.server.env,
    timestamp: new Date().toISOString(),
  });
});

app.get('/status', requireApiKey, async (req, res) => {
  try {
    const queue = await getQueueStatus();
    res.json({
      status: 'ok',
      queue,
      monitor: {
        intervalMinutes: config.settings.reviewMonitorIntervalMinutes,
      },
      settings: config.settings,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual trigger for testing
app.post('/admin/run-monitor', requireApiKey, async (req, res) => {
  console.log('[Admin] Manual review monitor run triggered');
  try {
    const result = await runMonitorForAllShops();
    res.json({ status: 'ok', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cron: Review Monitor ──────────────────────────────────────────────────────

const intervalMinutes = config.settings.reviewMonitorIntervalMinutes;
// node-cron doesn't support arbitrary minutes < 1 — use */N for every N minutes
const cronExpression = `*/${intervalMinutes} * * * *`;

cron.schedule(cronExpression, async () => {
  console.log(`[Cron] Running review monitor (every ${intervalMinutes}m)`);
  try {
    await runMonitorForAllShops();
  } catch (err) {
    console.error(`[Cron] Review monitor failed: ${err.message}`);
  }
});

console.log(`[Cron] Review monitor scheduled every ${intervalMinutes} minutes`);

// ── Start Server ──────────────────────────────────────────────────────────────

const PORT = config.server.port;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║     GRIDHAND Review Closer — Running             ║
╠══════════════════════════════════════════════════╣
║  Port:      ${String(PORT).padEnd(36)}║
║  Env:       ${config.server.env.padEnd(36)}║
║  SMS delay: ${String(config.settings.reviewRequestDelayHours + 'h').padEnd(36)}║
║  Monitor:   every ${String(intervalMinutes + 'm').padEnd(30)}║
╚══════════════════════════════════════════════════╝
  `);
});

module.exports = app;
