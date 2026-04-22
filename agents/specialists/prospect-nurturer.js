'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// ProspectNurturer — Multi-touch sequences for warm leads (D1/D3/D7/D14)
// Division: acquisition
// Reports to: acquisition-director
// Runs: on-demand (called by AcquisitionDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient = require('../../lib/ai-client')
const { sendSMS } = require('../../lib/twilio-client')
const { validateSMS } = require('../../lib/message-gate')
const { buildClientContext } = require('../../lib/client-context')
const { fileInteraction } = require('../../lib/memory-client')
const vault = require('../../lib/memory-vault')

const AGENT_ID  = 'prospect-nurturer'
const DIVISION  = 'acquisition'
const REPORTS_TO = 'acquisition-director'

const TOUCH_DAYS = [1, 3, 7, 14]

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
  // Store customer pain points (prospect nurture touches) per client into shared vault
  for (const r of reports) {
    if (r.clientId) {
      await vault.store(r.clientId, vault.KEYS.CUSTOMER_PAIN_POINTS, {
        nurtureTouchSent: r.status === 'action_taken',
        summary: r.summary || 'prospect nurture cycle complete',
        timestamp: Date.now(),
      }, 6, AGENT_ID).catch(() => {})
    }
  }
  return specialistReport
}

async function processClient(client) {
  const supabase = getSupabase()
  const now = Date.now()

  // Fetch warm leads that haven't converted
  const { data: leads } = await supabase
    .from('agent_state')
    .select('entity_id, state')
    .eq('agent', 'lead_nurture')
    .eq('client_id', client.id)
    .like('entity_id', 'lead:%')

  if (!leads?.length) return null

  let actionsTaken = 0
  const touchResults = []

  for (const row of leads) {
    const state = row.state || {}
    if (state.archived || state.score === 'hot' || !['warm', 'new', 'contacted'].includes(state.status)) continue

    const createdAt = state.createdAt ? new Date(state.createdAt).getTime() : null
    if (!createdAt) continue

    const daysSince = (now - createdAt) / (1000 * 60 * 60 * 24)
    const completedTouches = state.followupDays || []
    const phone = row.entity_id.replace('lead:', '')

    // Find next due touch
    let dueTouchDay = null
    for (const day of TOUCH_DAYS) {
      if (daysSince >= day && !completedTouches.includes(day)) {
        dueTouchDay = day
        break
      }
    }

    if (!dueTouchDay) continue

    // Stop sequence if lead replied recently (< 6h)
    if (state.lastInboundAt && (now - new Date(state.lastInboundAt).getTime()) < 6 * 60 * 60 * 1000) continue

    try {
      const message = await generateTouchMessage(client, state, dueTouchDay)
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

      // Update state
      await supabase.from('agent_state').upsert({
        agent: 'lead_nurture',
        client_id: client.id,
        entity_id: row.entity_id,
        state: {
          ...state,
          followupDays: [...completedTouches, dueTouchDay],
          lastContactAt: new Date().toISOString(),
          followupsSent: (state.followupsSent || 0) + 1,
        },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'agent,client_id,entity_id' })

      actionsTaken++
      touchResults.push({ phone: phone.slice(-4), day: dueTouchDay })
    } catch (err) {
      console.error(`[${AGENT_ID}] Touch failed for ${client.id}:`, err.message)
    }
  }

  if (!actionsTaken) return null

  return {
    agentId: AGENT_ID,
    clientId: client.id,
    timestamp: Date.now(),
    status: 'action_taken',
    summary: `Sent ${actionsTaken} nurture touch(es) for ${client.business_name}`,
    data: { touchResults },
    requiresDirectorAttention: false,
  }
}

async function generateTouchMessage(client, leadState, touchDay) {
  const ctx = buildClientContext(client)
  const dayLabels = { 1: 'Day 1', 3: 'Day 3', 7: 'Day 7', 14: 'Day 14' }

  // Resolve name — split on space to get first name only, never use 'valued prospect'
  const firstName = leadState.customerName?.split(' ')[0] || leadState.firstName || null
  const greeting = firstName || ''

  const systemPrompt = `${ctx.xml}

<lead>
Inquiry: ${leadState.inquiryAbout || 'your services'}
${greeting ? `Name: ${greeting}` : ''}
Touch: ${dayLabels[touchDay]} follow-up
</lead>

<task>
Write a ${touchDay <= 3 ? 'warm and curious' : 'brief and low-pressure'} SMS follow-up.
${touchDay === 14 ? 'This is the last message — make it easy for them to say no.' : ''}
${greeting ? `Address them by first name (${greeting}).` : `Do NOT use "valued prospect" — if no name is available, open with a statement about their interest instead (e.g. "Still thinking about ${leadState.inquiryAbout || 'what we discussed'}?").`}
Personalize to their inquiry. Add one specific value point.
</task>

<rules>
- 1-2 sentences max
- Sound human, not scripted
- No "Just checking in!" openers
- Sign off as ${client.business_name}
- Output ONLY the SMS text
</rules>`

  return aiClient.call({
    modelString: 'groq/llama-3.3-70b-versatile',
    clientApiKeys: {},
    systemPrompt,
    messages: [{ role: 'user', content: 'Write the follow-up.' }],
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
