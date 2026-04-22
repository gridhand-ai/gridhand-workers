'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// ColdOutreach — Reactivates cold prospects (>30 days no response), max 3 attempts
// Division: acquisition
// Reports to: acquisition-director
// Runs: on-demand (called by AcquisitionDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient = require('../../lib/ai-client')
const { sendSMS } = require('../../lib/twilio-client')
const { validateSMS } = require('../../lib/message-gate')

const AGENT_ID  = 'cold-outreach'
const DIVISION  = 'acquisition'
const REPORTS_TO = 'acquisition-director'

const COLD_THRESHOLD_DAYS = 30
const MAX_ATTEMPTS = 3

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

  // Find cold leads: no inbound reply for 30+ days, not archived, attempts < 3
  const { data: leads } = await supabase
    .from('agent_state')
    .select('entity_id, state')
    .eq('agent', 'lead_nurture')
    .eq('client_id', client.id)
    .like('entity_id', 'lead:%')

  if (!leads?.length) return null

  let actionsTaken = 0
  let archived = 0
  const reachOuts = []

  for (const row of leads) {
    const state = row.state || {}
    if (state.archived) continue
    if (!['warm', 'new', 'contacted'].includes(state.status)) continue

    const lastActivity = state.lastInboundAt || state.lastContactAt || state.createdAt
    if (!lastActivity) continue

    const daysSince = (now - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24)
    if (daysSince < COLD_THRESHOLD_DAYS) continue

    const coldAttempts = state.coldAttempts || 0
    const phone = row.entity_id.replace('lead:', '')

    // Archive after max attempts
    if (coldAttempts >= MAX_ATTEMPTS) {
      await supabase.from('agent_state').upsert({
        agent: 'lead_nurture',
        client_id: client.id,
        entity_id: row.entity_id,
        state: { ...state, archived: true, status: 'archived', archivedReason: 'cold_max_attempts' },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'agent,client_id,entity_id' })
      archived++
      continue
    }

    try {
      const message = await generateReEngagementMessage(client, state, coldAttempts + 1)
      if (!message) continue

      const gateResult = validateSMS(message, { businessName: client.business_name })
      if (!gateResult.valid) {
        console.warn(`[${AGENT_ID}] message-gate blocked SMS: ${gateResult.issues.join('; ')}`)
        continue
      }

      await sendSMS({
        from: client.twilio_number || process.env.TWILIO_PHONE_NUMBER,
        to: phone,
        body: message,
        clientApiKeys: {},
        clientSlug: client.email,
        clientTimezone: 'America/Chicago',
      })

      await supabase.from('agent_state').upsert({
        agent: 'lead_nurture',
        client_id: client.id,
        entity_id: row.entity_id,
        state: {
          ...state,
          coldAttempts: coldAttempts + 1,
          lastContactAt: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'agent,client_id,entity_id' })

      actionsTaken++
      reachOuts.push({ attempt: coldAttempts + 1, inquiry: state.inquiryAbout })
    } catch (err) {
      console.error(`[${AGENT_ID}] Re-engagement failed:`, err.message)
    }
  }

  if (!actionsTaken && !archived) return null

  return {
    agentId: AGENT_ID,
    clientId: client.id,
    timestamp: Date.now(),
    status: 'action_taken',
    summary: `${actionsTaken} cold re-engagement(s) sent, ${archived} archived for ${client.business_name}`,
    data: { reachOuts, archived },
    requiresDirectorAttention: false,
  }
}

async function generateReEngagementMessage(client, leadState, attemptNumber) {
  const tones = {
    1: 'curious and helpful — wonder if timing changed for them',
    2: 'brief and value-focused — one specific benefit they might be missing',
    3: 'graceful farewell — no hard feelings, door always open',
  }

  const systemPrompt = `<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<lead>
Original inquiry: ${leadState.inquiryAbout || 'your services'}
Days since last contact: 30+
Re-engagement attempt: ${attemptNumber} of ${MAX_ATTEMPTS}
</lead>

<task>
Write a cold re-engagement SMS. Tone: ${tones[attemptNumber] || tones[3]}.
${attemptNumber === MAX_ATTEMPTS ? 'This is the last message we will send.' : ''}
</task>

<rules>
- 1-2 sentences max
- Natural and human, not salesy
- Don't reference previous attempts or that this is automated
- Sign off as ${client.business_name}
- Output ONLY the SMS text
</rules>`

  return aiClient.call({
    modelString: 'groq/llama-3.3-70b-versatile',
    clientApiKeys: {},
    systemPrompt,
    messages: [{ role: 'user', content: 'Write the re-engagement message.' }],
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
