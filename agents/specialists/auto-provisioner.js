'use strict'
// tier: simple
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// AutoProvisioner — Auto Provisioner
// Detects new clients (onboarding_step >= 3) with no assigned workers yet
// and provisions Tier 1 defaults (receptionist, review-requester).
// Division: experience
// Reports to: experience-director
// Runs: on-demand (called by ExperienceDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')

const SPECIALIST_ID = 'auto-provisioner'
const DIVISION      = 'experience'
const REPORTS_TO    = 'experience-director'

// Tier 1 default workers provisioned for every new client
const TIER1_DEFAULTS = [
  { worker_id: 'receptionist',    tier: 1, active: true },
  { worker_id: 'review-requester', tier: 1, active: true },
]

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

  for (const client of clients) {
    try {
      const result = await processClient(client, supabase)
      if (result) outcomes.push(result)
    } catch (err) {
      console.error(`[${SPECIALIST_ID}] Error for client ${client.id}:`, err.message)
    }
  }

  return buildReport(outcomes)
}

async function processClient(client, supabase) {
  // Only process clients at onboarding_step >= 3
  if ((client.onboarding_step || 0) < 3) return null

  // Check if this client already has any assigned_workers rows (avoid double-provisioning)
  const { data: existing, error: checkError } = await supabase
    .from('assigned_workers')
    .select('worker_id')
    .eq('client_id', client.id)
    .limit(1)

  if (checkError) {
    console.warn(`[${SPECIALIST_ID}] assigned_workers check failed for ${client.id}: ${checkError.message}`)
    return null
  }

  // Already provisioned — skip
  if (existing && existing.length > 0) return null

  console.log(`[${SPECIALIST_ID}] Provisioning Tier 1 workers for ${client.business_name || client.id}`)

  // Insert default workers
  const rows = TIER1_DEFAULTS.map(w => ({
    client_id: client.id,
    worker_id: w.worker_id,
    tier:      w.tier,
    active:    w.active,
    created_at: new Date().toISOString(),
  }))

  const { error: insertError } = await supabase.from('assigned_workers').insert(rows)

  if (insertError) {
    console.error(`[${SPECIALIST_ID}] assigned_workers insert failed for ${client.id}: ${insertError.message}`)
    return null
  }

  // Log to activity_log
  await supabase.from('activity_log').insert({
    client_id:   client.id,
    worker_id:   SPECIALIST_ID,
    worker_name: 'Auto Provisioner',
    action:      'auto_provisioned',
    message:     `Tier 1 workers provisioned: ${TIER1_DEFAULTS.map(w => w.worker_id).join(', ')}`,
    outcome:     'ok',
    metadata:    { provisioned: TIER1_DEFAULTS.map(w => w.worker_id) },
    created_at:  new Date().toISOString(),
  }).catch(e => console.warn(`[${SPECIALIST_ID}] activity_log insert failed: ${e.message}`))

  return {
    agentId:      SPECIALIST_ID,
    clientId:     client.id,
    timestamp:    Date.now(),
    status:       'action_taken',
    actionsCount: TIER1_DEFAULTS.length,
    summary:      `Provisioned ${TIER1_DEFAULTS.length} Tier 1 worker(s) for ${client.business_name || client.id}`,
    escalations:  [],
    data:         { provisioned: TIER1_DEFAULTS.map(w => w.worker_id) },
    requiresDirectorAttention: false,
  }
}

function buildReport(outcomes) {
  const totalActions = outcomes.reduce((sum, o) => sum + (o.actionsCount || 0), 0)
  const provisioned  = outcomes.filter(o => o.status === 'action_taken')
  console.log(`[${SPECIALIST_ID.toUpperCase()}] Complete — ${provisioned.length} client(s) provisioned, ${totalActions} worker slot(s) created`)
  return {
    agentId:      SPECIALIST_ID,
    division:     DIVISION,
    reportsTo:    REPORTS_TO,
    timestamp:    Date.now(),
    actionsCount: totalActions,
    escalations:  outcomes.filter(o => o.requiresDirectorAttention),
    outcomes,
    data:         { provisionedClients: provisioned.length },
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION, REPORTS_TO }
