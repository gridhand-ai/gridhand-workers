'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// PipelineReporter — Aggregates all leads across stages (new, warm, cold,
// booked, won, lost) and produces a pipeline health summary. Flags stalled
// stages and surfaces opportunities to the Acquisition Director.
//
// Division: acquisition
// Reports to: acquisition-director
// Runs: on-demand (called by AcquisitionDirector)
//
// @param {Array<Object>} clients - Active client objects from Supabase
// @returns {Object} Specialist report: actionsCount, escalations, outcomes
// Tools used: lib/ai-client (groq), lib/memory-client, lib/memory-vault
// ──────────────────────────────────────────────────────────────────────────────

const { createClient }    = require('@supabase/supabase-js')
const aiClient            = require('../../lib/ai-client')
const { fileInteraction } = require('../../lib/memory-client')
const vault               = require('../../lib/memory-vault')

const AGENT_ID   = 'pipeline-reporter'
const DIVISION   = 'acquisition'
const REPORTS_TO = 'acquisition-director'

// A pipeline stage is considered "stalled" when no leads move in this many days
const STALL_THRESHOLD_DAYS = 7

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Main entry point — generate pipeline health report for each client.
 * @param {Array<Object>} clients
 * @param {string} [owner] - 'gridhand' (default) for internal reporting, or a client_id for client-scoped monthly reports
 * @returns {Object} specialist report
 */
async function run(clients = [], owner = 'gridhand') {
  console.log(`[${AGENT_ID.toUpperCase()}] Starting run — ${clients.length} clients, owner: ${owner}`)
  const isClientContext = owner !== 'gridhand'
  const reports = []

  for (const client of clients) {
    try {
      const result = await processClient(client, isClientContext)
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
      await vault.store(r.clientId, vault.KEYS.LAST_LEAD_OUTCOME, {
        lastAction:    'pipeline_report',
        pipelineStats: r.data?.stats,
        stalled:       r.data?.stalledStages || [],
        summary:       r.summary || 'pipeline report complete',
        timestamp:     Date.now(),
      }, 6, AGENT_ID).catch(() => {})
    }
  }

  return specialistReport
}

/**
 * Process a single client — pull lead stage counts and assess pipeline health.
 * @param {Object} client
 * @param {boolean} isClientContext
 * @returns {Object|null}
 */
async function processClient(client, isClientContext = false) {
  const supabase       = getSupabase()
  const now            = Date.now()
  const stallCutoff    = new Date(now - STALL_THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Count leads per stage
  const stages = ['new', 'warm', 'cold', 'booked', 'won', 'lost']
  const statPromises = stages.map(stage =>
    supabase
      .from('client_leads')
      .select('*', { count: 'exact', head: true })
      .eq('client_id', client.id)
      .eq('stage', stage)
  )
  const statResults = await Promise.all(statPromises)
  const stats = {}
  stages.forEach((stage, i) => {
    stats[stage] = statResults[i].count || 0
  })

  const totalLeads = Object.values(stats).reduce((sum, n) => sum + n, 0)
  if (totalLeads === 0) return null

  // Detect stalled stages (no new leads added recently)
  const { data: recentActivity } = await supabase
    .from('client_leads')
    .select('stage')
    .eq('client_id', client.id)
    .gte('created_at', stallCutoff)

  const activeStages   = new Set((recentActivity || []).map(r => r.stage))
  const stalledStages  = stages.filter(s => stats[s] > 0 && !activeStages.has(s))

  // AI synthesis — produce actionable insight string
  const insight = await synthesizePipeline(client, stats, stalledStages, isClientContext)

  const isStalled = stalledStages.includes('warm') || stalledStages.includes('new')

  return {
    agentId:                   AGENT_ID,
    clientId:                  client.id,
    timestamp:                 Date.now(),
    status:                    'action_taken',
    summary:                   `Pipeline report for ${client.business_name}: ${stats.warm} warm, ${stats.booked} booked, ${stats.won} won. ${stalledStages.length ? 'Stalled: ' + stalledStages.join(', ') : 'No stalled stages.'}`,
    data:                      { stats, stalledStages, insight, totalLeads },
    requiresDirectorAttention: isStalled,
  }
}

/**
 * Use Groq to synthesize a one-sentence actionable pipeline insight.
 * @param {Object} client
 * @param {Object} stats
 * @param {Array<string>} stalledStages
 * @param {boolean} isClientContext
 * @returns {Promise<string>}
 */
async function synthesizePipeline(client, stats, stalledStages, isClientContext = false) {
  const ownerBlock = isClientContext
    ? `<owner_context>
This report will be shared with ${client.business_name} as their monthly pipeline summary.
Frame insights as actionable advice the business owner can act on directly.
Avoid internal GRIDHAND references.
</owner_context>`
    : `<owner_context>
This is an internal GRIDHAND acquisition director report.
Frame insights for the acquisition director to prioritize follow-up actions across the client portfolio.
</owner_context>`

  const systemPrompt = `<role>Pipeline Reporter for GRIDHAND AI — synthesize actionable lead pipeline insights.</role>
${ownerBlock}

<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<pipeline>
New: ${stats.new}, Warm: ${stats.warm}, Cold: ${stats.cold},
Booked: ${stats.booked}, Won: ${stats.won}, Lost: ${stats.lost}
Stalled stages: ${stalledStages.join(', ') || 'none'}
</pipeline>

<task>
Write ONE actionable insight sentence for the acquisition director.
Focus on the biggest opportunity or bottleneck in this pipeline.
</task>

<rules>
- 1 sentence only
- Specific and actionable (not generic)
- Output ONLY the insight sentence
</rules>`

  try {
    const raw = await aiClient.call({
      modelString:   'groq/llama-3.3-70b-versatile',
      clientApiKeys: {},
      systemPrompt,
      messages:      [{ role: 'user', content: 'Provide the pipeline insight.' }],
      maxTokens:     80,
      _workerName:   AGENT_ID,
    })
    return raw?.trim() || 'No insight generated.'
  } catch {
    return 'Pipeline analysis complete.'
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} pipeline reports generated`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
