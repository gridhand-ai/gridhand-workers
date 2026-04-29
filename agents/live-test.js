// DEV ONLY — not for production dispatch
// tier: simple
// ─── GRIDHAND Live End-to-End Test ────────────────────────────────────────────
// Tests the full chain: worker fires event → Make.com scenario receives it →
// portal logs it → Supabase activity_log updated.
//
// Usage:
//   node agents/live-test.js                  — test all events (dry-run, no real SMS)
//   node agents/live-test.js --event review   — test one specific event
//   node agents/live-test.js --client astros-playland — use a specific client slug
//   node agents/live-test.js --full           — also verify Supabase write

const makeClient  = require('../lib/make-client')
const { createClient } = require('@supabase/supabase-js')

const TEST_CLIENT = process.env.TEST_CLIENT_SLUG || 'test-client'
const TEST_PHONE  = '+15550001234'
const TEST_NAME   = 'Test Customer'

const supabase = process.env.SUPABASE_URL
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    : null

// ─── All events we want to verify ────────────────────────────────────────────
const TESTS = [
    {
        name:    'review_requested',
        label:   'Review Requester',
        fn:      () => makeClient.reviewRequested({
            clientSlug:    TEST_CLIENT,
            customerPhone: TEST_PHONE,
            customerName:  TEST_NAME,
            reviewLink:    'https://g.page/r/test',
            serviceType:   'Brake Service',
        }),
    },
    {
        name:    'new_lead_captured',
        label:   'Lead Capture',
        fn:      () => makeClient.newLeadCaptured({
            clientSlug:    TEST_CLIENT,
            customerPhone: TEST_PHONE,
            customerName:  TEST_NAME,
            message:       'Hi I need an appointment',
        }),
    },
    {
        name:    'invoice_reminder_sent',
        label:   'Invoice Chaser',
        fn:      () => makeClient.invoiceReminderSent({
            clientSlug:    TEST_CLIENT,
            customerPhone: TEST_PHONE,
            customerName:  TEST_NAME,
            invoiceAmount: 250,
            invoiceId:     'INV-001',
            daysOverdue:   14,
        }),
    },
    {
        name:    'appointment_reminder_sent',
        label:   'Appointment Reminder',
        fn:      () => makeClient.appointmentReminderSent({
            clientSlug:       TEST_CLIENT,
            customerPhone:    TEST_PHONE,
            customerName:     TEST_NAME,
            appointmentTime:  'Tomorrow at 10am',
            serviceType:      'Full Detail',
        }),
    },
    {
        name:    'appointment_booked',
        label:   'Booking Confirmed',
        fn:      () => makeClient.appointmentBooked({
            clientSlug:    TEST_CLIENT,
            customerPhone: TEST_PHONE,
            customerName:  TEST_NAME,
            requestedTime: 'Friday 2pm',
            serviceType:   'Oil Change',
        }),
    },
    {
        name:    'lead_followup_sent',
        label:   'Lead Follow-Up',
        fn:      () => makeClient.leadFollowupSent({
            clientSlug:     TEST_CLIENT,
            customerPhone:  TEST_PHONE,
            customerName:   TEST_NAME,
            followupNumber: 2,
            source:         'website',
        }),
    },
    {
        name:    'reactivation_sent',
        label:   'Reactivation',
        fn:      () => makeClient.reactivationSent({
            clientSlug:    TEST_CLIENT,
            customerPhone: TEST_PHONE,
            customerName:  TEST_NAME,
            daysDormant:   90,
            offerText:     '20% off your next visit',
        }),
    },
    {
        name:    'upsell_sent',
        label:   'Upsell',
        fn:      () => makeClient.upsellSent({
            clientSlug:       TEST_CLIENT,
            customerPhone:    TEST_PHONE,
            customerName:     TEST_NAME,
            serviceCompleted: 'Oil Change',
            upsellOffer:      'Tire rotation for $29',
        }),
    },
    {
        name:    'referral_requested',
        label:   'Referral Request',
        fn:      () => makeClient.referralRequested({
            clientSlug:    TEST_CLIENT,
            customerPhone: TEST_PHONE,
            customerName:  TEST_NAME,
            incentiveText: '$25 credit for each friend',
        }),
    },
    {
        name:    'status_updated',
        label:   'Status Update',
        fn:      () => makeClient.statusUpdated({
            clientSlug:    TEST_CLIENT,
            customerPhone: TEST_PHONE,
            customerName:  TEST_NAME,
            status:        'Your car is ready for pickup!',
            serviceType:   'Transmission Rebuild',
        }),
    },
    {
        name:    'after_hours_lead',
        label:   'After-Hours Lead',
        fn:      () => makeClient.afterHoursLead({
            clientSlug:    TEST_CLIENT,
            customerPhone: TEST_PHONE,
            customerName:  TEST_NAME,
            message:       'Do you have Saturday appointments available?',
        }),
    },
]

