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

const AGENT_ID  = 'upsell-timer'
const DIVISION  = 'revenue'
const REPORTS_TO = 'revenue-director'

// Don't upsell a customer who was upselled in the last 90 days
const UPSELL_COOLDOWN_DAYS = 90

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

  return report(reports)
}

async function processClient(client) {
  const supabase = getSupabase()
  const now = Date.now()

  // Look for upsell triggers in the last 4 hours
  const since = new Date(now - 4 * 60 * 60 * 1000).toISOString()
  const { data: triggers } = await supabase
    .from('activity_log')
    .select('*')
    .eq('client_id', client.id)
    .in('worker_name', ['5_star_review', 'milestone_hit', 'payment_completed', '90_day_mark'])
    .gte('created_at', since)
    .is('upsell_sent', null)

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
    allTriggers.push({ action: '90_day_mark', metadata: { customerPhone: client.owner_cell } })
  }

  if (!allTriggers.length) return null

  let actionsTaken = 0
  const upsells = []

  for (const trigger of allTriggers) {
    const customerPhone = trigger.metadata?.customerPhone || client.owner_cell
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
      const message = await generateUpsellMessage(client, trigger)
      if (!message) continue

      await sendSMS({
        from: client.twilio_number,
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

      if (trigger.id) {
        await supabase.from('activity_log').update({ upsell_sent: new Date().toISOString() }).eq('id', trigger.id)
      }

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

async function generateUpsellMessage(client, trigger) {
  const contextMap = {
    '5_star_review':     'They just left a 5-star review — they love you.',
    'milestone_hit':     'They just hit an important milestone.',
    'payment_completed': 'They just completed a payment.',
    '90_day_mark':       'They\'ve been a client for 90 days.',
  }

  const systemPrompt = `<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
Current plan: ${client.plan || 'standard'}
</business>

<context>
Moment: ${contextMap[trigger.action] || 'positive client interaction'}
Upgrade opportunity: offer the next service tier or add-on.
</context>

<task>
Write a brief, natural upsell SMS. Make it feel like a natural next step, not a sales pitch.
Reference what's working for them. Offer one specific upgrade that makes sense.
</task>

<rules>
- 2-3 sentences max
- Warm and confident tone
- Make the upgrade feel obvious, not pushy
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
