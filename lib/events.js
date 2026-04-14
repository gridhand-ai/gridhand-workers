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

// ─── Core event emitter ───────────────────────────────────────────────────────
async function emit(type, payload = {}) {
    const event = {
        type,
        timestamp: new Date().toISOString(),
        workerName: payload.workerName || 'unknown',
        clientSlug: payload.clientSlug || null,
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

    // Write to Supabase activity_log
    if (supabase && event.clientSlug) {
        try {
            await supabase.from('activity_log').insert({
                client_id: event.clientSlug,
                worker: event.workerName,
                action: type,
                result: event.summary || event.error || type,
                metadata: event,
                created_at: event.timestamp,
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
//   const result = await withRetry(() => doWork(), { workerName, clientSlug, maxRetries: 2 })
async function withRetry(fn, { workerName, clientSlug, customerNumber, maxRetries = 2, fallbackReply = null } = {}) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await fn();
            if (attempt > 0) {
                await emit('task_completed', {
                    workerName, clientSlug, customerNumber,
                    summary: `Succeeded on retry ${attempt}`,
                    retryCount: attempt,
                });
            }
            return result;
        } catch (e) {
            lastError = e;

            if (attempt < maxRetries) {
                await emit('retry_triggered', {
                    workerName, clientSlug, customerNumber,
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
        workerName, clientSlug, customerNumber,
        error: lastError?.message || 'Unknown error',
        retryCount: maxRetries,
    });

    // Return fallback reply so the customer still gets a response
    return fallbackReply;
}

module.exports = { emit, withRetry, sendTelegramAlert };
