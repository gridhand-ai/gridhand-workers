'use strict'
// ── OG GRIDHAND AGENT — TIER 2 ────────────────────────────────────────────────
// BrandDirector — Manages reputation and marketing; alerts on negative review spikes
// Division: brand
// Reports to: gridhand-commander
// Runs: every hour (via Commander cascade)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../lib/ai-client')
const vault            = require('../lib/memory-vault')

const reviewOrchestrator  = require('./specialists/review-orchestrator')
const socialManager       = require('./specialists/social-manager')
const brandSentinel       = require('./specialists/brand-sentinel')
const campaignConductor   = require('./specialists/campaign-conductor')
const contentScheduler    = require('./specialists/content-scheduler')
const reputationDefender  = require('./specialists/reputation-defender')
// Arsenal — MJ's personal marketing toolkit
const nova                = require('./specialists/nova')  // Content Creator

// ── New Tools Available (2026-04-27) ──────────────────────────────────────────
// humanizer  — ~/.claude/skills/humanizer/SKILL.md — apply to ALL client-facing copy before sending
// remotion   — MCP: remotion-video — animated reports, video deliverables, dashboard recordings
// notebooklm — MCP: notebooklm — internal research only, query GRIDHAND docs and architecture
// gemini-image — MCP: gemini-image — generate design references, UI mockups, client visual assets
// Access via TOOL_REGISTRY in gridhand-commander.js

const AGENT_ID   = 'brand-director'
const DIVISION   = 'brand'
const REPORTS_TO = 'gridhand-commander'
const GROQ_MODEL = 'groq/llama-3.3-70b-versatile'

// All specialists this director can dispatch, in default order
const ALL_SPECIALISTS = [
  'review-orchestrator', 'social-manager', 'brand-sentinel', 'campaign-conductor',
  'content-scheduler', 'reputation-defender',
  // Arsenal specialists (on-demand, not dispatched in automated runs)
  'nova',
]

