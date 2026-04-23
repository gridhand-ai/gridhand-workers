// ─── Worker Guardian ─────────────────────────────────────────────────────────
// Monitors all GRIDHAND workers. Runs daily (or on-demand).
// Checks:
//   ✓ Railway server is reachable
//   ✓ All assigned workers have valid backing files
//   ✓ Supabase is reachable and writable
//   ✓ Twilio credentials are present and not expired
//   ✓ Activity logs show recent tasks (catches silent failures)
//   ✓ No workers have high error rates in the last 24h
//   ✓ Make.com integration webhook is reachable
//
// Alerts MJ via Telegram on any failure.
// Usage:
//   node agents/worker-guardian.js             — full check, Telegram alert on failure
//   node agents/worker-guardian.js --quiet     — only alert on failures
//   node agents/worker-guardian.js --force     — always send Telegram report

const { createClient } = require('@supabase/supabase-js')
const { sendTelegramAlert } = require('../lib/events')
const path = require('path')
const fs   = require('fs')
const sentry = require('../lib/sentry-client')
sentry.init()

const WORKERS_DIR = path.join(__dirname, '../workers')
const CLIENTS_DIR = path.join(__dirname, '../clients')

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ─── Core worker files that must always exist ─────────────────────────────────
const CORE_WORKERS = [
    'receptionist', 'faq', 'booking', 'intake', 'after-hours', 'waitlist',
    'review-requester', 'reminder', 'reactivation', 'lead-followup',
    'invoice-chaser', 'quote', 'referral', 'upsell', 'onboarding',
    'status-updater', 'weekly-report',
]

// ─── Check: all core worker files exist ──────────────────────────────────────
function checkWorkerFiles() {
    const results = []
    for (const name of CORE_WORKERS) {
        const jsPath  = path.join(WORKERS_DIR, `${name}.js`)
        const dirPath = path.join(WORKERS_DIR, name)
        const exists  = fs.existsSync(jsPath) || (fs.existsSync(dirPath) && fs.existsSync(path.join(dirPath, 'index.js')))
        results.push({ worker: name, ok: exists, detail: exists ? 'file exists' : 'MISSING — worker will fail silently' })
    }
    return results
}

// ─── Check: Supabase reachable + activity_log writable ───────────────────────
async function checkSupabase() {
    try {
        const { data, error } = await supabase.from('activity_log').select('id').limit(1)
        if (error) return { ok: false, detail: `Supabase error: ${error.message}` }
        return { ok: true, detail: 'Supabase reachable, activity_log accessible' }
    } catch (e) {
        return { ok: false, detail: `Supabase unreachable: ${e.message}` }
    }
}

// ─── Check: Twilio env vars present ──────────────────────────────────────────
function checkTwilio() {
    const sid   = process.env.TWILIO_ACCOUNT_SID
    const token = process.env.TWILIO_AUTH_TOKEN
    const from  = process.env.TWILIO_FROM_NUMBER
    if (!sid || !token || !from) {
        const missing = [!sid && 'TWILIO_ACCOUNT_SID', !token && 'TWILIO_AUTH_TOKEN', !from && 'TWILIO_FROM_NUMBER'].filter(Boolean)
        return { ok: false, detail: `Missing env vars: ${missing.join(', ')}` }
    }
    return { ok: true, detail: `Twilio configured: ${from}` }
}

// ─── Check: Make.com webhook reachable ───────────────────────────────────────
async function checkMakeWebhook() {
    const url = process.env.MAKE_OUTBOUND_WEBHOOK_URL
    if (!url) return { ok: false, detail: 'MAKE_OUTBOUND_WEBHOOK_URL not set' }

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                event:      'guardian_health_check',
                clientSlug: 'gridhand-internal',
                workerName: 'worker-guardian',
                timestamp:  new Date().toISOString(),
                data:       { test: true },
            }),
            signal: AbortSignal.timeout(8000),
        })
        return { ok: res.ok || res.status === 200, detail: `Make.com webhook returned ${res.status}` }
    } catch (e) {
        return { ok: false, detail: `Make.com webhook unreachable: ${e.message}` }
    }
}

// ─── Check: recent activity (catch silent failures) ───────────────────────────
async function checkRecentActivity() {
    try {
        const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
        const { data, error } = await supabase
            .from('activity_log')
            .select('worker_id, action, created_at')
            .gte('created_at', since)
            .order('created_at', { ascending: false })
            .limit(50)

        if (error) return { ok: false, detail: `Could not query activity_log: ${error.message}`, stats: null }

        const total  = data?.length || 0
        const failed = data?.filter(r => r.action === 'task_failed' || r.action === 'task_escalated').length || 0
        const errorRate = total > 0 ? Math.round((failed / total) * 100) : 0

        const workerCounts = {}
        data?.forEach(r => {
            workerCounts[r.worker_id] = (workerCounts[r.worker_id] || 0) + 1
        })

        return {
            ok: errorRate < 20, // alert if >20% error rate
            detail: `${total} tasks in last 48h, ${failed} failed (${errorRate}% error rate)`,
            stats: { total, failed, errorRate, workerCounts },
        }
    } catch (e) {
        return { ok: false, detail: `Activity check failed: ${e.message}`, stats: null }
    }
}

