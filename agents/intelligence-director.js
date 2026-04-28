'use strict'
// ── OG GRIDHAND AGENT — TIER 2 ────────────────────────────────────────────────
// IntelligenceDirector — Coordinates all monitoring & intelligence agents.
// Synthesizes system health, client signals, and operational patterns into
// a strategic brief for the Commander.
//
// Division: intelligence
// Reports to: gridhand-commander
// Runs: every 60 minutes
// Scout → Opus pattern: Groq reads everything, Opus synthesizes the brief
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../lib/ai-client')
const { scout }        = require('../lib/scout')
const vault            = require('../lib/memory-vault')

const exa                = require('../lib/exa-client')

const dailyDigest        = require('./daily-digest')
const credentialMonitor  = require('./credential-monitor')
const workerGuardian     = require('./worker-guardian')
const n8nEngine          = require('./n8n-scenario-engine')
const competitorMonitor       = require('./specialists/competitor-monitor')
const marketPulse             = require('./specialists/market-pulse')
const performanceBenchmarker  = require('./specialists/performance-benchmarker')
const vanguard                = require('./specialists/vanguard')
const sentinel                = require('./specialists/sentinel')
const lumen                   = require('./specialists/lumen')
const promptEngineer          = require('./specialists/prompt-engineer')
// Arsenal — MJ's personal reporting toolkit (on-demand, not in automated hourly run)
const pulse                   = require('./specialists/pulse')  // Monthly Report Generator

// ── New Tools Available (2026-04-27) ──────────────────────────────────────────
// humanizer  — ~/.claude/skills/humanizer/SKILL.md — apply to ALL client-facing copy before sending
// remotion   — MCP: remotion-video — animated reports, video deliverables, dashboard recordings
// notebooklm — MCP: notebooklm — internal research only, query GRIDHAND docs and architecture
// gemini-image — MCP: gemini-image — generate design references, UI mockups, client visual assets
// Access via TOOL_REGISTRY in gridhand-commander.js

const AGENT_ID   = 'intelligence-director'
const DIVISION   = 'intelligence'
const REPORTS_TO = 'gridhand-commander'

// Arsenal specialists available to intelligence-director on-demand
const ARSENAL_SPECIALISTS = {
  'pulse': pulse,  // Monthly ROI report generator
}
const OPUS_MODEL = 'groq/llama-3.3-70b-versatile'

// Module-level cache of the latest strategic assessment — populated by run()
// getBrief() returns it so the Commander can inject it into director runs
let _latestBrief = null

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// ── Format client_knowledge rows into a compact string for Scout sources ──────
function formatClientMemory(clientList) {
  const rows = []
  for (const c of clientList) {
    if (!c.clientKnowledge || !c.clientKnowledge.length) continue
    for (const k of c.clientKnowledge) {
      rows.push(`[${c.business_name || c.id}] ${k.category}: ${k.content}`)
    }
  }
  return rows.slice(0, 15).join('\n') || 'No client knowledge available.'
}

