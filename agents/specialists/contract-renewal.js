'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// ContractRenewal — Monitors client subscription renewal windows (30, 14, 7
// days out) and sends proactive renewal reminders. Surfaces high-value
// renewals to the Revenue Director for personal outreach.
//
// Division: revenue
// Reports to: revenue-director
// Runs: on-demand (called by RevenueDirector)
//
// @param {Array<Object>} clients - Active client objects from Supabase
// @returns {Object} Specialist report: actionsCount, escalations, outcomes
// Tools used: lib/ai-client (groq), lib/twilio-client, lib/message-gate,
//             lib/memory-client, lib/memory-vault
// ──────────────────────────────────────────────────────────────────────────────

const { createClient }    = require('@supabase/supabase-js')
const aiClient            = require('../../lib/ai-client')
const { sendSMS }         = require('../../lib/twilio-client')
const { validateSMS }     = require('../../lib/message-gate')
const { fileInteraction } = require('../../lib/memory-client')
const vault               = require('../../lib/memory-vault')

const AGENT_ID   = 'contract-renewal'
const DIVISION   = 'revenue'
const REPORTS_TO = 'revenue-director'

// Days before renewal to send reminder; escalate high-value at 30 days
const REMINDER_WINDOWS = [30, 14, 7]
// Monthly value threshold for escalating to director (in dollars)
const HIGH_VALUE_THRESHOLD = 300

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Main entry point — iterate clients, check renewal windows, send reminders.
 * @param {Array<Object>} clients
 * @returns {Object} specialist report
 */
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
    workerId:        AGENT_ID,
    interactionType: 'specialist_run',
  }).catch(() => {})

  for (const r of reports) {
    if (r.clientId) {
      await vault.store(r.clientId, vault.KEYS.UPSELL_TRIGGERS, {
        lastAction:  'renewal_reminder',
        daysUntil:   r.data?.daysUntilRenewal,
        monthlyValue: r.data?.monthlyValue,
        summary:     r.summary || 'contract renewal cycle complete',
        timestamp:   Date.now(),
      }, 7, AGENT_ID).catch(() => {})
    }
  }

  return specialistReport
}

/**
 * Process a single client — identify upcoming renewals and send reminders.
 * @param {Object} client
 * @returns {Object|null}
 */
async function processClient(client) {
  const supabase = getSupabase()
  const now      = Date.now()

  // Pull renewal records (subscriptions with upcoming renewal dates)
  const { data: renewals } = await supabase
    .from('client_subscriptions')
    .select('*')
    .eq('client_id', client.id)
    .eq('status', 'active')
    .order('renewal_date', { ascending: true })
    .limit(5)

  if (!renewals?.length) return null

  let reminded    = 0
  let escalations = 0
  const actions   = []

  for (const sub of renewals) {
    const renewalDate = new Date(sub.renewal_date).getTime()
    const daysUntil   = Math.floor((renewalDate - now) / (1000 * 60 * 60 * 24))
    const reminderState = sub.renewal_reminder_state || {}

    // Find which reminder window this qualifies for
    const window = REMINDER_WINDOWS.find(
      w => daysUntil <= w && !(reminderState[`day${w}Sent`])
    )
    if (!window) continue

    const monthlyValue = sub.monthly_amount || 0

    // High-value renewals at 30-day window go to director for personal outreach
    if (window === 30 && monthlyValue >= HIGH_VALUE_THRESHOLD) {
      await supabase.from('client_subscriptions').update({
        renewal_reminder_state: { ...reminderState, day30Sent: new Date().toISOString(), escalated: true },
      }).eq('id', sub.id)
      escalations++
      continue
    }

    const phone = sub.contact_phone || client.owner_phone
    if (!phone) continue

    try {
      const message = await generateRenewalReminder(client, sub, daysUntil)
      if (!message) continue

      const gateResult = validateSMS(message, { businessName: client.business_name })
      if (!gateResult.valid) {
        console.warn(`[${AGENT_ID}] message-gate blocked SMS: ${gateResult.issues.join('; ')}`)
        continue
      }

      await sendSMS({
        from:           client.twilio_number || process.env.TWILIO_PHONE_NUMBER,
        to:             phone,
        body:           message,
        clientApiKeys:  {},
        clientSlug:     client.email,
        clientTimezone: 'America/Chicago',
      })

      await supabase.from('client_subscriptions').update({
        renewal_reminder_state: {
          ...reminderState,
          [`day${window}Sent`]: new Date().toISOString(),
        },
      }).eq('id', sub.id)

      reminded++
      actions.push(`${daysUntil}-day renewal reminder sent for ${sub.plan_name || 'subscription'}`)
    } catch (err) {
      console.error(`[${AGENT_ID}] Renewal reminder failed for sub ${sub.id}:`, err.message)
    }
  }

  if (!reminded && !escalations) return null

  const primarySub = renewals[0]

  return {
    agentId:                   AGENT_ID,
    clientId:                  client.id,
    timestamp:                 Date.now(),
    status:                    'action_taken',
    summary:                   `${reminded} renewal reminder(s) sent, ${escalations} high-value renewal(s) escalated for ${client.business_name}`,
    data:                      {
      reminded,
      escalations,
      daysUntilRenewal: primarySub ? Math.floor((new Date(primarySub.renewal_date).getTime() - now) / 86400000) : null,
      monthlyValue:     primarySub?.monthly_amount,
      actions,
    },
    requiresDirectorAttention: escalations > 0,
  }
}

