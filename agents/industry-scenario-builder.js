'use strict';

/**
 * industry-scenario-builder.js
 *
 * ── GRIDHAND Industry Scenario Builder ───────────────────────────────────────
 * Converts the 29 pre-built industry scenario templates from lib/make-scenarios.js
 * into importable n8n workflow JSON files and (optionally) pushes them live.
 *
 * Each generated n8n workflow has 4 nodes:
 *   1. Webhook Trigger   — receives POST from integration layer or portal
 *   2. Set (extract)     — pulls clientId, customerPhone, triggerData from body
 *   3. HTTP Request      — POSTs to the correct GRIDHAND workers endpoint
 *   4. Respond to Webhook — returns { success: true } to caller
 *
 * Env vars used:
 *   N8N_BASE_URL       — n8n instance (default: https://gridhand-n8n-production.up.railway.app)
 *   N8N_API_KEY        — if set, pushes to live n8n via POST /api/v1/workflows
 *   WORKERS_BASE_URL   — GRIDHAND workers base (default: https://gridhand-workers-production.up.railway.app)
 *
 * Output:
 *   /scenarios/industry/{scenario-id}.json  — one workflow JSON per scenario
 *   /scenarios/index.json                   — updated with new entries
 *
 * Schedule:
 *   Wired into server.js alongside n8n-scenario-engine (daily at 2am via scheduleDailyRun)
 *
 * Usage:
 *   node agents/industry-scenario-builder.js              # all 29 scenarios
 *   node agents/industry-scenario-builder.js --industry restaurant  # one industry
 *   node agents/industry-scenario-builder.js --dry-run   # generate JSON only, no n8n push
 */

const fs   = require('fs');
const path = require('path');

const { getAllScenarios, getScenariosForIndustry } = require('../lib/make-scenarios');

// ─── Config ───────────────────────────────────────────────────────────────────

const N8N_BASE_URL    = process.env.N8N_BASE_URL    || 'https://gridhand-n8n-production.up.railway.app';
const N8N_API_KEY     = process.env.N8N_API_KEY     || '';
const WORKERS_BASE_URL = process.env.WORKERS_BASE_URL || 'https://gridhand-workers-production.up.railway.app';

const SCENARIOS_DIR   = path.join(__dirname, '..', 'scenarios');
const INDUSTRY_DIR    = path.join(SCENARIOS_DIR, 'industry');
const INDEX_FILE      = path.join(SCENARIOS_DIR, 'index.json');

// ─── Worker route map ─────────────────────────────────────────────────────────
// Maps make-scenarios worker names to the concrete workers endpoint path.
// The HTTP Request node POSTs to: WORKERS_BASE_URL + WORKER_ROUTES[worker]
// All endpoints accept the envelope: { clientId, customerPhone, triggerData, scenarioId }