async function run(clients = null, situation = null) {
  console.log(`[${AGENT_ID.toUpperCase()}] Starting run`)
  const supabase   = getSupabase()
  const clientList = clients || await getActiveClients(supabase)
  const now        = Date.now()

  // ── Load shared memory context ────────────────────────────────────────────
  const clientId     = clientList[0]?.id
  const vaultContext = clientId ? await vault.getContext(clientId).catch(() => '') : ''

  // ── Run all intelligence agents in parallel ──────────────────────────────
  console.log(`[${AGENT_ID.toUpperCase()}] Running intelligence agents in parallel...`)
  const [
    guardianResult,
    credentialResult,
    reputationResult,
    retentionResult,
    leadNurtureResult,
    marketPulseResult,
    performanceBenchResult,
    vanguardResult,
    sentinelResult,
    lumenResult,
    promptEngineerResult,
  ] = await Promise.allSettled([
    workerGuardian.run  ? workerGuardian.run({ quiet: true })         : Promise.resolve(null),
    credentialMonitor.run ? credentialMonitor.run()                   : Promise.resolve(null),
    // reputationAgent, retentionAgent, leadNurtureAgent are operational agents —
    // they send SMS and require a single UUID clientId, not a clientList array.
    // Their scheduled runs are handled by server.js setIntervals. Resolved here
    // as null so the intelligence brief treats them as skipped (not errored).
    Promise.resolve(null),
    Promise.resolve(null),
    Promise.resolve(null),
    marketPulse.run(clientList),
    performanceBenchmarker.run(clientList),
    vanguard.run(clientList),
    sentinel.run(clientList),
    lumen.run(clientList),
    promptEngineer.run(),
  ])

  const agentOutputs = {
    workerGuardian:        guardianResult.status          === 'fulfilled' ? guardianResult.value          : { error: guardianResult.reason?.message },
    credentials:           credentialResult.status        === 'fulfilled' ? credentialResult.value        : { error: credentialResult.reason?.message },
    reputation:            reputationResult.status        === 'fulfilled' ? reputationResult.value        : { error: reputationResult.reason?.message },
    retention:             retentionResult.status         === 'fulfilled' ? retentionResult.value         : { error: retentionResult.reason?.message },
    leadNurture:           leadNurtureResult.status       === 'fulfilled' ? leadNurtureResult.value       : { error: leadNurtureResult.reason?.message },
    marketPulse:           marketPulseResult.status       === 'fulfilled' ? marketPulseResult.value       : { error: marketPulseResult.reason?.message },
    performanceBenchmarks: performanceBenchResult.status  === 'fulfilled' ? performanceBenchResult.value  : { error: performanceBenchResult.reason?.message },
    vanguard:              vanguardResult.status          === 'fulfilled' ? vanguardResult.value          : { error: vanguardResult.reason?.message },
    sentinel:              sentinelResult.status          === 'fulfilled' ? sentinelResult.value          : { error: sentinelResult.reason?.message },
    lumen:                 lumenResult.status             === 'fulfilled' ? lumenResult.value             : { error: lumenResult.reason?.message },
    promptEngineer:        promptEngineerResult.status    === 'fulfilled' ? promptEngineerResult.value    : { error: promptEngineerResult.reason?.message },
  }

  // Pull recent system signals from Supabase
  const systemSignals = await getSystemSignals(supabase, now)

  // ── SCOUT: Groq reads all agent outputs + system signals ─────────────────
  console.log(`[${AGENT_ID.toUpperCase()}] Scout synthesizing intelligence...`)
  let intelligenceBrief = null
  try {
    intelligenceBrief = await scout({
      task: 'Synthesize all intelligence agent outputs into a strategic brief for the Commander. Identify system health issues, client risk patterns, operational anomalies, and opportunities.',
      sources: [
        { label: 'agent_outputs',   content: agentOutputs },
        { label: 'system_signals',  content: systemSignals },
        { label: 'active_clients',  content: clientList.map(c => ({ id: c.id, name: c.business_name, plan: c.plan, industry: c.industry })) },
        { label: 'vault_context',   content: vaultContext || 'No vault context yet.' },
        { label: 'client_memory',   content: formatClientMemory(clientList) },
      ],
      maxTokens: 4000,
    })
  } catch (err) {
    console.warn(`[${AGENT_ID}] Scout failed:`, err.message)
  }

  // ── OPUS: Strategic synthesis ─────────────────────────────────────────────
  let strategicReport = null
  if (intelligenceBrief) {
    try {
      const clientMemoryBlock = formatClientMemory(clientList)
      const opusResponse = await call({
        tier: 'standard',
        _workerName: 'intelligence-director',
        systemPrompt: `<role>IntelligenceDirector for GRIDHAND AI — synthesize operational intelligence and provide strategic assessments to the Commander.</role>${vaultContext ? `\n<context>${vaultContext}</context>` : ''}${clientMemoryBlock !== 'No client knowledge available.' ? `\n<client_memory>\n${clientMemoryBlock}\n</client_memory>` : ''}
<rules>Analyze the intelligence brief and produce a structured strategic assessment. Be direct — surface real risks, not generic observations.</rules>
<quality_standard>
DIRECTOR OUTPUT DISCIPLINE:
Never use: "I believe", "it seems", "perhaps", "it appears", "Certainly!", "Great!", "I'd be happy to", "Of course!", "I'm sorry", "Unfortunately", "I apologize", "I understand", "As an AI"
Outcome-first: lead with the decision or action, not the analysis
Return structured JSON only — no unstructured prose responses
Never explain reasoning unless confidence < 0.7 or explicitly asked
Escalate to Commander when: confidence < 0.6 OR situation is outside your defined scope
</quality_standard>
<output>Respond with valid JSON only:
{
  "system_health": "GREEN",
  "critical_alerts": ["alert1"],
  "client_risks": [{"clientId": "id", "risk": "description", "severity": "high"}],
  "opportunities": ["opportunity1"],
  "recommended_actions": ["action1"],
  "confidence": 85,
  "escalate": false
}
system_health values: "GREEN" | "YELLOW" | "RED"
confidence: integer 0-100 (set escalate: true if below 60)</output>`,
        messages: [{ role: 'user', content: `INTELLIGENCE BRIEF:\n\n${intelligenceBrief}\n\nProvide strategic assessment as JSON only.` }],
        maxTokens: 1000,
      })
      const match = opusResponse?.match(/\{[\s\S]*\}/)
      if (match) strategicReport = JSON.parse(match[0])
    } catch (err) {
      console.warn(`[${AGENT_ID}] Opus synthesis failed:`, err.message)
    }
  }

  const summary = strategicReport || {
    system_health: 'UNKNOWN',
    critical_alerts: [],
    client_risks: [],
    opportunities: [],
    recommended_actions: [],
  }

  // Cache the brief so Commander can call getBrief() to inject into director runs
  if (strategicReport) {
    _latestBrief = {
      system_health:       summary.system_health,
      critical_alerts:     summary.critical_alerts || [],
      client_risks:        summary.client_risks    || [],
      opportunities:       summary.opportunities   || [],
      recommended_actions: summary.recommended_actions || [],
      confidence:          summary.confidence      || null,
      generated_at:        new Date().toISOString(),
    }
  }

  const actionsCount = (summary.critical_alerts?.length || 0) + (summary.recommended_actions?.length || 0)

  console.log(`[${AGENT_ID.toUpperCase()}] Complete — health: ${summary.system_health}, ${actionsCount} actions flagged`)

  return report([{
    agentId:  AGENT_ID,
    clientId: 'system',
    timestamp: now,
    status:   actionsCount > 0 ? 'action_taken' : 'no_action',
    summary:  `Intelligence: ${summary.system_health} health, ${summary.critical_alerts?.length || 0} critical alert(s), ${summary.client_risks?.length || 0} client risk(s)`,
    data:     summary,
    requiresDirectorAttention: summary.system_health === 'RED' || (summary.critical_alerts?.length || 0) > 0,
  }])
}

