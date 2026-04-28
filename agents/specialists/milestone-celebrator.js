'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// MilestoneCelebrator — Detects client and customer milestones (first purchase,
// 30/90/180-day anniversary, 10th visit, loyalty threshold reached) and sends
// a personalized celebratory message to deepen the relationship.
//
// Division: experience
// Reports to: experience-director
// Runs: on-demand (called by ExperienceDirector)
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

const AGENT_ID   = 'milestone-celebrator'
const DIVISION   = 'experience'
const REPORTS_TO = 'experience-director'

// Anniversaries to celebrate (days since first purchase/visit)
const ANNIVERSARY_DAYS = [30, 90, 180, 365]
// Visit milestones
const VISIT_MILESTONES = [5, 10, 25, 50]

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Main entry point — iterate clients, detect and celebrate customer milestones.
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
      await vault.store(r.clientId, vault.KEYS.COMMUNICATION_PREFS, {
        lastAction:     'milestone_message',
        celebrated:     r.data?.celebrated || 0,
        summary:        r.summary || 'milestone celebrator cycle complete',
        timestamp:      Date.now(),
      }, 5, AGENT_ID).catch(() => {})
    }
  }

  return specialistReport
}

/**
 * Process a single client — find customers hitting milestones today.
 * @param {Object} client
 * @returns {Object|null}
 */
async function processClient(client) {
  const supabase  = getSupabase()
  const now       = Date.now()
  const todayStart = new Date(now).setHours(0, 0, 0, 0)
  const todayEnd   = new Date(now).setHours(23, 59, 59, 999)

  // Find customers whose first_purchase_at matches an anniversary window today
  // Uses milestones_sent JSONB column — keys like 'days_30', 'days_90', 'visits_10'
  const anniversaryMatches = []
  for (const days of ANNIVERSARY_DAYS) {
    const targetDate = new Date(now - days * 24 * 60 * 60 * 1000)
    const dayStart   = new Date(targetDate.setHours(0, 0, 0, 0)).toISOString()
    const dayEnd     = new Date(targetDate.setHours(23, 59, 59, 999)).toISOString()

    const { data } = await supabase
      .from('client_customers')
      .select('id, name, phone, first_purchase_at, visit_count, milestones_sent')
      .eq('client_id', client.id)
      .gte('first_purchase_at', dayStart)
      .lte('first_purchase_at', dayEnd)
      .limit(20)

    if (data?.length) {
      const milestoneKey = `days_${days}`
      const fresh = data.filter(c => !((c.milestones_sent || {})[milestoneKey]))
      anniversaryMatches.push(...fresh.map(c => ({ customer: c, type: 'anniversary', days, milestoneKey })))
    }
  }

  // Find customers hitting a visit count milestone
  const visitMatches = []
  for (const visits of VISIT_MILESTONES) {
    const { data } = await supabase
      .from('client_customers')
      .select('id, name, phone, visit_count, milestones_sent')
      .eq('client_id', client.id)
      .eq('visit_count', visits)
      .limit(20)

    if (data?.length) {
      const milestoneKey = `visits_${visits}`
      const fresh = data.filter(c => !((c.milestones_sent || {})[milestoneKey]))
      visitMatches.push(...fresh.map(c => ({ customer: c, type: 'visit', visits, milestoneKey })))
    }
  }

  const allMilestones = [...anniversaryMatches, ...visitMatches]
  if (!allMilestones.length) return null

  let celebrated = 0
  const actions  = []

  for (const milestone of allMilestones) {
    const phone = milestone.customer.phone
    if (!phone) continue

    try {
      const message = await generateCelebrationMessage(client, milestone)
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
        clientTimezone: client.timezone || process.env.DEFAULT_TIMEZONE || 'America/Chicago',
      })

      // Mark milestone as sent — merge into milestones_sent JSONB
      const existingSent = milestone.customer.milestones_sent || {}
      const nextSent = {
        ...existingSent,
        [milestone.milestoneKey]: new Date().toISOString(),
      }

      await supabase.from('client_customers')
        .update({ milestones_sent: nextSent })
        .eq('id', milestone.customer.id)

      celebrated++
      const label = milestone.type === 'anniversary'
        ? `${milestone.days}-day anniversary`
        : `${milestone.visits}-visit milestone`
      actions.push(`Celebrated ${label} for ${milestone.customer.name || milestone.customer.id}`)
    } catch (err) {
      console.error(`[${AGENT_ID}] SMS failed for customer ${milestone.customer.id}:`, err.message)
    }
  }

  if (!celebrated) return null

  return {
    agentId:                   AGENT_ID,
    clientId:                  client.id,
    timestamp:                 Date.now(),
    status:                    'action_taken',
    summary:                   `${celebrated} milestone message(s) sent for ${client.business_name}`,
    data:                      { celebrated, milestones: allMilestones.length, actions },
    requiresDirectorAttention: false,
  }
}

/**
 * Generate a personalized milestone celebration SMS via Groq.
 * @param {Object} client
 * @param {Object} milestone - { customer, type, days?, visits? }
 * @returns {Promise<string|null>}
 */
async function generateCelebrationMessage(client, milestone) {
  const milestoneLabel = milestone.type === 'anniversary'
    ? `${milestone.days}-day customer anniversary`
    : `${milestone.visits}th visit`

  const systemPrompt = `<role>Milestone Celebrator for GRIDHAND AI — write warm, personal customer milestone SMS messages for small business clients.</role>
<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<milestone>
Customer name: ${milestone.customer.name || 'there'}
Milestone: ${milestoneLabel}
</milestone>

<task>
Write a warm, personal SMS celebrating this customer milestone.
Make them feel genuinely appreciated.
</task>

<rules>
- 2 sentences max
- Warm and genuine — not corporate or salesy
- Reference the specific milestone naturally
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
      messages:      [{ role: 'user', content: 'Write the celebration SMS.' }],
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} milestone celebrations sent`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
