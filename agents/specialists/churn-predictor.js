'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// ChurnPredictor — Weekly churn risk score 1-10 per client; score 7+ triggers intervention
// Division: experience
// Reports to: experience-director
// Runs: on-demand (called by ExperienceDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient = require('../../lib/ai-client')
const { buildClientContext } = require('../../lib/client-context')
const { fileInteraction } = require('../../lib/memory-client')
const vault = require('../../lib/memory-vault')

const AGENT_ID  = 'churn-predictor'
const DIVISION  = 'experience'
const REPORTS_TO = 'experience-director'

const CHURN_RISK_THRESHOLD = 7

// How often this vertical's clients are expected to generate activity
const CYCLE_MAP = {
  'food-beverage':     'daily',
  'vehicle-service':   'weekly',
  'real-estate':       'monthly',
  'professional-b2b':  'monthly',
}

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
  // Store churn signals per client into shared vault
  for (const r of reports) {
    if (r.clientId) {
      await vault.store(r.clientId, vault.KEYS.CHURN_SIGNALS, {
        score: r.data?.score,
        engagementTrend: r.data?.signals?.engagementTrend,
        tasksPast7d: r.data?.signals?.tasksPast7d,
        highRisk: r.requiresDirectorAttention || false,
        summary: r.summary || 'churn analysis complete',
        timestamp: Date.now(),
      }, 8, AGENT_ID).catch(() => {})
    }
  }
  return specialistReport
}

async function processClient(client) {
  const supabase = getSupabase()
  const now = Date.now()

  // Gather signals
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
  const sevenDaysAgo  = new Date(now - 7  * 24 * 60 * 60 * 1000).toISOString()

  const [
    { count: totalTasks30d },
    { count: tasksPast7d },
    { count: supportTickets30d },
  ] = await Promise.all([
    supabase.from('activity_log').select('*', { count: 'exact', head: true }).eq('client_id', client.id).gte('created_at', thirtyDaysAgo),
    supabase.from('activity_log').select('*', { count: 'exact', head: true }).eq('client_id', client.id).gte('created_at', sevenDaysAgo),
    supabase.from('activity_log').select('*', { count: 'exact', head: true }).eq('client_id', client.id).eq('worker_name', 'support_ticket').gte('created_at', thirtyDaysAgo),
  ])

  // Compute engagement trend (are they doing fewer tasks this week vs avg week last month?)
  const avgWeeklyTasks = (totalTasks30d || 0) / 4
  const engagementTrend = avgWeeklyTasks > 0
    ? ((tasksPast7d || 0) - avgWeeklyTasks) / avgWeeklyTasks
    : 0

  const signals = {
    totalTasks30d: totalTasks30d || 0,
    tasksPast7d: tasksPast7d || 0,
    supportTickets30d: supportTickets30d || 0,
    engagementTrend,
    daysSinceSignup: Math.floor((now - new Date(client.created_at).getTime()) / (1000 * 60 * 60 * 24)),
    planActive: client.stripe_data?.subscription_status === 'active',
  }

  const score = await scoreChurnRisk(client, signals)

  // Save churn score
  await supabase.from('agent_state').upsert({
    agent: 'churn_predictor',
    client_id: client.id,
    entity_id: 'churn_score',
    state: { score, signals, scoredAt: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'agent,client_id,entity_id' })

  if (score < CHURN_RISK_THRESHOLD) return null

  // Log high-risk alert
  await supabase.from('activity_log').insert({
    client_id: client.id,
    action: 'churn_risk',
    summary: `Churn risk score: ${score}/10`,
    metadata: { score, signals },
    created_at: new Date().toISOString(),
  })

  return {
    agentId: AGENT_ID,
    clientId: client.id,
    timestamp: Date.now(),
    status: 'action_taken',
    summary: `${client.business_name} churn risk: ${score}/10 — intervention needed`,
    data: { score, signals },
    requiresDirectorAttention: true,
  }
}

async function scoreChurnRisk(client, signals) {
  const ctx = buildClientContext(client)
  const expectedCycle = CYCLE_MAP[ctx.vertical] || 'weekly'

  const systemPrompt = `<client_context>
  Business: ${client.business_name}
  Vertical: ${ctx.vertical}
  Expected cycle: ${expectedCycle}
</client_context>

<task>
Score the churn risk for this client from 1-10.
10 = about to cancel, 1 = highly engaged and stable.
Factor in the expected activity cycle — a daily-cycle business (e.g. restaurant) with 0 tasks in 7 days is far more alarming than a monthly-cycle business (e.g. real estate firm) with the same signal.
</task>

<signals>
Tasks last 30 days: ${signals.totalTasks30d}
Tasks last 7 days: ${signals.tasksPast7d}
Engagement trend: ${signals.engagementTrend > 0 ? '+' : ''}${Math.round(signals.engagementTrend * 100)}%
Support tickets last 30 days: ${signals.supportTickets30d}
Days since signup: ${signals.daysSinceSignup}
Plan active: ${signals.planActive}
</signals>

<rules>
Reply with ONLY a number 1-10. Nothing else.
</rules>`

  try {
    const raw = await aiClient.call({
      modelString: 'groq/llama-3.3-70b-versatile',
      clientApiKeys: {},
      systemPrompt,
      messages: [{ role: 'user', content: 'Score the churn risk.' }],
      maxTokens: 5,
      _workerName: AGENT_ID,
    })
    const score = parseInt(raw?.trim(), 10)
    return (isNaN(score) || score < 1 || score > 10) ? 5 : score
  } catch {
    // Fallback: rule-based score
    let score = 1
    if (signals.tasksPast7d === 0) score += 3
    if (signals.engagementTrend < -0.5) score += 2
    if (signals.supportTickets30d >= 3) score += 2
    if (!signals.planActive) score += 3
    return Math.min(score, 10)
  }
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} high-risk clients flagged`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
