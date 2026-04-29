'use strict';
// tier: simple
//
// ─── Email Triage Agent ──────────────────────────────────────────────────────
//
// Receives Gmail-watch payloads forwarded from n8n via:
//   POST /api/email-triage  (requireApiKey)
//
// Pure keyword classification — no AI calls. Routes to:
//   - Railway deploy failure  → Telegram + auto-redeploy + worker-guardian recheck
//   - Vercel deploy failure   → Telegram
//   - Make.com error          → Telegram
//   - Sentry alert            → Telegram + Linear ticket
//   - Critical alert          → Telegram + Linear ticket
//   - General alert           → Telegram
//   - False positive          → silenced (logged only, no Telegram)
//   - Nothing matched         → silent (return false, no spam)
//
// Never throws. All errors caught + sent to Sentry. Server stays alive.
//
// Payload shape from n8n:
//   { subject: string, from: string, body: string, receivedAt: ISO timestamp }

const { sendTelegramAlert } = require('../lib/events');
const sentry = require('../lib/sentry-client');

// ─── External integrations ───────────────────────────────────────────────────

const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const RAILWAY_WORKERS_SERVICE_ID = '468eae16-8a4a-480d-b95d-03f985be5aec';
const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';
const RAILWAY_REDEPLOY_FOLLOWUP_MS = 90 * 1000;

// In-memory dedupe for Linear tickets (subject → timestamp)
// Survives only the process lifetime — good enough for the 24h window.
const _recentLinearTickets = new Map();
const LINEAR_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

// ─── False positive silencing ────────────────────────────────────────────────

/**
 * Returns true if the email matches a known false-positive pattern.
 * False positives are logged to console but never sent to Telegram.
 */
function isFalsePositive(subject, from, body) {
    const subj = (subject || '').toLowerCase();
    const fromAddr = (from || '').toLowerCase();
    // body intentionally unused for now — kept in signature for future patterns
    void body;

    // Scheduled maintenance notices
    if (subj.includes('scheduled maintenance') || subj.includes('scheduled downtime')) {
        return true;
    }

    // Test alerts
    if (subj.includes('test alert')) {
        return true;
    }

    // Successful Railway deploys (sent from noreply@railway.app)
    if (fromAddr.includes('noreply@railway.app') && subj.includes('success')) {
        return true;
    }

    // Successful Vercel deploys
    if (fromAddr.includes('vercel.com') && subj.includes('successfully deployed')) {
        return true;
    }

    // Periodic digests
    if (subj.includes('weekly digest') || subj.includes('monthly summary')) {
        return true;
    }

    return false;
}

// ─── Classification ──────────────────────────────────────────────────────────

const ERROR_TERMS  = ['error', 'failed', 'failure', 'fatal', 'crash'];
const ALERT_TERMS  = ['alert', 'down', 'critical', 'failed', 'failure', 'incident'];

function _has(haystack, needle) {
    return haystack.includes(needle.toLowerCase());
}

function _hasAny(haystack, needles) {
    return needles.some(n => _has(haystack, n));
}

/**
 * Classify an email payload into one of the alert types.
 * Returns { type, label } or null if nothing matched.
 */
