'use strict'
// ── OG GRIDHAND AGENT — TIER 2 ────────────────────────────────────────────────
// AcquisitionDirector — Manages lead pipeline; delegates to 4 specialists
// Division: acquisition
// Reports to: gridhand-commander
// Runs: every 30 minutes (via Commander cascade)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')

const leadQualifier     = require('./specialists/lead-qualifier')
const prospectNurturer  = require('./specialists/prospect-nurturer')
const referralActivator = require('./specialists/referral-activator')
const coldOutreach      = require('./specialists/cold-outreach')

const AGENT_ID  = 'acquisition-director'
const DIVISION  = 'acquisition'
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

  // Run all acquisition specialists in parallel
  const [qualifierReport, nurturerReport, referralReport, coldReport] = await Promise.allSettled([
    leadQualifier.run(clientList),
    prospectNurturer.run(clientList),
    referralActivator.run(clientList),
    coldOutreach.run(clientList),
  ])

  const childReports = [qualifierReport, nurturerReport, referralReport, coldReport]
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)

  // Receive reports from each specialist
  for (const r of childReports) {
    await receive(r)
  }

  // Aggregate totals
  const totalActions = childReports.reduce((sum, r) => sum + (r.actionsCount || 0), 0)
  const escalations  = childReports.flatMap(r => r.escalations || [])
  const hotLeads     = childReports.flatMap(r =>
    (r.outcomes || []).filter(o => o.requiresDirectorAttention)
  )

  return report([{
    agentId: AGENT_ID,
    clientId: 'all',
    timestamp: Date.now(),
    status: totalActions > 0 ? 'action_taken' : 'no_action',
    summary: `Acquisition: ${totalActions} total actions across ${clientList.length} clients. ${hotLeads.length} hot lead(s) detected.`,
    data: { totalActions, hotLeads, childReports },
    requiresDirectorAttention: hotLeads.length > 0,
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report complete — ${totalActions} acquisition actions`)
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
