'use strict'
// ── GRIDHAND AGENT — TIER 1 ───────────────────────────────────────────────────
// PlatformDirector — Infrastructure health. Monitors Railway worker health,
// failed agent runs, API error rates, and Supabase connectivity.
// Division: platform
// Reports to: gridhand-commander
// Runs: every 15 minutes
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../lib/ai-client')

const workerGuardian = require('./worker-guardian')

const AGENT_ID   = 'platform-director'
const DIVISION   = 'platform'
const REPORTS_TO = 'gridhand-commander'
const GROQ_MODEL = 'groq/llama-3.3-70b-versatile'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

async function checkSupabaseHealth(supabase) {
  const start = Date.now()
  try {
    await supabase.from('clients').select('id').limit(1)
    return { status: 'ok', latencyMs: Date.now() - start }
  } catch (err) {
    return { status: 'error', latencyMs: Date.now() - start, error: err.message }
  }
}

async function getRecentWorkerFailures(supabase) {
  try {
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    const { data } = await supabase
      .from('activity_log')
      .select('agent_id, outcome, created_at, metadata')
      .eq('outcome', 'error')
      .gte('created_at', since)
    const byAgent = {}
    for (const row of data || []) {
      byAgent[row.agent_id] = (byAgent[row.agent_id] || 0) + 1
    }
    return { failures: data || [], byAgent }
  } catch { return { failures: [], byAgent: {} } }
}

async function getQueueDepth(supabase) {
  try {
    const { count } = await supabase
      .from('activity_log')
      .select('id', { count: 'exact', head: true })
      .eq('outcome', 'pending')
    return count || 0
  } catch { return 0 }
}

async function synthesizePlatformHealth(dbHealth, workerFailures, queueDepth, guardianResult) {
  const failureCount = workerFailures.failures.length
  const hotAgents    = Object.entries(workerFailures.byAgent)
    .filter(([, c]) => c >= 2)
    .map(([id, c]) => `${id}(${c}x)`)

  try {
    const raw = await call({
      modelString: GROQ_MODEL,
      systemPrompt: `<role>PlatformDirector for GRIDHAND AI — assess system infrastructure health and surface operational hotspots.</role>
<rules>Analyze DB latency, worker failure count, hot agents, and queue depth. Flag anything that needs immediate attention.</rules>
<output>Respond with valid JSON only: { "status": "healthy|degraded|down", "hotspots": ["string"], "recommendation": "one sentence" }</output>`,
      messages: [{
        role: 'user',
        content: `DB latency: ${dbHealth.latencyMs}ms (${dbHealth.status}). Worker failures last 15m: ${failureCount}. Hot agents: ${hotAgents.join(', ') || 'none'}. Queue depth: ${queueDepth}.`,
      }],
      maxTokens: 150,
    })
    const match = raw?.match(/\{[\s\S]*\}/)
    if (match) return { ...JSON.parse(match[0]), dbHealth, failureCount, queueDepth }
  } catch {}
  return { status: dbHealth.status === 'error' ? 'degraded' : 'healthy', hotspots: hotAgents, dbHealth, failureCount, queueDepth }
}

async function run(clients = null, situation = null) {
  console.log(`[${AGENT_ID.toUpperCase()}] Platform health check`)
  const supabase = getSupabase()

  const [dbHealth, workerFailures, queueDepth, guardianResult] = await Promise.all([
    checkSupabaseHealth(supabase),
    getRecentWorkerFailures(supabase),
    getQueueDepth(supabase),
    workerGuardian.run ? workerGuardian.run({ quiet: true }).catch(() => null) : Promise.resolve(null),
  ])

  const assessment = await synthesizePlatformHealth(dbHealth, workerFailures, queueDepth, guardianResult)
  const isDegraded = assessment.status === 'degraded' || assessment.status === 'down'

  if (isDegraded) {
    console.warn(`[${AGENT_ID.toUpperCase()}] Platform ${assessment.status.toUpperCase()} — ${assessment.recommendation}`)
  } else {
    console.log(`[${AGENT_ID.toUpperCase()}] Platform healthy — DB ${dbHealth.latencyMs}ms, ${workerFailures.failures.length} errors`)
  }

  return report([{
    agentId:   AGENT_ID,
    clientId:  'system',
    timestamp: Date.now(),
    status:    assessment.status,
    summary:   `Platform: ${assessment.status}. DB ${dbHealth.latencyMs}ms. ${workerFailures.failures.length} worker errors. Queue: ${queueDepth}.`,
    data:      assessment,
    requiresDirectorAttention: isDegraded,
  }])
}

function report(outcomes) {
  const escalations = outcomes.filter(o => o.requiresDirectorAttention)
  return {
    agentId:      AGENT_ID,
    division:     DIVISION,
    reportsTo:    REPORTS_TO,
    timestamp:    Date.now(),
    totalClients: outcomes.length,
    actionsCount: escalations.length,
    escalations,
    outcomes,
  }
}

module.exports = { run, report, AGENT_ID, DIVISION, REPORTS_TO }
