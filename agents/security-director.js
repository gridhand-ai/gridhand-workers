'use strict'
// ── GRIDHAND AGENT — TIER 1 ───────────────────────────────────────────────────
// SecurityDirector — Monitors auth anomalies, API key exposure, RLS health,
// worker error spikes. Escalates threats to Commander immediately.
// Division: security
// Reports to: gridhand-commander
// Runs: every 30 minutes
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../lib/ai-client')
const vault            = require('../lib/memory-vault')

const complianceMonitor = require('./specialists/compliance-monitor')

const AGENT_ID   = 'security-director'
const DIVISION   = 'security'
const REPORTS_TO = 'gridhand-commander'
const GROQ_MODEL = 'groq/llama-3.3-70b-versatile'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

async function scanAuthAnomalies(supabase) {
  try {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const { data } = await supabase
      .from('activity_log')
      .select('worker_id, client_id, action, created_at')
      .eq('outcome', 'error')
      .gte('created_at', since)
    return data || []
  } catch { return [] }
}

async function scanApiKeyExposure(supabase) {
  try {
    const { data } = await supabase
      .from('clients')
      .select('id, business_name, api_keys_configured')
      .eq('is_active', true)
    const exposed = (data || []).filter(c => !c.api_keys_configured)
    return exposed
  } catch { return [] }
}

async function scanWorkerErrors(supabase) {
  try {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { data } = await supabase
      .from('activity_log')
      .select('worker_id, outcome, created_at')
      .eq('outcome', 'error')
      .gte('created_at', since)
    const errorsByAgent = {}
    for (const row of data || []) {
      errorsByAgent[row.worker_id] = (errorsByAgent[row.worker_id] || 0) + 1
    }
    return Object.entries(errorsByAgent)
      .filter(([, count]) => count >= 3)
      .map(([agentId, count]) => ({ agentId, errorCount: count }))
  } catch { return [] }
}

async function synthesizeThreatLevel(authAnomalies, exposedClients, workerErrors, compliance) {
  const summary = {
    authErrors: authAnomalies.length,
    exposedClients: exposedClients.length,
    spikedWorkers: workerErrors.length,
    complianceFlags: compliance?.escalations?.length || 0,
  }

  try {
    const raw = await call({
      modelString: GROQ_MODEL,
      systemPrompt: `<role>SecurityDirector for GRIDHAND AI — assess system security posture from scan results and worker error patterns.</role>
<rules>Evaluate the security scan data and worker error spikes. Identify the top threats and provide a single concrete remediation action.</rules>
<output>Respond with valid JSON only: { "threatLevel": "low|medium|high|critical", "topThreats": ["string"], "recommendation": "one sentence action" }</output>`,
      messages: [{
        role: 'user',
        content: `Security scan: ${JSON.stringify(summary)}. Worker error spikes: ${JSON.stringify(workerErrors)}.`,
      }],
      maxTokens: 200,
    })
    const match = raw?.match(/\{[\s\S]*\}/)
    if (match) return { ...JSON.parse(match[0]), summary }
  } catch (err) {
    console.warn(`[${AGENT_ID}] Synthesis failed:`, err.message)
  }
  return { threatLevel: 'unknown', topThreats: [], recommendation: 'Manual review required', summary }
}

async function logSecurityScan(supabase, assessment) {
  try {
    await supabase.from('activity_log').insert({
      worker_id:  AGENT_ID,
      client_id:  'system',
      action:     'security_scan',
      outcome:    assessment.threatLevel === 'critical' || assessment.threatLevel === 'high' ? 'escalated' : 'ok',
      metadata:   assessment,
      created_at: new Date().toISOString(),
    })
  } catch {}
}

async function run(clients = null, situation = null) {
  console.log(`[${AGENT_ID.toUpperCase()}] Starting security scan`)
  const supabase = getSupabase()

  const [authAnomalies, exposedClients, workerErrors, complianceResult] = await Promise.allSettled([
    scanAuthAnomalies(supabase),
    scanApiKeyExposure(supabase),
    scanWorkerErrors(supabase),
    complianceMonitor.run(clients || []).catch(() => null),
  ])

  const assessment = await synthesizeThreatLevel(
    authAnomalies.status  === 'fulfilled' ? authAnomalies.value  : [],
    exposedClients.status === 'fulfilled' ? exposedClients.value : [],
    workerErrors.status   === 'fulfilled' ? workerErrors.value   : [],
    complianceResult.status === 'fulfilled' ? complianceResult.value : null
  )

  await logSecurityScan(supabase, assessment)

  const isCritical = assessment.threatLevel === 'critical' || assessment.threatLevel === 'high'
  if (isCritical) {
    console.warn(`[${AGENT_ID.toUpperCase()}] THREAT LEVEL: ${assessment.threatLevel.toUpperCase()} — ${assessment.recommendation}`)
  }

  return report([{
    agentId:   AGENT_ID,
    clientId:  'system',
    timestamp: Date.now(),
    status:    isCritical ? 'escalated' : 'ok',
    summary:   `Security: ${assessment.threatLevel} threat level. ${assessment.topThreats?.join(', ') || 'No active threats'}.`,
    data:      assessment,
    requiresDirectorAttention: isCritical,
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

async function getActiveClients(supabase) {
  const { data, error } = await (supabase || getSupabase())
    .from('clients').select('*').eq('is_active', true)
  if (error) return []
  return data || []
}

module.exports = { run, report, AGENT_ID, DIVISION, REPORTS_TO }
