// ─── Build + update all GRIDHAND Make.com scenarios ───────────────────────────
// 1. Creates 3 missing scenarios (Appointment Booked, Referral, Status Updated)
// 2. Updates ALL existing scenarios so they accept worker events (clientSlug)
//    and forward full structured data to the portal webhook handler
// 3. Prints all new hook URLs so we can add them to Railway
//
// Usage: MAKE_API_KEY=xxx MAKE_TEAM_ID=xxx node scripts/build-scenarios.js

const MAKE_API_KEY = process.env.MAKE_API_KEY || '3be2c88b-3038-4511-b92d-f92e05f641d7'
const MAKE_TEAM_ID = process.env.MAKE_TEAM_ID || '2044683'
const MAKE_ZONE    = process.env.MAKE_ZONE    || 'us2'
const BASE_URL     = `https://${MAKE_ZONE}.make.com/api/v2`
const PORTAL_URL   = 'https://gridhand-portal.vercel.app/api/make/webhook'
const SECRET       = 'gridhand-make-2026'

async function api(method, path, body) {
    const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
            'Authorization': `Token ${MAKE_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    })
    return res.json()
}

// ─── Blueprint factory ────────────────────────────────────────────────────────
// Builds a 2-module blueprint: WebHook → HTTP forward to portal
// hookId: existing Make.com hook ID (from the scenario's webhook trigger)
// scenarioType: the scenario_type value sent to portal
function makeBlueprint(hookId, scenarioType, hookLabel) {
    return {
        flow: [
            {
                id: 1,
                mapper: {},
                module: 'gateway:CustomWebHook',
                version: 1,
                parameters: { hook: hookId, maxResults: 1 },
                metadata: {
                    restore: {
                        parameters: {
                            hook: { data: { editable: 'true' }, label: hookLabel },
                        },
                    },
                    designer: { x: 0, y: 0 },
                    parameters: [
                        { name: 'hook', type: 'hook:gateway-webhook', label: 'Webhook', required: true },
                        { name: 'maxResults', type: 'number', label: 'Maximum number of results' },
                    ],
                },
            },
            {
                id: 2,
                mapper: {
                    qs: [],
                    url: PORTAL_URL,
                    data: `{"client_id": "{{1.client_id}}", "client_slug": "{{1.clientSlug}}", "scenario_type": "${scenarioType}", "trigger_source": "{{1.trigger_source}}", "worker_name": "{{1.workerName}}", "trigger_data": {{toJSON(1)}}, "make_secret": "${SECRET}"}`,
                    method: 'POST',
                    headers: [],
                    timeout: '30',
                    useMtls: false,
                    bodyType: 'raw',
                    contentType: 'application/json',
                    shareCookies: false,
                    parseResponse: true,
                    followRedirect: true,
                    rejectUnauthorized: true,
                },
                module: 'http:ActionSendData',
                version: 3,
                metadata: { designer: { x: 300, y: 0 } },
                parameters: { handleErrors: false },
            },
        ],
        metadata: {
            zone: MAKE_ZONE,
            instant: true,
            version: 1,
            designer: { orphans: [] },
            scenario: {
                dlq: true,
                dataloss: false,
                maxErrors: 1000,
                autoCommit: true,
                roundtrips: 1,
                sequential: false,
                confidential: false,
                freshVariables: false,
                autoCommitTriggerLast: true,
            },
        },
    }
}

// ─── Create a new scenario with its own webhook ───────────────────────────────
async function createScenario(name, scenarioType) {
    console.log(`\nCreating: ${name}`)

    // Step 1: create a new webhook hook
    const hookRes = await api('POST', `/hooks`, {
        name: `${name} Hook`,
        teamId: parseInt(MAKE_TEAM_ID),
        typeName: 'gateway-webhook',
    })
    const hookId = hookRes.hook?.id
    if (!hookId) {
        console.error(`  ✗ Failed to create hook:`, JSON.stringify(hookRes))
        return null
    }
    console.log(`  ✓ Hook created: ${hookId}`)

    // Step 2: create the scenario with the blueprint
    const blueprint = makeBlueprint(hookId, scenarioType, name)
    const scenarioRes = await api('POST', `/scenarios?teamId=${MAKE_TEAM_ID}`, {
        blueprint: JSON.stringify({
            ...blueprint,
            name,
        }),
        scheduling: { type: 'immediately' },
    })

    const scenarioId = scenarioRes.scenario?.id
    if (!scenarioId) {
        console.error(`  ✗ Failed to create scenario:`, JSON.stringify(scenarioRes).slice(0, 200))
        return null
    }
    console.log(`  ✓ Scenario created: ${scenarioId}`)

    // Step 3: get the webhook URL
    const hookDetail = await api('GET', `/hooks/${hookId}`)
    const webhookUrl = hookDetail.hook?.url || `https://hook.${MAKE_ZONE}.make.com/${hookDetail.hook?.name}`
    console.log(`  ✓ Hook URL: ${webhookUrl}`)

    return { scenarioId, hookId, webhookUrl, name, scenarioType }
}