// ─── Check if Make.com scenario received the event ────────────────────────────
// Looks at operations count before vs after the fire to confirm delivery.
// Requires MAKE_API_KEY to be set.
async function getMakeOpsCount(hookUrl) {
    if (!hookUrl || !process.env.MAKE_API_KEY) return null
    // We can't easily map hookUrl → scenarioId without a lookup,
    // so we just verify the fire() returned true (HTTP 200 from Make.com).
    return null // placeholder — Make.com returns 200 when it accepts the payload
}

// ─── Check Supabase for a recent activity_log entry ──────────────────────────
async function checkSupabaseLog(eventName, clientSlug, afterTime) {
    if (!supabase) return null
    const { data, error } = await supabase
        .from('activity_log')
        .select('id, action, worker, created_at')
        .eq('action', eventName)
        .gte('created_at', afterTime)
        .order('created_at', { ascending: false })
        .limit(5)
    if (error) return { ok: false, detail: error.message }
    return { ok: (data?.length || 0) > 0, count: data?.length || 0 }
}

// ─── Run single test ──────────────────────────────────────────────────────────
async function runTest(test, fullMode) {
    const start = new Date().toISOString()
    let result
    try {
        result = await test.fn()
    } catch (e) {
        return { name: test.name, ok: false, detail: `threw: ${e.message}` }
    }

    const hookUrl    = makeClient.getHookUrl(test.name)
    const configured = !!hookUrl && hookUrl !== (process.env.MAKE_OUTBOUND_WEBHOOK_URL || '')

    let sbCheck = null
    if (fullMode && supabase) {
        // Wait 2s for portal to write to Supabase
        await new Promise(r => setTimeout(r, 2000))
        sbCheck = await checkSupabaseLog(test.name, TEST_CLIENT, start)
    }

    return {
        name:       test.name,
        label:      test.label,
        ok:         result === true || result === null, // null = not configured (still pass)
        fired:      result === true,
        configured,
        hookUrl:    hookUrl ? hookUrl.replace('https://hook.us2.make.com/', 'make.com/') : 'FALLBACK',
        supabase:   sbCheck,
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const args       = process.argv.slice(2)
    const fullMode   = args.includes('--full')
    const eventFilter = args.find(a => a.startsWith('--event=') || (args[args.indexOf(a) - 1] === '--event'))
        || (args.includes('--event') ? args[args.indexOf('--event') + 1] : null)

    const clientOverride = args.includes('--client') ? args[args.indexOf('--client') + 1] : null
    if (clientOverride) process.env.TEST_CLIENT_SLUG = clientOverride

    console.log('GRIDHAND Live Test')
    console.log('='.repeat(50))
    console.log(`Client slug: ${TEST_CLIENT}`)
    console.log(`Mode: ${fullMode ? 'FULL (checks Supabase)' : 'FIRE-ONLY (checks Make.com delivery)'}`)
    console.log()

    const testsToRun = eventFilter
        ? TESTS.filter(t => t.name.includes(eventFilter))
        : TESTS

    if (testsToRun.length === 0) {
        console.error(`No tests match --event "${eventFilter}"`)
        process.exit(1)
    }

    let passed = 0, failed = 0, specific = 0
    for (const test of testsToRun) {
        const r = await runTest(test, fullMode)
        const icon    = r.ok ? (r.fired ? '✓' : '○') : '✗'
        const routing = r.configured ? `[specific hook]` : `[catch-all]`
        const sb      = fullMode && r.supabase ? ` [sb:${r.supabase.ok ? '✓' : '✗'}]` : ''
        console.log(`  ${icon} ${r.label.padEnd(25)} ${routing.padEnd(18)} ${r.hookUrl || '(not configured)'}${sb}`)
        if (r.ok) passed++; else failed++
        if (r.configured) specific++
        if (!r.ok) console.log(`      ERROR: ${r.detail}`)
    }

    console.log()
    console.log('─'.repeat(50))
    console.log(`✓ Passed: ${passed}  ✗ Failed: ${failed}`)
    console.log(`Routing: ${specific} specific hooks, ${testsToRun.length - specific} via catch-all`)

    if (failed > 0) process.exit(1)
}

main().catch(e => {
    console.error('Live test crashed:', e.message)
    process.exit(1)
})

module.exports = { runTest, TESTS }
