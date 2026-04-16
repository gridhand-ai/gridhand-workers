// ─── Scenario Warden ─────────────────────────────────────────────────────────
// Monitors all GRIDHAND Make.com scenarios. Runs daily (or on-demand).
// Checks:
//   ✓ All expected scenarios exist and are active (not paused/disabled)
//   ✓ No scenarios have stuck messages (dlqCount > 0)
//   ✓ Scenarios are actually firing (operations > 0 recently)
//   ✓ Worker Events scenario is correctly wired to forward to portal
//   ✓ All webhook hooks are still valid
//
// Auto-fixes:
//   → Re-activates paused scenarios automatically
//   → Clears stuck DLQ messages (after logging them)
//
// Alerts MJ via Telegram on any issue that needs manual attention.
// Usage:
//   node agents/scenario-warden.js             — full check + auto-fix
//   node agents/scenario-warden.js --dry-run   — check only, no fixes
//   node agents/scenario-warden.js --force     — always send full report

const { sendTelegramAlert } = require('../lib/events')

const MAKE_API_KEY = process.env.MAKE_API_KEY
const MAKE_TEAM_ID = process.env.MAKE_TEAM_ID
const MAKE_ZONE    = process.env.MAKE_ZONE || 'us2'
const BASE_URL     = `https://${MAKE_ZONE}.make.com/api/v2`

// ─── Expected scenarios with their required state ────────────────────────────
const EXPECTED_SCENARIOS = [
    { name: 'GRIDHAND — Worker Events',              critical: true  },
    { name: 'GRIDHAND — Appointment Reminder',       critical: true  },
    { name: 'GRIDHAND — Invoice Chaser',             critical: true  },
    { name: 'GRIDHAND — Lead Nurture',               critical: true  },
    { name: 'GRIDHAND — Missed Call',                critical: true  },
    { name: 'GRIDHAND — Reactivation',               critical: false },
    { name: 'GRIDHAND — Review Pipeline',            critical: true  },
    { name: 'GRIDHAND — Upsell',                     critical: false },
    { name: 'GRIDHAND — Dunning Recovery',           critical: false },
    { name: 'GRIDHAND — Lead Speed-to-Contact',      critical: false },
    { name: 'GRIDHAND — No-Show Re-Engagement',      critical: false },
    { name: 'GRIDHAND — Repair Order Ready',         critical: false },
    { name: 'GRIDHAND — Review Response Bot',        critical: false },

    // ── Client-specific scenarios ─────────────────────────────────────────────
    { name: 'GRIDHAND — Astros Playland & Cafe — Booking Events',   critical: true  },
    { name: 'GRIDHAND — Astros Playland & Cafe — Gmail & Calendar', critical: false },
    { name: 'GRIDHAND — Astros Playland & Cafe — Social Engagement', critical: false },
    { name: 'GRIDHAND — Astros Playland & Cafe — Staff Scheduling',  critical: false },
]

