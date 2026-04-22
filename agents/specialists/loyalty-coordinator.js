'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// LoyaltyCoordinator — Milestone rewards: 30/60/90 day marks, 100th task, 6-month, $10k value
// Division: experience
// Reports to: experience-director
// Runs: on-demand (called by ExperienceDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient = require('../../lib/ai-client')
const { sendSMS } = require('../../lib/twilio-client')
const { validateSMS } = require('../../lib/message-gate')
const { buildClientContext } = require('../../lib/client-context')

const AGENT_ID  = 'loyalty-coordinator'
const DIVISION  = 'experience'
const REPORTS_TO = 'experience-director'

const MILESTONES = [
  { id: 'day_30',      key: 'day_30',      label: '30-day mark',        check: (d, t) => d >= 30  && d < 31 },
  { id: 'day_60',      key: 'day_60',      label: '60-day mark',        check: (d, t) => d >= 60  && d < 61 },
  { id: 'day_90',      key: 'day_90',      label: '90-day mark',        check: (d, t) => d >= 90  && d < 91 },
  { id: 'day_180',     key: 'day_180',     label: '6-month anniversary', check: (d, t) => d >= 180 && d < 181 },
  { id: 'task_100',    key: 'task_100',    label: '100th task',          check: (d, t) => t >= 100 },
  { id: 'task_500',    key: 'task_500',    label: '500th task',          check: (d, t) => t >= 500 },
  { id: 'revenue_10k', key: 'revenue_10k', label: '$10k value milestone', check: (d, t, rev) => typeof rev === 'number' && rev >= 10000 },
]

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

  const daysSinceSignup = Math.floor((now - new Date(client.created_at).getTime()) / (1000 * 60 * 60 * 24))

  // Get total task count
  const { count: totalTasks } = await supabase
    .from('activity_log')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', client.id)

  // Get already-celebrated milestones
  const { data: celebratedData } = await supabase
    .from('agent_state')
    .select('state')
    .eq('agent', 'loyalty_coordinator')
    .eq('client_id', client.id)
    .eq('entity_id', 'celebrated_milestones')
    .single()

  const celebrated = celebratedData?.state?.milestones || []
  const actionsTaken = []

  // Total revenue — optional field, skip gracefully if absent
  const totalRevenue = typeof client.totalRevenue === 'number' ? client.totalRevenue : null

  for (const milestone of MILESTONES) {
    if (celebrated.includes(milestone.key)) continue

    // task_500 is not available on free tier
    if (milestone.id === 'task_500' && client.plan === 'free') continue

    // revenue_10k: only check when totalRevenue is known
    if (milestone.id === 'revenue_10k') {
      if (totalRevenue === null || !milestone.check(daysSinceSignup, totalTasks || 0, totalRevenue)) continue
    } else {
      if (!milestone.check(daysSinceSignup, totalTasks || 0, totalRevenue)) continue
    }

    // This milestone is newly hit
    const ownerPhone = client.owner_cell
    if (!ownerPhone) continue

    try {
      const message = await generateCelebrationMessage(client, milestone, { daysSinceSignup, totalTasks, totalRevenue })
      if (!message) continue

      const gateResult = validateSMS(message, { businessName: client.business_name })
      if (!gateResult.valid) {
        console.warn(`[${AGENT_ID}] message-gate blocked SMS: ${gateResult.issues.join('; ')}`)
        continue
      }

      await sendSMS({
        from: client.twilio_number || process.env.TWILIO_PHONE_NUMBER,
        to: ownerPhone,
        body: message,
        clientApiKeys: {},
        clientSlug: client.email,
        clientTimezone: 'America/Chicago',
      })

      // Mark as celebrated
      const newCelebrated = [...celebrated, milestone.key]
      await supabase.from('agent_state').upsert({
        agent: 'loyalty_coordinator',
        client_id: client.id,
        entity_id: 'celebrated_milestones',
        state: { milestones: newCelebrated },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'agent,client_id,entity_id' })

      actionsTaken.push(milestone.label)
    } catch (err) {
      console.error(`[${AGENT_ID}] Celebration failed for ${milestone.key}:`, err.message)
    }
  }

  if (!actionsTaken.length) return null

  return {
    agentId: AGENT_ID,
    clientId: client.id,
    timestamp: Date.now(),
    status: 'action_taken',
    summary: `Celebrated milestones for ${client.business_name}: ${actionsTaken.join(', ')}`,
    data: { milestones: actionsTaken },
    requiresDirectorAttention: false,
  }
}

async function generateCelebrationMessage(client, milestone, stats) {
  const ctx = buildClientContext(client)

  const systemPrompt = `${ctx.xml}

<milestone>
Achievement: ${milestone.label}
Days active: ${stats.daysSinceSignup}
Total tasks completed: ${stats.totalTasks || 0}
${stats.totalRevenue !== null ? `Total value generated: $${stats.totalRevenue.toLocaleString()}` : ''}
</milestone>

<task>
Write a genuine, warm celebration SMS for this milestone.
Match the tone of the business vertical — energetic for gyms and fitness, professional warmth for B2B and legal, fun enthusiasm for family entertainment, warm and friendly for personal care.
Make them feel valued and recognized. Highlight what they've accomplished.
</task>

<rules>
- 2-3 sentences max
- Genuinely enthusiastic, not hollow — let the vertical tone shine
- Reference the specific milestone
- Sign off as GRIDHAND
- Output ONLY the SMS text
</rules>`

  return aiClient.call({
    modelString: 'groq/llama-3.3-70b-versatile',
    clientApiKeys: {},
    systemPrompt,
    messages: [{ role: 'user', content: 'Write the celebration message.' }],
    maxTokens: 150,
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} milestones celebrated`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
