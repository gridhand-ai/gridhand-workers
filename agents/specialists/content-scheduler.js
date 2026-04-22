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
// Tools used: lib/ai-client (groq), lib/memory-client, lib/memory-vault
// ──────────────────────────────────────────────────────────────────────────────

const { createClient }    = require('@supabase/supabase-js')
const aiClient            = require('../../lib/ai-client')
const { fileInteraction } = require('../../lib/memory-client')
const vault               = require('../../lib/memory-vault')

const AGENT_ID   = 'content-scheduler'
const DIVISION   = 'brand'
const REPORTS_TO = 'brand-director'

// Number of content ideas to generate per weekly batch
const CONTENT_BATCH_SIZE = 5
// Regenerate if content calendar is older than this many days
const REGEN_AFTER_DAYS   = 6

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
        summary:       r.summary || 'content scheduler cycle complete',
        timestamp:     Date.now(),
      }, 5, AGENT_ID).catch(() => {})
    }
  }

  return specialistReport
}

/**
 * Process a single client — check if content batch is stale, regenerate if needed.
 * @param {Object} client
 * @returns {Object|null}
 */
async function processClient(client) {
  const supabase   = getSupabase()
  const now        = Date.now()
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
  const brandVoiceEntry = await vault.get(client.id, vault.KEYS.BRAND_VOICE).catch(() => null)
  const brandVoice      = brandVoiceEntry?.voice || null

  const ideas = await generateContentBatch(client, brandVoice)
  if (!ideas?.length) return null

  // Log the content batch to activity_log for Social Manager
  try {
    await supabase.from('activity_log').insert({
      client_id:   client.id,
      worker_name: AGENT_ID,
      worker_id:   AGENT_ID,
      event_type:  'content_batch',
      message:     `Generated ${ideas.length} content ideas for week of ${new Date().toDateString()}`,
      metadata:    { ideas, generatedAt: new Date().toISOString() },
      credits_used: 0,
      created_at:  new Date().toISOString(),
    })
  } catch (err) {
    console.error(`[${AGENT_ID}] Failed to log content batch:`, err.message)
  }

  return {
    agentId:                   AGENT_ID,
    clientId:                  client.id,
    timestamp:                 Date.now(),
    status:                    'action_taken',
    summary:                   `Generated ${ideas.length} content ideas for ${client.business_name}`,
    data:                      { ideas, batchSize: ideas.length },
    requiresDirectorAttention: false,
  }
}

/**
 * Generate a batch of content ideas via Groq.
 * @param {Object} client
 * @param {string|null} brandVoice
 * @returns {Promise<Array<Object>>}
 */
async function generateContentBatch(client, brandVoice) {
  const systemPrompt = `<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
${brandVoice ? `<brand_voice>${brandVoice}</brand_voice>` : ''}
</business>

<task>
Generate ${CONTENT_BATCH_SIZE} unique social media content ideas for this week.
Each idea should be a short-form post (suitable for Instagram, Facebook, or SMS broadcast).
</task>

<output>
Return a JSON array of objects. Each object has:
- "type": one of "tip", "story", "offer", "question", "behind-the-scenes"
- "hook": the opening line or headline (max 12 words)
- "angle": 1-sentence description of the content angle

Example:
[{"type":"tip","hook":"3 things to look for before hiring a contractor","angle":"Position the business as the trustworthy expert by educating on common pitfalls."}]

Return ONLY valid JSON. No other text.
</output>`

  try {
    const raw = await aiClient.call({
      modelString:   'groq/llama-3.3-70b-versatile',
      clientApiKeys: {},
      systemPrompt,
      messages:      [{ role: 'user', content: 'Generate the content batch.' }],
      maxTokens:     600,
      _workerName:   AGENT_ID,
    })

    const jsonMatch = raw?.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []
    return JSON.parse(jsonMatch[0])
  } catch (err) {
    console.error(`[${AGENT_ID}] Content generation failed:`, err.message)
    return []
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
