'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// ReviewVelocity — Review Velocity Tracker
// Monitors review request success rate per client over the last 7 days.
// Flags clients whose velocity drops below 1.0 reviews/day.
// Division: brand
// Reports to: brand-director
// Runs: on-demand (called by BrandDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')

const SPECIALIST_ID = 'review-velocity'
const DIVISION      = 'brand'
const REPORTS_TO    = 'brand-director'

const VELOCITY_THRESHOLD = 1.0 // reviews/day — flag below this

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

async function run(clients = []) {
  console.log(`[${SPECIALIST_ID.toUpperCase()}] Starting run — ${clients.length} client(s)`)
  const supabase = getSupabase()
  const outcomes = []

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  for (const client of clients) {
    try {
      const result = await processClient(client, supabase, sevenDaysAgo)
      if (result) outcomes.push(result)
    } catch (err) {
      console.error(`[${SPECIALIST_ID}] Error for client ${client.id}:`, err.message)
    }
  }

  return buildReport(outcomes)
}

async function processClient(client, supabase, sevenDaysAgo) {
  // Count review_request_sent actions for this client in last 7 days
  const { count, error } = await supabase
    .from('activity_log')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', client.id)
    .eq('worker_id', 'review-requester')
    .eq('action', 'review_request_sent')
    .gte('created_at', sevenDaysAgo)

  if (error) {
    console.warn(`[${SPECIALIST_ID}] Query failed for ${client.id}: ${error.message}`)
    return null
  }

  const requestCount = count || 0
  const velocity     = requestCount / 7  // reviews per day

  const flagged = velocity < VELOCITY_THRESHOLD

  // Log the velocity check
  await supabase.from('activity_log').insert({
    client_id:   client.id,
    worker_id:   SPECIALIST_ID,
    worker_name: 'Review Velocity Tracker',
    action:      'velocity_check',
    message:     `Review velocity: ${velocity.toFixed(2)}/day over last 7 days (${requestCount} requests). ${flagged ? 'FLAGGED — below threshold.' : 'OK.'}`,
    outcome:     flagged ? 'error' : 'ok',
    metadata:    { requestCount, velocity: parseFloat(velocity.toFixed(2)), threshold: VELOCITY_THRESHOLD, flagged },
    created_at:  new Date().toISOString(),
  }).catch(e => console.warn(`[${SPECIALIST_ID}] activity_log insert failed: ${e.message}`))

  console.log(`[${SPECIALIST_ID}] ${client.business_name || client.id}: velocity=${velocity.toFixed(2)}/day${flagged ? ' FLAGGED' : ''}`)

  return {
    agentId:      SPECIALIST_ID,
    clientId:     client.id,
    timestamp:    Date.now(),
    status:       flagged ? 'action_taken' : 'no_action',
    actionsCount: flagged ? 1 : 0,
    summary:      `Review velocity ${velocity.toFixed(2)}/day for ${client.business_name || client.id}${flagged ? ' — below threshold, escalating' : ''}`,
    escalations:  [],
    data:         { clientId: client.id, velocity: parseFloat(velocity.toFixed(2)), flag: flagged, requestCount },
    requiresDirectorAttention: flagged,
  }
}

function buildReport(outcomes) {
  const totalActions = outcomes.reduce((sum, o) => sum + (o.actionsCount || 0), 0)
  const flagged      = outcomes.filter(o => o.data?.flag)
  console.log(`[${SPECIALIST_ID.toUpperCase()}] Complete — ${flagged.length} client(s) flagged for low review velocity`)
  return {
    agentId:      SPECIALIST_ID,
    division:     DIVISION,
    reportsTo:    REPORTS_TO,
    timestamp:    Date.now(),
    actionsCount: totalActions,
    escalations:  outcomes.filter(o => o.requiresDirectorAttention),
    outcomes,
    data:         { velocityReports: outcomes.map(o => o.data).filter(Boolean) },
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION, REPORTS_TO }
