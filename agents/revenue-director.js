'use strict'
// ── OG GRIDHAND AGENT — TIER 2 ────────────────────────────────────────────────
// RevenueDirector — Manages all money automation; escalates if revenue at risk > $500
// Division: revenue
// Reports to: gridhand-commander
// Runs: every hour (via Commander cascade)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')

const invoiceRecovery   = require('./specialists/invoice-recovery')
const upsellTimer       = require('./specialists/upsell-timer')
const subscriptionGuard = require('./specialists/subscription-guard')
const pricingOptimizer  = require('./specialists/pricing-optimizer')

const AGENT_ID  = 'revenue-director'
const DIVISION  = 'revenue'
const REPORTS_TO = 'gridhand-commander'

const ESCALATION_REVENUE_THRESHOLD = 500

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

async function run(clients = null, situation = null) {
  console.log(`[${AGENT_ID.toUpperCase()}] Starting run — situation: ${situation || 'scheduled'}`)

  const clientList = clients || await getActiveClients()
  if (!clientList.length) return report([])

  // Run all revenue specialists in parallel
  const [invoiceReport, upsellReport, guardReport, pricingReport] = await Promise.allSettled([
    invoiceRecovery.run(clientList),
    upsellTimer.run(clientList),
    subscriptionGuard.run(clientList),
    pricingOptimizer.run(clientList),
  ])

  const childReports = [invoiceReport, upsellReport, guardReport, pricingReport]
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)

  for (const r of childReports) {
    await receive(r)
  }

  // Check total revenue at risk
  const totalAtRisk = childReports.reduce((sum, r) => {
    return sum + ((r.outcomes || []).reduce((s, o) => s + (o.data?.totalAtRisk || 0), 0))
  }, 0)

  const totalActions = childReports.reduce((sum, r) => sum + (r.actionsCount || 0), 0)
  const escalations  = childReports.flatMap(r => r.escalations || [])

  const needsCommanderAlert = totalAtRisk > ESCALATION_REVENUE_THRESHOLD || escalations.length > 0

  return report([{
    agentId: AGENT_ID,
    clientId: 'all',
    timestamp: Date.now(),
    status: totalActions > 0 ? 'action_taken' : 'no_action',
    summary: `Revenue: ${totalActions} total actions. $${totalAtRisk} at risk. ${escalations.length} escalation(s).`,
    data: { totalActions, totalAtRisk, escalations, childReports },
    requiresDirectorAttention: needsCommanderAlert,
  }])
}

async function report(outcomes) {
  const totalActions = outcomes.reduce((sum, o) => sum + (o.actionsCount || (o.status === 'action_taken' ? 1 : 0)), 0)
  const summary = {
    agentId: AGENT_ID,
    division: DIVISION,
    reportsTo: REPORTS_TO,
    timestamp: Date.now(),
    totalClients: outcomes.length,
    actionsCount: totalActions,
    escalations: outcomes.filter(o => o.requiresDirectorAttention),
    outcomes,
  }
  console.log(`[${AGENT_ID.toUpperCase()}] Report complete — ${totalActions} revenue actions`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.actionsCount || 0} actions`)
}

async function getActiveClients() {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('is_active', true)
  if (error) {
    console.error(`[${AGENT_ID}] Failed to load clients:`, error.message)
    return []
  }
  return data || []
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
