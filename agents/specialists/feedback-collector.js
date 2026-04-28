'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// FeedbackCollector — Sends post-service feedback requests to recent customers
// via SMS. Collects CSAT/NPS-style signals and stores them for the Review
// Orchestrator and Brand Director to act on.
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

const AGENT_ID   = 'feedback-collector'
const DIVISION   = 'experience'
const REPORTS_TO = 'experience-director'

// Send feedback request this many hours after service completion
const FEEDBACK_DELAY_HOURS = 2
// Cooldown to avoid re-requesting feedback from same customer
const FEEDBACK_COOLDOWN_DAYS = 90

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Main entry point — iterate clients, send feedback requests for recent services.
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
      await vault.store(r.clientId, vault.KEYS.CUSTOMER_PAIN_POINTS, {
        lastAction:  'feedback_request_sent',
        sent:        r.data?.sent || 0,
        summary:     r.summary || 'feedback collector cycle complete',
        timestamp:   Date.now(),
      }, 5, AGENT_ID).catch(() => {})
    }
  }

  return specialistReport
}

/**
 * Process a single client — find recent completed services and send feedback SMS.
 * @param {Object} client
 * @returns {Object|null}
 */
async function processClient(client) {
  const supabase     = getSupabase()
  const now          = Date.now()
  const minAgeMs     = FEEDBACK_DELAY_HOURS * 60 * 60 * 1000
  const cutoffMs     = FEEDBACK_COOLDOWN_DAYS * 24 * 60 * 60 * 1000
  const completedAfter = new Date(now - 48 * 60 * 60 * 1000).toISOString() // services in last 48h
  const cooldownCutoff = new Date(now - cutoffMs).toISOString()

  // Find recently completed service interactions that haven't had a feedback request yet
  const { data: completions } = await supabase
    .from('client_service_completions')
    .select('*')
    .eq('client_id', client.id)
    .gte('completed_at', completedAfter)
    .lt('completed_at', new Date(now - minAgeMs).toISOString()) // must be old enough
    .is('feedback_sent_at', null)
    .order('completed_at', { ascending: false })
    .limit(10)

  if (!completions?.length) return null

  let sent    = 0
  const actions = []

  for (const completion of completions) {
    const phone = completion.customer_phone
    if (!phone) continue

    // Check cooldown — don't re-send to same customer within 90 days
    const { count: recentFeedback } = await supabase
      .from('client_service_completions')
      .select('*', { count: 'exact', head: true })
      .eq('client_id', client.id)
      .eq('customer_phone', phone)
      .not('feedback_sent_at', 'is', null)
      .gte('feedback_sent_at', cooldownCutoff)

    if (recentFeedback > 0) continue

    try {
      const message = await generateFeedbackRequest(client, completion)
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

      await supabase.from('client_service_completions').update({
        feedback_sent_at: new Date().toISOString(),
      }).eq('id', completion.id)

      sent++
      actions.push(`Feedback request sent for service ${completion.id}`)
    } catch (err) {
      console.error(`[${AGENT_ID}] SMS failed for completion ${completion.id}:`, err.message)
    }
  }

  if (!sent) return null

  return {
    agentId:                   AGENT_ID,
    clientId:                  client.id,
    timestamp:                 Date.now(),
    status:                    'action_taken',
    summary:                   `${sent} feedback request(s) sent for ${client.business_name}`,
    data:                      { sent, completions: completions.length, actions },
    requiresDirectorAttention: false,
  }
}

/**
 * Generate a friendly post-service feedback SMS via Groq.
 * @param {Object} client
 * @param {Object} completion
 * @returns {Promise<string|null>}
 */
async function generateFeedbackRequest(client, completion) {
  const systemPrompt = `<role>Feedback Collector for GRIDHAND AI — write post-service feedback request SMS messages for small business clients.</role>
<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<service>
Type: ${completion.service_type || 'your recent service'}
Customer name: ${completion.customer_name || 'there'}
</service>

<task>
Write a warm post-service feedback request SMS. Ask them to rate their
experience on a scale of 1-5 by replying with a number.
</task>

<rules>
- 2 sentences max
- Friendly and appreciative
- Ask for a 1-5 rating reply
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
      messages:      [{ role: 'user', content: 'Write the feedback request SMS.' }],
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} feedback collection actions taken`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
