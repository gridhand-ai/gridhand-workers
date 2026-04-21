'use strict'
// ── OG GRIDHAND AGENT — TIER 2 ────────────────────────────────────────────────
// BrandDirector — Manages reputation and marketing; alerts on negative review spikes
// Division: brand
// Reports to: gridhand-commander
// Runs: every hour (via Commander cascade)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')

const reviewOrchestrator = require('./specialists/review-orchestrator')
const socialManager      = require('./specialists/social-manager')
const brandSentinel      = require('./specialists/brand-sentinel')
const campaignConductor  = require('./specialists/campaign-conductor')

const AGENT_ID  = 'brand-director'
const DIVISION  = 'brand'
const REPORTS_TO = 'gridhand-commander'

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

  // Run all brand specialists in parallel
  const [reviewReport, socialReport, sentinelReport, campaignReport] = await Promise.allSettled([
    reviewOrchestrator.run(clientList),
    socialManager.run(clientList),
    brandSentinel.run(clientList),
    campaignConductor.run(clientList),
  ])

  const childReports = [reviewReport, socialReport, sentinelReport, campaignReport]
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)

  for (const r of childReports) {
    await receive(r)
  }

  const totalActions    = childReports.reduce((sum, r) => sum + (r.actionsCount || 0), 0)
  const escalations     = childReports.flatMap(r => r.escalations || [])
  const brandAlerts     = escalations.filter(e => e.data?.negativeCount >= 3)
  const needsCommanderAlert = brandAlerts.length > 0 || escalations.length > 2

  return report([{
    agentId: AGENT_ID,
    clientId: 'all',
    timestamp: Date.now(),
    status: totalActions > 0 ? 'action_taken' : 'no_action',
    summary: `Brand: ${totalActions} actions. ${brandAlerts.length} negative review spike(s). ${escalations.length} total escalation(s).`,
    data: { totalActions, brandAlerts, escalations, childReports },
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report complete — ${totalActions} brand actions`)
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
