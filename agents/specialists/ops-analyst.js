'use strict'
// ── NEXUS — Operations Analyst ────────────────────────────────────────────────
// Codename: NEXUS
// Role: Monitors all active workers/agents, surfaces bottlenecks, flags failures
// Division: internal
// Model: groq/llama-3.3-70b-versatile
//
// Modes:
//   audit    — what's broken or failing right now
//   optimize — what's underperforming (high error rate, low throughput)
//   report   — weekly ops summary across the full fleet
//
// Does NOT send SMS. Does NOT go through message-gate.js — internal output only.
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../../lib/ai-client')

const SPECIALIST_ID = 'ops-analyst'
const DIVISION      = 'internal'
const MODEL         = 'groq/llama-3.3-70b-versatile'

const NEXUS_SYSTEM = `<role>
You are NEXUS, the Operations Analyst for GRIDHAND AI. You monitor the full agent fleet — workers, specialists, directors, and the Commander — to surface bottlenecks, failures, and underperformance before they impact clients.
</role>

<architecture>
GRIDHAND Workers (Railway):
- 15 active SMS workers per client (60+ on bench)
- Commander runs every 15 min, orchestrates 5 Directors
- Directors run specialists on-demand
- Specialists log outcomes to activity_log and agent_state in Supabase
- Bull + Redis for job queues
- Token usage tracked in token_tracker table
</architecture>

<rules>
- audit mode: identify specific agents/workers with error rates above 10%, stalled queues, or missed runs in the last 24h
- optimize mode: surface agents with low action rates, high token spend relative to outcomes, or patterns that indicate misconfiguration
- report mode: produce a structured weekly summary — total actions, error rates, top performers, bottom performers, cost vs outcome
- Always output structured JSON matching the defined output schema
- Never mention Make.com — refer to it as "the integration layer"
- Flag anything that requires human (MJ) intervention in the escalations array
</rules>

<quality_standard>
SPECIALIST OUTPUT DISCIPLINE:
Never use: "I believe", "it seems", "perhaps", "it appears", "Certainly!", "Great!", "I'd be happy to", "Of course!", "I'm sorry", "Unfortunately", "I apologize", "I understand", "As an AI"
Outcome-first: lead with the issue or recommendation, not the analysis
Return structured JSON only — no unstructured prose responses
Never explain reasoning unless confidence < 0.7 or explicitly asked
If confidence < 0.7, set escalate: true and include reasoning_short.
</quality_standard>
<output>
Return valid JSON only. Schema: { issues: [], recommendations: [], summary: string, confidence: number (0.0-1.0), escalate: boolean, reasoning_short: string (max 20 words) }
issues: array of { agentId, severity: 'critical'|'warning'|'info', description, affectedClients? }
recommendations: array of { action, rationale, priority: 'high'|'medium'|'low' }
summary: one-paragraph plain-English ops summary
confidence: 0.0-1.0 confidence in the audit findings
escalate: true if confidence < 0.7 or any critical issue found
</output>`

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Run NEXUS — Operations Analyst.
 *
 * @param {object} params
 * @param {'audit'|'optimize'|'report'} params.mode
 * @param {string} [params.clientSlug]  - Scope to a specific client (optional)
 * @param {string} [params.dateRange]   - e.g. '7d', '24h', '30d' (default '7d')
 * @returns {Promise<{success: boolean, issues: Array, recommendations: Array, summary: string, specialist: string}>}
 */
async function run({ mode = 'audit', clientSlug = null, dateRange = '7d' } = {}) {
  console.log(`[NEXUS] run() — mode: ${mode}, clientSlug: ${clientSlug || 'all'}, dateRange: ${dateRange}`)

  const validModes = ['audit', 'optimize', 'report']
  if (!validModes.includes(mode)) {
    return {
      success: false,
      issues: [],
      recommendations: [],
      summary: `Invalid mode "${mode}". Valid options: audit, optimize, report.`,
      specialist: SPECIALIST_ID,
    }
  }

  const supabase = getSupabase()

  // Pull recent activity_log data for context
  const hoursBack = dateRange === '24h' ? 24 : dateRange === '30d' ? 720 : 168 // default 7d
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString()

  let activityQuery = supabase
    .from('activity_log')
    .select('worker_name, action, summary, created_at, client_id')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(200)

  if (clientSlug) {
    // Filter by client slug via a join pattern — use ilike on summary as fallback
    activityQuery = activityQuery.ilike('summary', `%${clientSlug}%`)
  }

  const { data: recentActivity, error: activityErr } = await activityQuery
  if (activityErr) {
    console.error('[NEXUS] activity_log query failed:', activityErr.message)
  }

  // Pull error-class entries
  const { data: errorEntries } = await supabase
    .from('activity_log')
    .select('worker_name, action, summary, created_at')
    .ilike('action', '%error%')
    .gte('created_at', since)
    .limit(50)

  const modeInstructions = {
    audit:    'Identify all critical failures, stalled agents, missed runs, and error spikes in the last period. Rank by severity. Output JSON only.',
    optimize: 'Identify agents with low throughput, high token cost relative to outcomes, and configuration issues that reduce effectiveness. Output JSON only.',
    report:   'Produce a comprehensive weekly operations summary. Include total actions, error rates, top-performing agents, underperformers, cost trends, and 3 concrete improvement recommendations. Output JSON only.',
  }

  const contextBlock = [
    `MODE: ${mode.toUpperCase()}`,
    `DATE RANGE: last ${dateRange}`,
    clientSlug ? `CLIENT SCOPE: ${clientSlug}` : 'CLIENT SCOPE: all clients',
    '',
    `INSTRUCTION: ${modeInstructions[mode]}`,
    '',
    'RECENT ACTIVITY SAMPLE:',
    JSON.stringify((recentActivity || []).slice(0, 50), null, 2),
    '',
    'RECENT ERRORS:',
    JSON.stringify((errorEntries || []).slice(0, 20), null, 2),
  ].join('\n')

  let rawOutput = null
  try {
    rawOutput = await call({
      modelString:  MODEL,
      systemPrompt: NEXUS_SYSTEM,
      messages:     [{ role: 'user', content: contextBlock }],
      maxTokens:    2000,
    })
  } catch (err) {
    console.error('[NEXUS] call failed:', err.message)
    return {
      success:         false,
      issues:          [],
      recommendations: [],
      summary:         `NEXUS failed: ${err.message}`,
      specialist:      SPECIALIST_ID,
    }
  }

  // Parse JSON response
  let parsed = { issues: [], recommendations: [], summary: rawOutput || '' }
  try {
    const jsonMatch = rawOutput?.match(/\{[\s\S]*\}/)
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0])
  } catch {
    parsed.summary = rawOutput || 'Could not parse NEXUS output.'
  }

  console.log(`[NEXUS] Output ready — ${parsed.issues?.length || 0} issues, ${parsed.recommendations?.length || 0} recommendations`)
  return {
    success:         true,
    issues:          parsed.issues          || [],
    recommendations: parsed.recommendations || [],
    summary:         parsed.summary         || '',
    specialist:      SPECIALIST_ID,
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION }
