'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// SupportEscalator — Monitors open support tickets and customer complaint
// signals. Escalates unresolved tickets past SLA windows to the Experience
// Director and sends acknowledgment messages to waiting customers.
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

const AGENT_ID   = 'support-escalator'
const DIVISION   = 'experience'
const REPORTS_TO = 'experience-director'

// Hours before a ticket is considered overdue and triggers escalation
const SLA_HOURS = {
  urgent:  4,
  normal:  24,
  low:     72,
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Main entry point — iterate clients, check SLA compliance, escalate overdue tickets.
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
        lastAction:    'support_escalation',
        escalated:     r.data?.escalated || 0,
        acknowledged:  r.data?.acknowledged || 0,
        summary:       r.summary || 'support escalator cycle complete',
        timestamp:     Date.now(),
      }, 8, AGENT_ID).catch(() => {})
    }
  }

  return specialistReport
}

/**
 * Process a single client — find overdue tickets, acknowledge and escalate.
 * @param {Object} client
 * @returns {Object|null}
 */
async function processClient(client) {
  const supabase = getSupabase()
  const now      = Date.now()

  const { data: tickets } = await supabase
    .from('client_support_tickets')
    .select('*')
    .eq('client_id', client.id)
    .eq('status', 'open')
    .is('escalated_at', null)
    .order('created_at', { ascending: true })
    .limit(20)

  if (!tickets?.length) return null

  let acknowledged  = 0
  let escalations   = 0
  const actions     = []

  for (const ticket of tickets) {
    const createdAt   = new Date(ticket.created_at).getTime()
    const ageHours    = (now - createdAt) / (1000 * 60 * 60)
    const priority    = ticket.priority || 'normal'
    const slaLimit    = SLA_HOURS[priority] || SLA_HOURS.normal
    const isOverdue   = ageHours > slaLimit

    if (!isOverdue) continue

    // Send acknowledgment SMS to customer if they have a phone and haven't been acknowledged yet
    const customerPhone = ticket.customer_phone
    if (customerPhone && !ticket.acknowledged_at) {
      try {
        const message = await generateAcknowledgment(client, ticket)
        if (message) {
          const gateResult = validateSMS(message, { businessName: client.business_name })
          if (gateResult.valid) {
            await sendSMS({
              from:           client.twilio_number || process.env.TWILIO_PHONE_NUMBER,
              to:             customerPhone,
              body:           message,
              clientApiKeys:  {},
              clientSlug:     client.email,
              clientTimezone: 'America/Chicago',
            })
            await supabase.from('client_support_tickets').update({
              acknowledged_at: new Date().toISOString(),
            }).eq('id', ticket.id)
            acknowledged++
            actions.push(`Acknowledgment sent to customer for ticket ${ticket.id}`)
          } else {
            console.warn(`[${AGENT_ID}] message-gate blocked acknowledgment: ${gateResult.issues.join('; ')}`)
          }
        }
      } catch (err) {
        console.error(`[${AGENT_ID}] Acknowledgment SMS failed for ticket ${ticket.id}:`, err.message)
      }
    }

    // Mark ticket as escalated to director
    try {
      await supabase.from('client_support_tickets').update({
        escalated_at: new Date().toISOString(),
        status:       'escalated',
      }).eq('id', ticket.id)
      escalations++
      actions.push(`Ticket ${ticket.id} escalated (${Math.floor(ageHours)}h overdue, ${priority} priority)`)
    } catch (err) {
      console.error(`[${AGENT_ID}] Escalation update failed for ticket ${ticket.id}:`, err.message)
    }
  }

  if (!acknowledged && !escalations) return null

  return {
    agentId:                   AGENT_ID,
    clientId:                  client.id,
    timestamp:                 Date.now(),
    status:                    'action_taken',
    summary:                   `${acknowledged} acknowledgment(s) sent, ${escalations} ticket(s) escalated for ${client.business_name}`,
    data:                      { acknowledged, escalated: escalations, actions },
    requiresDirectorAttention: escalations > 0,
  }
}

/**
 * Generate a customer acknowledgment SMS for an overdue ticket via Groq.
 * @param {Object} client
 * @param {Object} ticket
 * @returns {Promise<string|null>}
 */
async function generateAcknowledgment(client, ticket) {
  const systemPrompt = `<business>
Name: ${client.business_name}
</business>

<ticket>
Issue: ${ticket.subject || 'your recent inquiry'}
Customer: ${ticket.customer_name || 'there'}
Priority: ${ticket.priority || 'normal'}
</ticket>

<task>
Write a brief SMS to acknowledge this customer's support request and let them
know the team is on it. Do not make specific promises about resolution time.
</task>

<rules>
- 2 sentences max
- Empathetic and reassuring
- Do not mention specific time commitments
- Sign off as ${client.business_name}
- Output ONLY the SMS text
</rules>`

  try {
    return await aiClient.call({
      modelString:   'groq/llama-3.3-70b-versatile',
      clientApiKeys: {},
      systemPrompt,
      messages:      [{ role: 'user', content: 'Write the acknowledgment SMS.' }],
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} support escalation actions taken`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
