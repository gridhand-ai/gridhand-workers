'use strict'
// ── OG GRIDHAND AGENT — TIER 2 ────────────────────────────────────────────────
// RevenueDirector — Manages all money automation; escalates if revenue at risk > $500
// Division: revenue
// Reports to: gridhand-commander
// Runs: every hour (via Commander cascade)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../lib/ai-client')
const vault            = require('../lib/memory-vault')

const invoiceRecovery   = require('./specialists/invoice-recovery')
const upsellTimer       = require('./specialists/upsell-timer')
const subscriptionGuard = require('./specialists/subscription-guard')
const pricingOptimizer  = require('./specialists/pricing-optimizer')
const paymentDunner     = require('./specialists/payment-dunner')
const contractRenewal   = require('./specialists/contract-renewal')
const revenueForecaster = require('./specialists/revenue-forecaster')

const AGENT_ID   = 'revenue-director'
const DIVISION   = 'revenue'
const REPORTS_TO = 'gridhand-commander'
const GROQ_MODEL = 'groq/llama-3.3-70b-versatile'

const ESCALATION_REVENUE_THRESHOLD = 500

// All specialists this director can dispatch, in default order
const ALL_SPECIALISTS = [
  'invoice-recovery', 'upsell-timer', 'subscription-guard', 'pricing-optimizer',
  'payment-dunner', 'contract-renewal', 'revenue-forecaster',
]

const SPECIALIST_MAP = {
  'invoice-recovery':    invoiceRecovery,
  'upsell-timer':        upsellTimer,
  'subscription-guard':  subscriptionGuard,
  'pricing-optimizer':   pricingOptimizer,
  'payment-dunner':      paymentDunner,
  'contract-renewal':    contractRenewal,
  'revenue-forecaster':  revenueForecaster,
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
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

  try {
    const raw = await call({
      modelString: GROQ_MODEL,
      systemPrompt: `<role>RevenueDirector for GRIDHAND AI — manage all money automation for small business clients across verticals: auto_repair, restaurant, gym, barbershop, retail, real_estate.</role>${vaultContext ? `\n<context>${vaultContext}</context>` : ''}
<specialists>invoice-recovery (overdue invoices and failed payments), upsell-timer (optimal upgrade moment identification), subscription-guard (cancellation risk detection and retention), pricing-optimizer (market and plan-fit pricing analysis)</specialists>
<rules>Given the client list and situation, decide the optimal specialist dispatch order and explain why.</rules>
<output>Respond with valid JSON only: { "specialists_priority": ["specialist-name"], "vertical": "dominant_vertical_or_mixed", "rationale": "one sentence" }</output>`,
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

async function run(clients = null, situation = null, commanderBrief = null) {
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

  // Check total revenue at risk
  const totalAtRisk = childReports.reduce((sum, r) => {
    return sum + ((r.outcomes || []).reduce((s, o) => s + (o.data?.totalAtRisk || 0), 0))
  }, 0)

  const totalActions = childReports.reduce((sum, r) => sum + (r.actionsCount || 0), 0)
  const escalations  = childReports.flatMap(r => r.escalations || [])

  const needsCommanderAlert = totalAtRisk > ESCALATION_REVENUE_THRESHOLD || escalations.length > 0

  return report([{
    agentId:   AGENT_ID,
    clientId:  'all',
    timestamp: Date.now(),
    status:    totalActions > 0 ? 'action_taken' : 'no_action',
    summary:   `Revenue: ${totalActions} total actions. $${totalAtRisk} at risk. ${escalations.length} escalation(s).`,
    data:      { totalActions, totalAtRisk, escalations, childReports, reasoning },
    requiresDirectorAttention: needsCommanderAlert,
  }])
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report complete — ${totalActions} revenue actions`)
  return summary
}

async function receive(childReport, supabaseInstance) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.actionsCount || 0} actions`)

  // Flag high-value outcomes for tracking
  if (childReport.actionsCount > 0) {
    const supabase = supabaseInstance || getSupabase()
    await supabase
      .from('activity_log')
      .update({ outcome: 'actioned', outcome_director: AGENT_ID })
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