async function getSystemSignals(supabase, now) {
  const signals = {}
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString()
  const oneDayAgo  = new Date(now - 24 * 60 * 60 * 1000).toISOString()

  try {
    const [errorsRes, activityRes, runsRes] = await Promise.allSettled([
      supabase.from('worker_errors').select('worker_name, error_message, created_at').gte('created_at', oneHourAgo).limit(20),
      supabase.from('activity_log').select('client_id, worker_name, created_at').gte('created_at', oneDayAgo).limit(100),
      supabase.from('agent_runs').select('agent_id, status, summary, ran_at').gte('ran_at', oneDayAgo).limit(50),
    ])
    signals.recent_errors   = errorsRes.status   === 'fulfilled' ? errorsRes.value.data   || [] : []
    signals.recent_activity = activityRes.status === 'fulfilled' ? activityRes.value.data || [] : []
    signals.recent_runs     = runsRes.status     === 'fulfilled' ? runsRes.value.data     || [] : []
  } catch (err) {
    console.warn(`[${AGENT_ID}] System signal fetch failed:`, err.message)
  }
  return signals
}

async function report(outcomes) {
  const actionsCount = outcomes.reduce((s, o) => s + (o.actionsCount || (o.status === 'action_taken' ? 1 : 0)), 0)
  return {
    agentId:    AGENT_ID,
    division:   DIVISION,
    reportsTo:  REPORTS_TO,
    timestamp:  Date.now(),
    actionsCount,
    escalations: outcomes.filter(o => o.requiresDirectorAttention),
    outcomes,
  }
}

async function getActiveClients(supabase) {
  const { data, error } = await supabase.from('clients').select('*').eq('is_active', true)
  if (error) { console.error(`[${AGENT_ID}] Client load failed:`, error.message); return [] }
  return data || []
}

// ── getBrief: returns the latest strategic assessment as a formatted string ───
// Called by gridhand-commander before dispatching directors, so each director
// receives the Intelligence brief as a commanderBrief context injection.
function getBrief() {
  if (!_latestBrief) return null
  const { system_health, critical_alerts, client_risks, opportunities, recommended_actions, generated_at } = _latestBrief
  const lines = [
    `INTELLIGENCE BRIEF (${generated_at}) — System Health: ${system_health}`,
  ]
  if (critical_alerts?.length) {
    lines.push(`Critical alerts: ${critical_alerts.slice(0, 3).join('; ')}`)
  }
  if (client_risks?.length) {
    lines.push(`Client risks: ${client_risks.slice(0, 3).map(r => `${r.clientId || r} (${r.severity || 'medium'})`).join(', ')}`)
  }
  if (opportunities?.length) {
    lines.push(`Opportunities: ${opportunities.slice(0, 2).join('; ')}`)
  }
  if (recommended_actions?.length) {
    lines.push(`Recommended actions: ${recommended_actions.slice(0, 3).join('; ')}`)
  }
  return lines.join('\n')
}

