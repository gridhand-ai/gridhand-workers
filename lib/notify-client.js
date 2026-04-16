/**
 * notify-client.js
 *
 * Sends a notification to a client via the portal API.
 * Used by all workers to notify clients of task completions, errors, etc.
 *
 * Fire-and-forget — never throws. Failures are logged but never bubble up
 * into the SMS response path.
 */

const PORTAL_URL = process.env.PORTAL_URL || 'https://gridhand.ai'
const WORKERS_API_SECRET = process.env.WORKERS_API_SECRET

/**
 * @param {object} opts
 * @param {string} opts.clientId  — Supabase client UUID
 * @param {string} opts.type      — notification type: worker_task | message | commander | call | alert | review | make_error | info
 * @param {string} opts.title     — short title (required)
 * @param {string} [opts.body]    — optional longer body text
 * @param {object} [opts.metadata] — optional JSON metadata
 */
async function notifyClient({ clientId, type, title, body, metadata = {} }) {
    if (!clientId) return
    if (!WORKERS_API_SECRET) {
        console.warn('[notify-client] WORKERS_API_SECRET not set — skipping notification')
        return
    }

    try {
        const res = await fetch(`${PORTAL_URL}/api/notifications/worker`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WORKERS_API_SECRET}`,
            },
            body: JSON.stringify({ clientId, type, title, body, metadata }),
        })
        if (!res.ok) {
            console.error(`[notify-client] Portal returned ${res.status} for clientId=${clientId}`)
        }
    } catch (err) {
        console.error('[notify-client] Failed:', err.message)
        // Fire and forget — never throw
    }
}

module.exports = { notifyClient }
