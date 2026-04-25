'use strict'
// ── LEDGER — Financial Watchdog ───────────────────────────────────────────────
// Codename: LEDGER
// Role: Tracks MRR, churn rate, LTV, token spend vs revenue
// Division: internal
// Model: groq/llama-3.3-70b-versatile
//
// Modes:
//   mrr      — monthly recurring revenue summary
//   spend    — AI cost vs revenue breakdown
//   forecast — 90-day revenue projection
//
// Does NOT send SMS. Internal financial monitoring only.
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../../lib/ai-client')

const SPECIALIST_ID = 'financial-watchdog'
const DIVISION      = 'internal'
const MODEL         = 'groq/llama-3.3-70b-versatile'

const LEDGER_SYSTEM = `<role>
You are LEDGER, the Financial Watchdog for GRIDHAND AI. You track MRR trends, churn rate, customer lifetime value, AI token spend, and the ratio of cost to revenue. You surface financial risks and opportunities before they become problems.
</role>

<business>
GRIDHAND SaaS tiers:
- Free tier: $0/mo
- Core: $197/mo
- Full: $347/mo
- Enterprise: $497/mo

Key metrics to track:
- MRR: sum of all active subscription revenue
- Net MRR change: (new MRR + expansion) - (churn + contraction)
- Churn rate: cancelled subscriptions / total active at period start
- LTV: average revenue per account / churn rate
- AI cost ratio: total token spend (Groq + Anthropic + ElevenLabs) / MRR — target below 15%
- CAC payback period: CAC / (MRR per customer - variable cost per customer)
</business>

<rules>
- mrr mode: compute current MRR, MoM change, tier breakdown, and churn impact
- spend mode: break down AI costs by provider and by use case, compare to revenue, flag if cost ratio exceeds 15%
- forecast mode: project 90-day revenue based on current growth rate, churn rate, and pipeline
- Always output structured JSON matching the defined schema
- Flag alerts in the alerts array for anything that requires MJ's attention
- Never include personally identifiable financial data — aggregate only
</rules>

<quality_standard>
SPECIALIST OUTPUT DISCIPLINE:
Never use: "I believe", "it seems", "perhaps", "it appears", "Certainly!", "Great!", "I'd be happy to", "Of course!", "I'm sorry", "Unfortunately", "I apologize", "I understand", "As an AI"
Outcome-first: lead with the metric or alert, not the analysis
Return structured JSON only — no unstructured prose responses
Never explain reasoning unless confidence < 0.7 or explicitly asked
If confidence < 0.7, set escalate: true and include reasoning_short.
</quality_standard>
<output>
Return valid JSON only. Schema: { metrics: {}, insights: [], alerts: [], confidence: number (0.0-1.0), escalate: boolean, reasoning_short: string (max 20 words) }
metrics: key-value financial metrics relevant to the mode
insights: array of { finding, implication }
alerts: array of { severity: 'critical'|'warning', message, action }
confidence: 0.0-1.0 confidence in the metrics and alerts
escalate: true when confidence < 0.7 or financial anomaly outside normal patterns
</output>`

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Run LEDGER — Financial Watchdog.
 *
 * @param {object} params
 * @param {'mrr'|'spend'|'forecast'} params.mode
 * @param {string} [params.period]  - e.g. '30d', '90d' (default '30d')
 * @returns {Promise<{success: boolean, metrics: object, insights: Array, alerts: Array, specialist: string}>}
 */