const WORKER_ROUTES = {
    appointment_reminder: '/trigger/appointment-reminder',
    missed_call:          '/trigger/missed-call',
    review_pipeline:      '/trigger/review-pipeline',
    reactivation:         '/trigger/reactivation',
    onboarding:           '/trigger/onboarding',
    no_show:              '/trigger/no-show',
    upsell:               '/trigger/upsell',
    lead_nurture:         '/trigger/lead-nurture',
    repair_ready:         '/trigger/repair-ready',
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function generateId() {
    return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

function loadIndex() {
    try {
        return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    } catch {
        return { generated: [], lastRun: null };
    }
}

function saveIndex(index) {
    fs.mkdirSync(SCENARIOS_DIR, { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

// ─── Workflow JSON Generator ──────────────────────────────────────────────────

/**
 * Build a valid n8n workflow JSON for a single industry scenario.
 *
 * Node layout (left → right):
 *   [Webhook Trigger] → [Set: Extract Fields] → [HTTP Request: Workers] → [Respond to Webhook]
 *
 * The webhook path is stable per scenario-id so the URL never changes between
 * re-runs. Idempotency: if the workflow already exists in n8n, the push will
 * return an error we catch and log (no duplicate workflows created).
 */
function buildWorkflowJson(scenario) {
    const workerRoute  = WORKER_ROUTES[scenario.worker] || `/trigger/${scenario.worker.replace(/_/g, '-')}`;
    const workersUrl   = `${WORKERS_BASE_URL}${workerRoute}`;
    const webhookPath  = `gridhand-industry-${scenario.id}`;
    const workflowName = `[GRIDHAND] ${scenario.industry.toUpperCase()} — ${scenario.name}`;

    // Stable node IDs derived from scenario id (deterministic, no churn on re-runs)
    const triggerId    = `trigger-${scenario.id}`;
    const extractId    = `extract-${scenario.id}`;
    const httpId       = `http-${scenario.id}`;
    const respondId    = `respond-${scenario.id}`;

    // Build the payload field list from webhookPayload keys for documentation
    const payloadKeys  = Object.keys(scenario.webhookPayload || {});
    const payloadDocs  = payloadKeys.map(k => `//   ${k}: ${scenario.webhookPayload[k]}`).join('\n');

    return {
        name: workflowName,
        nodes: [
            // ── 1. Webhook Trigger ──────────────────────────────────────────
            {
                id: triggerId,
                name: 'Webhook Trigger',
                type: 'n8n-nodes-base.webhook',
                typeVersion: 1,
                position: [240, 300],
                parameters: {
                    path: webhookPath,
                    httpMethod: 'POST',
                    responseMode: 'responseNode',
                    options: {},
                },
                webhookId: generateId(),
            },

            // ── 2. Set: Extract clientId, customerPhone, triggerData ────────
            {
                id: extractId,
                name: 'Extract Fields',
                type: 'n8n-nodes-base.set',
                typeVersion: 3,
                position: [480, 300],
                parameters: {
                    mode: 'manual',
                    fields: {
                        values: [
                            {
                                name: 'clientId',
                                type: 'string',
                                value: '={{ $json.body.client_id }}',
                            },
                            {
                                name: 'customerPhone',
                                type: 'string',
                                // Most scenarios carry phone on the top-level payload;
                                // fall back to trigger_data.phone for nested shapes.
                                value: '={{ $json.body.trigger_data.phone ?? $json.body.trigger_data.caller_number ?? $json.body.trigger_data.agent_phone ?? "" }}',
                            },
                            {
                                name: 'scenarioId',
                                type: 'string',
                                value: scenario.id,
                            },
                            {
                                name: 'triggerData',
                                type: 'object',
                                value: '={{ $json.body.trigger_data }}',
                            },
                            {
                                name: 'triggerSource',
                                type: 'string',
                                value: '={{ $json.body.trigger_source ?? "live" }}',
                            },
                            {
                                name: 'eventId',
                                type: 'string',
                                // Passed through for idempotency checking in the worker
                                value: '={{ $json.body.event_id ?? "" }}',
                            },
                        ],
                    },
                    options: {},
                },
            },

            // ── 3. HTTP Request: POST to GRIDHAND workers ───────────────────
            {
                id: httpId,
                name: 'POST to GRIDHAND Workers',
                type: 'n8n-nodes-base.httpRequest',
                typeVersion: 4,
                position: [720, 300],
                parameters: {
                    method: 'POST',
                    url: workersUrl,
                    sendHeaders: true,
                    headerParameters: {
                        parameters: [
                            {
                                name: 'Content-Type',
                                value: 'application/json',
                            },
                        ],
                    },
                    sendBody: true,
                    contentType: 'json',
                    // jsCode comment in body is stripped by n8n; using specifyBody: 'json'
                    specifyBody: 'json',
                    jsonBody: `={
  "clientId":      "{{ $json.clientId }}",
  "customerPhone": "{{ $json.customerPhone }}",
  "scenarioId":    "${scenario.id}",
  "worker":        "${scenario.worker}",
  "triggerData":   {{ JSON.stringify($json.triggerData) }},
  "triggerSource": "{{ $json.triggerSource }}",
  "eventId":       "{{ $json.eventId }}"
}`,
                    options: {
                        timeout: 10000,
                    },
                    // ── Payload contract (documentation) ──
                    // Scenario: ${scenario.id}
                    // Industry: ${scenario.industry}
                    // Worker:   ${scenario.worker} → ${workersUrl}
                    // trigger_data fields expected:
                    // ${payloadDocs}
                },
            },

            // ── 4. Respond to Webhook ───────────────────────────────────────
            {
                id: respondId,
                name: 'Respond to Webhook',
                type: 'n8n-nodes-base.respondToWebhook',
                typeVersion: 1,
                position: [960, 300],
                parameters: {
                    respondWith: 'json',
                    responseBody: '={{ { "success": true, "scenarioId": "' + scenario.id + '", "worker": "' + scenario.worker + '", "processedAt": new Date().toISOString() } }}',
                    options: {},
                },
            },
        ],

        connections: {
            'Webhook Trigger': {
                main: [[{ node: 'Extract Fields', type: 'main', index: 0 }]],
            },
            'Extract Fields': {
                main: [[{ node: 'POST to GRIDHAND Workers', type: 'main', index: 0 }]],
            },
            'POST to GRIDHAND Workers': {
                main: [[{ node: 'Respond to Webhook', type: 'main', index: 0 }]],
            },
        },

        settings: {
            executionOrder: 'v1',
            saveManualExecutions: true,
            callerPolicy: 'workflowsFromSameOwner',
            errorWorkflow: '',
        },

        tags: ['gridhand', 'industry', scenario.industry, scenario.trigger, 'auto-generated'],

        meta: {
            gridhand: {
                source:        'industry-scenario-builder',
                scenarioId:    scenario.id,
                scenarioName:  scenario.name,
                industry:      scenario.industry,
                trigger:       scenario.trigger,
                worker:        scenario.worker,
                workersUrl,
                webhookPath,
                description:   scenario.description,
                generatedAt:   new Date().toISOString(),
            },
        },
    };
}

// ─── N8N API push ─────────────────────────────────────────────────────────────

async function pushToN8n(workflowJson) {
    if (!N8N_API_KEY) {
        return { skipped: true, reason: 'N8N_API_KEY not set — saved to disk only' };
    }

    // n8n API v1: `meta` and `tags` are read-only on creation — strip both before POST
    const { meta: _meta, tags: _tags, ...workflowPayload } = workflowJson;

    const response = await fetch(`${N8N_BASE_URL}/api/v1/workflows`, {
        method: 'POST',
        headers: {
            'Content-Type':  'application/json',
            'X-N8N-API-KEY': N8N_API_KEY,
        },
        body: JSON.stringify(workflowPayload),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`n8n API error (${response.status}): ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    return { pushed: true, n8nId: data.id, n8nName: data.name };
}

// ─── Main builder ─────────────────────────────────────────────────────────────

async function runIndustryScenarioBuilder(options = {}) {
    // ── Parse CLI args ──
    const args     = process.argv.slice(2);
    const dryRun   = args.includes('--dry-run')  || options.dryRun   || false;
    const onlyIndustry =
        args.find(a => a.startsWith('--industry='))?.split('=')[1]
        ?? (args.indexOf('--industry') !== -1 ? args[args.indexOf('--industry') + 1] : null)
        ?? options.industry
        ?? null;

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log(  '║      GRIDHAND INDUSTRY SCENARIO BUILDER — STARTING       ║');
    console.log(  '╚═══════════════════════════════════════════════════════════╝');
    console.log(`\n  Mode:         ${dryRun ? 'DRY RUN (no n8n push)' : N8N_API_KEY ? 'LIVE (pushing to n8n)' : 'DISK ONLY (N8N_API_KEY not set)'}`);
    console.log(`  Industry:     ${onlyIndustry ?? 'all'}`);
    console.log(`  n8n URL:      ${N8N_BASE_URL}`);
    console.log(`  Workers URL:  ${WORKERS_BASE_URL}`);
    console.log(`  Output:       ${INDUSTRY_DIR}\n`);

    // ── Pick scenarios ──
    const scenarios = onlyIndustry
        ? getScenariosForIndustry(onlyIndustry)
        : getAllScenarios();

    if (scenarios.length === 0) {
        console.error(`[INDUSTRY BUILDER] No scenarios found${onlyIndustry ? ` for industry "${onlyIndustry}"` : ''}. Check lib/make-scenarios.js.`);
        process.exit(1);
    }

    // ── Ensure output directories exist ──
    fs.mkdirSync(INDUSTRY_DIR, { recursive: true });

    // ── Load index ──
    const index = loadIndex();

    // Build a set of scenario IDs already present in the index under our source tag
    const existingIds = new Set(
        index.generated
            .filter(e => e.source === 'industry-scenario-builder')
            .map(e => e.scenarioId)
    );

    const generated = [];
    const skippedExisting = [];

    for (const scenario of scenarios) {
        // Skip if already indexed (idempotent — re-run safe)
        if (existingIds.has(scenario.id)) {
            skippedExisting.push(scenario.id);
            continue;
        }

        try {
            // ── Build workflow JSON ──
            const workflowJson = buildWorkflowJson(scenario);

            // ── Save to /scenarios/industry/{id}.json ──
            const outputPath = path.join(INDUSTRY_DIR, `${scenario.id}.json`);
            fs.writeFileSync(outputPath, JSON.stringify(workflowJson, null, 2));

            // ── Push to n8n (unless dry-run) ──
            let n8nResult = { skipped: true, reason: 'dry-run mode' };
            if (!dryRun) {
                try {
                    n8nResult = await pushToN8n(workflowJson);
                } catch (n8nErr) {
                    n8nResult = { error: n8nErr.message };
                    console.warn(`[INDUSTRY BUILDER]   n8n push failed for ${scenario.id}: ${n8nErr.message}`);
                }
            }

            const statusTag = n8nResult.pushed
                ? `n8n #${n8nResult.n8nId}`
                : n8nResult.error
                    ? `n8n FAILED`
                    : `disk only`;

            console.log(`[INDUSTRY BUILDER]   ${scenario.industry.padEnd(12)} ${scenario.id.padEnd(42)} → ${statusTag}`);

            generated.push({
                source:      'industry-scenario-builder',
                scenarioId:  scenario.id,
                name:        scenario.name,
                industry:    scenario.industry,
                trigger:     scenario.trigger,
                worker:      scenario.worker,
                filePath:    outputPath,
                generatedAt: new Date().toISOString(),
                n8n:         n8nResult,
            });

        } catch (err) {
            console.error(`[INDUSTRY BUILDER]   Error building "${scenario.id}": ${err.message}`);
        }
    }

    // ── Update index ──
    index.generated.push(...generated);
    index.lastRun    = new Date().toISOString();
    index.totalCount = index.generated.length;
    saveIndex(index);

    // ── Summary ──
    const pushedCount = generated.filter(e => e.n8n?.pushed).length;

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log(  '║           INDUSTRY SCENARIO BUILDER COMPLETE             ║');
    console.log(  '╚═══════════════════════════════════════════════════════════╝');
    console.log(`\n  Generated this run:  ${generated.length} scenarios`);
    console.log(`  Skipped (existing):  ${skippedExisting.length}`);
    console.log(`  Pushed to n8n:       ${pushedCount}`);
    console.log(`  Total in index:      ${index.generated.length}`);
    console.log(`  Index:               ${INDEX_FILE}`);
    console.log(`  Scenario dir:        ${INDUSTRY_DIR}`);

    if (!N8N_API_KEY && !dryRun) {
        console.log(`\n  Set N8N_API_KEY to push ${generated.length} workflows to n8n`);
        console.log(`  n8n instance: ${N8N_BASE_URL}`);
    }

    // Industry breakdown
    if (generated.length > 0) {
        console.log('\n  By industry:');
        const byIndustry = {};
        for (const e of generated) {
            byIndustry[e.industry] = (byIndustry[e.industry] || 0) + 1;
        }
        for (const [industry, count] of Object.entries(byIndustry)) {
            console.log(`    ${industry.padEnd(14)} ${count} workflow${count !== 1 ? 's' : ''}`);
        }
    }

    console.log('');
    return generated;
}

// ─── Daily scheduler (mirrors n8n-scenario-engine pattern) ───────────────────

function scheduleDailyRun() {
    function msUntilNextTwoAM() {
        const now  = new Date();
        const next = new Date(now);
        next.setHours(2, 0, 0, 0);
        if (next <= now) next.setDate(next.getDate() + 1);
        return next - now;
    }

    const msUntil = msUntilNextTwoAM();
    const hours   = Math.floor(msUntil / 3600000);
    const minutes = Math.floor((msUntil % 3600000) / 60000);

    console.log(`[INDUSTRY BUILDER] Scheduled — next run in ${hours}h ${minutes}m (daily at 2am)`);

    setTimeout(() => {
        runIndustryScenarioBuilder().catch(e =>
            console.error('[INDUSTRY BUILDER] Daily run error:', e.message)
        );
        setInterval(() => {
            runIndustryScenarioBuilder().catch(e =>
                console.error('[INDUSTRY BUILDER] Daily run error:', e.message)
            );
        }, 24 * 60 * 60 * 1000);
    }, msUntil);
}

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = {
    runIndustryScenarioBuilder,
    scheduleDailyRun,
    buildWorkflowJson,
};

// ─── Direct execution ─────────────────────────────────────────────────────────

if (require.main === module) {
    runIndustryScenarioBuilder().catch(err => {
        console.error('[INDUSTRY BUILDER] Fatal error:', err.message);
        process.exit(1);
    });
}