function classify(payload) {
    const subject = (payload.subject || '').toLowerCase();
    const from    = (payload.from    || '').toLowerCase();
    const body    = (payload.body    || '').toLowerCase();
    const all     = `${subject} ${from} ${body}`;

    // Railway deploy failure
    const looksLikeError = _hasAny(subject, ERROR_TERMS) || _has(body, 'deployment failed');
    if (looksLikeError && (_has(from, 'railway') || _has(all, 'railway'))) {
        return { type: 'railway', label: 'Railway Deploy Failure' };
    }

    // Vercel deploy failure
    if (_has(all, 'vercel') && _hasAny(all, ['error', 'failed', 'failure'])) {
        return { type: 'vercel', label: 'Vercel Deploy Failure' };
    }

    // Make.com error
    if ((_has(all, 'make.com') || _has(all, 'make scenario')) &&
        _hasAny(all, ['error', 'failed', 'failure'])) {
        return { type: 'make', label: 'Make.com Scenario Error' };
    }

    // Sentry alert
    if (_has(from, 'sentry') || _has(payload.subject || '', 'Sentry')) {
        return { type: 'sentry', label: 'Sentry Alert' };
    }

    // Critical alert — keywords like "critical", "fatal", "incident", "down" in subject
    if (_hasAny(subject, ['critical', 'fatal', 'incident', 'outage'])) {
        return { type: 'critical', label: 'Critical System Alert' };
    }

    // General alert — last-resort match
    if (_hasAny(all, ALERT_TERMS)) {
        return { type: 'general', label: 'System Alert' };
    }

    return null;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function _formatTime(iso) {
    try {
        const d = iso ? new Date(iso) : new Date();
        return d.toLocaleString('en-US', {
            timeZone: 'America/Chicago',
            hour:     'numeric',
            minute:   '2-digit',
            hour12:   true,
            timeZoneName: 'short',
        });
    } catch {
        return new Date().toISOString();
    }
}

function _truncate(str, max) {
    if (!str) return '(none)';
    return str.length > max ? str.slice(0, max) + '…' : str;
}

function buildAlertMessage(classification, payload) {
    const time = _formatTime(payload.receivedAt);

    const lines = [
        '🚨 *Email Alert Detected*',
        `Type: ${classification.label}`,
        `From: ${_truncate(payload.from, 120)}`,
        `Subject: ${_truncate(payload.subject, 200)}`,
        `Time: ${time}`,
        '',
    ];

    // Type-specific tail
    switch (classification.type) {
        case 'railway':
            lines.push('Checking Railway status now...');
            break;
        case 'vercel':
            lines.push('Check Vercel dashboard for deployment status.');
            break;
        case 'make':
            lines.push('Open Make.com to inspect failed scenario run.');
            break;
        case 'sentry':
            lines.push('Open Sentry for full stack trace.');
            break;
        case 'critical':
            lines.push('Critical alert — Linear ticket being filed.');
            break;
        default:
            lines.push('Review email manually for next steps.');
    }

    return lines.join('\n');
}

// ─── Railway auto-redeploy ───────────────────────────────────────────────────

/**
 * Tiny GraphQL fetch helper. Uses global fetch (Node 18+).
 * Returns parsed JSON body or throws on transport / GraphQL errors.
 */
async function _gqlFetch(endpoint, headers, query, variables) {
    const res = await fetch(endpoint, {
        method:  'POST',
        headers: {
            'Content-Type': 'application/json',
            ...headers,
        },
        body: JSON.stringify({ query, variables }),
    });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {
        throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (json.errors && json.errors.length) {
        throw new Error(`GraphQL: ${json.errors.map(e => e.message).join('; ')}`);
    }
    return json.data;
}

/**
 * Get the latest deployment ID for the workers service.
 * Returns null if not found / on error.
 */
async function _getLatestRailwayDeploymentId() {
    const token = process.env.RAILWAY_API_TOKEN;
    if (!token) {
        console.warn('[email-triage] RAILWAY_API_TOKEN not set — skipping deployment lookup');
        return null;
    }

    const query = `
        query Deployments($serviceId: String!) {
            deployments(
                first: 1
                input: { serviceId: $serviceId }
            ) {
                edges { node { id status createdAt } }
            }
        }
    `;

    try {
        const data = await _gqlFetch(
            RAILWAY_GRAPHQL_ENDPOINT,
            { Authorization: `Bearer ${token}` },
            query,
            { serviceId: RAILWAY_WORKERS_SERVICE_ID }
        );
        const edges = data?.deployments?.edges || [];
        if (!edges.length) {
            console.warn('[email-triage] no deployments returned for workers service');
            return null;
        }
        return edges[0].node.id;
    } catch (e) {
        console.error('[email-triage] failed to fetch latest Railway deployment:', e.message);
        try { sentry.captureError?.(e, { agent: 'email-triage', stage: 'railway-deployment-lookup' }); } catch {}
        return null;
    }
}

/**
 * Trigger a redeploy of the latest deployment for the workers service.
 * Fires Telegram before + schedules a 90s follow-up check (non-blocking).
 * Never throws.
 */
async function autoRedeployRailway() {
    const token = process.env.RAILWAY_API_TOKEN;
    if (!token) {
        console.warn('[email-triage] RAILWAY_API_TOKEN not set — cannot auto-redeploy');
        return { ok: false, reason: 'missing_token' };
    }

    try {
        await sendTelegramAlert('🔄 Railway failure detected — auto-redeploying workers now...');
    } catch (e) {
        console.error('[email-triage] Telegram redeploy notice failed:', e.message);
    }

    const deploymentId = await _getLatestRailwayDeploymentId();
    if (!deploymentId) {
        console.warn('[email-triage] no deployment id — skipping redeploy');
        return { ok: false, reason: 'no_deployment_id' };
    }

    const mutation = `
        mutation Redeploy($id: String!) {
            deploymentRedeploy(id: $id) { id status }
        }
    `;

    try {
        const data = await _gqlFetch(
            RAILWAY_GRAPHQL_ENDPOINT,
            { Authorization: `Bearer ${token}` },
            mutation,
            { id: deploymentId }
        );
        const newId = data?.deploymentRedeploy?.id;
        console.log(`[email-triage] Railway redeploy triggered: ${newId || 'unknown id'}`);

        // Non-blocking 90s follow-up — Node refs the timer so it'll fire even on idle.
        setTimeout(() => {
            railwayFollowUp().catch(e => {
                console.error('[email-triage] delayed follow-up failed:', e.message);
            });
        }, RAILWAY_REDEPLOY_FOLLOWUP_MS).unref();

        return { ok: true, deploymentId: newId };
    } catch (e) {
        console.error('[email-triage] Railway redeploy failed:', e.message);
        try { sentry.captureError?.(e, { agent: 'email-triage', stage: 'railway-redeploy' }); } catch {}
        try {
            await sendTelegramAlert(`⚠️ Auto-redeploy failed: ${e.message}\nManual redeploy needed.`);
        } catch {}
        return { ok: false, reason: 'mutation_failed', error: e.message };
    }
}

// ─── Linear ticket creation ──────────────────────────────────────────────────

/**
 * Returns true if a Linear ticket with this subject was created in the last 24h.
 * Combines in-memory dedupe with a Linear API search to survive process restarts.
 */
async function _linearDuplicateExists(subject, apiKey) {
    // 1) Process-local dedupe
    const now = Date.now();
    const lastSeen = _recentLinearTickets.get(subject);
    if (lastSeen && (now - lastSeen) < LINEAR_DEDUPE_WINDOW_MS) {
        return true;
    }

    // 2) Linear API search — issues with same title in last 24h
    const since = new Date(now - LINEAR_DEDUPE_WINDOW_MS).toISOString();
    const query = `
        query DuplicateCheck($title: String!, $since: DateTimeOrDuration!) {
            issues(
                filter: {
                    title: { eq: $title }
                    createdAt: { gte: $since }
                }
                first: 1
            ) {
                nodes { id title createdAt }
            }
        }
    `;

    try {
        const data = await _gqlFetch(
            LINEAR_GRAPHQL_ENDPOINT,
            { Authorization: apiKey },
            query,
            { title: subject, since }
        );
        const found = (data?.issues?.nodes || []).length > 0;
        if (found) _recentLinearTickets.set(subject, now);
        return found;
    } catch (e) {
        // If dedupe lookup fails, don't block ticket creation — just log.
        console.warn('[email-triage] Linear dedupe lookup failed:', e.message);
        return false;
    }
}

/**
 * Resolve the first available Linear team ID.
 * Cached on first call for the process lifetime.
 */
let _cachedLinearTeamId = null;
async function _getLinearTeamId(apiKey) {
    if (_cachedLinearTeamId) return _cachedLinearTeamId;

    const query = `query Teams { teams(first: 1) { nodes { id name } } }`;
    const data = await _gqlFetch(
        LINEAR_GRAPHQL_ENDPOINT,
        { Authorization: apiKey },
        query,
        {}
    );
    const team = (data?.teams?.nodes || [])[0];
    if (!team) throw new Error('No Linear teams found');
    _cachedLinearTeamId = team.id;
    console.log(`[email-triage] resolved Linear team: ${team.name} (${team.id})`);
    return _cachedLinearTeamId;
}

/**
 * Create a Linear issue from an alert email.
 * Skips creation if a same-subject ticket exists within the last 24h.
 * Sends Telegram confirmation on success. Never throws.
 */
async function createLinearTicket(payload) {
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
        console.warn('[email-triage] LINEAR_API_KEY not set — skipping Linear ticket');
        return { ok: false, reason: 'missing_key' };
    }

    const subject = (payload.subject || '(no subject)').slice(0, 250);
    const description = (payload.body || '').slice(0, 500);

    try {
        if (await _linearDuplicateExists(subject, apiKey)) {
            console.log(`[email-triage] Linear duplicate skipped: "${_truncate(subject, 80)}"`);
            return { ok: true, skipped: true, reason: 'duplicate' };
        }

        const teamId = await _getLinearTeamId(apiKey);

        const mutation = `
            mutation CreateIssue($input: IssueCreateInput!) {
                issueCreate(input: $input) {
                    success
                    issue { id title url }
                }
            }
        `;
        const data = await _gqlFetch(
            LINEAR_GRAPHQL_ENDPOINT,
            { Authorization: apiKey },
            mutation,
            {
                input: {
                    teamId,
                    title:       subject,
                    description: description || '(no body)',
                    priority:    2, // High
                },
            }
        );

        const issue = data?.issueCreate?.issue;
        if (!data?.issueCreate?.success || !issue) {
            throw new Error('issueCreate returned no issue');
        }

        _recentLinearTickets.set(subject, Date.now());

        try {
            await sendTelegramAlert(`🎫 Linear ticket created: ${subject}\n${issue.url || ''}`.trim());
        } catch (e) {
            console.error('[email-triage] Telegram (Linear) failed:', e.message);
        }

        console.log(`[email-triage] Linear issue created: ${issue.id} — ${issue.url}`);
        return { ok: true, id: issue.id, url: issue.url };
    } catch (e) {
        console.error('[email-triage] Linear ticket creation failed:', e.message);
        try { sentry.captureError?.(e, { agent: 'email-triage', stage: 'linear-create' }); } catch {}
        return { ok: false, reason: 'create_failed', error: e.message };
    }
}

// ─── Railway follow-up ───────────────────────────────────────────────────────

/**
 * For Railway alerts — re-check current deployment state via worker-guardian.
 * If still failing, send a confirming follow-up Telegram.
 * Never throws; always logs.
 */
async function railwayFollowUp() {
    let checkRailwayDeployments;
    try {
        ({ checkRailwayDeployments } = require('./worker-guardian'));
    } catch (e) {
        console.warn('[email-triage] worker-guardian not loadable:', e.message);
        return;
    }

    if (typeof checkRailwayDeployments !== 'function') {
        console.warn('[email-triage] worker-guardian.checkRailwayDeployments not exported — skipping follow-up');
        return;
    }

    try {
        const result = await checkRailwayDeployments();
        if (result && result.ok === false) {
            const detail = result.detail || 'Latest deploy still failing';
            await sendTelegramAlert(
                `⚠️ Confirmed still failing. Manual redeploy needed.\n${detail}`
            );
        } else if (result && result.skipped) {
            console.log('[email-triage] Railway recheck skipped:', result.detail);
        } else {
            console.log('[email-triage] Railway recheck OK — alert was likely transient');
        }
    } catch (e) {
        console.error('[email-triage] Railway recheck failed:', e.message);
        try { sentry.captureError?.(e, { agent: 'email-triage', stage: 'railway-followup' }); } catch {}
    }
}

// ─── Core run function ───────────────────────────────────────────────────────

/**
 * Main entry. Called fire-and-forget from POST /api/email-triage.
 * Always resolves — never rejects — so callers don't need to handle errors.
 *
 * @param {{ subject?: string, from?: string, body?: string, receivedAt?: string }} payload
 * @returns {Promise<{ matched: boolean, type?: string }>}
 */
async function run(payload = {}) {
    try {
        if (!payload || typeof payload !== 'object') {
            console.warn('[email-triage] invalid payload — ignored');
            return { matched: false };
        }

        // False-positive silencing — runs BEFORE classification, no Telegram, just log.
        if (isFalsePositive(payload.subject, payload.from, payload.body)) {
            console.log('[email-triage] silenced false positive:', payload.subject);
            return { matched: false, silenced: true };
        }

        const classification = classify(payload);
        if (!classification) {
            console.log(`[email-triage] no match — subject="${_truncate(payload.subject, 80)}" from="${_truncate(payload.from, 80)}"`);
            return { matched: false };
        }

        console.log(`[email-triage] match: ${classification.type} — ${_truncate(payload.subject, 80)}`);

        const message = buildAlertMessage(classification, payload);

        try {
            await sendTelegramAlert(message);
        } catch (e) {
            console.error('[email-triage] Telegram send failed:', e.message);
            try { sentry.captureError?.(e, { agent: 'email-triage', stage: 'telegram-send' }); } catch {}
        }

        // Railway failure → auto-redeploy + scheduled 90s follow-up
        if (classification.type === 'railway') {
            await autoRedeployRailway();
        }

        // Sentry / critical → Linear ticket (with 24h dedupe)
        if (classification.type === 'sentry' || classification.type === 'critical') {
            await createLinearTicket(payload);
        }

        return { matched: true, type: classification.type };

    } catch (e) {
        console.error('[email-triage] unexpected error:', e.message);
        try { sentry.captureError?.(e, { agent: 'email-triage', stage: 'run' }); } catch {}
        return { matched: false, error: e.message };
    }
}

module.exports = {
    run,
    classify,
    buildAlertMessage,
    isFalsePositive,
    autoRedeployRailway,
    createLinearTicket,
};
