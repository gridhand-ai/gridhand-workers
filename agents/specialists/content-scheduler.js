'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// ContentScheduler — Generates a weekly batch of short-form social content
// ideas (captions, hooks, topic angles) tailored to the client's industry and
// brand voice. Stores the content calendar in activity_log for the Social
// Manager to execute.
//
// Division: brand
// Reports to: brand-director
// Runs: on-demand (called by BrandDirector)
//
// @param {Array<Object>} clients - Active client objects from Supabase
// @returns {Object} Specialist report: actionsCount, escalations, outcomes
// Tools used: lib/content-pipeline (multi-step), lib/campaign-feedback, lib/memory-client, lib/memory-vault
// ──────────────────────────────────────────────────────────────────────────────

const { createClient }       = require('@supabase/supabase-js')
const exa                    = require('../../lib/exa-client')
const { fileInteraction }    = require('../../lib/memory-client')
const vault                  = require('../../lib/memory-vault')
const { runContentPipeline } = require('../../lib/content-pipeline')
const { logContentBatch }    = require('../../lib/campaign-feedback')

const AGENT_ID   = 'content-scheduler'
const DIVISION   = 'brand'
const REPORTS_TO = 'brand-director'

// Number of content ideas to generate per weekly batch
const CONTENT_BATCH_SIZE = 5
// Regenerate if content calendar is older than this many days
const REGEN_AFTER_DAYS   = 6

/**
 * Fetch trending content topics for a client's industry via Exa.
 * This keeps content calendars fresh and grounded in what's actually trending.
 */
async function fetchTrendingTopics(client) {
  const industry = client.industry || 'small business'
  const city     = client.city || client.location || ''
  const query    = city
    ? `trending ${industry} content topics social media ${city} 2025`
    : `trending ${industry} small business social media content ideas 2025`
  try {
    const results = await exa.search(query, { numResults: 3, maxChars: 1000 })
    if (!results?.results?.length) {
      // Self-correction: broaden search to industry + social media trends
      console.log(`[${AGENT_ID}] Exa returned no trending topics — retrying with broader terms`)
      const retry = await exa.search(`${industry} social media content ideas trending`, { numResults: 3, maxChars: 1000 })
      if (!retry?.results?.length) return null
      return retry.results.map(r => r.highlights?.join(' ') || r.title).join('\n').slice(0, 1500)
    }
    return results.results.map(r => r.highlights?.join(' ') || r.title).join('\n').slice(0, 1500)
  } catch (err) {
    console.warn(`[${AGENT_ID}] Exa trending topics failed (non-blocking):`, err.message)
    return null
  }
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Main entry point — iterate clients, generate content calendar batches.
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
      await vault.store(r.clientId, vault.KEYS.BRAND_VOICE, {
        lastAction:    'content_batch_generated',
        batchSize:     r.data?.ideas?.length || 0,
        avgScore:      r.data?.avgScore      || 0,
        summary:       r.summary || 'content scheduler cycle complete',
        timestamp:     Date.now(),
      }, 5, AGENT_ID).catch(() => {})
    }
  }

  return specialistReport
}

/**
 * Process a single client — check if content batch is stale, regenerate if needed.
 * Uses multi-step content pipeline: research → draft → score → refine → image prompts.
 * @param {Object} client
 * @returns {Object|null}
 */
async function processClient(client) {
  const supabase    = getSupabase()
  const now         = Date.now()
  const regenCutoff = new Date(now - REGEN_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Check when last content batch was generated
  const { data: lastBatch } = await supabase
    .from('activity_log')
    .select('created_at')
    .eq('client_id', client.id)
    .eq('worker_name', AGENT_ID)
    .eq('event_type', 'content_batch')
    .order('created_at', { ascending: false })
    .limit(1)

  const lastGenerated = lastBatch?.[0]?.created_at
  if (lastGenerated && lastGenerated > regenCutoff) {
    return null // Fresh content already exists
  }

  // Load brand voice from vault for context
  const brandVoiceEntry = await vault.recall(client.id, vault.KEYS.BRAND_VOICE).catch(() => null)
  const brandVoice      = brandVoiceEntry?.voice || null

  // Optional: fetch live trending topics via Exa to seed the pipeline's research step
  const trendingTopic = await fetchTrendingTopics(client)

  // ── Multi-step pipeline (research → draft → score → refine → image prompts) ──
  const { ideas, avgScore, pipelineLog } = await runContentPipeline({
    client,
    topic:     trendingTopic || null,
    type:      'social_post',
    batchSize: CONTENT_BATCH_SIZE,
    brandVoice,
  })

  if (!ideas?.length) return null

  console.log(`[${AGENT_ID}] Pipeline complete for ${client.business_name} — ${ideas.length} ideas, avg score ${avgScore}`)

  // Log the content batch to activity_log for Social Manager
  // image_prompt is stored per-idea in metadata for dashboard consumption
  try {
    await supabase.from('activity_log').insert({
      client_id:    client.id,
      worker_name:  AGENT_ID,
      worker_id:    AGENT_ID,
      event_type:   'content_batch',
      message:      `Generated ${ideas.length} content ideas (avg quality ${avgScore}/10) for week of ${new Date().toDateString()}`,
      metadata:     { ideas, avgScore, pipelineLog, generatedAt: new Date().toISOString() },
      credits_used: 0,
      created_at:   new Date().toISOString(),
    })
  } catch (err) {
    console.error(`[${AGENT_ID}] Failed to log content batch:`, err.message)
  }

  // ── Compound learning: feed result back to agent_memory ───────────────────
  await logContentBatch({
    clientId: client.id,
    ideas,
    avgScore,
    industry: client.industry || 'business',
    bizName:  client.business_name,
  }).catch(() => {})

  return {
    agentId:                   AGENT_ID,
    clientId:                  client.id,
    timestamp:                 Date.now(),
    status:                    'action_taken',
    summary:                   `Generated ${ideas.length} content ideas (avg ${avgScore}/10) for ${client.business_name}`,
    data:                      { ideas, batchSize: ideas.length, avgScore },
    requiresDirectorAttention: false,
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} content batches generated`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
