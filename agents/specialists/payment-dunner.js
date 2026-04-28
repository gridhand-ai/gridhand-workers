'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// PaymentDunner — Handles failed payment recovery. Detects Stripe payment
// failures and sends escalating SMS prompts (soft → firm → final) to recover
// the payment before the account is suspended.
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

const AGENT_ID   = 'payment-dunner'
const DIVISION   = 'revenue'
const REPORTS_TO = 'revenue-director'

// Dun attempt thresholds (days after initial failure)
const DUN_SCHEDULE = [
  { day: 1,  tone: 'soft' },
  { day: 4,  tone: 'firm' },
  { day: 10, tone: 'final' },
]

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Main entry point — iterate clients, process failed payments.
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
      await vault.store(r.clientId, vault.KEYS.CONTACT_HISTORY, {
        lastAction:  'payment_dun',
        dunsSent:    r.data?.dunsSent || 0,
        atRisk:      r.data?.totalAtRisk,
        summary:     r.summary || 'payment-dunner cycle complete',
        timestamp:   Date.now(),
      }, 8, AGENT_ID).catch(() => {})
    }
  }

  return specialistReport
}

/**
 * Process a single client — find failed payments and send dun messages.
 * @param {Object} client
 * @returns {Object|null}
 */
async function processClient(client) {
  const supabase = getSupabase()
  const now      = Date.now()

  const { data: failedPayments } = await supabase
    .from('client_payment_failures')
    .select('*')
    .eq('client_id', client.id)
    .eq('resolved', false)
    .order('failed_at', { ascending: true })
    .limit(10)

  if (!failedPayments?.length) return null

  let dunsSent   = 0
  let escalations = 0
  const actions  = []

  for (const payment of failedPayments) {
    const failedAt   = new Date(payment.failed_at).getTime()
    const daysFailed = (now - failedAt) / (1000 * 60 * 60 * 24)
    const dunState   = payment.dun_state || {}
    const lastDunDay = dunState.lastDunDay || 0

    // Find which dun tier applies
    const dunTier = [...DUN_SCHEDULE].reverse().find(
      d => daysFailed >= d.day && lastDunDay < d.day
    )
    if (!dunTier) continue

    if (dunTier.tone === 'final') {
      // Mark for director escalation instead of SMS
      await supabase.from('client_payment_failures').update({
        dun_state: { ...dunState, lastDunDay: dunTier.day, escalatedAt: new Date().toISOString() },
      }).eq('id', payment.id)
      escalations++
      continue
    }

    const phone = payment.customer_phone || client.owner_phone
    if (!phone) continue

    try {
      const message = await generateDunMessage(client, payment, dunTier.tone, Math.floor(daysFailed))
      if (!message) continue

      const gateResult = validateSMS(message, {
        businessName: client.business_name,
        amount:       payment.amount ? String(payment.amount) : undefined,
      })
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
        clientTimezone: client.timezone || process.env.DEFAULT_TIMEZONE || 'America/Chicago',
      })

      await supabase.from('client_payment_failures').update({
        dun_state: {
          ...dunState,
          lastDunDay:                dunTier.day,
          [`day${dunTier.day}SentAt`]: new Date().toISOString(),
        },
      }).eq('id', payment.id)

      dunsSent++
      actions.push(`${dunTier.tone} dun sent — day ${dunTier.day} of failure`)
    } catch (err) {
      console.error(`[${AGENT_ID}] Dun SMS failed for payment ${payment.id}:`, err.message)
    }
  }

  if (!dunsSent && !escalations) return null

  const totalAtRisk = failedPayments.reduce((sum, p) => sum + (p.amount || 0), 0)

  return {
    agentId:                   AGENT_ID,
    clientId:                  client.id,
    timestamp:                 Date.now(),
    status:                    'action_taken',
    summary:                   `${dunsSent} payment dun(s) sent, ${escalations} escalated for ${client.business_name}. At risk: $${totalAtRisk}`,
    data:                      { dunsSent, escalations, totalAtRisk, actions },
    requiresDirectorAttention: escalations > 0 || totalAtRisk > 200,
  }
}

/**
 * Generate a payment recovery SMS via Groq.
 * @param {Object} client
 * @param {Object} payment
 * @param {string} tone - 'soft' | 'firm'
 * @param {number} daysFailed
 * @returns {Promise<string|null>}
 */
async function generateDunMessage(client, payment, tone, daysFailed) {
  const toneInstructions = {
    soft: 'Friendly and helpful — let them know a payment didn\'t go through. Offer to help update their info.',
    firm: 'Firmer — acknowledge it\'s been several days. Emphasize they need to update payment to avoid interruption.',
  }

  const systemPrompt = `<role>Payment Dunner for GRIDHAND AI — write payment recovery SMS messages for small business clients.</role>
<business>
Name: ${client.business_name}
</business>

<payment>
Amount: $${payment.amount || 'your balance'}
Days since failure: ${daysFailed}
</payment>

<task>
Write a payment follow-up SMS. Tone: ${toneInstructions[tone]}
</task>

<rules>
- 2 sentences max
- Professional and non-threatening
- Include clear action (update payment info, reply, or call)
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
      messages:      [{ role: 'user', content: 'Write the payment recovery SMS.' }],
      maxTokens:     130,
      _workerName:   AGENT_ID,
      tier: 'specialist',
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} payment dun actions taken`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
