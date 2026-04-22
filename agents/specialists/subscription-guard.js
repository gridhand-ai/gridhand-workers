'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// SubscriptionGuard — Monitors payment health, proactive SMS before failure, recovery after
// Division: revenue
// Reports to: revenue-director
// Runs: on-demand (called by RevenueDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient = require('../../lib/ai-client')
const { sendSMS } = require('../../lib/twilio-client')
const { validateSMS } = require('../../lib/message-gate')
const { fileInteraction } = require('../../lib/memory-client')

const AGENT_ID  = 'subscription-guard'
const DIVISION  = 'revenue'
const REPORTS_TO = 'revenue-director'

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
  return specialistReport
}

async function processClient(client) {
  const supabase = getSupabase()
  const now = Date.now()

  // Check Stripe subscription state from client record
  // billing fields read directly from clients table
  const subscriptionStatus = client.billing_status
  const cardExpMonth = client.stripe_data?.card_exp_month || client.stripe_data?.payment_method?.card?.exp_month || null
  const cardExpYear = client.stripe_data?.card_exp_year || client.stripe_data?.payment_method?.card?.exp_year || null
  if (!cardExpMonth || !cardExpYear) {
    console.debug(`[subscription-guard] card expiry data not available for ${client.business_name}`)
  }
  const trialEndDate = client.trial_ended_at ? new Date(client.trial_ended_at) : null

  const actions = []
  let requiresAttention = false

  // 1. Card expiry warning — 7 days before expiry
  if (cardExpMonth && cardExpYear) {
    const expiry = new Date(cardExpYear, cardExpMonth - 1, 1)
    const daysUntilExpiry = (expiry.getTime() - now) / (1000 * 60 * 60 * 24)
    if (daysUntilExpiry > 0 && daysUntilExpiry <= 7) {
      const alreadyWarned = await getGuardState(supabase, client.id, 'card_expiry_warned')
      if (!alreadyWarned) {
        const msg = await generateMessage(client, 'card_expiry', { daysUntilExpiry: Math.floor(daysUntilExpiry) })
        if (msg && client.owner_cell) {
          const gateResult = validateSMS(msg, { businessName: client.business_name })
          if (!gateResult.valid) {
            console.warn(`[${AGENT_ID}] message-gate blocked card_expiry SMS: ${gateResult.issues.join('; ')}`)
          } else {
            await sendSMS({
              from: client.twilio_number || process.env.TWILIO_PHONE_NUMBER,
              to: client.owner_cell,
              body: gateResult.text,
              clientApiKeys: {},
              clientSlug: client.email,
              clientTimezone: client.timezone || process.env.DEFAULT_TIMEZONE || 'America/Chicago',
            })
            await setGuardState(supabase, client.id, 'card_expiry_warned', true)
            actions.push('card_expiry_warning_sent')
          }
        }
      }
    }
  }

  // 2. Failed payment recovery
  if (subscriptionStatus === 'past_due' || subscriptionStatus === 'unpaid') {
    const alreadyContacted = await getGuardState(supabase, client.id, 'payment_failure_contacted')
    if (!alreadyContacted) {
      const msg = await generateMessage(client, 'payment_failed', {})
      if (msg && client.owner_cell) {
        const gateResult = validateSMS(msg, { businessName: client.business_name })
        if (!gateResult.valid) {
          console.warn(`[${AGENT_ID}] message-gate blocked payment_failed SMS: ${gateResult.issues.join('; ')}`)
        } else {
          await sendSMS({
            from: client.twilio_number || process.env.TWILIO_PHONE_NUMBER,
            to: client.owner_cell,
            body: gateResult.text,
            clientApiKeys: {},
            clientSlug: client.email,
            clientTimezone: client.timezone || process.env.DEFAULT_TIMEZONE || 'America/Chicago',
          })
          await setGuardState(supabase, client.id, 'payment_failure_contacted', true)
          actions.push('payment_failure_recovery_sent')
          requiresAttention = true
        }
      }
    }
  }

  // 3. Trial ending in 3 days
  if (trialEndDate) {
    const daysUntilTrialEnd = (trialEndDate.getTime() - now) / (1000 * 60 * 60 * 24)
    if (daysUntilTrialEnd > 0 && daysUntilTrialEnd <= 3) {
      const alreadyWarned = await getGuardState(supabase, client.id, 'trial_end_warned')
      if (!alreadyWarned) {
        const msg = await generateMessage(client, 'trial_ending', { daysLeft: Math.floor(daysUntilTrialEnd) })
        if (msg && client.owner_cell) {
          const gateResult = validateSMS(msg, { businessName: client.business_name })
          if (!gateResult.valid) {
            console.warn(`[${AGENT_ID}] message-gate blocked trial_ending SMS: ${gateResult.issues.join('; ')}`)
          } else {
            await sendSMS({
              from: client.twilio_number || process.env.TWILIO_PHONE_NUMBER,
              to: client.owner_cell,
              body: gateResult.text,
              clientApiKeys: {},
              clientSlug: client.email,
              clientTimezone: client.timezone || process.env.DEFAULT_TIMEZONE || 'America/Chicago',
            })
            await setGuardState(supabase, client.id, 'trial_end_warned', true)
            actions.push('trial_ending_warning_sent')
          }
        }
      }
    }
  }

  if (!actions.length) return null

  return {
    agentId: AGENT_ID,
    clientId: client.id,
    timestamp: Date.now(),
    status: 'action_taken',
    summary: `Subscription guard actions for ${client.business_name}: ${actions.join(', ')}`,
    data: { actions },
    requiresDirectorAttention: requiresAttention,
  }
}

async function getGuardState(supabase, clientId, key) {
  const { data } = await supabase
    .from('agent_state')
    .select('state')
    .eq('agent', 'subscription_guard')
    .eq('client_id', clientId)
    .eq('entity_id', key)
    .single()
  return data?.state?.value || false
}

async function setGuardState(supabase, clientId, key, value) {
  await supabase.from('agent_state').upsert({
    agent: 'subscription_guard',
    client_id: clientId,
    entity_id: key,
    state: { value, setAt: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'agent,client_id,entity_id' })
}

async function generateMessage(client, type, data) {
  const instructions = {
    card_expiry: `Card expires in ${data.daysUntilExpiry} day(s). Friendly heads-up to update payment info before service interrupts.`,
    payment_failed: 'Payment failed. Need them to update billing. Helpful and calm, not accusatory.',
    trial_ending: `Free trial ends in ${data.daysLeft} day(s). Encourage them to add payment info to continue.`,
  }

  const systemPrompt = `<business>
Name: ${client.business_name}
</business>

<task>
Write a payment/subscription notification SMS.
Context: ${instructions[type]}
</task>

<rules>
- 2 sentences max
- Professional and helpful, never alarming
- Include a clear action step
- Sign off as GRIDHAND
- Output ONLY the SMS text
</rules>`

  return aiClient.call({
    modelString: 'groq/llama-3.3-70b-versatile',
    clientApiKeys: {},
    systemPrompt,
    messages: [{ role: 'user', content: 'Write the subscription message.' }],
    maxTokens: 130,
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
