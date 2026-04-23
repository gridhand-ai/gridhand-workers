'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// UpsellTimer — Identifies perfect upsell moments: post-review, post-milestone, 90-day mark
// Division: revenue
// Reports to: revenue-director
// Runs: on-demand (called by RevenueDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient = require('../../lib/ai-client')
const { sendSMS } = require('../../lib/twilio-client')
const { validateSMS } = require('../../lib/message-gate')
const { fileInteraction } = require('../../lib/memory-client')
const vault = require('../../lib/memory-vault')

const AGENT_ID  = 'upsell-timer'
const DIVISION  = 'revenue'
const REPORTS_TO = 'revenue-director'

// Don't upsell a customer who was upselled in the last 90 days
const UPSELL_COOLDOWN_DAYS = 90

// Real GRIDHAND plan catalog — prevents Groq hallucinating plan names
const PLAN_CATALOG = {
  free: {
    name: 'Free',
    price: 0,
    nextPlan: 'Starter',
    nextPrice: 197,
    upgrade: 'Starter plan ($197/mo) — unlocks 12 workers including booking, lead follow-up, reminders, and invoice chasing',
  },
  starter: {
    name: 'Starter',
    price: 197,
    nextPlan: 'Growth',
    nextPrice: 347,
    upgrade: 'Growth plan ($347/mo) — adds lead qualifier, chat-to-lead, reputation monitor, and status updater',
  },
  growth: {
    name: 'Growth',
    price: 347,
    nextPlan: 'Command',
    nextPrice: 497,
    upgrade: 'Command plan ($497/mo) — full AI workforce, all 30 workers, priority support',
  },
  command: {
    name: 'Command',
    price: 497,
    nextPlan: null,
    nextPrice: null,
    upgrade: null,
  },
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

async function run(clients = []) {
  console.log(`[${AGENT_ID.toUpperCase()}] Starting run — ${clients.length} clients`)
  const reports = []

  for (const client of clients) {
    try {
      const result = await processClient(client)
      if (result) reports.push(result)
    } catch (err) {
      console.error(`[${AGENT_ID}] Error for client ${client.id}:`, err.message)
    }
  }

  const specialistReport = await report(reports)
  await fileInteraction(specialistReport, {
    workerId: AGENT_ID,
    interactionType: 'specialist_run',
  }).catch(() => {})
  // Store upsell readiness triggers per client into shared vault
  for (const r of reports) {
    if (r.clientId) {
      await vault.store(r.clientId, vault.KEYS.UPSELL_TRIGGERS, {
        offerSent: r.status === 'action_taken',
        summary: r.summary || 'upsell timing check complete',
        timestamp: Date.now(),
      }, 7, AGENT_ID).catch(() => {})
    }
  }
  return specialistReport
}

async function processClient(client) {
  const supabase = getSupabase()
  const now = Date.now()

  // Clients on Command are already at the top — nothing to upsell
  const planKey = (client.plan || 'free').toLowerCase()
  const currentPlan = PLAN_CATALOG[planKey] || PLAN_CATALOG.free
  if (!currentPlan.upgrade) {
    console.log(`[${AGENT_ID}] ${client.business_name} is on Command plan — skipping upsell`)
    return null
  }

  // Look for upsell triggers in the last 4 hours
  const since = new Date(now - 4 * 60 * 60 * 1000).toISOString()
  const { data: triggers } = await supabase
    .from('activity_log')
    .select('*')
    .eq('client_id', client.id)
    .in('worker_name', ['5_star_review', 'milestone_hit', 'payment_completed', '90_day_mark'])
    .gte('created_at', since)
    .not('action', 'eq', 'upsell_sent')  // skip rows already actioned as upsell

  // Also check for 90-day clients
  const ninetyDaysAgo = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString()
  const ninetyOneDaysAgo = new Date(now - 91 * 24 * 60 * 60 * 1000).toISOString()
  const { data: ninetyDayClients } = await supabase
    .from('clients')
    .select('id, business_name, twilio_number')
    .gte('created_at', ninetyOneDaysAgo)
    .lte('created_at', ninetyDaysAgo)
    .eq('id', client.id)

  const allTriggers = [...(triggers || [])]
  if (ninetyDayClients?.length) {
    // 90-day milestone: flag for director review rather than SMS-ing the owner about themselves
    await supabase.from('activity_log').insert({
      client_id:   client.id,
      worker_id:   AGENT_ID,
      worker_name: AGENT_ID,
      action:      '90_day_upsell_flag',
      outcome:     null,
      metadata: {
        reason: '90 days on platform',
        currentPlan: currentPlan.name,
        recommendedUpgrade: currentPlan.upgrade,
        flaggedAt: new Date().toISOString(),
      },
      created_at: new Date().toISOString(),
    })
    console.log(`[${AGENT_ID}] ${client.business_name} 90-day mark — flagged for director review (not SMS'd)`)
    // Do not push a trigger that would SMS the owner back to themselves
  }

  if (!allTriggers.length) return null

  let actionsTaken = 0
  const upsells = []

  for (const trigger of allTriggers) {
    // 90_day_mark activity_log rows were the old pattern — they would SMS owner_cell
    // back to themselves. Skip them here; the new path above handles 90-day separately.
    if (trigger.action === '90_day_mark') continue

    const customerPhone = trigger.metadata?.customerPhone
    if (!customerPhone) continue

    // Cooldown check
    const { data: lastUpsell } = await supabase
      .from('agent_state')
      .select('state')
      .eq('agent', 'upsell_timer')
      .eq('client_id', client.id)
      .eq('entity_id', `upsell:${customerPhone}`)
      .single()

    if (lastUpsell?.state?.lastUpsellAt) {
      const daysSince = (now - new Date(lastUpsell.state.lastUpsellAt).getTime()) / (1000 * 60 * 60 * 24)
      if (daysSince < UPSELL_COOLDOWN_DAYS) continue
    }

    try {
      const message = await generateUpsellMessage(client, trigger, currentPlan)
      if (!message) continue

      const gateResult = validateSMS(message, { businessName: client.business_name })
      if (!gateResult.valid) {
        console.warn(`[${AGENT_ID}] message-gate blocked SMS: ${gateResult.issues.join('; ')}`)
        continue
      }

      await sendSMS({
        from: client.twilio_number || process.env.TWILIO_PHONE_NUMBER,
        to: customerPhone,
        body: message,
        clientApiKeys: {},
        clientSlug: client.email,
        clientTimezone: 'America/Chicago',
      })

      await supabase.from('agent_state').upsert({
        agent: 'upsell_timer',
        client_id: client.id,
        entity_id: `upsell:${customerPhone}`,
        state: { lastUpsellAt: new Date().toISOString(), trigger: trigger.action },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'agent,client_id,entity_id' })

      // Cooldown tracked in agent_state above — no activity_log column update needed

      actionsTaken++
      upsells.push({ trigger: trigger.action })
    } catch (err) {
      console.error(`[${AGENT_ID}] Upsell failed:`, err.message)
    }
  }

  if (!actionsTaken) return null

  return {
    agentId: AGENT_ID,
    clientId: client.id,
    timestamp: Date.now(),
    status: 'action_taken',
    summary: `${actionsTaken} upsell offer(s) sent for ${client.business_name}`,
    data: { upsells },
    requiresDirectorAttention: false,
  }
}

async function generateUpsellMessage(client, trigger, currentPlan) {
  const contextMap = {
    '5_star_review':     'They just left a 5-star review — they love you.',
    'milestone_hit':     'They just hit an important milestone.',
    'payment_completed': 'They just completed a payment.',
  }

  const systemPrompt = `<role>Upsell Timer Agent for GRIDHAND AI — write natural upgrade SMS messages at the right moment in the client relationship.</role>
<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<upgrade_path>
Current plan: ${currentPlan.name} ($${currentPlan.price}/mo)
Recommended next: ${currentPlan.upgrade}
</upgrade_path>

<context>
Moment: ${contextMap[trigger.action] || 'positive client interaction'}
</context>

<task>
Write a brief, natural upsell SMS to the customer referencing what's working for them.
Mention the specific upgrade listed in upgrade_path — use the exact plan name and price from there.
Make it feel like a natural next step, not a sales pitch.
</task>

<rules>
- 2-3 sentences max
- Warm and confident tone
- Make the upgrade feel obvious, not pushy
- Use only the plan name and price from upgrade_path — never invent plan names
- Sign off as ${client.business_name}
- Output ONLY the SMS text
</rules>`

  return aiClient.call({
    modelString: 'groq/llama-3.3-70b-versatile',
    clientApiKeys: {},
    systemPrompt,
    messages: [{ role: 'user', content: 'Write the upsell message.' }],
    maxTokens: 140,
    _workerName: AGENT_ID,
  })
}

async function report(outcomes) {
  const summary = {
    agentId: AGENT_ID,
    division: DIVISION,
    reportsTo: REPORTS_TO,
    timestamp: Date.now(),
    totalClients: outcomes.length,
    actionsCount: outcomes.filter(o => o.status === 'action_taken').length,
    escalations: outcomes.filter(o => o.requiresDirectorAttention),
    outcomes,
  }
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} actions taken`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
