'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// LeadQualifier — Scores incoming leads 1-10 via Groq AI
// Division: acquisition
// Reports to: acquisition-director
// Runs: on-demand (called by AcquisitionDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient = require('../../lib/ai-client')
const { fileInteraction } = require('../../lib/memory-client')
const vault = require('../../lib/memory-vault')

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

const AGENT_ID  = 'lead-qualifier'
const DIVISION  = 'acquisition'
const REPORTS_TO = 'acquisition-director'

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
    workerId: AGENT_ID,
    interactionType: 'specialist_run',
  }).catch(() => {})
  // Store best lead outcome per client into shared vault
  for (const r of reports) {
    if (r.clientId) {
      const hotCount  = r.data?.hot?.length  || 0
      const warmCount = r.data?.warm?.length || 0
      await vault.store(r.clientId, vault.KEYS.LAST_LEAD_OUTCOME, {
        hotLeads: hotCount,
        warmLeads: warmCount,
        summary: `${hotCount} hot, ${warmCount} warm leads qualified`,
        timestamp: Date.now(),
      }, 7, AGENT_ID).catch(() => {})
    }
  }
  return specialistReport
}

async function processClient(client) {
  const leads = client._pendingLeads || []
  if (!leads.length) return null

  const scored = []
  for (const lead of leads) {
    const score = await scoreLead(lead, client)
    scored.push({ ...lead, score })
  }

  const hot    = scored.filter(l => l.score >= 8)
  const warm   = scored.filter(l => l.score >= 4 && l.score < 8)
  const cold   = scored.filter(l => l.score < 4)

  // Persist high-intent leads (score >= 7) to activity_log
  try {
    const supabase = getSupabase()
    for (const lead of scored.filter(l => l.score >= 7)) {
      await supabase.from('activity_log').insert({
        client_id: client.id,
        worker_name: 'lead-qualifier',
        worker_id: 'lead-qualifier',
        event_type: 'lead_scored',
        message: `Lead scored ${lead.score}/10 — ${lead.inquiryAbout || 'inquiry'}`,
        metadata: { score: lead.score, leadId: lead.id },
        credits_used: 0,
        created_at: new Date().toISOString(),
      }).catch(() => {})
    }
  } catch {
    // Never block the return on persistence failure
  }

  const actions = []
  if (hot.length)  actions.push(`${hot.length} hot lead(s) routed for immediate SMS`)
  if (warm.length) actions.push(`${warm.length} warm lead(s) routed to nurture sequence`)
  if (cold.length) actions.push(`${cold.length} cold lead(s) archived`)

  return {
    agentId: AGENT_ID,
    clientId: client.id,
    timestamp: Date.now(),
    status: scored.length ? 'action_taken' : 'no_action',
    summary: `Qualified ${scored.length} leads for ${client.business_name}: ${actions.join(', ')}`,
    data: { hot, warm, cold },
    requiresDirectorAttention: hot.length > 0,
  }
}

async function scoreLead(lead, client) {
  const systemPrompt = `<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<task>
Score this lead from 1-10 based on buying intent.
10 = ready to buy now, 1 = very unlikely to convert.
Consider: industry fit, request specificity, response speed, language used.
</task>

<output>
Reply with ONLY a number 1-10. Nothing else.
</output>`

  const msg = `Lead inquiry: "${lead.inquiryAbout || 'general inquiry'}"
Source: ${lead.source || 'unknown'}
Last reply: "${lead.lastMessage || 'none'}"
Days since contact: ${lead.daysSinceContact || 0}`

  try {
    const raw = await aiClient.call({
      modelString: 'groq/llama-3.3-70b-versatile',
      clientApiKeys: {},
      systemPrompt,
      messages: [{ role: 'user', content: msg }],
      maxTokens: 5,
      _workerName: AGENT_ID,
    })
    const score = parseInt(raw?.trim(), 10)
    return (isNaN(score) || score < 1 || score > 10) ? 5 : score
  } catch {
    return 5 // neutral fallback
  }
}

async function report(outcomes) {
  const summary = {
    agentId: AGENT_ID,
    division: DIVISION,
    reportsTo: REPORTS_TO,
    timestamp: Date.now(),
    totalClients: outcomes.length,
    actionsCount: outcomes.filter(o => o.status === 'action_taken').length,
    escalations: outcomes.filter(o => o.requiresDirectorAttention),
    outcomes,
  }
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} actions taken`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
