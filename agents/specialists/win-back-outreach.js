'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// WinBackOutreach — Identifies past clients or leads who have gone cold (60+
// days silent) and sends a re-engagement SMS to win them back.
//
// Division: acquisition
// Reports to: acquisition-director
// Runs: on-demand (called by AcquisitionDirector)
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

const AGENT_ID   = 'win-back-outreach'
const DIVISION   = 'acquisition'
const REPORTS_TO = 'acquisition-director'

// Days of silence before a contact is considered "cold" and eligible for win-back
const COLD_THRESHOLD_DAYS = 60
// Days to wait between win-back attempts to avoid over-messaging
const WIN_BACK_COOLDOWN_DAYS = 30

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Main entry point — iterate clients, find cold contacts, send win-back SMS.
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
        lastAction:  'win_back_outreach',
        reached:     r.data?.reached || 0,
        summary:     r.summary || 'win-back cycle complete',
        timestamp:   Date.now(),
      }, 5, AGENT_ID).catch(() => {})
    }
  }

  return specialistReport
}

/**
 * Process a single client — identify cold contacts and send win-back SMS.
 * @param {Object} client
 * @returns {Object|null}
 */
async function processClient(client) {
  const supabase  = getSupabase()
  const now       = Date.now()
  const coldCutoff = new Date(now - COLD_THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const cooldownCutoff = new Date(now - WIN_BACK_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Find leads that have gone cold and are not within the cooldown window
  const { data: coldLeads } = await supabase
    .from('client_leads')
    .select('*')
    .eq('client_id', client.id)
    .lt('last_contact_at', coldCutoff)
    .or(`win_back_sent_at.is.null,win_back_sent_at.lt.${cooldownCutoff}`)
    .limit(5)

  if (!coldLeads?.length) return null

  let reached   = 0
  const actions = []

  for (const lead of coldLeads) {
    const phone = lead.phone
    if (!phone) continue

    try {
      const message = await generateWinBackMessage(client, lead)
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

      await supabase.from('client_leads').update({
        win_back_sent_at: new Date().toISOString(),
      }).eq('id', lead.id)

      reached++
      actions.push(`Win-back sent to ${lead.name || lead.id}`)
    } catch (err) {
      console.error(`[${AGENT_ID}] SMS failed for lead ${lead.id}:`, err.message)
    }
  }

  if (!reached) return null

  return {
    agentId:                   AGENT_ID,
    clientId:                  client.id,
    timestamp:                 Date.now(),
    status:                    'action_taken',
    summary:                   `${reached} win-back message(s) sent for ${client.business_name}`,
    data:                      { reached, coldLeads: coldLeads.length, actions },
    requiresDirectorAttention: false,
  }
}

/**
 * Generate a re-engagement SMS for a cold contact via Groq.
 * @param {Object} client
 * @param {Object} lead
 * @returns {Promise<string|null>}
 */
async function generateWinBackMessage(client, lead) {
  const systemPrompt = `<role>Win-Back Outreach Agent for GRIDHAND AI — write warm, low-pressure re-engagement SMS messages for small business clients.</role>
<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<contact>
Name: ${lead.name || 'there'}
Last inquiry: ${lead.inquiry_about || 'a previous interest'}
</contact>

<task>
Write a warm, low-pressure re-engagement SMS to reconnect with this contact.
Acknowledge it's been a while. Keep it brief and genuine.
</task>

<rules>
- 2 sentences max
- Friendly and human — not promotional
- End with a light question or open door (e.g. "Still interested?" or "Anything we can help with?")
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
      messages:      [{ role: 'user', content: 'Write the win-back re-engagement SMS.' }],
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} win-back actions taken`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
