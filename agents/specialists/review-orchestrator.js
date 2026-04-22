'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// ReviewOrchestrator — Times review requests 45-90 min after positive service; 30-day suppression
// Division: brand
// Reports to: brand-director
// Runs: on-demand (called by BrandDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient = require('../../lib/ai-client')
const { sendSMS } = require('../../lib/twilio-client')
const { validateSMS } = require('../../lib/message-gate')
const { buildClientContext } = require('../../lib/client-context')
const { fileInteraction } = require('../../lib/memory-client')

const AGENT_ID  = 'review-orchestrator'
const DIVISION  = 'brand'
const REPORTS_TO = 'brand-director'

const REQUEST_DELAY_MIN = 45  // minutes after service interaction
const REQUEST_DELAY_MAX = 90
const SUPPRESSION_DAYS  = 30

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

  const windowStart = new Date(now - REQUEST_DELAY_MAX * 60 * 1000).toISOString()
  const windowEnd   = new Date(now - REQUEST_DELAY_MIN * 60 * 1000).toISOString()

  // Find positive service completions in the 45-90 min window
  const { data: serviceEvents } = await supabase
    .from('activity_log')
    .select('*')
    .eq('client_id', client.id)
    .in('worker_name', ['appointment_completed', 'service_completed', 'booking_fulfilled', 'task_completed'])
    .gte('created_at', windowStart)
    .lte('created_at', windowEnd)
    .is('review_requested', null)

  if (!serviceEvents?.length) return null

  let actionsTaken = 0
  const requestsSent = []

  for (const event of serviceEvents) {
    const customerPhone = event.metadata?.customerPhone
    if (!customerPhone) continue

    // Suppression check — don't ask if we asked in the last 30 days
    const { data: suppressState } = await supabase
      .from('agent_state')
      .select('state')
      .eq('agent', 'review_orchestrator')
      .eq('client_id', client.id)
      .eq('entity_id', `review_asked:${customerPhone}`)
      .single()

    if (suppressState?.state?.lastAskedAt) {
      const daysSince = (now - new Date(suppressState.state.lastAskedAt).getTime()) / (1000 * 60 * 60 * 24)
      if (daysSince < SUPPRESSION_DAYS) continue
    }

    try {
      const message = await generateReviewRequest(client, event)
      if (!message) continue

      const gateResult = validateSMS(message, { businessName: client.business_name })
      if (!gateResult.valid) {
        console.warn(`[${AGENT_ID}] message-gate blocked SMS: ${gateResult.issues.join('; ')}`)
        continue
      }

      await sendSMS({
        from: client.twilio_number || process.env.TWILIO_PHONE_NUMBER,
        to: customerPhone,
        body: message,
        clientApiKeys: {},
        clientSlug: client.email,
        clientTimezone: 'America/Chicago',
      })

      // Update suppression state
      await supabase.from('agent_state').upsert({
        agent: 'review_orchestrator',
        client_id: client.id,
        entity_id: `review_asked:${customerPhone}`,
        state: { lastAskedAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'agent,client_id,entity_id' })

      // Mark event as handled
      await supabase.from('activity_log').update({ review_requested: new Date().toISOString() }).eq('id', event.id)

      actionsTaken++
      requestsSent.push({ event: event.action })
    } catch (err) {
      console.error(`[${AGENT_ID}] Review request failed:`, err.message)
    }
  }

  if (!actionsTaken) return null

  return {
    agentId: AGENT_ID,
    clientId: client.id,
    timestamp: Date.now(),
    status: 'action_taken',
    summary: `${actionsTaken} review request(s) sent for ${client.business_name}`,
    data: { requestsSent },
    requiresDirectorAttention: false,
  }
}

async function generateReviewRequest(client, event) {
  const ctx = buildClientContext(client)

  // Resolve review link — check multiple locations, skip entirely if missing
  let reviewLink = client.integrations?.google_review_link || client.worker_config?.review_link || null

  if (!reviewLink) {
    console.warn(`[review-orchestrator] no review link for ${client.business_name}, skipping`)
    return null
  }

  const customerName = event.metadata?.customerName || event.metadata?.customerFirstName || null

  const systemPrompt = `${ctx.xml}

<context>
Customer just had a positive service experience (${event.action.replace(/_/g, ' ')}).
This is the perfect moment for a review request — they're happy right now.
${customerName ? `Customer's first name: ${customerName}` : 'No customer name available.'}
Review link: ${reviewLink}
</context>

<task>
Write a brief, natural review request SMS.
Reference that they just used the service. Make the ask feel effortless.
${customerName ? `Address them by first name (${customerName}).` : 'Do NOT use "Hi there" — open warmly without a name.'}
Include the review link.
</task>

<rules>
- 2-3 sentences max
- Casual, grateful tone
- Don't beg or over-explain
- Sign off as ${client.business_name}
- Output ONLY the SMS text
</rules>`

  return aiClient.call({
    modelString: 'groq/llama-3.3-70b-versatile',
    clientApiKeys: {},
    systemPrompt,
    messages: [{ role: 'user', content: 'Write the review request.' }],
    maxTokens: 140,
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} review requests sent`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
