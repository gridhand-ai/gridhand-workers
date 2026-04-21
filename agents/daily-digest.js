/**
 * ── OG GRIDHAND AGENT (Original) ─────────────────────────────────────────────
 * Serves clients directly. Runs on Railway. Active 24/7.
 * ─────────────────────────────────────────────────────────────────────────────
 * daily-digest.js
 *
 * Sends MJ a morning briefing via Telegram at 9am CT (14:00 UTC).
 *
 * Covers the last 24 hours:
 *   - Tasks completed per client
 *   - Errors logged
 *   - Voice calls handled
 *   - Unread client notifications
 *
 * Railway cron schedule: DAILY_DIGEST_CRON=0 14 * * *
 *
 * Usage:
 *   node agents/daily-digest.js            — run immediately (used by cron)
 *   node agents/daily-digest.js --test     — run and force send even if no data
 */

const { createClient } = require('@supabase/supabase-js')
const { sendTelegramAlert } = require('../lib/events')

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
)

const WINDOW_HOURS = 24

async function runDailyDigest() {
    const args   = process.argv.slice(2)
    const isTest = args.includes('--test')

    const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString()

    console.log('[daily-digest] Pulling 24h snapshot from Supabase...')

    const [
        { data: activityRows,     error: actErr    },
        { data: callRows,         error: callErr   },
        { data: notifRows,        error: notifErr  },
        { data: clientRows,       error: clientErr },
    ] = await Promise.all([
        supabase
            .from('activity_log')
            .select('client_id, worker_name, message, created_at')
            .gte('created_at', since)
            .order('created_at', { ascending: false }),

        supabase
            .from('call_logs')
            .select('client_id, created_at, duration_seconds')
            .gte('created_at', since),

        supabase
            .from('notifications')
            .select('client_id, type, title, created_at')
            .eq('read', false)
            .gte('created_at', since),

        supabase
            .from('clients')
            .select('id, business_name'),
    ])

    if (actErr)    console.error('[daily-digest] activity_log error:', actErr.message)
    if (callErr)   console.error('[daily-digest] call_logs error:', callErr.message)
    if (notifErr)  console.error('[daily-digest] notifications error:', notifErr.message)
    if (clientErr) console.error('[daily-digest] clients error:', clientErr.message)

    // Build client name lookup
    const clientNames = {}
    for (const c of (clientRows || [])) {
        clientNames[c.id] = c.business_name || c.id.slice(0, 8)
    }

    // Aggregate tasks per client
    const tasksByClient = {}
    const errorsByClient = {}
    for (const row of (activityRows || [])) {
        const name = clientNames[row.client_id] || row.client_id?.slice(0, 8) || 'Unknown'
        const isError = /fail|error/i.test(row.message || '')
        if (isError) {
            errorsByClient[name] = (errorsByClient[name] || 0) + 1
        } else {
            tasksByClient[name] = (tasksByClient[name] || 0) + 1
        }
    }

    const totalTasks  = (activityRows || []).filter(r => !/fail|error/i.test(r.message || '')).length
    const totalErrors = (activityRows || []).filter(r => /fail|error/i.test(r.message || '')).length
    const totalCalls  = (callRows || []).length
    const totalUnread = (notifRows || []).length

    // Skip sending if absolutely no activity and not a test run
    if (!isTest && totalTasks === 0 && totalErrors === 0 && totalCalls === 0) {
        console.log('[daily-digest] No activity in last 24h — skipping digest')
        return { sent: false, reason: 'no activity' }
    }

    // Format the message
    const dateStr = new Date().toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        weekday: 'short', month: 'short', day: 'numeric',
    })

    const lines = [
        `*GRIDHAND Daily Digest* — ${dateStr}`,
        `_Last 24 hours_`,
        '',
        `Tasks completed: *${totalTasks}*`,
        `Errors: *${totalErrors}*`,
        `Voice calls handled: *${totalCalls}*`,
        `Unread client notifications: *${totalUnread}*`,
    ]

    // Per-client task breakdown (only clients with activity)
    const activeClients = Object.keys(tasksByClient)
    if (activeClients.length > 0) {
        lines.push('')
        lines.push('*By client:*')
        for (const name of activeClients.slice(0, 10)) {
            const tasks  = tasksByClient[name] || 0
            const errors = errorsByClient[name] || 0
            const errStr = errors > 0 ? ` (${errors} error${errors > 1 ? 's' : ''})` : ''
            lines.push(`  • ${name}: ${tasks} task${tasks !== 1 ? 's' : ''}${errStr}`)
        }
        if (activeClients.length > 10) {
            lines.push(`  _...and ${activeClients.length - 10} more_`)
        }
    }

    // Flag clients with errors only
    const errorOnlyClients = Object.keys(errorsByClient).filter(n => !tasksByClient[n])
    if (errorOnlyClients.length > 0) {
        lines.push('')
        lines.push('*Clients with errors only (no completions):*')
        for (const name of errorOnlyClients) {
            lines.push(`  🔴 ${name}: ${errorsByClient[name]} error(s)`)
        }
    }

    if (isTest) lines.push('\n_[test run]_')

    const message = lines.join('\n')
    console.log('[daily-digest] Sending Telegram digest...')
    await sendTelegramAlert(message)
    console.log('[daily-digest] Sent.')

    return { sent: true, totalTasks, totalErrors, totalCalls, totalUnread }
}

runDailyDigest().catch(async (err) => {
    console.error('[daily-digest] Fatal error:', err.message)
    await sendTelegramAlert(`*Daily Digest FAILED* 🔥\n\`${err.message}\``).catch(() => {})
    process.exit(1)
})

module.exports = { runDailyDigest }
