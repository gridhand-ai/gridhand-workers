'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// MarketPulse — Scans client activity patterns, keyword trends in inbound
// messages, and service request distributions to identify emerging demand
// signals. Surfaces high-confidence market insights to the Intelligence
// Director for cross-client pattern recognition.
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

const AGENT_ID   = 'market-pulse'
const DIVISION   = 'intelligence'
const REPORTS_TO = 'intelligence-director'

// Look at messages from the last N days for trend analysis
const TREND_WINDOW_DAYS = 14

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Main entry point — iterate clients, analyze inbound message trends.
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
        lastAction:    'market_pulse_scan',
        topSignals:    r.data?.signals || [],
        insight:       r.data?.insight,
        summary:       r.summary || 'market pulse scan complete',
        timestamp:     Date.now(),
      }, 6, AGENT_ID).catch(() => {})
    }
  }

  return specialistReport
}

/**
 * Process a single client — extract message trends and surface demand signals.
 * @param {Object} client
 * @returns {Object|null}
 */
async function processClient(client) {
  const supabase   = getSupabase()
  const cutoff     = new Date(Date.now() - TREND_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Pull recent inbound messages
  const { data: messages } = await supabase
    .from('messages')
    .select('body, created_at')
    .eq('client_id', client.id)
    .eq('direction', 'inbound')
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(100)

  if (!messages?.length || messages.length < 5) return null

  // Build a sample corpus for trend analysis (truncate long messages)
  const corpus = messages
    .map(m => (m.body || '').slice(0, 120))
    .filter(Boolean)
    .join('\n')

  const analysis = await analyzeTrends(client, corpus, messages.length)
  if (!analysis) return null

  return {
    agentId:                   AGENT_ID,
    clientId:                  client.id,
    timestamp:                 Date.now(),
    status:                    'action_taken',
    summary:                   `Market pulse: ${messages.length} messages analyzed for ${client.business_name}. ${analysis.topSignal || 'No dominant trend detected.'}`,
    data:                      {
      messagesAnalyzed: messages.length,
      signals:          analysis.signals || [],
      insight:          analysis.insight,
      topSignal:        analysis.topSignal,
    },
    requiresDirectorAttention: (analysis.signals?.length || 0) >= 3,
  }
}

/**
 * Use Groq to extract demand signals from message corpus.
 * @param {Object} client
 * @param {string} corpus
 * @param {number} messageCount
 * @returns {Promise<Object|null>}
 */
async function analyzeTrends(client, corpus, messageCount) {
  const systemPrompt = `<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<task>
Analyze these ${messageCount} recent inbound customer messages. Identify:
1. Recurring demand signals or topics customers keep asking about
2. Any emerging services or needs not currently being met
3. The single most important market insight from this data
</task>

<messages>
${corpus.slice(0, 3000)}
</messages>

<output>
Return a JSON object with:
- "signals": array of up to 3 strings (specific recurring topics/demands)
- "topSignal": the single most important signal as a sentence
- "insight": 1 actionable sentence for the business owner

Return ONLY valid JSON. No other text.
</output>`

  try {
    const raw = await aiClient.call({
      modelString:   'groq/llama-3.3-70b-versatile',
      clientApiKeys: {},
      systemPrompt,
      messages:      [{ role: 'user', content: 'Analyze the message trends.' }],
      maxTokens:     300,
      _workerName:   AGENT_ID,
    })
    const jsonMatch = raw?.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    return JSON.parse(jsonMatch[0])
  } catch (err) {
    console.error(`[${AGENT_ID}] Trend analysis failed:`, err.message)
    return null
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} market pulse analyses completed`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