/**
 * Generate a subscription renewal reminder SMS via Groq.
 * @param {Object} client
 * @param {Object} sub
 * @param {number} daysUntil
 * @returns {Promise<string|null>}
 */
async function generateRenewalReminder(client, sub, daysUntil) {
  const urgency = daysUntil <= 7 ? 'urgent — renewal is in less than a week'
    : daysUntil <= 14 ? 'moderately urgent — renewal is coming soon'
    : 'friendly heads-up — renewal is in about a month'

  const systemPrompt = `<role>Contract Renewal Specialist for GRIDHAND AI — write subscription renewal reminder SMS messages for small business clients.</role>
<business>
Name: ${client.business_name}
</business>

<subscription>
Plan: ${sub.plan_name || 'your current plan'}
Days until renewal: ${daysUntil}
Amount: ${sub.monthly_amount ? '$' + sub.monthly_amount + '/mo' : 'your subscription amount'}
</subscription>

<task>
Write a subscription renewal reminder SMS. Urgency level: ${urgency}.
</task>

<rules>
- 2 sentences max
- Professional and helpful, not alarming
- Mention the renewal timeframe
- Sign off as ${client.business_name}
- Output ONLY the SMS text
</rules>

<quality_standard>
ANTI-AI BLACKLIST — never use these in any message you generate:
Openers: "Absolutely!", "Certainly!", "Great question!", "I hope this finds you well", "Just checking in!", "This is a friendly reminder", "Please be advised", "As per our records"
Filler: "valued customer", "valued client", "don't hesitate to reach out", "at your earliest convenience", "please feel free to", "I believe", "it seems", "I understand your concern"
Fake urgency: "Act now!", "Limited time!", "Don't miss out!"

TONE RULES:
- 7th-8th grade reading level
- Short sentences (10-15 words max), varied rhythm
- First name only — never full name or "dear customer"
- Real specifics always: time, date, amount, service name
- Match the business's vertical voice — auto shop ≠ restaurant ≠ gym
- No emoji unless the business already uses them
</quality_standard>`

  try {
    return await aiClient.call({
      modelString:   'groq/llama-3.3-70b-versatile',
      clientApiKeys: {},
      systemPrompt,
      messages:      [{ role: 'user', content: 'Write the renewal reminder SMS.' }],
      maxTokens:     130,
      _workerName:   AGENT_ID,
    })
  } catch (err) {
    console.error(`[${AGENT_ID}] AI call failed:`, err.message)
    return null
  }
}

/**
 * Aggregate outcomes into a director-ready report.
 * @param {Array<Object>} outcomes
 * @returns {Object}
 */
async function report(outcomes) {
  const summary = {
    agentId:      AGENT_ID,
    division:     DIVISION,
    reportsTo:    REPORTS_TO,
    timestamp:    Date.now(),
    totalClients: outcomes.length,
    actionsCount: outcomes.filter(o => o.status === 'action_taken').length,
    escalations:  outcomes.filter(o => o.requiresDirectorAttention),
    outcomes,
  }
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} renewal reminder actions taken`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
