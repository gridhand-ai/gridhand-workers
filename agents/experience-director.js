'use strict'
// ── OG GRIDHAND AGENT — TIER 2 ────────────────────────────────────────────────
// ExperienceDirector — Manages client success and retention; triggers on churn signals
// Division: experience
// Reports to: gridhand-commander
// Runs: every 2 hours (via Commander cascade)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')

const churnPredictor       = require('./specialists/churn-predictor')
const loyaltyCoordinator   = require('./specialists/loyalty-coordinator')
const clientSuccess        = require('./specialists/client-success')
const onboardingConductor  = require('./specialists/onboarding-conductor')

const AGENT_ID  = 'experience-director'
const DIVISION  = 'experience'
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

  // Separate new clients (< 30 days) for onboarding focus
  const now = Date.now()
  const newClients = clientList.filter(c => {
    const days = (now - new Date(c.created_at).getTime()) / (1000 * 60 * 60 * 24)
    return days <= 31
  })

  // Run all experience specialists in parallel
  const [churnReport, loyaltyReport, successReport, onboardingReport] = await Promise.allSettled([
    churnPredictor.run(clientList),
    loyaltyCoordinator.run(clientList),
    clientSuccess.run(clientList),
    onboardingConductor.run(newClients),
  ])

  const childReports = [churnReport, loyaltyReport, successReport, onboardingReport]
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)

  for (const r of childReports) {
    await receive(r)
  }

  const totalActions  = childReports.reduce((sum, r) => sum + (r.actionsCount || 0), 0)
  const churnRisks    = (churnReport.status === 'fulfilled' ? churnReport.value?.escalations : []) || []
  const needsAlert    = churnRisks.length > 0

  return report([{
    agentId: AGENT_ID,
    clientId: 'all',
    timestamp: Date.now(),
    status: totalActions > 0 ? 'action_taken' : 'no_action',
    summary: `Experience: ${totalActions} actions. ${churnRisks.length} churn risk(s) detected. ${newClients.length} client(s) in onboarding.`,
    data: { totalActions, churnRisks, newClients: newClients.length, childReports },
    requiresDirectorAttention: needsAlert,
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report complete — ${totalActions} experience actions`)
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
