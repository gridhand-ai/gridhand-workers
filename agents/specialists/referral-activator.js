'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// ReferralActivator — Times referral asks after positive interactions
// Division: acquisition
// Reports to: acquisition-director
// Runs: on-demand (called by AcquisitionDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient = require('../../lib/ai-client')
const { sendSMS } = require('../../lib/twilio-client')
const { validateSMS } = require('../../lib/message-gate')

const AGENT_ID  = 'referral-activator'
const DIVISION  = 'acquisition'
const REPORTS_TO = 'acquisition-director'

// Positive triggers that create a referral opportunity
const REFERRAL_TRIGGERS = ['5_star_review', 'payment_completed', 'milestone_hit', 'positive_feedback']
// Cooldown: don't ask same customer twice within 60 days
const REFERRAL_COOLDOWN_DAYS = 60

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

  // Look for positive events in the last 2 hours that haven't triggered a referral ask
  const since = new Date(now - 2 * 60 * 60 * 1000).toISOString()
  const { data: events } = await supabase
    .from('activity_log')
    .select('*')
    .eq('client_id', client.id)
    .in('action', REFERRAL_TRIGGERS)
    .gte('created_at', since)
    .is('referral_ask_sent', null)

  if (!events?.length) return null

  let actionsTaken = 0
  const asks = []

  for (const event of events) {
    const customerPhone = event.metadata?.customerPhone
    if (!customerPhone) continue

    // Check cooldown — don't ask if we asked recently
    const { data: lastAsk } = await supabase
      .from('agent_state')
      .select('state')
      .eq('agent', 'referral_activator')
      .eq('client_id', client.id)
      .eq('entity_id', `referral:${customerPhone}`)
      .single()

    if (lastAsk?.state?.lastAskAt) {
      const daysSince = (now - new Date(lastAsk.state.lastAskAt).getTime()) / (1000 * 60 * 60 * 24)
      if (daysSince < REFERRAL_COOLDOWN_DAYS) continue
    }

    try {
      const message = await generateReferralAsk(client, event)
      if (!message) continue

      const gateResult = validateSMS(message, { businessName: client.business_name })
      if (!gateResult.valid) {
        console.warn(`[${AGENT_ID}] message-gate blocked SMS: ${gateResult.issues.join('; ')}`)
        continue
      }

      await sendSMS({
        from: client.twilio_number,
        to: customerPhone,
        body: message,
        clientApiKeys: {},
        clientSlug: client.email,
        clientTimezone: 'America/Chicago',
      })

      // Record that we sent the ask
      await supabase.from('agent_state').upsert({
        agent: 'referral_activator',
        client_id: client.id,
        entity_id: `referral:${customerPhone}`,
        state: { lastAskAt: new Date().toISOString(), trigger: event.action },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'agent,client_id,entity_id' })

      // Mark event as handled
      await supabase.from('activity_log').update({ referral_ask_sent: new Date().toISOString() }).eq('id', event.id)

      actionsTaken++
      asks.push({ trigger: event.action })
    } catch (err) {
      console.error(`[${AGENT_ID}] Ask failed for ${client.id}:`, err.message)
    }
  }

  if (!actionsTaken) return null

  return {
    agentId: AGENT_ID,
    clientId: client.id,
    timestamp: Date.now(),
    status: 'action_taken',
    summary: `Sent ${actionsTaken} referral ask(s) for ${client.business_name}`,
    data: { asks },
    requiresDirectorAttention: false,
  }
}

async function generateReferralAsk(client, event) {
  const triggerContext = {
    '5_star_review': 'just left a 5-star review',
    'payment_completed': 'just completed a payment',
    'milestone_hit': 'just hit a major milestone with us',
    'positive_feedback': 'shared some great feedback',
  }

  const systemPrompt = `<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<context>
Customer ${triggerContext[event.action] || 'had a great experience'}.
Now is the perfect moment to ask for a referral.
</context>

<task>
Write a warm, natural referral request SMS.
Ask if they know anyone who could benefit from similar help.
Make it feel like a genuine ask from a business that cares, not a marketing blast.
</task>

<rules>
- 2 sentences max
- Personal and warm tone
- Don't offer a discount or incentive (keep it authentic)
- Sign off as ${client.business_name}
- Output ONLY the SMS text
</rules>`

  return aiClient.call({
    modelString: 'groq/llama-3.3-70b-versatile',
    clientApiKeys: {},
    systemPrompt,
    messages: [{ role: 'user', content: 'Write the referral ask.' }],
    maxTokens: 120,
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