async function run({ mode = 'mrr', period = '30d' } = {}) {
  console.log(`[LEDGER] run() — mode: ${mode}, period: ${period}`)

  const validModes = ['mrr', 'spend', 'forecast']
  if (!validModes.includes(mode)) {
    return {
      success:    false,
      metrics:    {},
      insights:   [],
      alerts:     [{ severity: 'warning', message: `Invalid mode "${mode}"`, action: 'Use mrr, spend, or forecast' }],
      specialist: SPECIALIST_ID,
    }
  }

  const supabase   = getSupabase()
  const daysBack   = period === '90d' ? 90 : 30
  const since      = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()
  const prevPeriod = new Date(Date.now() - daysBack * 2 * 24 * 60 * 60 * 1000).toISOString()

  // Pull client subscription data
  const { data: clients } = await supabase
    .from('clients')
    .select('id, plan, stripe_data, created_at, updated_at')
    .not('plan', 'is', null)

  // Pull token spend data
  const { data: tokenRows } = await supabase
    .from('token_usage')
    .select('model, tokens_in, tokens_out, cost_usd, created_at, client_id')
    .gte('created_at', since)
    .limit(500)

  // Pull recent Stripe events for churn signals
  const { data: stripeEvents } = await supabase
    .from('stripe_events')
    .select('type, data, created_at')
    .gte('created_at', since)
    .in('type', ['customer.subscription.deleted', 'customer.subscription.updated', 'invoice.payment_failed'])
    .limit(100)

  const PLAN_MRR = { free: 0, core: 197, full: 347, enterprise: 497 }

  // Compute basic metrics
  const activeClients  = (clients || []).filter(c => c.stripe_data?.subscription_status === 'active')
  const currentMRR     = activeClients.reduce((sum, c) => sum + (PLAN_MRR[c.plan] || 0), 0)
  const cancelledCount = (stripeEvents || []).filter(e => e.type === 'customer.subscription.deleted').length
  const totalTokenCost = (tokenRows || []).reduce((sum, r) => sum + (r.cost_usd || 0), 0)

  const modeInstructions = {
    mrr:      'Analyze MRR composition, tier distribution, MoM trend, churn events, and net revenue change. Identify top risks to MRR. Output JSON only.',
    spend:    'Break down AI token costs by provider and use case. Compute the cost-to-revenue ratio. Flag if spend exceeds 15% of MRR. Output JSON only.',
    forecast: 'Project 90-day revenue based on current growth rate, churn rate, and pipeline signals. Include optimistic, base, and pessimistic cases. Output JSON only.',
  }

  const contextBlock = [
    `MODE: ${mode.toUpperCase()}`,
    `PERIOD: last ${period}`,
    '',
    `INSTRUCTION: ${modeInstructions[mode]}`,
    '',
    'CLIENT METRICS:',
    `Total active clients: ${activeClients.length}`,
    `Current MRR: $${currentMRR.toLocaleString()}`,
    `Cancelled this period: ${cancelledCount}`,
    `Tier breakdown: ${JSON.stringify(
      Object.entries(PLAN_MRR).map(([plan, arr]) => ({
        plan,
        count: activeClients.filter(c => c.plan === plan).length,
        arr,
      }))
    )}`,
    '',
    'TOKEN SPEND:',
    `Total cost (period): $${totalTokenCost.toFixed(2)}`,
    `Cost ratio vs MRR: ${currentMRR > 0 ? ((totalTokenCost / currentMRR) * 100).toFixed(1) : 'N/A'}%`,
    `Sample token rows: ${JSON.stringify((tokenRows || []).slice(0, 20), null, 2)}`,
    '',
    'STRIPE EVENTS:',
    JSON.stringify((stripeEvents || []).slice(0, 30), null, 2),
  ].join('\n')

  let rawOutput = null
  try {
    rawOutput = await call({
      modelString:  MODEL,
      systemPrompt: LEDGER_SYSTEM,
      messages:     [{ role: 'user', content: contextBlock }],
      maxTokens:    2000,
    })
  } catch (err) {
    console.error('[LEDGER] call failed:', err.message)
    return {
      success:    false,
      metrics:    { currentMRR, activeClients: activeClients.length, totalTokenCost },
      insights:   [],
      alerts:     [{ severity: 'critical', message: `LEDGER AI call failed: ${err.message}`, action: 'Check Groq API key and connectivity' }],
      specialist: SPECIALIST_ID,
    }
  }

  let parsed = { metrics: {}, insights: [], alerts: [] }
  try {
    const jsonMatch = rawOutput?.match(/\{[\s\S]*\}/)
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0])
  } catch {
    parsed.metrics  = { currentMRR, activeClients: activeClients.length, totalTokenCost }
    parsed.insights = [{ finding: rawOutput || 'No output', implication: 'Manual review required' }]
  }

  // Always include raw computed metrics as a baseline
  parsed.metrics = {
    currentMRR,
    activeClients:  activeClients.length,
    totalTokenCost: parseFloat(totalTokenCost.toFixed(2)),
    costRatioPct:   currentMRR > 0 ? parseFloat(((totalTokenCost / currentMRR) * 100).toFixed(1)) : null,
    cancelledThisPeriod: cancelledCount,
    ...parsed.metrics,
  }

  console.log(`[LEDGER] Output ready — MRR: $${currentMRR}, cost ratio: ${parsed.metrics.costRatioPct}%`)
  return {
    success:    true,
    metrics:    parsed.metrics    || {},
    insights:   parsed.insights   || [],
    alerts:     parsed.alerts     || [],
    specialist: SPECIALIST_ID,
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION }
