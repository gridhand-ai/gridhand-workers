'use strict'
// tier: standard
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// ROIReporter — ROI Snapshot per client
// Calculates review requests sent, calls handled, leads contacted over last 30 days.
// Generates a "value delivered" summary keyed to the client's plan cost.
// Division: brand
// Reports to: brand-director
// Runs: on-demand (called by BrandDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { getPlanCost } = require('../../lib/plan-catalog')

const SPECIALIST_ID = 'roi-reporter'
const DIVISION      = 'brand'
const REPORTS_TO    = 'brand-director'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

async function run(clients = []) {
  console.log(`[${SPECIALIST_ID.toUpperCase()}] Starting run — ${clients.length} client(s)`)
  const supabase    = getSupabase()
  const outcomes    = []
  const thirtyAgo   = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  for (const client of clients) {
    try {
      const result = await processClient(client, supabase, thirtyAgo)
      if (result) outcomes.push(result)
    } catch (err) {
      console.error(`[${SPECIALIST_ID}] Error for client ${client.id}:`, err.message)
    }
  }

  return buildReport(outcomes)
}

async function processClient(client, supabase, thirtyAgo) {
  // Gather metrics in parallel
  const [reviewRes, callRes, leadRes] = await Promise.allSettled([
    // Review requests sent (last 30 days)
    supabase
      .from('activity_log')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', client.id)
      .eq('action', 'review_request_sent')
      .gte('created_at', thirtyAgo),

    // Calls handled (call_logs table)
    supabase
      .from('call_logs')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', client.id)
      .gte('created_at', thirtyAgo),

    // Leads contacted (status != 'new')
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', client.id)
      .neq('status', 'new')
      .gte('created_at', thirtyAgo),
  ])

  const reviewCount  = reviewRes.status === 'fulfilled'  ? (reviewRes.value.count  || 0) : 0
  const callCount    = callRes.status   === 'fulfilled'  ? (callRes.value.count    || 0) : 0
  const leadCount    = leadRes.status   === 'fulfilled'  ? (leadRes.value.count    || 0) : 0

  const planKey  = (client.plan || 'starter').toLowerCase()
  const planCost = getPlanCost(planKey) || getPlanCost('starter')

  // Value summary — plain language, no invented dollar amounts beyond plan cost
  const summary = buildValueSummary(client, reviewCount, callCount, leadCount, planCost)

  const metrics = { review_requests_sent: reviewCount, calls_handled: callCount, leads_contacted: leadCount }

  // Log snapshot to activity_log
  await supabase.from('activity_log').insert({
    client_id:   client.id,
    worker_id:   SPECIALIST_ID,
    worker_name: 'ROI Reporter',
    action:      'roi_snapshot',
    message:     summary,
    outcome:     'ok',
    metadata:    { metrics, planCost, plan: planKey },
    created_at:  new Date().toISOString(),
  }).catch(e => console.warn(`[${SPECIALIST_ID}] activity_log insert failed: ${e.message}`))

  console.log(`[${SPECIALIST_ID}] ${client.business_name || client.id}: reviews=${reviewCount}, calls=${callCount}, leads=${leadCount}`)

  return {
    agentId:      SPECIALIST_ID,
    clientId:     client.id,
    timestamp:    Date.now(),
    status:       'action_taken',
    actionsCount: 1,
    summary,
    escalations:  [],
    data:         { clientId: client.id, metrics, planCost, summary },
    requiresDirectorAttention: false,
  }
}

function buildValueSummary(client, reviews, calls, leads, planCost) {
  const name = client.business_name || 'your business'
  const parts = []
  if (reviews > 0) parts.push(`${reviews} review request${reviews === 1 ? '' : 's'} sent`)
  if (calls > 0)   parts.push(`${calls} call${calls === 1 ? '' : 's'} handled`)
  if (leads > 0)   parts.push(`${leads} lead${leads === 1 ? '' : 's'} contacted`)

  const activity = parts.length ? parts.join(', ') : 'monitoring active'
  return `${name}: $${planCost}/mo plan — last 30 days: ${activity}.`
}

function buildReport(outcomes) {
  const totalActions = outcomes.reduce((sum, o) => sum + (o.actionsCount || 0), 0)
  console.log(`[${SPECIALIST_ID.toUpperCase()}] Complete — ${totalActions} ROI snapshot(s) generated`)
  return {
    agentId:      SPECIALIST_ID,
    division:     DIVISION,
    reportsTo:    REPORTS_TO,
    timestamp:    Date.now(),
    actionsCount: totalActions,
    escalations:  outcomes.filter(o => o.requiresDirectorAttention),
    outcomes,
    data:         { snapshots: outcomes.map(o => o.data).filter(Boolean) },
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION, REPORTS_TO }
