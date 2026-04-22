'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// PerformanceBenchmarker — Evaluates each active client against cross-portfolio
// benchmarks (response time, conversion rate, review score, retention rate).
// Flags underperformers and surfaces which division should intervene.
//
// Division: intelligence
// Reports to: intelligence-director
// Runs: on-demand (called by IntelligenceDirector)
//
// @param {Array<Object>} clients - Active client objects from Supabase
// @returns {Object} Specialist report: actionsCount, escalations, outcomes
// Tools used: lib/ai-client (groq), lib/memory-client, lib/memory-vault
// ──────────────────────────────────────────────────────────────────────────────

const { createClient }    = require('@supabase/supabase-js')
const aiClient            = require('../../lib/ai-client')
const { fileInteraction } = require('../../lib/memory-client')
const vault               = require('../../lib/memory-vault')

const AGENT_ID   = 'performance-benchmarker'
const DIVISION   = 'intelligence'
const REPORTS_TO = 'intelligence-director'

// Minimum benchmark thresholds — clients below these are flagged
const BENCHMARKS = {
  avgReviewScore:        4.0,   // out of 5
  responseRatePercent:   60,    // % of leads responded to
  retentionRate30d:      0.8,   // 80% of active clients still active after 30d
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Main entry point — benchmark all clients against portfolio standards.
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
        lastAction:     'performance_benchmark',
        metrics:        r.data?.metrics,
        gaps:           r.data?.gaps || [],
        summary:        r.summary || 'performance benchmark complete',
        timestamp:      Date.now(),
      }, 7, AGENT_ID).catch(() => {})
    }
  }

  return specialistReport
}

/**
 * Process a single client — gather key metrics and compare to benchmarks.
 * @param {Object} client
 * @returns {Object|null}
 */
async function processClient(client) {
  const supabase    = getSupabase()
  const now         = Date.now()
  const thirtyAgo   = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()

  // Avg review score
  const { data: reviewData } = await supabase
    .from('client_reviews')
    .select('rating')
    .eq('client_id', client.id)
    .gte('received_at', thirtyAgo)

  const ratings      = (reviewData || []).map(r => r.rating).filter(Boolean)
  const avgReview    = ratings.length
    ? ratings.reduce((sum, r) => sum + r, 0) / ratings.length
    : null

  // Lead response rate — % of leads that had a response sent
  const { count: totalLeads } = await supabase
    .from('client_leads')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', client.id)
    .gte('created_at', thirtyAgo)

  const { count: respondedLeads } = await supabase
    .from('client_leads')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', client.id)
    .gte('created_at', thirtyAgo)
    .not('first_response_at', 'is', null)

  const responseRate = (totalLeads || 0) > 0
    ? Math.round(((respondedLeads || 0) / totalLeads) * 100)
    : null

  const metrics = {
    avgReviewScore: avgReview ? parseFloat(avgReview.toFixed(2)) : null,
    responseRatePercent: responseRate,
    reviewCount: ratings.length,
    totalLeads: totalLeads || 0,
  }

  // Identify gaps vs benchmarks
  const gaps = []
  if (metrics.avgReviewScore !== null && metrics.avgReviewScore < BENCHMARKS.avgReviewScore) {
    gaps.push(`Review score ${metrics.avgReviewScore} below benchmark ${BENCHMARKS.avgReviewScore} — brand division needed`)
  }
  if (metrics.responseRatePercent !== null && metrics.responseRatePercent < BENCHMARKS.responseRatePercent) {
    gaps.push(`Lead response rate ${metrics.responseRatePercent}% below benchmark ${BENCHMARKS.responseRatePercent}% — acquisition division needed`)
  }

  if (!gaps.length && metrics.avgReviewScore === null && metrics.responseRatePercent === null) {
    return null // No data to benchmark
  }

  // AI synthesis — produce directional recommendation
  const recommendation = await synthesizeRecommendation(client, metrics, gaps)

  return {
    agentId:                   AGENT_ID,
    clientId:                  client.id,
    timestamp:                 Date.now(),
    status:                    'action_taken',
    summary:                   `Performance benchmark for ${client.business_name}: ${gaps.length ? gaps.length + ' gap(s) identified' : 'meeting benchmarks'}`,
    data:                      { metrics, gaps, recommendation },
    requiresDirectorAttention: gaps.length >= 2,
  }
}

/**
 * Produce a directional recommendation from benchmark gaps via Groq.
 * @param {Object} client
 * @param {Object} metrics
 * @param {Array<string>} gaps
 * @returns {Promise<string>}
 */
async function synthesizeRecommendation(client, metrics, gaps) {
  if (!gaps.length) return 'Client is performing at or above benchmarks — no action needed.'

  const systemPrompt = `<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<metrics>
Review score (30d): ${metrics.avgReviewScore ?? 'no data'}
Lead response rate: ${metrics.responseRatePercent != null ? metrics.responseRatePercent + '%' : 'no data'}
</metrics>

<gaps>
${gaps.join('\n')}
</gaps>

<task>
Write ONE actionable recommendation sentence for the intelligence director.
Specify which division should act and why.
</task>

<rules>
- 1 sentence only
- Specific and actionable
- Output ONLY the recommendation sentence
</rules>`

  try {
    const raw = await aiClient.call({
      modelString:   'groq/llama-3.3-70b-versatile',
      clientApiKeys: {},
      systemPrompt,
      messages:      [{ role: 'user', content: 'Provide the performance recommendation.' }],
      maxTokens:     80,
      _workerName:   AGENT_ID,
    })
    return raw?.trim() || 'Performance gaps detected — review division assignments.'
  } catch {
    return 'Performance gaps detected — manual review recommended.'
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} performance benchmarks completed`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
