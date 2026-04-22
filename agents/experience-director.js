'use strict'
// ── OG GRIDHAND AGENT — TIER 2 ────────────────────────────────────────────────
// ExperienceDirector — Manages client success and retention; triggers on churn signals
// Division: experience
// Reports to: gridhand-commander
// Runs: every 2 hours (via Commander cascade)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../lib/ai-client')
const vault            = require('../lib/memory-vault')

const churnPredictor       = require('./specialists/churn-predictor')
const loyaltyCoordinator   = require('./specialists/loyalty-coordinator')
const clientSuccess        = require('./specialists/client-success')
const onboardingConductor  = require('./specialists/onboarding-conductor')

const AGENT_ID   = 'experience-director'
const DIVISION   = 'experience'
const REPORTS_TO = 'gridhand-commander'
const GROQ_MODEL = 'groq/llama-3.3-70b-versatile'

// All specialists this director can dispatch, in default order
const ALL_SPECIALISTS = ['churn-predictor', 'loyalty-coordinator', 'client-success', 'onboarding-conductor']

const SPECIALIST_MAP = {
  'churn-predictor':     churnPredictor,
  'loyalty-coordinator': loyaltyCoordinator,
  'client-success':      clientSuccess,
  'onboarding-conductor': onboardingConductor,
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// ── Groq reasoning: decide specialist priority for this client cohort ─────────
async function reasonAboutSpecialists(clientList, newClientCount, situation, commanderBrief, vaultContext = '') {
  const clientSample = clientList.slice(0, 5).map(c => ({
    id:       c.id,
    vertical: c.industry_type || c.industry || 'unknown',
    plan:     c.plan,
    days_old: Math.floor((Date.now() - new Date(c.created_at).getTime()) / (1000 * 60 * 60 * 24)),
  }))

  const briefContext = commanderBrief
    ? `\n\nCommander strategic brief:\n${commanderBrief}`
    : ''

  try {
    const raw = await call({
      modelString: GROQ_MODEL,
      systemPrompt: `You are part of the GRIDHAND collective intelligence. ${vaultContext ? vaultContext + '\n\n' : ''}You are the ExperienceDirector for GRIDHAND AI. You manage client success and retention for small business clients across verticals: auto_repair, restaurant, gym, barbershop, retail, real_estate, and others.
Your specialists are: churn-predictor (identifies at-risk clients before they cancel), loyalty-coordinator (runs loyalty and re-engagement programs), client-success (monitors satisfaction and usage health), onboarding-conductor (guides new clients through setup, runs for clients under 30 days).
Given the client list and situation, decide the optimal dispatch order for specialists and briefly explain why.
Respond ONLY with valid JSON matching: { "specialists_priority": ["specialist-name", ...], "vertical": "dominant_vertical_or_mixed", "rationale": "one sentence" }`,
      messages: [{
        role: 'user',
        content: `Clients: ${JSON.stringify(clientSample)}. New clients in onboarding: ${newClientCount}. Situation: ${situation || 'scheduled_run'}.${briefContext}`,
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

  // Separate new clients (< 31 days) for onboarding focus
  const now = Date.now()
  const newClients = clientList.filter(c => {
    const days = (now - new Date(c.created_at).getTime()) / (1000 * 60 * 60 * 24)
    return days <= 31
  })

  // ── Load shared memory context ────────────────────────────────────────────
  const clientId     = clientList[0]?.id
  const vaultContext = clientId ? await vault.getContext(clientId).catch(() => '') : ''

  // ── Groq reasoning: determine specialist priority ─────────────────────────
  const reasoning = await reasonAboutSpecialists(clientList, newClients.length, situation, commanderBrief, vaultContext)
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

  // Run all specialists in parallel, passing newClients to onboarding-conductor
  const specialistPromises = orderedSpecialists.map(name => {
    const clientsForSpec = name === 'onboarding-conductor' ? newClients : clientList
    return SPECIALIST_MAP[name].run(clientsForSpec)
  })
  const results = await Promise.allSettled(specialistPromises)

  const childReports = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)

  for (const r of childReports) {
    await receive(r, supabase)
  }

  const totalActions = childReports.reduce((sum, r) => sum + (r.actionsCount || 0), 0)
  const churnRisks   = childReports
    .filter(r => r.agentId?.includes('churn'))
    .flatMap(r => r.escalations || [])
  const needsAlert   = churnRisks.length > 0

  return report([{
    agentId:   AGENT_ID,
    clientId:  'all',
    timestamp: now,
    status:    totalActions > 0 ? 'action_taken' : 'no_action',
    summary:   `Experience: ${totalActions} actions. ${churnRisks.length} churn risk(s) detected. ${newClients.length} client(s) in onboarding.`,
    data:      { totalActions, churnRisks, newClients: newClients.length, childReports, reasoning },
    requiresDirectorAttention: needsAlert,
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report complete — ${totalActions} experience actions`)
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
      .eq('agent_id', childReport.agentId)
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
