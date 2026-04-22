'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// PricingOptimizer — Identifies underpriced clients (90%+ plan usage), flags for upgrade
// Division: revenue
// Reports to: revenue-director
// Runs: on-demand (called by RevenueDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { fileInteraction } = require('../../lib/memory-client')
const vault = require('../../lib/memory-vault')

const AGENT_ID  = 'pricing-optimizer'
const DIVISION  = 'revenue'
const REPORTS_TO = 'revenue-director'

// Usage threshold above which we flag for upgrade conversation
const USAGE_THRESHOLD = 0.90

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
  // Store offer structure (pricing analysis) per client into shared vault
  for (const r of reports) {
    if (r.clientId) {
      await vault.store(r.clientId, vault.KEYS.OFFER_STRUCTURE, {
        upgradeFlagged: r.status === 'action_taken',
        usagePercent: r.data?.usagePercent,
        summary: r.summary || 'pricing optimization check complete',
        timestamp: Date.now(),
      }, 7, AGENT_ID).catch(() => {})
    }
  }
  return specialistReport
}

async function processClient(client) {
  const supabase = getSupabase()

  // Get current month task count
  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const { count: taskCount } = await supabase
    .from('activity_log')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', client.id)
    .gte('created_at', startOfMonth.toISOString())

  const planLimit = client.task_limit || client.tasks_limit || 500
  const usageRatio = (taskCount || 0) / planLimit
  const usagePct = Math.round(usageRatio * 100)

  if (usageRatio < USAGE_THRESHOLD) return null

  // Already flagged this month?
  const { data: flagState } = await supabase
    .from('agent_state')
    .select('state')
    .eq('agent', 'pricing_optimizer')
    .eq('client_id', client.id)
    .eq('entity_id', 'upgrade_flag')
    .single()

  const flaggedAt = flagState?.state?.flaggedAt
  if (flaggedAt) {
    const daysSince = (Date.now() - new Date(flaggedAt).getTime()) / (1000 * 60 * 60 * 24)
    if (daysSince < 30) return null // Don't re-flag within 30 days
  }

  // Flag for upgrade conversation
  await supabase.from('agent_state').upsert({
    agent: 'pricing_optimizer',
    client_id: client.id,
    entity_id: 'upgrade_flag',
    state: {
      flaggedAt: new Date().toISOString(),
      usagePct,
      taskCount,
      planLimit,
      currentPlan: client.plan || 'unknown',
    },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'agent,client_id,entity_id' })

  // Log to activity
  await supabase.from('activity_log').insert({
    client_id: client.id,
    action: 'upgrade_opportunity_flagged',
    summary: `Client at ${usagePct}% of plan usage`,
    metadata: { usagePct, taskCount, planLimit },
    created_at: new Date().toISOString(),
  })

  return {
    agentId: AGENT_ID,
    clientId: client.id,
    timestamp: Date.now(),
    status: 'action_taken',
    summary: `${client.business_name} at ${usagePct}% plan usage — flagged for upgrade conversation`,
    data: { usagePct, taskCount, planLimit, currentPlan: client.plan },
    requiresDirectorAttention: true, // Always escalate — this is a revenue conversation
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} clients flagged for upgrade`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
