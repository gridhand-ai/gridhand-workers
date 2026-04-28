'use strict'
// lib/campaign-feedback.js — Compound learning feedback loop
//
// AgentScaler-parity: after a campaign or content batch runs, log what worked
// back into agent_memory and industry_learnings so future runs start smarter.
//
// Write targets:
//   agent_memory     — per-client learning (commander picks up on next cycle)
//   industry_learnings — pooled cross-client wisdom (workers pick up via industry-learnings.js)
//
// Called at the END of content-scheduler and campaign-conductor runs.

const { createClient } = require('@supabase/supabase-js')
const aiClient         = require('./ai-client')

const AGENT_ID = 'campaign-feedback'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Distill what happened in a campaign run into a 1-2 sentence learning.
 * Used by both logCampaignResult and the industry_learnings writer.
 *
 * @param {Object} context
 * @returns {Promise<string>} - Distilled learning sentence(s)
 */
async function distillLearning({ campaignType, content, outcome, industry, bizName }) {
  const systemPrompt = `<role>Memory distiller for GRIDHAND AI — convert campaign results into actionable learnings.</role>

<task>
Summarize this campaign result as a 1-2 sentence learning that a future AI agent
can use to make better decisions for similar ${industry} businesses.
Focus on what WORKED or what should be AVOIDED next time.
Be specific — no generic advice.
</task>

<campaign>
Business: ${bizName}
Industry: ${industry}
Campaign type: ${campaignType}
Content summary: ${typeof content === 'string' ? content.slice(0, 300) : JSON.stringify(content).slice(0, 300)}
Outcome: sent=${outcome.sent || 0}, responded=${outcome.responded || 0}, booked=${outcome.booked || 0}, revenue=$${outcome.revenue || 0}
Response rate: ${outcome.sent ? Math.round(((outcome.responded || 0) / outcome.sent) * 100) : 0}%
</campaign>

<output>
Return ONLY the learning sentence(s). No labels, no JSON, no explanation.
</output>`

  try {
    const raw = await aiClient.call({
      tier:          'quality',
      clientApiKeys: {},
      systemPrompt,
      messages:      [{ role: 'user', content: 'Distill this into a learning.' }],
      maxTokens:     150,
      _workerName:   AGENT_ID,
    })
    return (raw || '').trim()
  } catch {
    return ''
  }
}

/**
 * Log campaign/content result back to memory for compound learning.
 *
 * @param {Object} options
 * @param {string} options.clientId      - Supabase client UUID
 * @param {string} options.campaignType  - e.g. 'seasonal_campaign', 'content_batch', 'cold_outreach'
 * @param {string|Object} options.content - The content that was sent (text or structured data)
 * @param {Object} options.outcome        - { sent, responded, booked, revenue }
 * @param {string} [options.industry]     - Business industry (for cross-client learning)
 * @param {string} [options.bizName]      - Business name (for context)
 * @param {string} [options.agentSource]  - Which specialist logged this
 * @returns {Promise<{ logged: boolean, learning: string }>}
 */
async function logCampaignResult({
  clientId,
  campaignType,
  content,
  outcome = {},
  industry   = 'business',
  bizName    = 'client',
  agentSource = AGENT_ID,
}) {
  if (!clientId) {
    console.warn(`[${AGENT_ID}] logCampaignResult called without clientId — skipping`)
    return { logged: false, learning: '' }
  }

  const supabase    = getSupabase()
  const responseRate = outcome.sent
    ? Math.round(((outcome.responded || 0) / outcome.sent) * 100)
    : null

  // ── 1. Distill the learning ──────────────────────────────────────────────
  const learning = await distillLearning({ campaignType, content, outcome, industry, bizName })

  // ── 2. Write to agent_memory (per-client, commander reads this) ──────────
  if (learning) {
    const memoryContent = `Campaign type: ${campaignType} | ` +
      `Response rate: ${responseRate !== null ? responseRate + '%' : 'unknown'} | ` +
      `Booked: ${outcome.booked || 0} | Revenue: $${outcome.revenue || 0} | ` +
      `Learning: ${learning}`

    await supabase.from('agent_memory').insert({
      client_id:        clientId,
      worker_id:        agentSource,
      interaction_type: 'campaign_feedback',
      summary:          memoryContent,
      raw_content:      {
        campaignType,
        content: typeof content === 'string' ? content.slice(0, 500) : content,
        outcome,
        learning,
        timestamp: new Date().toISOString(),
      },
      created_at: new Date().toISOString(),
    }).catch(err => {
      console.error(`[${AGENT_ID}] agent_memory write failed:`, err.message)
    })
  }

  // ── 3. Write to industry_learnings (pooled cross-client wisdom) ──────────
  if (learning && responseRate !== null && responseRate >= 10) {
    // Only contribute to industry pool if the result was meaningfully positive
    const confidenceScore = Math.min(
      10,
      Math.round(
        (responseRate / 10) +
        (outcome.booked  ? 2 : 0) +
        (outcome.revenue ? 1 : 0)
      )
    )

    await supabase.from('industry_learnings').insert({
      industry,
      learning,
      worker_type:      campaignType,
      confidence_score: confidenceScore,
      created_at:       new Date().toISOString(),
    }).catch(err => {
      console.error(`[${AGENT_ID}] industry_learnings write failed:`, err.message)
    })
  }

  console.log(`[${AGENT_ID}] Feedback logged for client ${clientId} — type: ${campaignType}, learning: "${learning.slice(0, 80)}..."`)

  return { logged: true, learning }
}

/**
 * Log a content batch result (used by content-scheduler after generating ideas).
 * Simplified variant — no outcome metrics yet, logs activity so next run starts
 * with awareness of what was recently generated.
 *
 * @param {Object} options
 * @param {string} options.clientId
 * @param {Array}  options.ideas          - Generated content ideas
 * @param {number} options.avgScore       - Pipeline avg quality score
 * @param {string} [options.industry]
 * @param {string} [options.bizName]
 * @returns {Promise<{ logged: boolean }>}
 */
async function logContentBatch({ clientId, ideas = [], avgScore = 0, industry = 'business', bizName = 'client' }) {
  if (!clientId) return { logged: false }

  const supabase = getSupabase()

  const summary = `Content batch: ${ideas.length} ideas generated (avg quality score: ${avgScore}/10) for ${bizName}. ` +
    `Types: ${[...new Set(ideas.map(i => i.type))].join(', ')}.`

  await supabase.from('agent_memory').insert({
    client_id:        clientId,
    worker_id:        'content-scheduler',
    interaction_type: 'content_batch_logged',
    summary,
    raw_content: {
      ideaCount: ideas.length,
      avgScore,
      types:     ideas.map(i => i.type),
      hooks:     ideas.map(i => i.hook),
      timestamp: new Date().toISOString(),
    },
    created_at: new Date().toISOString(),
  }).catch(err => {
    console.error(`[${AGENT_ID}] Content batch memory write failed:`, err.message)
  })

  return { logged: true }
}

module.exports = { logCampaignResult, logContentBatch, distillLearning }