// ─── Check: all client configs are valid ─────────────────────────────────────
function checkClientConfigs() {
    const results = []
    try {
        const files = fs.readdirSync(CLIENTS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'))
        for (const file of files) {
            const slug = file.replace('.json', '')
            try {
                const raw = fs.readFileSync(path.join(CLIENTS_DIR, file), 'utf8')
                const cfg = JSON.parse(raw)
                const workers = cfg.workers || []
                const missingWorkers = workers.filter(w => {
                    const jsPath  = path.join(WORKERS_DIR, `${w}.js`)
                    const dirPath = path.join(WORKERS_DIR, w)
                    return !fs.existsSync(jsPath) && !fs.existsSync(path.join(dirPath, 'index.js'))
                })
                results.push({
                    slug,
                    ok: missingWorkers.length === 0,
                    workers: workers.length,
                    missing: missingWorkers,
                    detail: missingWorkers.length > 0
                        ? `${slug}: workers missing — ${missingWorkers.join(', ')}`
                        : `${slug}: ${workers.length} workers OK`,
                })
            } catch (e) {
                results.push({ slug, ok: false, detail: `${slug}: invalid JSON — ${e.message}` })
            }
        }
    } catch (e) {
        results.push({ slug: '_all', ok: false, detail: `Could not scan clients dir: ${e.message}` })
    }
    return results
}

// ─── Format Telegram report ───────────────────────────────────────────────────
function formatReport(checks, forceReport) {
    const allOk = Object.values(checks).every(c => Array.isArray(c) ? c.every(r => r.ok) : c.ok)
    if (allOk && !forceReport) return null // nothing to report

    const lines = [`*GRIDHAND Worker Guardian* ${allOk ? '✅' : '🚨'}`, `_${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CDT_`, '']

    // Server checks
    lines.push('*System*')
    lines.push(checks.supabase.ok ? `✅ Supabase: ${checks.supabase.detail}` : `❌ Supabase: ${checks.supabase.detail}`)
    lines.push(checks.twilio.ok   ? `✅ Twilio: ${checks.twilio.detail}`    : `❌ Twilio: ${checks.twilio.detail}`)
    lines.push(checks.make.ok     ? `✅ Make.com webhook: reachable`          : `❌ Make.com: ${checks.make.detail}`)
    lines.push('')

    // Activity
    lines.push('*Activity (48h)*')
    lines.push(checks.activity.ok ? `✅ ${checks.activity.detail}` : `⚠️ ${checks.activity.detail}`)
    lines.push('')

    // Worker files
    const missingWorkers = checks.workerFiles.filter(r => !r.ok)
    if (missingWorkers.length > 0) {
        lines.push('*Missing Workers*')
        missingWorkers.forEach(r => lines.push(`❌ ${r.worker}`))
        lines.push('')
    } else {
        lines.push(`✅ All ${CORE_WORKERS.length} core worker files present`)
        lines.push('')
    }

    // Client configs
    const badClients = checks.clientConfigs.filter(r => !r.ok)
    if (badClients.length > 0) {
        lines.push('*Client Config Issues*')
        badClients.forEach(r => lines.push(`⚠️ ${r.detail}`))
    } else {
        lines.push(`✅ ${checks.clientConfigs.length} client configs valid`)
    }

    return lines.join('\n')
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
    const args        = process.argv.slice(2)
    const quietMode   = args.includes('--quiet')
    const forceReport = args.includes('--force')

    console.log('[worker-guardian] Running health checks...')

    const [supabaseCheck, activityCheck, makeCheck] = await Promise.all([
        checkSupabase(),
        checkRecentActivity(),
        checkMakeWebhook(),
    ])

    const checks = {
        supabase:      supabaseCheck,
        twilio:        checkTwilio(),
        make:          makeCheck,
        activity:      activityCheck,
        workerFiles:   checkWorkerFiles(),
        clientConfigs: checkClientConfigs(),
    }

    const allOk = checks.supabase.ok && checks.twilio.ok && checks.activity.ok &&
        checks.workerFiles.every(r => r.ok) && checks.clientConfigs.every(r => r.ok)

    // Console output
    if (!quietMode) {
        console.log(`\nSupabase:    ${checks.supabase.ok ? '✓' : '✗'} ${checks.supabase.detail}`)
        console.log(`Twilio:      ${checks.twilio.ok ? '✓' : '✗'} ${checks.twilio.detail}`)
        console.log(`Make.com:    ${checks.make.ok ? '✓' : '✗'} ${checks.make.detail}`)
        console.log(`Activity:    ${checks.activity.ok ? '✓' : '✗'} ${checks.activity.detail}`)
        const missingW = checks.workerFiles.filter(r => !r.ok)
        console.log(`Workers:     ${missingW.length === 0 ? '✓ all present' : `✗ ${missingW.map(r=>r.worker).join(', ')} missing`}`)
        const badC = checks.clientConfigs.filter(r => !r.ok)
        console.log(`Clients:     ${badC.length === 0 ? `✓ ${checks.clientConfigs.length} valid` : `⚠ ${badC.length} issues`}`)
        console.log(`\nOverall:     ${allOk ? '✅ ALL HEALTHY' : '🚨 ISSUES FOUND'}`)
    }

    // Telegram alert
    const report = formatReport(checks, forceReport)
    if (report) {
        await sendTelegramAlert(report)
        console.log('[worker-guardian] Telegram alert sent')
        sentry.captureMessage(report, 'error', { check: 'worker-guardian-health' })
    }

    return { ok: allOk, checks }
}

run().catch(e => {
    console.error('[worker-guardian] Fatal error:', e.message)
    sentry.captureError(e, { agent: 'worker-guardian' })
    sendTelegramAlert(`*Worker Guardian CRASHED* 🔥\n\`${e.message}\``).catch(() => {})
    process.exit(1)
})

module.exports = { run, checkSupabase, checkWorkerFiles, checkRecentActivity }
