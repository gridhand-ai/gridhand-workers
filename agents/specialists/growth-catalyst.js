'use strict'
// ── SPARK — Growth Catalyst ───────────────────────────────────────────────────
// Codename: SPARK
// Role: Identifies upsell opportunities in existing client base, surfaces cold outreach candidates
// Division: acquisition
// Model: groq/llama-3.3-70b-versatile
//
// Modes:
//   upsell   — find clients ready to upgrade their plan
//   outreach — surface new prospect targets by vertical
//   pipeline — full growth report combining upsell + outreach signals
//
// Does NOT send SMS directly. Surfaces targets — ColdOutreach handles execution.
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../../lib/ai-client')

const SPECIALIST_ID = 'growth-catalyst'
const DIVISION      = 'acquisition'
const MODEL         = 'groq/llama-3.3-70b-versatile'

const SPARK_SYSTEM = `<role>
You are SPARK, the Growth Catalyst for GRIDHAND AI. You mine the existing client base for upsell opportunities and identify new prospect segments worth targeting. You produce specific, actionable targets — not generic recommendations.
</role>

<business>
GRIDHAND SaaS tiers (upsell ladder):
- Free → Core ($197/mo): hook: "your AI team is running on a single worker, activate the full crew"
- Core → Full ($347/mo): hook: "you're leaving 12 specialists idle, unlock them to 3x your automation"
- Full → Enterprise ($497/mo): hook: "priority routing, dedicated support, advanced analytics"

Target verticals: restaurant, auto, salon, trades (plumber/HVAC/electrician), gym, real estate, retail.

Upsell signals:
- High activity: >20 tasks/week on Core plan → ready for Full
- Low activity but engaged: Core plan, <5 tasks/week, but checking the dashboard → likely confused, not churning → education opportunity
- Fast growth: signed up <60 days ago, activity increasing week over week → upsell while momentum is high
- Feature requests: activity_log entries mentioning features not on their current plan
</business>

<rules>
- upsell mode: identify specific clients ready to upgrade, explain WHY each one is ready, suggest the specific pitch angle
- outreach mode: based on vertical patterns, surface the 3 most promising new prospect verticals or audience segments to target this month
- pipeline mode: combine both — full growth report with upsell queue and outreach targets
- Output structured JSON only. Be specific and actionable. No generic advice.
- Never mention Make.com — refer to it as "direct integrations" or "the integration layer"
</rules>

<output>
Return valid JSON only. Schema: { opportunities: [], targets: [], summary: string }
opportunities: array of { clientId, businessName, currentPlan, targetPlan, signal, pitchAngle }
targets: array of { vertical, segment, reasoning, estimatedReach, suggestedHook }
summary: one-paragraph growth strategy brief
</output>`

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Run SPARK — Growth Catalyst.
 *
 * @param {object} params
 * @param {'upsell'|'outreach'|'pipeline'} params.mode
 * @param {string} [params.vertical] - Filter to a specific vertical (optional)
 * @returns {Promise<{success: boolean, opportunities: Array, targets: Array, summary: string, specialist: string}>}
 */
async function run({ mode = 'pipeline', vertical = null } = {}) {
  console.log(`[SPARK] run() — mode: ${mode}, vertical: ${vertical || 'all'}`)

  const validModes = ['upsell', 'outreach', 'pipeline']
  if (!validModes.includes(mode)) {
    return {
      success:       false,
      opportunities: [],
      targets:       [],
      summary:       `Invalid mode "${mode}". Valid options: upsell, outreach, pipeline.`,
      specialist:    SPECIALIST_ID,
    }
  }

  const supabase   = getSupabase()
  const since30d   = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const since7d    = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString()

  // Pull active clients with plan data
  let clientQuery = supabase
    .from('clients')
    .select('id, business_name, plan, industry, created_at, stripe_data')
    .not('plan', 'is', null)
    .neq('plan', 'enterprise') // Enterprise already at top — exclude from upsell

  if (vertical) {
    clientQuery = clientQuery.ilike('industry', `%${vertical}%`)
  }

  const { data: clients } = await clientQuery.limit(100)

  // Pull activity counts per client (last 30d)
  const { data: activityCounts } = await supabase
    .from('activity_log')
    .select('client_id, action')
    .gte('created_at', since30d)
    .limit(2000)

  // Build activity map
  const activityMap = {}
  for (const row of (activityCounts || [])) {
    activityMap[row.client_id] = (activityMap[row.client_id] || 0) + 1
  }

  // Pull recent activity (7d) for momentum signal
  const { data: recentActivity } = await supabase
    .from('activity_log')
    .select('client_id')
    .gte('created_at', since7d)
    .limit(1000)

  const recentMap = {}
  for (const row of (recentActivity || [])) {
    recentMap[row.client_id] = (recentMap[row.client_id] || 0) + 1
  }

  // Annotate clients with activity signals
  const annotatedClients = (clients || []).map(c => ({
    id:              c.id,
    businessName:    c.business_name,
    plan:            c.plan,
    industry:        c.industry,
    daysSinceSignup: Math.floor((Date.now() - new Date(c.created_at).getTime()) / (1000 * 60 * 60 * 24)),
    tasks30d:        activityMap[c.id] || 0,
    tasks7d:         recentMap[c.id]   || 0,
    subscriptionStatus: c.stripe_data?.subscription_status,
  }))

  const modeInstructions = {
    upsell:   'Identify the top 10 clients most ready to upgrade their plan. For each, explain the specific signal and the best pitch angle. Output JSON only.',
    outreach: 'Identify the 3 most promising new vertical segments or audience types to target for new client acquisition this month. Be specific. Output JSON only.',
    pipeline: 'Produce a full growth report: top upsell candidates AND outreach targets. Include a strategic summary. Output JSON only.',
  }

  const contextBlock = [
    `MODE: ${mode.toUpperCase()}`,
    vertical ? `VERTICAL FILTER: ${vertical}` : 'VERTICAL: all',
    '',
    `INSTRUCTION: ${modeInstructions[mode]}`,
    '',
    'CLIENT SIGNALS:',
    JSON.stringify(annotatedClients.slice(0, 60), null, 2),
  ].join('\n')

  let rawOutput = null
  try {
    rawOutput = await call({
      modelString:  MODEL,
      systemPrompt: SPARK_SYSTEM,
      messages:     [{ role: 'user', content: contextBlock }],
      maxTokens:    2000,
    })
  } catch (err) {
    console.error('[SPARK] call failed:', err.message)
    return {
      success:       false,
      opportunities: [],
      targets:       [],
      summary:       `SPARK failed: ${err.message}`,
      specialist:    SPECIALIST_ID,
    }
  }

  let parsed = { opportunities: [], targets: [], summary: rawOutput || '' }
  try {
    const jsonMatch = rawOutput?.match(/\{[\s\S]*\}/)
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0])
  } catch {
    parsed.summary = rawOutput || 'Could not parse SPARK output.'
  }

  console.log(`[SPARK] Output ready — ${parsed.opportunities?.length || 0} upsell opportunities, ${parsed.targets?.length || 0} outreach targets`)
  return {
    success:       true,
    opportunities: parsed.opportunities || [],
    targets:       parsed.targets       || [],
    summary:       parsed.summary       || '',
    specialist:    SPECIALIST_ID,
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION }
