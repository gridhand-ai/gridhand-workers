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
const exa                 = require('../../lib/exa-client')
const { fileInteraction } = require('../../lib/memory-client')
const vault               = require('../../lib/memory-vault')

// ── Vertical knowledge base ───────────────────────────────────────────────────
const VERTICAL_INTEL = {
  'auto':          { peakDays: 'Mon/Tue', avgTicket: '$180-$400', reviewPlatforms: 'Yelp + Google', repeatCycle: '3-6 months', shopperBehavior: 'price + trust driven' },
  'vehicle':       { peakDays: 'Mon/Tue', avgTicket: '$180-$400', reviewPlatforms: 'Yelp + Google', repeatCycle: '3-6 months', shopperBehavior: 'price + trust driven' },
  'salon':         { peakDays: 'Thu-Sat', avgTicket: '$60-$150', reviewPlatforms: 'Google + Instagram', repeatCycle: '3-6 weeks', shopperBehavior: 'Instagram drives discovery, reviews seal trust' },
  'barber':        { peakDays: 'Fri-Sat', avgTicket: '$30-$60', reviewPlatforms: 'Google + Instagram', repeatCycle: '3-4 weeks', shopperBehavior: 'Instagram drives discovery, repeat loyalty critical' },
  'restaurant':    { peakDays: 'Fri-Sun', avgTicket: '$20-$60', reviewPlatforms: 'Google + Yelp', repeatCycle: '2-4 weeks', shopperBehavior: 'Google reviews + response time matter most' },
  'gym':           { peakDays: 'Mon/Jan spike', avgTicket: '$30-$80/mo', reviewPlatforms: 'Google', repeatCycle: 'monthly', shopperBehavior: 'retention drops at 90 days, referrals work well' },
  'fitness':       { peakDays: 'Mon/Jan spike', avgTicket: '$30-$80/mo', reviewPlatforms: 'Google', repeatCycle: 'monthly', shopperBehavior: 'retention drops at 90 days, referrals work well' },
  'retail':        { peakDays: 'Sat-Sun', avgTicket: '$40-$200', reviewPlatforms: 'Google Maps', repeatCycle: '4-8 weeks', shopperBehavior: 'foot traffic + Google Maps visibility critical' },
  'real-estate':   { peakDays: 'varies', avgTicket: '$5k-$25k commission', reviewPlatforms: 'Google + Zillow', repeatCycle: '3-7 years', shopperBehavior: 'long sales cycle, lead nurture is everything' },
}

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
 * Fetch real-time market trends for a client's vertical and city via Exa.
 * Returns a compact intel string or null if search fails.
 */
async function fetchMarketIntel(client) {
  const industry  = client.industry || 'small business'
  const city      = client.city     || client.location || ''
  const query     = city
    ? `${industry} business trends customer demand ${city} 2025`
    : `${industry} small business customer demand trends 2025`

  try {
    const results = await exa.search(query, { numResults: 3, maxChars: 1200 })
    if (!results?.results?.length) {
      // Self-correction: retry with broader terms
      console.log(`[${AGENT_ID}] Exa returned no results — retrying with broader query`)
      const broad = await exa.search(`${industry} business trends 2025`, { numResults: 3, maxChars: 1200 })
      if (!broad?.results?.length) return null
      return broad.results.map(r => r.highlights?.join(' ') || r.title).join('\n').slice(0, 2000)
    }
    return results.results.map(r => r.highlights?.join(' ') || r.title).join('\n').slice(0, 2000)
  } catch (err) {
    console.warn(`[${AGENT_ID}] Exa search failed (non-blocking):`, err.message)
    return null
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
  // Pull real-time market context from the web before generating insights
  const marketIntel = await fetchMarketIntel(client)

  // Resolve vertical-specific context
  const industryKey  = Object.keys(VERTICAL_INTEL).find(k =>
    (client.industry || '').toLowerCase().includes(k)
  )
  const verticalData = industryKey ? VERTICAL_INTEL[industryKey] : null
  const verticalXml  = verticalData
    ? `<vertical_context industry="${client.industry}">
Peak days: ${verticalData.peakDays}
Average ticket: ${verticalData.avgTicket}
Key review platforms: ${verticalData.reviewPlatforms}
Repeat visit cycle: ${verticalData.repeatCycle}
Shopper behavior: ${verticalData.shopperBehavior}
</vertical_context>`
    : ''

  const systemPrompt = `<role>Market Pulse Analyst for GRIDHAND AI — identify demand signals and emerging needs from customer message data, enriched with real-time market research.</role>
<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>
${verticalXml}
${marketIntel ? `<market_intel source="web_search">\n${marketIntel}\n</market_intel>` : ''}

<task>
Analyze these ${messageCount} recent inbound customer messages. Cross-reference with
the market intel above if available. Identify:
1. Recurring demand signals or topics customers keep asking about
2. Any emerging services or needs not currently being met — compare against market trends
3. The single most important market insight from this combined data
</task>

<messages>
${corpus.slice(0, 3000)}
</messages>

<self_correction>
If your signals array is empty after analyzing the messages, re-examine the corpus
for subtler patterns — frequency of similar words, time-of-day patterns, or
service type clustering. Only return empty signals if the corpus is genuinely random.
</self_correction>

<quality_standard>
SPECIALIST OUTPUT DISCIPLINE:
Never use: "I believe", "it seems", "perhaps", "it appears", "Certainly!", "Great!", "I'd be happy to", "Of course!", "I'm sorry", "Unfortunately", "I apologize", "I understand", "As an AI"
Outcome-first: lead with the signal or insight, not the analysis
Return structured JSON only — no unstructured prose responses
Never explain reasoning unless confidence < 0.7 or explicitly asked
If confidence < 0.7, set escalate: true and include reasoning_short.
</quality_standard>
<output>
Return a JSON object with:
- "signals": array of up to 3 strings (specific recurring topics/demands)
- "topSignal": the single most important signal as a sentence
- "insight": 1 actionable sentence for the business owner
- "marketContext": 1 sentence from web research if available, null otherwise
- "confidence": number (0.0-1.0, certainty in the signals identified)
- "escalate": boolean (true if confidence < 0.7)
- "reasoning_short": string (max 20 words explaining the conclusion)

Return ONLY valid JSON. No other text.
</output>`

  try {
    const raw = await aiClient.call({
      modelString:   'groq/llama-3.3-70b-versatile',
      clientApiKeys: {},
      systemPrompt,
      messages:      [{ role: 'user', content: 'Analyze the message trends.' }],
      maxTokens:     400,
      _workerName:   AGENT_ID,
      tier: 'specialist',
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
