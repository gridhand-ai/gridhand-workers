'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// RevenueForecaster — Analyzes MRR trends, upcoming renewals, and pipeline
// velocity to produce a 30-day revenue forecast per client. Flags clients
// where projected revenue is declining vs last period.
//
// Division: revenue
// Reports to: revenue-director
// Runs: on-demand (called by RevenueDirector)
//
// @param {Array<Object>} clients - Active client objects from Supabase
// @returns {Object} Specialist report: actionsCount, escalations, outcomes
// Tools used: lib/ai-client (groq), lib/memory-client, lib/memory-vault
// ──────────────────────────────────────────────────────────────────────────────

const { createClient }    = require('@supabase/supabase-js')
const aiClient            = require('../../lib/ai-client')
const { fileInteraction } = require('../../lib/memory-client')
const vault               = require('../../lib/memory-vault')

const AGENT_ID   = 'revenue-forecaster'
const DIVISION   = 'revenue'
const REPORTS_TO = 'revenue-director'

// Trigger director attention if projected 30-day revenue drops more than this %
const DECLINE_THRESHOLD_PCT = 0.15

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Main entry point — iterate clients, generate revenue forecasts.
 * @param {Array<Object>} clients
 * @returns {Object} specialist report
 */
async function run(clients = []) {
  console.log(`[${AGENT_ID.toUpperCase()}] Starting run — ${clients.length} clients`)
  const reports = []

  for (const client of clients) {
    try {
      const result = await processClient(client)
      if (result) reports.push(result)
    } catch (err) {
      console.error(`[${AGENT_ID}] Error for client ${client.id}:`, err.message)
    }
  }

  const specialistReport = await report(reports)
  await fileInteraction(specialistReport, {
    workerId:        AGENT_ID,
    interactionType: 'specialist_run',
  }).catch(() => {})

  for (const r of reports) {
    if (r.clientId) {
      await vault.store(r.clientId, vault.KEYS.BUSINESS_GOALS, {
        lastAction:      'revenue_forecast',
        mrr:             r.data?.currentMRR,
        forecast30d:     r.data?.forecast30d,
        trend:           r.data?.trend,
        summary:         r.summary || 'revenue forecast complete',
        timestamp:       Date.now(),
      }, 7, AGENT_ID).catch(() => {})
    }
  }

  return specialistReport
}

/**
 * Process a single client — compute revenue signals and produce a forecast.
 * @param {Object} client
 * @returns {Object|null}
 */
async function processClient(client) {
  const supabase    = getSupabase()
  const now         = Date.now()
  const thirtyAgo   = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
  const sixtyAgo    = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString()

  // Payments received in the last 30 days
  const { data: recentPayments } = await supabase
    .from('client_payment_history')
    .select('amount, paid_at')
    .eq('client_id', client.id)
    .eq('status', 'paid')
    .gte('paid_at', thirtyAgo)

  // Payments from the 30 days before that (30-60 days ago) for trend
  const { data: priorPayments } = await supabase
    .from('client_payment_history')
    .select('amount')
    .eq('client_id', client.id)
    .eq('status', 'paid')
    .gte('paid_at', sixtyAgo)
    .lt('paid_at', thirtyAgo)

  const currentMRR = (recentPayments || []).reduce((sum, p) => sum + (p.amount || 0), 0)
  const priorMRR   = (priorPayments  || []).reduce((sum, p) => sum + (p.amount || 0), 0)

  if (currentMRR === 0 && priorMRR === 0) return null

  // Count upcoming renewals in next 30 days
  const { count: upcomingRenewals } = await supabase
    .from('client_subscriptions')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', client.id)
    .eq('status', 'active')
    .lte('renewal_date', new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString())
    .gte('renewal_date', new Date().toISOString())

  // Trend calculation
  const trend = priorMRR > 0
    ? (currentMRR - priorMRR) / priorMRR
    : (currentMRR > 0 ? 1 : 0)

  const forecast30d = await forecastRevenue(client, currentMRR, priorMRR, upcomingRenewals || 0, trend)
  const isDecline   = trend < -DECLINE_THRESHOLD_PCT

  return {
    agentId:                   AGENT_ID,
    clientId:                  client.id,
    timestamp:                 Date.now(),
    status:                    'action_taken',
    summary:                   `${client.business_name} MRR: $${currentMRR.toFixed(0)} (${trend >= 0 ? '+' : ''}${Math.round(trend * 100)}% vs last period). 30-day forecast: $${forecast30d.toFixed(0)}`,
    data:                      { currentMRR, priorMRR, trend, forecast30d, upcomingRenewals },
    requiresDirectorAttention: isDecline,
  }
}

/**
 * Produce a 30-day revenue forecast using Groq reasoning.
 * @param {Object} client
 * @param {number} currentMRR
 * @param {number} priorMRR
 * @param {number} upcomingRenewals
 * @param {number} trend
 * @returns {Promise<number>}
 */
async function forecastRevenue(client, currentMRR, priorMRR, upcomingRenewals, trend) {
  const systemPrompt = `<role>Revenue Forecaster for GRIDHAND AI — produce 30-day revenue forecasts from MRR trend data for small business clients.</role>
<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<revenue_data>
MRR last 30 days: $${currentMRR.toFixed(0)}
MRR prior 30 days: $${priorMRR.toFixed(0)}
Trend: ${trend >= 0 ? '+' : ''}${Math.round(trend * 100)}%
Upcoming renewals next 30 days: ${upcomingRenewals}
</revenue_data>

<task>
Estimate the 30-day revenue forecast as a single dollar amount.
Factor in current MRR, trend direction, and renewal count.
</task>

<rules>
- Reply with ONLY a number (no $ sign, no text, no commas)
- Example valid reply: 2400
</rules>`

  try {
    const raw = await aiClient.call({
      modelString:   'groq/llama-3.3-70b-versatile',
      clientApiKeys: {},
      systemPrompt,
      messages:      [{ role: 'user', content: 'Provide the 30-day revenue forecast.' }],
      maxTokens:     10,
      _workerName:   AGENT_ID,
      tier: 'specialist',
    })
    const num = parseFloat(raw?.replace(/[^0-9.]/g, '') || '')
    return isNaN(num) ? currentMRR : num
  } catch {
    // Fallback: simple trend projection
    return currentMRR * (1 + trend * 0.5)
  }
}

/**
 * Aggregate outcomes into a director-ready report.
 * @param {Array<Object>} outcomes
 * @returns {Object}
 */
async function report(outcomes) {
  const summary = {
    agentId:      AGENT_ID,
    division:     DIVISION,
    reportsTo:    REPORTS_TO,
    timestamp:    Date.now(),
    totalClients: outcomes.length,
    actionsCount: outcomes.filter(o => o.status === 'action_taken').length,
    escalations:  outcomes.filter(o => o.requiresDirectorAttention),
    outcomes,
  }
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} revenue forecasts generated`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
