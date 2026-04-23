'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// PricingOptimizer — Identifies underpriced clients (90%+ plan usage), flags for upgrade
// Division: revenue
// Reports to: revenue-director
// Runs: on-demand (called by RevenueDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../../lib/ai-client')
const exa              = require('../../lib/exa-client')
const { fileInteraction } = require('../../lib/memory-client')
const vault            = require('../../lib/memory-vault')

const AGENT_ID  = 'pricing-optimizer'
const DIVISION  = 'revenue'
const REPORTS_TO = 'revenue-director'

// Usage threshold above which we flag for upgrade conversation
const USAGE_THRESHOLD = 0.90

// Known SMB service pricing ranges for validation / context
const VERTICAL_PRICING = {
  'auto':       { services: 'oil change $35-$90, brake job $150-$400, tune-up $120-$300' },
  'vehicle':    { services: 'oil change $35-$90, brake job $150-$400, tune-up $120-$300' },
  'salon':      { services: 'haircut $35-$120, color $80-$250, highlights $100-$300' },
  'barber':     { services: 'haircut $25-$55, shave $20-$50, combo $45-$90' },
  'restaurant': { services: 'lunch $12-$25, dinner $20-$60, catering varies' },
  'gym':        { services: 'membership $25-$80/mo, personal training $50-$150/session' },
  'fitness':    { services: 'membership $25-$80/mo, personal training $50-$150/session' },
  'retail':     { services: 'varies by category — benchmark against top local competitors' },
}

/**
 * Fetch local competitor pricing for a client's service via Exa.
 * Grounds the upgrade recommendation in real market rates.
 */
async function fetchCompetitorPricing(client) {
  const industry = client.industry || 'business'
  const city     = client.city || client.location || ''
  const query    = city
    ? `${industry} pricing rates ${city} local competitors 2025`
    : `average ${industry} service pricing rates 2025`
  try {
    const results = await exa.search(query, { numResults: 3, maxChars: 800 })
    if (!results?.results?.length) {
      // Self-correction: retry with service type + national benchmark
      const retry = await exa.search(`${industry} service average price benchmark United States`, { numResults: 3, maxChars: 800 })
      if (!retry?.results?.length) return null
      return retry.results.map(r => r.highlights?.join(' ') || r.title).join('\n').slice(0, 1200)
    }
    return results.results.map(r => r.highlights?.join(' ') || r.title).join('\n').slice(0, 1200)
  } catch (err) {
    console.warn(`[${AGENT_ID}] Exa pricing search failed (non-blocking):`, err.message)
    return null
  }
}

/**
 * Generate an AI-powered pricing insight for the upgrade recommendation.
 */
async function generatePricingInsight(client, usagePct, competitorPricing) {
  const industryKey    = Object.keys(VERTICAL_PRICING).find(k =>
    (client.industry || '').toLowerCase().includes(k)
  )
  const verticalData   = industryKey ? VERTICAL_PRICING[industryKey] : null

  const systemPrompt = `<role>Pricing Optimizer for GRIDHAND AI — generate data-backed upgrade recommendations for small business clients.</role>
<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
Current plan: ${client.plan || 'unknown'}
Plan usage: ${usagePct}% of limit
</business>
${verticalData ? `<vertical_context>\nTypical service pricing in this vertical: ${verticalData.services}\n</vertical_context>` : ''}
${competitorPricing ? `<competitor_pricing source="web_research">\n${competitorPricing}\n</competitor_pricing>` : ''}

<task>
Write ONE concise sentence explaining why this business should upgrade their GRIDHAND plan,
referencing their usage level and any relevant market context.
Focus on ROI — at their usage rate they are getting good value; the next tier unlocks more automation.
</task>

<rules>
- 1 sentence only
- Reference the ${usagePct}% usage figure
- Do not invent specific competitor prices not found in the data
- Output ONLY the recommendation sentence
</rules>`

  try {
    const raw = await call({
      modelString:   'groq/llama-3.3-70b-versatile',
      clientApiKeys: {},
      systemPrompt,
      messages:      [{ role: 'user', content: 'Write the upgrade recommendation.' }],
      maxTokens:     100,
      _workerName:   AGENT_ID,
    })
    return raw?.trim() || null
  } catch {
    return null
  }
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

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
  // Store offer structure (pricing analysis) per client into shared vault
  for (const r of reports) {
    if (r.clientId) {
      await vault.store(r.clientId, vault.KEYS.OFFER_STRUCTURE, {
        upgradeFlagged: r.status === 'action_taken',
        usagePercent: r.data?.usagePercent,
        summary: r.summary || 'pricing optimization check complete',
        timestamp: Date.now(),
      }, 7, AGENT_ID).catch(() => {})
    }
  }
  return specialistReport
}

async function processClient(client) {
  const supabase = getSupabase()

  // Get current month task count
  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const { count: taskCount } = await supabase
    .from('activity_log')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', client.id)
    .gte('created_at', startOfMonth.toISOString())

  const planLimit = client.task_limit || client.tasks_limit || 500
  const usageRatio = (taskCount || 0) / planLimit
  const usagePct = Math.round(usageRatio * 100)

  if (usageRatio < USAGE_THRESHOLD) return null

  // Already flagged this month?
  const { data: flagState } = await supabase
    .from('agent_state')
    .select('state')
    .eq('agent', 'pricing_optimizer')
    .eq('client_id', client.id)
    .eq('entity_id', 'upgrade_flag')
    .single()

  const flaggedAt = flagState?.state?.flaggedAt
  if (flaggedAt) {
    const daysSince = (Date.now() - new Date(flaggedAt).getTime()) / (1000 * 60 * 60 * 24)
    if (daysSince < 30) return null // Don't re-flag within 30 days
  }

  // Fetch competitor pricing data + generate AI insight before flagging
  const competitorPricing = await fetchCompetitorPricing(client)
  const pricingInsight    = await generatePricingInsight(client, usagePct, competitorPricing)

  // Flag for upgrade conversation
  await supabase.from('agent_state').upsert({
    agent: 'pricing_optimizer',
    client_id: client.id,
    entity_id: 'upgrade_flag',
    state: {
      flaggedAt: new Date().toISOString(),
      usagePct,
      taskCount,
      planLimit,
      currentPlan:    client.plan || 'unknown',
      pricingInsight: pricingInsight || null,
    },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'agent,client_id,entity_id' })

  // Log to activity
  await supabase.from('activity_log').insert({
    client_id: client.id,
    action: 'upgrade_opportunity_flagged',
    message: pricingInsight || `Client at ${usagePct}% of plan usage`,
    metadata: { usagePct, taskCount, planLimit, pricingInsight },
    created_at: new Date().toISOString(),
  })

  return {
    agentId: AGENT_ID,
    clientId: client.id,
    timestamp: Date.now(),
    status: 'action_taken',
    summary: `${client.business_name} at ${usagePct}% plan usage — flagged for upgrade conversation${pricingInsight ? ': ' + pricingInsight.slice(0, 80) : ''}`,
    data: { usagePct, taskCount, planLimit, currentPlan: client.plan, pricingInsight },
    requiresDirectorAttention: true, // Always escalate — this is a revenue conversation
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} clients flagged for upgrade`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