// ─── Update an existing scenario blueprint ────────────────────────────────────
async function updateScenario(scenarioId, hookId, scenarioType, name) {
    console.log(`\nUpdating: ${name} (${scenarioId})`)

    const blueprint = makeBlueprint(hookId, scenarioType, name)
    const res = await api('PATCH', `/scenarios/${scenarioId}`, {
        blueprint: JSON.stringify({ ...blueprint, name }),
    })

    if (res.scenario) {
        console.log(`  ✓ Updated`)
        return true
    }
    console.error(`  ✗ Failed:`, JSON.stringify(res).slice(0, 200))
    return false
}

// ─── Get existing hook URL ────────────────────────────────────────────────────
async function getHookUrl(hookId) {
    const res = await api('GET', `/hooks/${hookId}`)
    return res.hook?.url || null
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('GRIDHAND Scenario Builder')
    console.log('='.repeat(50))

    // Existing scenarios to update
    const existing = [
        { id: 4569962, hookId: 2083848, type: 'review_pipeline',          name: 'GRIDHAND — Review Pipeline' },
        { id: 4680543, hookId: 2132764, type: 'lead_speed',               name: 'GRIDHAND — Lead Speed-to-Contact' },
        { id: 4569964, hookId: 2083850, type: 'invoice_chaser',           name: 'GRIDHAND — Invoice Chaser' },
        { id: 4569965, hookId: 2083851, type: 'appointment_reminder',     name: 'GRIDHAND — Appointment Reminder' },
        { id: 4569969, hookId: 2083854, type: 'lead_nurture',             name: 'GRIDHAND — Lead Nurture' },
        { id: 4569963, hookId: 2083849, type: 'missed_call',              name: 'GRIDHAND — Missed Call' },
        { id: 4569967, hookId: 2083852, type: 'reactivation',             name: 'GRIDHAND — Reactivation' },
        { id: 4680546, hookId: 2132767, type: 'repair_ready',             name: 'GRIDHAND — Repair Order Ready' },
        { id: 4680537, hookId: 2132761, type: 'dunning_recovery',         name: 'GRIDHAND — Dunning Recovery' },
        { id: 4680545, hookId: 2132766, type: 'no_show',                  name: 'GRIDHAND — No-Show Re-Engagement' },
        { id: 4680544, hookId: 2132765, type: 'review_response',          name: 'GRIDHAND — Review Response Bot' },
        { id: 4569968, hookId: 2083853, type: 'upsell',                   name: 'GRIDHAND — Upsell' },
    ]

    // Update all existing scenarios
    console.log('\n=== Updating existing scenarios ===')
    const existingHookUrls = {}
    for (const s of existing) {
        await updateScenario(s.id, s.hookId, s.type, s.name)
        const url = await getHookUrl(s.hookId)
        existingHookUrls[s.type] = url
    }

    // Create 3 new scenarios
    console.log('\n=== Creating new scenarios ===')
    const newScenarios = [
        { name: 'GRIDHAND — Appointment Booked',  type: 'appointment_booked' },
        { name: 'GRIDHAND — Referral Requested',  type: 'referral_requested' },
        { name: 'GRIDHAND — Status Updated',       type: 'status_updated' },
    ]

    const newResults = {}
    for (const s of newScenarios) {
        const result = await createScenario(s.name, s.type)
        if (result) newResults[s.type] = result
    }

    // Build final mapping
    const allHooks = {
        // Existing
        MAKE_HOOK_REVIEW_PIPELINE:        existingHookUrls['review_pipeline'],
        MAKE_HOOK_LEAD_SPEED:             existingHookUrls['lead_speed'],
        MAKE_HOOK_INVOICE_CHASER:         existingHookUrls['invoice_chaser'],
        MAKE_HOOK_APPOINTMENT_REMINDER:   existingHookUrls['appointment_reminder'],
        MAKE_HOOK_LEAD_NURTURE:           existingHookUrls['lead_nurture'],
        MAKE_HOOK_MISSED_CALL:            existingHookUrls['missed_call'],
        MAKE_HOOK_REACTIVATION:           existingHookUrls['reactivation'],
        MAKE_HOOK_REPAIR_READY:           existingHookUrls['repair_ready'],
        MAKE_HOOK_DUNNING_RECOVERY:       existingHookUrls['dunning_recovery'],
        MAKE_HOOK_NO_SHOW:                existingHookUrls['no_show'],
        MAKE_HOOK_REVIEW_RESPONSE:        existingHookUrls['review_response'],
        MAKE_HOOK_UPSELL:                 existingHookUrls['upsell'],
        // New
        MAKE_HOOK_APPOINTMENT_BOOKED:     newResults['appointment_booked']?.webhookUrl,
        MAKE_HOOK_REFERRAL:               newResults['referral_requested']?.webhookUrl,
        MAKE_HOOK_STATUS_UPDATED:         newResults['status_updated']?.webhookUrl,
    }

    console.log('\n=== All hook URLs (add to Railway) ===')
    for (const [key, val] of Object.entries(allHooks)) {
        console.log(`${key}=${val || 'MISSING'}`)
    }

    // Write env file for Railway
    const fs = require('fs')
    const envLines = Object.entries(allHooks)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    fs.writeFileSync('/tmp/make-hooks.env', envLines)
    console.log('\n✓ Hook URLs saved to /tmp/make-hooks.env')
    console.log('\nRun: cat /tmp/make-hooks.env | while IFS=\'=\' read k v; do railway variables --set "$k=$v"; done')
}

main().catch(e => {
    console.error('FATAL:', e.message)
    process.exit(1)
})