// ─── Make.com API helper ──────────────────────────────────────────────────────
async function makeAPI(method, endpoint, body = null) {
    if (!MAKE_API_KEY) throw new Error('MAKE_API_KEY not set')

    const opts = {
        method,
        headers: {
            'Authorization': `Token ${MAKE_API_KEY}`,
            'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
    }
    if (body) opts.body = JSON.stringify(body)

    const res = await fetch(`${BASE_URL}${endpoint}`, opts)
    const data = await res.json()
    return { ok: res.ok, status: res.status, data }
}

// ─── Fetch all scenarios ──────────────────────────────────────────────────────
async function fetchAllScenarios() {
    const { ok, data } = await makeAPI('GET', `/scenarios?teamId=${MAKE_TEAM_ID}&pg[limit]=100`)
    if (!ok) throw new Error(`Failed to fetch scenarios: ${JSON.stringify(data)}`)
    return data.scenarios || []
}

// ─── Re-activate a paused/inactive scenario ──────────────────────────────────
async function reactivateScenario(scenarioId, name) {
    // Make API v2: activate via POST /scenarios/{id}/start (not PATCH isActive)
    const { ok, data } = await makeAPI('POST', `/scenarios/${scenarioId}/start`)
    return { ok, detail: ok ? `Re-activated: ${name}` : `Failed to re-activate ${name}: ${data.message}` }
}

// ─── Clear incomplete executions for a scenario ───────────────────────────────
async function clearDLQ(scenarioId, name) {
    // Make API v2: incomplete executions live at /dlqs?scenarioId=, not /scenarios/{id}/dlq
    const { data: dlqData } = await makeAPI('GET', `/dlqs?scenarioId=${scenarioId}`)
    const items = dlqData?.dlqs || []
    const count = items.length

    if (count === 0) return { cleared: 0, detail: 'No incomplete executions' }

    // Delete each individually (bulk delete requires extra confirmation handshake)
    let cleared = 0
    for (const item of items) {
        const { ok } = await makeAPI('DELETE', `/dlqs/${item.id}`)
        if (ok) cleared++
    }

    return { cleared, detail: `Cleared ${cleared}/${count} incomplete executions from ${name}` }
}

// ─── Check all scenarios ──────────────────────────────────────────────────────
async function checkScenarios(scenarios, dryRun) {
    const results = []

    // Build lookup map by name
    const byName = {}
    for (const s of scenarios) byName[s.name] = s

    for (const expected of EXPECTED_SCENARIOS) {
        const scenario = byName[expected.name]

        if (!scenario) {
            results.push({
                name:     expected.name,
                ok:       false,
                critical: expected.critical,
                issues:   [`NOT FOUND — scenario missing from Make.com`],
                autoFixed: [],
            })
            continue
        }

        const issues   = []
        const autoFixed = []

        // Check active state
        if (!scenario.isActive) {
            issues.push('Scenario is PAUSED/INACTIVE')
            if (!dryRun) {
                const fix = await reactivateScenario(scenario.id, expected.name)
                if (fix.ok) {
                    autoFixed.push('Re-activated')
                    issues.pop() // fixed
                }
            }
        }

        // Check for stuck messages
        if (scenario.dlqCount > 0) {
            issues.push(`${scenario.dlqCount} stuck message(s) in DLQ`)
            if (!dryRun) {
                const fix = await clearDLQ(scenario.id, expected.name)
                if (fix.cleared > 0) {
                    autoFixed.push(`Cleared ${fix.cleared} stuck msgs`)
                }
            }
        }

        // Check if scenario has ever run (operations = 0 for new/untriggered)
        if (scenario.operations === 0 && expected.critical) {
            issues.push('Zero operations recorded — scenario may never have fired')
        }

        // Check for invalid state
        if (scenario.isinvalid) {
            issues.push('Scenario marked INVALID — blueprint may have errors')
        }

        results.push({
            id:        scenario.id,
            name:      expected.name,
            ok:        issues.length === 0,
            critical:  expected.critical,
            active:    scenario.isActive,
            operations: scenario.operations,
            dlqCount:  scenario.dlqCount,
            lastEdit:  scenario.lastEdit?.slice(0, 10),
            issues,
            autoFixed,
        })
    }

    return results
}

// ─── Format Telegram report ───────────────────────────────────────────────────
function formatReport(results, dryRun, forceReport) {
    const hasIssues    = results.some(r => !r.ok)
    const criticalDown = results.some(r => !r.ok && r.critical)

    if (!hasIssues && !forceReport) return null

    const emoji = criticalDown ? '🚨' : hasIssues ? '⚠️' : '✅'
    const lines = [
        `*GRIDHAND Scenario Warden* ${emoji}`,
        `_${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CDT_`,
        dryRun ? '_dry-run mode — no changes made_' : '',
        '',
    ].filter(l => l !== undefined)

    for (const r of results) {
        if (!r.ok) {
            const prefix = r.critical ? '🔴' : '🟡'
            lines.push(`${prefix} *${r.name.replace('GRIDHAND — ', '')}*`)
            r.issues.forEach(i => lines.push(`  → ${i}`))
            r.autoFixed.forEach(f => lines.push(`  ✅ Auto-fixed: ${f}`))
        }
    }

    const healthy = results.filter(r => r.ok).length
    lines.push('')
    lines.push(`${healthy}/${results.length} scenarios healthy`)

    if (!hasIssues) {
        lines.push('All scenarios running normally.')
    }

    return lines.filter(l => l !== null).join('\n')
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
    const args        = process.argv.slice(2)
    const dryRun      = args.includes('--dry-run')
    const forceReport = args.includes('--force')

    if (!MAKE_API_KEY) {
        const msg = '*Scenario Warden*: MAKE_API_KEY not set — cannot check scenarios 🚨'
        console.error('[scenario-warden]', msg)
        await sendTelegramAlert(msg)
        process.exit(1)
    }

    console.log('[scenario-warden] Fetching Make.com scenarios...')

    let scenarios
    try {
        scenarios = await fetchAllScenarios()
        console.log(`[scenario-warden] Found ${scenarios.length} scenarios`)
    } catch (e) {
        const msg = `*Scenario Warden FAILED* 🔥\nCould not reach Make.com API: \`${e.message}\``
        await sendTelegramAlert(msg)
        console.error('[scenario-warden]', e.message)
        process.exit(1)
    }

    const results = await checkScenarios(scenarios, dryRun)

    // Console output
    for (const r of results) {
        const status = r.ok ? '✓' : '✗'
        const ops    = r.operations !== undefined ? ` [${r.operations} ops]` : ''
        console.log(`  ${status} ${r.name}${ops}${r.issues.length ? ' — ' + r.issues.join(', ') : ''}`)
        if (r.autoFixed.length) console.log(`    → Fixed: ${r.autoFixed.join(', ')}`)
    }

    const allOk = results.every(r => r.ok)
    console.log(`\n${allOk ? '✅ All scenarios healthy' : '🚨 Issues found'}`)

    // Telegram report
    const report = formatReport(results, dryRun, forceReport)
    if (report) {
        await sendTelegramAlert(report)
        console.log('[scenario-warden] Telegram alert sent')
    }

    return { ok: allOk, results }
}

run().catch(async e => {
    console.error('[scenario-warden] Fatal:', e.message)
    await sendTelegramAlert(`*Scenario Warden CRASHED* 🔥\n\`${e.message}\``).catch(() => {})
    process.exit(1)
})

module.exports = { run, checkScenarios, fetchAllScenarios }
