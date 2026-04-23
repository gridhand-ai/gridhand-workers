// ─── Typed Event System — inspired by clawhip/claw-code architecture ─────────
// Replaces raw console.log with structured, routable events.
// Events flow to: console (dev), Supabase activity_log (prod), Telegram (alerts)
//
// Event types:
//   task_started    — worker picked up a task
//   task_completed  — worker finished successfully
//   task_failed     — worker failed (with retry info)
//   task_escalated  — failure escalated to MJ via Telegram
//   retry_triggered — auto-retry fired
//   provider_fallback — Anthropic down, switched to fallback provider
//   worker_healthy  — periodic health check passed

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Telegram alert sender ────────────────────────────────────────────────────
async function sendTelegramAlert(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        });
    } catch (e) {
        console.error('[events] Telegram alert failed:', e.message);
    }
}

// ─── Outcome resolver ─────────────────────────────────────────────────────────
// Maps event type to the outcome value stored in activity_log.outcome.
// 'ok'    = successful task completion
// 'error' = failure, escalation, or unrecoverable retry exhaustion
// null    = informational events that are not task outcomes (health checks, etc.)
const OUTCOME_MAP = {
    task_completed:    'ok',
    task_started:      null,
    task_failed:       'error',
    task_escalated:    'error',
    retry_triggered:   null,
    provider_fallback: null,
    worker_healthy:    null,
    task_blocked:      'error',
};

// ─── Core event emitter ───────────────────────────────────────────────────────
async function emit(type, payload = {}) {
    const event = {
        type,
        timestamp: new Date().toISOString(),
        workerName: payload.workerName || 'unknown',
        clientSlug: payload.clientSlug || null,
        // supabaseClientId is the UUID needed for the activity_log FK.
        // clientSlug is a text slug used for logging/display only.
        supabaseClientId: payload.supabaseClientId || null,
        customerNumber: payload.customerNumber || null,
        provider: payload.provider || null,
        retryCount: payload.retryCount ?? null,
        error: payload.error || null,
        summary: payload.summary || null,
        metadata: payload.metadata || null,
    };

    // Always log to console
    const icon = {
        task_started:      '▶',
        task_completed:    '✓',
        task_failed:       '✗',
        task_escalated:    '🚨',
        retry_triggered:   '↺',
        provider_fallback: '⇄',
        worker_healthy:    '♥',
    }[type] || '·';

    console.log(`[${event.workerName}] ${icon} ${type}${event.clientSlug ? ` | ${event.clientSlug}` : ''}${event.error ? ` | ${event.error}` : ''}`);

    // Write to Supabase activity_log.
    // Requires supabaseClientId (UUID) — clientSlug alone is a text slug and
    // will fail silently against the uuid FK. Both must be present to log.
    const clientUuid = event.supabaseClientId;
    if (supabase && clientUuid) {
        try {
            await supabase.from('activity_log').insert({
                client_id:   clientUuid,
                worker_name: event.workerName,
                action:      type,
                outcome:     OUTCOME_MAP[type] ?? null,
                message:     event.summary || event.error || type,
                metadata:    event,
                created_at:  event.timestamp,
            });
        } catch (e) {
            // Non-fatal — don't crash workers over logging failures
        }
    }

    // Telegram alerts for critical events
    if (type === 'task_escalated') {
        const msg = [
            `*GRIDHAND ALERT* 🚨`,
            `Worker: \`${event.workerName}\``,
            event.clientSlug ? `Client: \`${event.clientSlug}\`` : null,
            `Error: ${event.error}`,
            `Retried: ${event.retryCount}x before escalating`,
            `Time: ${event.timestamp}`,
        ].filter(Boolean).join('\n');
        await sendTelegramAlert(msg);
    }

    if (type === 'provider_fallback') {
        const msg = [
            `*Provider Fallback* ⇄`,
            `Anthropic unreachable — switched to \`${event.provider}\``,
            `Worker: \`${event.workerName}\``,
        ].join('\n');
        await sendTelegramAlert(msg);
    }

    return event;
}

// ─── Retry wrapper — wrap any async fn with auto-retry + escalation ───────────
// Usage:
//   const result = await withRetry(() => doWork(), { workerName, clientSlug, supabaseClientId, maxRetries: 2 })
async function withRetry(fn, { workerName, clientSlug, supabaseClientId, customerNumber, maxRetries = 2, fallbackReply = null } = {}) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await fn();
            if (attempt > 0) {
                await emit('task_completed', {
                    workerName, clientSlug, supabaseClientId, customerNumber,
                    summary: `Succeeded on retry ${attempt}`,
                    retryCount: attempt,
                });
            }
            return result;
        } catch (e) {
            lastError = e;

            if (attempt < maxRetries) {
                await emit('retry_triggered', {
                    workerName, clientSlug, supabaseClientId, customerNumber,
                    error: e.message,
                    retryCount: attempt + 1,
                });
                // Brief backoff before retry (500ms * attempt)
                await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
            }
        }
    }

    // All retries exhausted
    await emit('task_escalated', {
        workerName, clientSlug, supabaseClientId, customerNumber,
        error: lastError?.message || 'Unknown error',
        retryCount: maxRetries,
    });

    // Return fallback reply so the customer still gets a response
    return fallbackReply;
}

// ─── Critical system alert ────────────────────────────────────────────────────
// Use for unhandled errors, infrastructure failures, and ElevenLabs outages.
// Always fires Telegram regardless of event type.
// Never throws — critical alerts must not cause secondary failures.
async function sendCriticalAlert(source, errorMessage, context = {}) {
    const msg = [
        `*CRITICAL SYSTEM ALERT* 🔴`,
        `Source: \`${source}\``,
        `Error: ${errorMessage}`,
        context.clientId ? `Client: \`${context.clientId}\`` : null,
        context.workerName ? `Worker: \`${context.workerName}\`` : null,
        `Time: ${new Date().toISOString()}`,
    ].filter(Boolean).join('\n');

    try {
        await sendTelegramAlert(msg);
    } catch (e) {
        console.error('[events] sendCriticalAlert: Telegram delivery failed:', e.message);
    }

    console.error(`[CRITICAL] ${source}: ${errorMessage}`);
}

module.exports = { emit, withRetry, sendTelegramAlert, sendCriticalAlert };
