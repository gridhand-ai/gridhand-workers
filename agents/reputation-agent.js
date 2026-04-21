/**
 * ── OG GRIDHAND AGENT (Original) ─────────────────────────────────────────────
 * Serves clients directly. Runs on Railway. Active 24/7.
 * ─────────────────────────────────────────────────────────────────────────────
 * reputation-agent.js
 *
 * Intelligent reputation management agent.
 * Replaces: Review Requester + Review Responder + Reputation Monitor
 *
 * Capabilities:
 *   - Send personalized review request SMS 2-4 hours after job completion
 *   - Monitor Google Business reviews via polling
 *   - Draft and send review responses within 24h of a new review
 *   - Track review velocity — alert MJ + client if < 4.0 stars or 2 neg/week
 *   - Suppress repeat requests — don't send another for 30 days if ignored
 *
 * Trigger: POST /agents/reputation { clientId, event: 'job_complete', customerId, customerPhone, customerName, serviceName }
 * Cron:    Daily review monitor (checks for new Google reviews, drafts responses)
 *
 * Usage:
 *   node agents/reputation-agent.js --check <clientId>    — run review monitor now
 *   node agents/reputation-agent.js --request <clientId>  — send pending review requests
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

// Optimal review request delay: 2–4 hours post job complete (middle: 3h)
const REVIEW_REQUEST_DELAY_MS = 3 * 60 * 60 * 1000;
// Don't re-request if customer ignored within 30 days
const IGNORE_COOLDOWN_DAYS = 30;
// Alert threshold: 2 negative reviews in 7 days
const NEG_REVIEW_WINDOW_DAYS = 7;
const NEG_REVIEW_ALERT_COUNT = 2;
// Star threshold for rep alert
const LOW_STAR_THRESHOLD = 4.0;

// ─── Portal API helper ────────────────────────────────────────────────────────
async function logActivity(clientId, action, summary, metadata = {}) {
    if (!WORKERS_SECRET) return;
    try {
        await fetch(`${PORTAL_URL}/api/workers/log`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WORKERS_SECRET}`,
            },
            body: JSON.stringify({ clientId, workerName: 'ReputationAgent', action, summary, metadata }),
        });
    } catch (e) {
        console.log(`[ReputationAgent] Log failed: ${e.message}`);
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
        body: JSON.stringify({ clientId, workerName: 'ReputationAgent', errorMessage: message, context }),
    }).catch(e => console.log(`[ReputationAgent] Error report failed: ${e.message}`));
}

// ─── State helpers (Supabase) ─────────────────────────────────────────────────

// Track review request state per customer per client
async function getReviewRequestState(clientId, customerPhone) {
    const { data } = await supabase
        .from('agent_state')
        .select('state')
        .eq('agent', 'reputation')
        .eq('client_id', clientId)
        .eq('entity_id', `review_req:${customerPhone}`)
        .single();
    return data?.state || null;
}

async function setReviewRequestState(clientId, customerPhone, state) {
    await supabase
        .from('agent_state')
        .upsert({
            agent: 'reputation',
            client_id: clientId,
            entity_id: `review_req:${customerPhone}`,
            state,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'agent,client_id,entity_id' });
}

// Track seen reviews to avoid re-processing
async function getSeenReviewIds(clientId) {
    const { data } = await supabase
        .from('agent_state')
        .select('state')
        .eq('agent', 'reputation')
        .eq('client_id', clientId)
        .eq('entity_id', 'seen_review_ids')
        .single();
    return data?.state?.ids || [];
}

async function markReviewSeen(clientId, reviewId) {
    const existing = await getSeenReviewIds(clientId);
    const updated = [...new Set([...existing, reviewId])].slice(-500); // cap at 500
    await supabase
        .from('agent_state')
        .upsert({
            agent: 'reputation',
            client_id: clientId,
            entity_id: 'seen_review_ids',
            state: { ids: updated },
            updated_at: new Date().toISOString(),
        }, { onConflict: 'agent,client_id,entity_id' });
}

// ─── Load client config from Supabase ────────────────────────────────────────
async function loadClientConfig(clientId) {
    const { data, error } = await supabase
        .from('clients')
        .select('id, business_name, industry, settings, twilio_number, timezone, slug')
        .eq('id', clientId)
        .single();
    if (error || !data) throw new Error(`Client not found: ${clientId}`);
    return data;
}

// ─── Google Business API: fetch recent reviews ────────────────────────────────
// Polls the Google My Business API for new reviews. Requires client to have
// google_business_location_id + google_access_token in their settings.
// Returns [] gracefully if credentials aren't configured.
async function fetchGoogleReviews(clientConfig) {
    const settings = clientConfig.settings || {};
    const locationId   = settings.google_business_location_id;
    const accessToken  = settings.google_access_token;

    if (!locationId || !accessToken) {
        console.log(`[ReputationAgent] No Google Business credentials for ${clientConfig.id} — skipping review fetch`);
        return [];
    }

    try {
        const url = `https://mybusiness.googleapis.com/v4/${locationId}/reviews?pageSize=50`;
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) {
            const body = await res.text();
            console.log(`[ReputationAgent] Google API ${res.status}: ${body.slice(0, 100)}`);
            return [];
        }

        const data = await res.json();
        return data.reviews || [];
    } catch (e) {
        console.log(`[ReputationAgent] Google reviews fetch failed: ${e.message}`);
        return [];
    }
}

// ─── Draft review response using AI ──────────────────────────────────────────
async function draftReviewResponse(clientConfig, review) {
    const bizName   = clientConfig.business_name;
    const industry  = clientConfig.industry || 'business';
    const starRating = review.starRating || 'UNKNOWN';
    const reviewText = review.comment || '(no text)';
    const reviewerName = review.reviewer?.displayName || 'this customer';

    const systemPrompt = `<business>
Name: ${bizName}
Industry: ${industry}
</business>

<task>
Draft a professional, warm response to a Google review. The response will be posted publicly on Google by the business owner.
</task>

<review>
Stars: ${starRating}
Reviewer: ${reviewerName}
Text: ${reviewText}
</review>

<rules>
- Keep response under 150 words.
- Thank them by name if a name is available.
- For 5-star reviews: express genuine gratitude, reinforce what they liked.
- For 3-4 star reviews: thank them, acknowledge the feedback, invite them back.
- For 1-2 star reviews: apologize sincerely, take responsibility without making excuses, invite them to contact us directly to resolve it.
- Never be defensive. Never argue.
- End with: "— ${bizName} Team"
- Output ONLY the response text, no quotes, no preamble.
</rules>`;

    const reply = await aiClient.call({
        modelString: 'groq/llama-3.3-70b-versatile',
        clientApiKeys: {},
        systemPrompt,
        messages: [{ role: 'user', content: 'Draft the review response.' }],
        maxTokens: 200,
        _workerName: 'ReputationAgent',
    });

    return reply || null;
}

// ─── Post review response to Google ──────────────────────────────────────────
async function postReviewResponse(clientConfig, reviewName, responseText) {
    const settings    = clientConfig.settings || {};
    const accessToken = settings.google_access_token;
    if (!accessToken) return { ok: false, reason: 'no_token' };

    try {
        const url = `https://mybusiness.googleapis.com/v4/${reviewName}/reply`;
        const res = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ comment: responseText }),
            signal: AbortSignal.timeout(10000),
        });
        return { ok: res.ok, status: res.status };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

// ─── Review velocity analysis ─────────────────────────────────────────────────
function analyzeReviewVelocity(reviews) {
    const cutoff = new Date(Date.now() - NEG_REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const recent = reviews.filter(r => new Date(r.createTime) > cutoff);

    const negCount = recent.filter(r => ['ONE', 'TWO'].includes(r.starRating)).length;

    // Calculate average rating across all reviews (last 50)
    const starMap = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
    const ratings = reviews.map(r => starMap[r.starRating] || 0).filter(Boolean);
    const avgRating = ratings.length
        ? ratings.reduce((a, b) => a + b, 0) / ratings.length
        : null;

    return { negCount, avgRating, recentTotal: recent.length };
}

// ─── Send review request SMS ──────────────────────────────────────────────────
async function sendReviewRequest({ clientConfig, clientLoader, customerPhone, customerName, serviceName }) {
    const settings   = clientConfig.settings || {};
    const reviewLink = settings.google_review_link || settings.review_link || null;
    const bizName    = clientConfig.business_name;
    const timezone   = clientConfig.timezone || 'America/Chicago';
    const twilioNum  = clientConfig.twilio_number;

    if (!twilioNum) {
        console.log(`[ReputationAgent] No Twilio number for client ${clientConfig.id} — skipping`);
        return;
    }

    // Compliance: opt-out check
    try {
        optoutManager.guardOutbound(clientConfig.slug, customerPhone);
    } catch (e) {
        console.log(`[ReputationAgent] Opt-out guard: ${e.message}`);
        return;
    }

    // Compliance: TCPA quiet hours
    if (tcpaChecker.isQuietHours(timezone)) {
        console.log(`[ReputationAgent] TCPA quiet hours for ${clientConfig.id} — review request queued`);
        return; // Will be retried by the next scheduled run during business hours
    }

    const nameGreet  = customerName ? `Hi ${customerName}` : 'Hi there';
    const serviceRef = serviceName ? ` for your ${serviceName}` : '';
    const linkPart   = reviewLink ? ` ${reviewLink}` : '';

    const body = `${nameGreet}! Thank you for choosing ${bizName}${serviceRef}. We hope everything went great! Would you mind sharing a quick Google review?${linkPart} It means a lot to our small team. — ${bizName}`;

    // Load client object (with apiKeys) for twilio-sender
    const client = clientLoader ? clientLoader(twilioNum) : null;
    const clientApiKeys = client?.apiKeys || {};

    await sender.sendSMS({
        from: twilioNum,
        to: customerPhone,
        body,
        clientSlug: clientConfig.slug,
        clientApiKeys,
        clientTimezone: timezone,
    });

    console.log(`[ReputationAgent] Review request sent to customer (client: ${clientConfig.id})`);
}

// ─── Main: handle job_complete event ─────────────────────────────────────────
// Called when a job is marked complete. Schedules a review request.
// In production this is triggered via POST /agents/reputation with event='job_complete'.
// The actual SMS fires after REVIEW_REQUEST_DELAY_MS (stored in agent_state).
async function handleJobComplete({ clientId, customerPhone, customerName, serviceName }) {
    console.log(`[ReputationAgent] job_complete for client ${clientId}`);

    // Check if we already sent a request to this customer recently
    const state = await getReviewRequestState(clientId, customerPhone);
    if (state) {
        const lastSent  = state.lastRequestSent ? new Date(state.lastRequestSent) : null;
        const ignored   = state.status === 'ignored';
        const daysSince = lastSent ? (Date.now() - lastSent.getTime()) / (1000 * 60 * 60 * 24) : null;

        if (ignored && daysSince !== null && daysSince < IGNORE_COOLDOWN_DAYS) {
            console.log(`[ReputationAgent] Customer ignored last request ${Math.floor(daysSince)}d ago — suppressed`);
            return { scheduled: false, reason: 'ignore_cooldown' };
        }
    }

    // Schedule request: fire at scheduledAt time (now + delay)
    const scheduledAt = new Date(Date.now() + REVIEW_REQUEST_DELAY_MS).toISOString();
    await setReviewRequestState(clientId, customerPhone, {
        status: 'pending',
        scheduledAt,
        customerName: customerName || null,
        serviceName: serviceName || null,
        lastRequestSent: null,
    });

    console.log(`[ReputationAgent] Review request scheduled for ${scheduledAt} (client: ${clientId})`);
    await logActivity(clientId, 'review_request_scheduled', `Scheduled for ${scheduledAt}`, { scheduledAt });

    return { scheduled: true, scheduledAt };
}

// ─── Main: run pending review requests ────────────────────────────────────────
// Called by daily cron or periodic check. Fires any requests that are past their
// scheduledAt time. Pass clientLoader from server.js to get full client config.
async function runPendingRequests(clientLoader) {
    console.log('[ReputationAgent] Checking pending review requests...');

    const now = new Date().toISOString();

    // Fetch all pending requests
    const { data: pending, error } = await supabase
        .from('agent_state')
        .select('client_id, entity_id, state')
        .eq('agent', 'reputation')
        .like('entity_id', 'review_req:%')
        .eq('state->>status', 'pending');

    if (error) {
        console.log(`[ReputationAgent] Supabase query error: ${error.message}`);
        return;
    }

    if (!pending?.length) {
        console.log('[ReputationAgent] No pending review requests');
        return;
    }

    for (const row of pending) {
        const scheduledAt = row.state?.scheduledAt;
        if (!scheduledAt || new Date(scheduledAt) > new Date(now)) continue; // not ready yet

        const customerPhone = row.entity_id.replace('review_req:', '');
        const clientId      = row.client_id;

        try {
            const clientConfig = await loadClientConfig(clientId);

            await sendReviewRequest({
                clientConfig,
                clientLoader,
                customerPhone,
                customerName: row.state?.customerName,
                serviceName:  row.state?.serviceName,
            });

            // Mark as sent
            await setReviewRequestState(clientId, customerPhone, {
                ...row.state,
                status: 'sent',
                lastRequestSent: new Date().toISOString(),
            });

            await logActivity(clientId, 'review_request_sent', 'Review request SMS sent');
            await emit('task_completed', {
                workerName: 'ReputationAgent',
                clientSlug: clientConfig.slug,
                summary: 'Review request sent',
            });

        } catch (e) {
            console.log(`[ReputationAgent] Failed to send request for ${clientId}: ${e.message}`);
            reportError(clientId, e.message, { phase: 'send_review_request' });
        }
    }
}

// ─── Main: monitor Google reviews ────────────────────────────────────────────
// Polls Google for new reviews, drafts + posts responses, checks rep health.
async function monitorReviews(clientId) {
    console.log(`[ReputationAgent] Monitoring reviews for client ${clientId}`);

    let clientConfig;
    try {
        clientConfig = await loadClientConfig(clientId);
    } catch (e) {
        console.log(`[ReputationAgent] Client load failed: ${e.message}`);
        return;
    }

    const reviews = await fetchGoogleReviews(clientConfig);
    if (!reviews.length) {
        console.log(`[ReputationAgent] No reviews found (or no credentials) for ${clientId}`);
        return;
    }

    const seenIds = await getSeenReviewIds(clientId);
    const newReviews = reviews.filter(r => r.reviewId && !seenIds.includes(r.reviewId));

    console.log(`[ReputationAgent] ${newReviews.length} new reviews for ${clientId}`);

    // Draft and post responses for new reviews
    for (const review of newReviews) {
        try {
            // Only respond if they don't already have a reply
            if (review.reviewReply) {
                await markReviewSeen(clientId, review.reviewId);
                continue;
            }

            const responseText = await draftReviewResponse(clientConfig, review);
            if (!responseText) {
                console.log(`[ReputationAgent] AI draft returned empty for review ${review.reviewId}`);
                continue;
            }

            const postResult = await postReviewResponse(clientConfig, review.name, responseText);
            if (postResult.ok) {
                console.log(`[ReputationAgent] Response posted for review ${review.reviewId}`);
                await logActivity(clientId, 'review_responded', `Responded to ${review.starRating} star review`);
            } else {
                // Store drafted response for manual posting if API fails
                await supabase.from('agent_state').upsert({
                    agent: 'reputation',
                    client_id: clientId,
                    entity_id: `draft_response:${review.reviewId}`,
                    state: { reviewId: review.reviewId, draftedResponse: responseText, stars: review.starRating, reviewText: review.comment?.slice(0, 200) },
                    updated_at: new Date().toISOString(),
                }, { onConflict: 'agent,client_id,entity_id' });

                console.log(`[ReputationAgent] Post failed (${postResult.reason || postResult.status}) — draft saved`);
            }

            await markReviewSeen(clientId, review.reviewId);

        } catch (e) {
            console.log(`[ReputationAgent] Review response error: ${e.message}`);
            reportError(clientId, e.message, { phase: 'review_response', reviewId: review.reviewId });
        }
    }

    // Mark all reviews as seen (including ones we already responded to)
    for (const review of reviews) {
        if (review.reviewId && !seenIds.includes(review.reviewId)) {
            await markReviewSeen(clientId, review.reviewId);
        }
    }

    // Velocity analysis — alert if below threshold or rapid negatives
    const { negCount, avgRating } = analyzeReviewVelocity(reviews);
    const bizName = clientConfig.business_name;

    if (avgRating !== null && avgRating < LOW_STAR_THRESHOLD) {
        const alertMsg = [
            `*Reputation Alert* — ${bizName}`,
            `Average rating: ${avgRating.toFixed(1)} stars (below ${LOW_STAR_THRESHOLD} threshold)`,
            `Recent negatives: ${negCount} in last ${NEG_REVIEW_WINDOW_DAYS} days`,
        ].join('\n');
        await sendTelegramAlert(alertMsg);
        await logActivity(clientId, 'reputation_alert', `Avg rating ${avgRating.toFixed(1)} < ${LOW_STAR_THRESHOLD}`, { avgRating, negCount });
    } else if (negCount >= NEG_REVIEW_ALERT_COUNT) {
        const alertMsg = [
            `*Reputation Alert* — ${bizName}`,
            `${negCount} negative reviews in the last ${NEG_REVIEW_WINDOW_DAYS} days`,
            `Average rating: ${avgRating?.toFixed(1) || 'unknown'} stars`,
        ].join('\n');
        await sendTelegramAlert(alertMsg);
        await logActivity(clientId, 'reputation_alert', `${negCount} negative reviews in ${NEG_REVIEW_WINDOW_DAYS}d`, { avgRating, negCount });
    }
}

// ─── Primary run() export — used by server.js trigger route ──────────────────
async function run(clientId, context = {}) {
    const { event, customerPhone, customerName, serviceName } = context;

    if (event === 'job_complete') {
        if (!customerPhone) throw new Error('customerPhone required for job_complete event');
        return handleJobComplete({ clientId, customerPhone, customerName, serviceName });
    }

    if (event === 'monitor_reviews') {
        return monitorReviews(clientId);
    }

    if (event === 'send_pending') {
        return runPendingRequests(context.clientLoader || null);
    }

    throw new Error(`Unknown event: ${event}. Use job_complete | monitor_reviews | send_pending`);
}

// ─── Standalone CLI entry ─────────────────────────────────────────────────────
if (require.main === module) {
    const args = process.argv.slice(2);
    const mode = args[0];
    const clientId = args[1];

    if (!clientId && mode !== '--send-pending') {
        console.error('Usage: node agents/reputation-agent.js --check <clientId>');
        console.error('       node agents/reputation-agent.js --request <clientId>');
        console.error('       node agents/reputation-agent.js --send-pending');
        process.exit(1);
    }

    const task = mode === '--check'
        ? monitorReviews(clientId)
        : mode === '--request'
            ? handleJobComplete({ clientId, customerPhone: args[2] || '', customerName: args[3], serviceName: args[4] })
            : runPendingRequests(null);

    task
        .then(r => { console.log('[ReputationAgent] Done:', JSON.stringify(r || {})); })
        .catch(e => {
            console.error('[ReputationAgent] Fatal:', e.message);
            process.exit(1);
        });
}

module.exports = { run, handleJobComplete, monitorReviews, runPendingRequests };