// ── runInternalIntelligence: delegates to competitor-monitor Mode A ───────────
// Aggregates city/industry-wide open data into the industry_intelligence table.
// @param {string} industry - 'restaurant' | 'auto' | 'salon' | 'retail'
// @param {string} city     - e.g. 'Milwaukee'
// @param {string} state    - e.g. 'WI'
async function runInternalIntelligence(industry, city, state) {
  console.log(`[${AGENT_ID.toUpperCase()}] runInternalIntelligence: ${industry} / ${city}, ${state}`)
  try {
    return await competitorMonitor.runInternal({ industry, city, state })
  } catch (err) {
    console.error(`[${AGENT_ID}] runInternalIntelligence failed:`, err.message)
    return { status: 'error', reason: err.message }
  }
}

// ── runClientMonitoring: delegates to competitor-monitor Mode B ───────────────
// Monitors specific competitors per client, saves insights to competitor_monitoring.
// Does NOT send alerts — alert delivery is handled separately via message-gate.
// @param {string} clientId
// @param {Array<{name: string, url: string, platform: string}>} competitors
async function runClientMonitoring(clientId, competitors) {
  console.log(`[${AGENT_ID.toUpperCase()}] runClientMonitoring: clientId=${clientId}`)
  try {
    return await competitorMonitor.runClient({ clientId, competitors })
  } catch (err) {
    console.error(`[${AGENT_ID}] runClientMonitoring failed:`, err.message)
    return { status: 'error', reason: err.message }
  }
}

// ── discoverUrl: Mirror Engine entry point ────────────────────────────────────
// Runs xray-agent on a prospect URL, logs the run to agent_runs, returns manifest.
// @param {string} url - Prospect website URL
// @returns {Promise<object>} ClientManifest
async function discoverUrl(url) {
  console.log(`[${AGENT_ID.toUpperCase()}] discoverUrl: ${url}`)
  const supabase = getSupabase()
  const xray = require('./specialists/xray-agent')
  const startedAt = new Date().toISOString()

  let manifest = null
  let runStatus = 'error'

  try {
    manifest = await xray.discover(url)
    runStatus = manifest.hipaa_risk ? 'blocked' : 'success'
  } catch (err) {
    console.error(`[${AGENT_ID}] discoverUrl failed:`, err.message)
    manifest = {
      url,
      business_name: null,
      industry: 'unknown',
      brand_voice: null,
      services: [],
      tone: 'professional',
      social_links: [],
      phone: null,
      email: null,
      recommended_workers: [],
      knowledge_base_seed: [],
      hipaa_risk: false,
      scraped_at: startedAt,
      error: err.message,
    }
  }

  // Log to agent_runs
  try {
    await supabase.from('agent_runs').insert({
      agent_id:  AGENT_ID,
      status:    runStatus,
      summary:   `Mirror Engine discovery for ${url} — industry: ${manifest.industry || 'unknown'}, workers: ${manifest.recommended_workers?.length || 0}`,
      ran_at:    startedAt,
    })
  } catch (logErr) {
    console.warn(`[${AGENT_ID}] agent_runs log failed:`, logErr.message)
  }

  return manifest
}

module.exports = { run, report, getBrief, runInternalIntelligence, runClientMonitoring, discoverUrl, AGENT_ID, DIVISION, REPORTS_TO, ARSENAL_SPECIALISTS, schedule: '0 * * * *', tier: 2 }

// ── MISSION FILE CONSOLIDATION (weekly) ──────────────────────────────────────
// Reads ~/.claude/GRIDHAND_MISSION.md, removes duplicates, consolidates similar
// entries, keeps it sharp. Runs as part of the weekly intelligence cycle.
async function consolidateMissionFile() {
  const fs = require('fs')
  const path = require('path')
  const missionPath = path.join(process.env.HOME || '/root', '.claude/GRIDHAND_MISSION.md')

  if (!fs.existsSync(missionPath)) return

  const content = fs.readFileSync(missionPath, 'utf8')
  const lines = content.split('\n')

  // Deduplicate lines within sections (keep unique, preserve structure)
  const seen = new Set()
  const deduped = lines.filter(line => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---') || trimmed.startsWith('*') || trimmed.startsWith('-')) return true
    if (seen.has(trimmed)) return false
    seen.add(trimmed)
    return true
  })

  fs.writeFileSync(missionPath, deduped.join('\n'))
  console.log(`[INTELLIGENCE-DIRECTOR] Mission file consolidated: ${lines.length} → ${deduped.length} lines`)
}

module.exports.consolidateMissionFile = consolidateMissionFile
