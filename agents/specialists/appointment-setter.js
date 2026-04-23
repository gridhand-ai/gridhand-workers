'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// AppointmentSetter — Detects warm leads and pending inquiries that have not
// yet been booked, then sends a personalized SMS prompt to schedule a
// consultation or service appointment on behalf of the client.
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

const AGENT_ID   = 'appointment-setter'
const DIVISION   = 'acquisition'
const REPORTS_TO = 'acquisition-director'

// Minimum lead score to attempt booking outreach
const BOOKING_SCORE_THRESHOLD = 5

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Main entry point — iterate clients, attempt booking outreach for warm leads.
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
      await vault.store(r.clientId, vault.KEYS.LAST_LEAD_OUTCOME, {
        lastAction:      'appointment_outreach',
        booked:          r.data?.booked || 0,
        contacted:       r.data?.contacted || 0,
        summary:         r.summary || 'appointment-setter cycle complete',
        timestamp:       Date.now(),
      }, 6, AGENT_ID).catch(() => {})
    }
  }

  return specialistReport
}

/**
 * Process a single client — find unbooked warm leads and send booking SMS.
 * @param {Object} client
 * @returns {Object|null} outcome or null if nothing to do
 */
async function processClient(client) {
  const supabase = getSupabase()

  // Pull leads that are warm (score >= threshold) but not yet booked
  const { data: leads } = await supabase
    .from('client_leads')
    .select('*')
    .eq('client_id', client.id)
    .gte('score', BOOKING_SCORE_THRESHOLD)
    .is('booked_at', null)
    .is('booking_sms_sent_at', null)
    .order('score', { ascending: false })
    .limit(10)

  if (!leads?.length) return null

  let contacted = 0
  let booked    = 0
  const actions = []

  for (const lead of leads) {
    const phone = lead.phone
    if (!phone) continue

    try {
      const message = await generateBookingMessage(client, lead)
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

      await supabase.from('client_leads').update({
        booking_sms_sent_at: new Date().toISOString(),
      }).eq('id', lead.id)

      contacted++
      actions.push(`SMS sent to lead ${lead.id} (score ${lead.score})`)
    } catch (err) {
      console.error(`[${AGENT_ID}] SMS failed for lead ${lead.id}:`, err.message)
    }
  }

  if (!contacted) return null

  return {
    agentId:                   AGENT_ID,
    clientId:                  client.id,
    timestamp:                 Date.now(),
    status:                    'action_taken',
    summary:                   `${contacted} booking outreach SMS sent for ${client.business_name}`,
    data:                      { contacted, booked, leads: leads.length, actions },
    requiresDirectorAttention: false,
  }
}

/**
 * Generate a personalized booking invitation SMS via Groq.
 * @param {Object} client
 * @param {Object} lead
 * @returns {Promise<string|null>}
 */
async function generateBookingMessage(client, lead) {
  const systemPrompt = `<role>Appointment Setter for GRIDHAND AI — write warm, brief SMS messages inviting qualified leads to book appointments for small business clients.</role>
<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<lead>
Name: ${lead.name || 'there'}
Inquiry: ${lead.inquiry_about || 'general inquiry'}
Score: ${lead.score}/10
</lead>

<task>
Write a warm, brief SMS inviting this lead to book an appointment or consultation.
Reference their inquiry topic. Keep it conversational and friendly.
</task>

<rules>
- 2 sentences max
- Human tone, not salesy
- End with a clear CTA (reply YES, click link, or call us)
- Sign off as ${client.business_name}
- Output ONLY the SMS text
</rules>`

  try {
    return await aiClient.call({
      modelString:   'groq/llama-3.3-70b-versatile',
      clientApiKeys: {},
      systemPrompt,
      messages:      [{ role: 'user', content: 'Write the booking invitation SMS.' }],
      maxTokens:     130,
      _workerName:   AGENT_ID,
    })
  } catch (err) {
    console.error(`[${AGENT_ID}] AI call failed:`, err.message)
    return null
  }
}

/**
 * Aggregate individual client outcomes into a director-ready report.
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} booking outreach actions taken`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