const SPECIALIST_MAP = {
  'review-orchestrator': reviewOrchestrator,
  'social-manager':      socialManager,
  'brand-sentinel':      brandSentinel,
  'campaign-conductor':  campaignConductor,
  'content-scheduler':   contentScheduler,
  'reputation-defender': reputationDefender,
  // Arsenal
  'nova':                nova,
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// ── Format client_knowledge rows into a compact XML block ─────────────────────
function formatClientMemory(clientList) {
  const rows = []
  for (const c of clientList) {
    if (!c.clientKnowledge || !c.clientKnowledge.length) continue
    for (const k of c.clientKnowledge) {
      rows.push(`[${c.business_name || c.id}] ${k.category}: ${k.content}`)
    }
  }
  if (!rows.length) return ''
  return `<client_memory>\n${rows.slice(0, 10).join('\n')}\n</client_memory>`
}

// ── Groq reasoning: decide specialist priority for this client cohort ─────────
async function reasonAboutSpecialists(clientList, situation, commanderBrief, vaultContext = '') {
  const clientSample = clientList.slice(0, 5).map(c => ({
    id:       c.id,
    vertical: c.industry_type || c.industry || 'unknown',
    plan:     c.plan,
  }))

  const briefContext = commanderBrief
    ? `\n\nCommander strategic brief:\n${commanderBrief}`
    : ''

  const memoryBlock = formatClientMemory(clientList)

  try {
    const raw = await call({
      tier: 'simple',
      _workerName: 'brand-director',
      systemPrompt: `<role>BrandDirector for GRIDHAND AI — manage reputation and marketing for small business clients across verticals: auto_repair, restaurant, gym, barbershop, retail, real_estate.</role>${vaultContext ? `\n<context>${vaultContext}</context>` : ''}${memoryBlock ? `\n${memoryBlock}` : ''}
<specialists>review-orchestrator (review requests and responses), social-manager (social media posting and engagement), brand-sentinel (monitors negative mentions and review spikes), campaign-conductor (runs marketing campaigns)</specialists>
<brand_standards>GRIDHAND voice: direct, confident, outcome-first. Never "AI software/platform/tool" — always "a worker that handles [specific job]". Never mention Make.com — use "direct integrations". SMS/email: grade 7-8 reading level, plain language, local business owner tone. No fake stats, no invented metrics.</brand_standards>
<rules>Given the client list and situation, decide the optimal specialist dispatch order and explain why.</rules>
<quality_standard>
DIRECTOR OUTPUT DISCIPLINE:
Never use: "I believe", "it seems", "perhaps", "it appears", "Certainly!", "Great!", "I'd be happy to", "Of course!", "I'm sorry", "Unfortunately", "I apologize", "I understand", "As an AI"
Outcome-first: lead with the decision or action, not the analysis
Return structured JSON only — no unstructured prose responses
Never explain reasoning unless confidence < 0.7 or explicitly asked
Escalate to Commander when: confidence < 0.6 OR situation is outside your defined scope
</quality_standard>
<output>Respond with valid JSON only: { "specialists_priority": ["specialist-name"], "vertical": "dominant_vertical_or_mixed", "rationale": "one sentence", "confidence": number (0.0-1.0), "escalate": boolean }</output>`,
      messages: [{
        role: 'user',
        content: `Clients: ${JSON.stringify(clientSample)}. Situation: ${situation || 'scheduled_run'}.${briefContext}`,
      }],
      maxTokens: 300,
    })

    const match = raw?.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
  } catch (err) {
    console.warn(`[${AGENT_ID}] Groq reasoning failed:`, err.message)
  }
  return null
}

// ── Log reasoning trace to Supabase ──────────────────────────────────────────
async function logReasoning(supabase, reasoning, situation) {
  try {
    await supabase.from('director_reasoning').insert({
      director_id:         AGENT_ID,
      reasoning:           reasoning?.rationale         || null,
      specialists_chosen:  reasoning?.specialists_priority || [],
      vertical:            reasoning?.vertical           || null,
      situation:           situation || 'scheduled',
      created_at:          new Date().toISOString(),
    })
  } catch (err) {
    // Never let logging break the run
    console.warn(`[${AGENT_ID}] Reasoning log failed:`, err.message)
  }
}

// ── Log run to agent_runs ─────────────────────────────────────────────────────
async function logRun(supabase, startedAt, actionsCount, status, data) {
  try {
    await supabase.from('agent_runs').insert({
      agent_id: AGENT_ID,
      status,
      summary:  `${AGENT_ID} run: ${actionsCount} actions`,
      payload:  { startedAt, completedAt: new Date().toISOString(), actionsCount, ...data },
      ran_at:   new Date().toISOString(),
    })
  } catch (err) {
    console.warn(`[${AGENT_ID}] Failed to log run:`, err.message)
  }
}

async function run(clients = null, situation = null, commanderBrief = null) {
  const startedAt = new Date().toISOString()
  try {
    console.log(`[${AGENT_ID.toUpperCase()}] Starting run — situation: ${situation || 'scheduled'}`)

    const supabase   = getSupabase()
    const clientList = clients || await getActiveClients(supabase)
    if (!clientList.length) return report([])

    // ── Load shared memory context ────────────────────────────────────────────
    const clientId     = clientList[0]?.id
    const vaultContext = clientId ? await vault.getContext(clientId).catch(() => '') : ''

    // ── Groq reasoning: determine specialist priority ─────────────────────────
    const reasoning = await reasonAboutSpecialists(clientList, situation, commanderBrief, vaultContext)
    await logReasoning(supabase, reasoning, situation)

    // Build ordered specialist list — AI-ranked if available, default otherwise
    const priorityOrder = (reasoning?.specialists_priority?.length)
      ? reasoning.specialists_priority.filter(s => SPECIALIST_MAP[s])
      : ALL_SPECIALISTS

    const remainingSpecialists = ALL_SPECIALISTS.filter(s => !priorityOrder.includes(s))
    const orderedSpecialists   = [...priorityOrder, ...remainingSpecialists]

    console.log(`[${AGENT_ID.toUpperCase()}] Specialist order (${reasoning?.vertical || 'default'}): ${orderedSpecialists.join(' → ')}`)
    if (reasoning?.rationale) {
      console.log(`[${AGENT_ID.toUpperCase()}] Reasoning: ${reasoning.rationale}`)
    }

    // Run all specialists in parallel
    const specialistPromises = orderedSpecialists.map(name => SPECIALIST_MAP[name].run(clientList))
    const results = await Promise.allSettled(specialistPromises)

    const childReports = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)

    for (const r of childReports) {
      await receive(r, supabase)
    }

    const totalActions    = childReports.reduce((sum, r) => sum + (r.actionsCount || 0), 0)
    const escalations     = childReports.flatMap(r => r.escalations || [])
    const brandAlerts     = escalations.filter(e => e.data?.negativeCount >= 3)
    const needsCommanderAlert = brandAlerts.length > 0 || escalations.length > 2

    await logRun(supabase, startedAt, totalActions, 'ok', { brandAlerts: brandAlerts.length, escalations: escalations.length, clients: clientList.length })

    return report([{
      agentId:   AGENT_ID,
      clientId:  'all',
      timestamp: Date.now(),
      status:    totalActions > 0 ? 'action_taken' : 'no_action',
      summary:   `Brand: ${totalActions} actions. ${brandAlerts.length} negative review spike(s). ${escalations.length} total escalation(s).`,
      data:      { totalActions, brandAlerts, escalations, childReports, reasoning },
      requiresDirectorAttention: needsCommanderAlert,
    }])
  } catch (err) {
    console.error(`[${AGENT_ID}] run() fatal error:`, err.message)
    try {
      const supabase = getSupabase()
      await logRun(supabase, startedAt, 0, 'error', { error: err.message })
    } catch (_) {}
    return {
      agentId:      AGENT_ID,
      division:     DIVISION,
      actionsCount: 0,
      escalations:  [],
      outcomes:     [{ status: 'error', error: err.message }],
    }
  }
}

async function report(outcomes) {
  const totalActions = outcomes.reduce((sum, o) => sum + (o.actionsCount || (o.status === 'action_taken' ? 1 : 0)), 0)
  const summary = {
    agentId:      AGENT_ID,
    division:     DIVISION,
    reportsTo:    REPORTS_TO,
    timestamp:    Date.now(),
    totalClients: outcomes.length,
    actionsCount: totalActions,
    escalations:  outcomes.filter(o => o.requiresDirectorAttention),
    outcomes,
  }
  console.log(`[${AGENT_ID.toUpperCase()}] Report complete — ${totalActions} brand actions`)
  return summary
}

async function receive(childReport, supabaseInstance) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.actionsCount || 0} actions`)

  // Flag high-value outcomes for tracking
  if (childReport.actionsCount > 0) {
    const supabase = supabaseInstance || getSupabase()
    await supabase
      .from('activity_log')
      .update({ outcome: 'ok', outcome_director: AGENT_ID })
      .eq('worker_id', childReport.agentId)
      .is('outcome', null)
      .catch(() => {}) // never block on logging
  }
}

async function getActiveClients(supabase) {
  const sb = supabase || getSupabase()
  const { data, error } = await sb
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
