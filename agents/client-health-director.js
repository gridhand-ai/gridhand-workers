'use strict'
// tier: standard
// ── GRIDHAND AGENT — TIER 1 ───────────────────────────────────────────────────
// ClientHealthDirector — Unified client health scoring. Combines churn signals,
// engagement, payment status, and support volume into one score per client.
// Feeds churn-predictor, upsell-timer, and win-back-outreach with real signals.
// Division: client
// Reports to: gridhand-commander
// Runs: every 2 hours
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { notifyOwner }  = require('../lib/notify-owner')

const churnPredictor   = require('./specialists/churn-predictor')
const feedbackCollector = require('./specialists/feedback-collector')
const supportEscalator = require('./specialists/support-escalator')
const milestoneC       = require('./specialists/milestone-celebrator')

// ── New Tools Available (2026-04-27) ──────────────────────────────────────────
// humanizer  — ~/.claude/skills/humanizer/SKILL.md — apply to ALL client-facing copy before sending
// remotion   — MCP: remotion-video — animated reports, video deliverables, dashboard recordings
// notebooklm — MCP: notebooklm — internal research only, query GRIDHAND docs and architecture
// gemini-image — MCP: gemini-image — generate design references, UI mockups, client visual assets
// Access via TOOL_REGISTRY in gridhand-commander.js

const AGENT_ID   = 'client-health-director'
const DIVISION   = 'client'
const REPORTS_TO = 'gridhand-commander'

const ALL_SPECIALISTS = ['churn-predictor', 'feedback-collector', 'support-escalator', 'milestone-celebrator']
const SPECIALIST_MAP  = {
  'churn-predictor':     churnPredictor,
  'feedback-collector':  feedbackCollector,
  'support-escalator':   supportEscalator,
  'milestone-celebrator': milestoneC,
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

async function buildClientHealthMap(supabase, clientList) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  try {
    const { data: activity } = await supabase
      .from('activity_log')
      .select('client_id, action, outcome, created_at')
      .gte('created_at', since)

    const healthMap = {}
    for (const client of clientList) {
      const clientActivity = (activity || []).filter(a => a.client_id === client.id)
      const errors   = clientActivity.filter(a => a.outcome === 'error').length
      const actions  = clientActivity.length
      const engaged  = actions >= 5
      healthMap[client.id] = {
        clientId:     client.id,
        businessName: client.business_name,
        plan:         client.plan,
        actionsLast7d: actions,
        errorsLast7d:  errors,
        engaged,
        rawScore: engaged ? Math.max(0, 100 - (errors * 10)) : 30,
      }
    }
    return healthMap
  } catch { return {} }
}

async function scoreAndTriage(healthMap, childReports) {
  const churnFlags = childReports
    .flatMap(r => r.escalations || [])
    .filter(e => e.data?.churnRisk === 'high')
    .map(e => e.clientId)

  const clients = Object.values(healthMap).map(c => ({
    ...c,
    churnFlagged: churnFlags.includes(c.clientId),
    finalScore: churnFlags.includes(c.clientId) ? Math.min(c.rawScore, 25) : c.rawScore,
  }))

  const critical = clients.filter(c => c.finalScore < 30)
  const watch    = clients.filter(c => c.finalScore >= 30 && c.finalScore < 60)
  const healthy  = clients.filter(c => c.finalScore >= 60)

  return { critical, watch, healthy, total: clients.length }
}

async function run(clients = null, situation = null) {
  try {
    console.log(`[${AGENT_ID.toUpperCase()}] Building client health scores`)
    const supabase   = getSupabase()
    const clientList = clients || await getActiveClients(supabase)
    if (!clientList.length) return report([])

    const [healthMap, specialistResults] = await Promise.all([
      buildClientHealthMap(supabase, clientList),
      Promise.allSettled(ALL_SPECIALISTS.map(name => SPECIALIST_MAP[name].run(clientList))),
    ])

    const childReports = specialistResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)

    const triage = await scoreAndTriage(healthMap, childReports)

    console.log(`[${AGENT_ID.toUpperCase()}] Health: ${triage.healthy.length} healthy / ${triage.watch.length} watch / ${triage.critical.length} critical`)

    const needsEscalation = triage.critical.length > 0

    // Fire proactive owner notifications for each critical-health client — fire-and-forget
    for (const c of triage.critical) {
      if (!c?.clientId) continue
      const name = c.businessName || 'your business'
      const msg = `Urgent: ${name} health score dropped to ${c.finalScore} — ${c.errorsLast7d || 0} errors in last 7d. Action needed.`
      notifyOwner({
        businessId: c.clientId,
        eventType:  'urgent_escalation',
        message:    msg,
      }).catch(() => {}) // never block director on notification failure
    }

    return report([{
      agentId:   AGENT_ID,
      clientId:  'all',
      timestamp: Date.now(),
      status:    needsEscalation ? 'escalated' : 'ok',
      summary:   `Client health: ${triage.healthy.length} healthy, ${triage.watch.length} watch, ${triage.critical.length} critical of ${triage.total}.`,
      data:      { triage, childReports },
      requiresDirectorAttention: needsEscalation,
    }])
  } catch (err) {
    console.error(`[${AGENT_ID}] run() fatal error:`, err.message)
    return {
      agentId:      AGENT_ID,
      division:     DIVISION,
      actionsCount: 0,
      escalations:  [],
      outcomes:     [{ status: 'error', error: err.message }],
    }
  }
}

async function receive(childReport, supabase) {
  console.log(`[${AGENT_ID}] Received child report from ${childReport?.agentId || 'unknown'}`)
}

function report(outcomes) {
  const totalActions = outcomes.reduce((sum, o) => sum + (o.actionsCount || 0), 0)
  return {
    agentId:      AGENT_ID,
    division:     DIVISION,
    reportsTo:    REPORTS_TO,
    timestamp:    Date.now(),
    totalClients: outcomes.length,
    actionsCount: totalActions,
    escalations:  outcomes.filter(o => o.requiresDirectorAttention),
    outcomes,
  }
}

async function getActiveClients(supabase) {
  const { data, error } = await (supabase || getSupabase())
    .from('clients').select('*').eq('is_active', true)
  if (error) return []
  return data || []
}

module.exports = { run, receive, report, AGENT_ID, DIVISION, REPORTS_TO }
