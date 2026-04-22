'use strict'
// ── BRIDGE — Client Success Director ─────────────────────────────────────────
// Codename: BRIDGE
// Role: Owns NPS, health scores, QBR scheduling, escalation routing
// Division: experience
// Model: groq/llama-3.3-70b-versatile
//
// Modes:
//   health   — flag at-risk clients with health scores
//   qbr      — generate QBR agenda for a specific client
//   escalate — route urgent client issues to the right handler
//
// Does NOT send SMS. Surfaces issues and produces agendas — humans execute.
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../../lib/ai-client')

const SPECIALIST_ID = 'client-success-director'
const DIVISION      = 'experience'
const MODEL         = 'groq/llama-3.3-70b-versatile'

const BRIDGE_SYSTEM = `<role>
You are BRIDGE, the Client Success Director for GRIDHAND AI. You own the health of every client relationship. You score account health, surface at-risk clients before they churn, generate quarterly business review agendas, and route urgent escalations to the right handler.
</role>

<health_scoring>
Health score is 1-10 (10 = thriving, 1 = about to churn).

Score components:
- Activity trend (0-3 pts): growing week over week = 3, stable = 2, declining = 1, dead = 0
- Support friction (0-2 pts): 0 tickets = 2, 1-2 = 1, 3+ = 0
- Plan fit (0-2 pts): usage near plan ceiling = 1 (upsell signal), well-matched = 2, underusing = 1
- Tenure (0-2 pts): >90 days active = 2, 30-90 days = 1, <30 days = 1 (still onboarding)
- Payment health (0-1 pt): no failed payments = 1, any failure = 0

Score 7-10 = healthy. Score 4-6 = at-risk. Score 1-3 = critical.
</health_scoring>

<rules>
- health mode: score every provided client, group by tier (healthy/at-risk/critical), surface top 5 at-risk in detail
- qbr mode: generate a structured QBR agenda for the specified client — 4 sections: (1) wins since last QBR, (2) current metrics vs goals, (3) upcoming 90-day priorities, (4) action items with owners
- escalate mode: categorize the issue by urgency and type, determine the correct handler (MJ direct, experience director, or automated resolution), and draft a brief escalation summary
- Always output structured JSON matching the defined schema
- Never mention Make.com
</rules>

<output>
Return valid JSON only.

health schema: { healthScores: [{ clientId, businessName, score, tier, topRisk, topOpportunity }], escalations: [], summary: string }
qbr schema: { healthScores: [], escalations: [], agenda: string }
escalate schema: { healthScores: [], escalations: [{ clientId?, issue, urgency, handler, summary }] }
</output>`

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Run BRIDGE — Client Success Director.
 *
 * @param {object} params
 * @param {'health'|'qbr'|'escalate'} params.mode
 * @param {string} [params.clientSlug] - Required for qbr and escalate modes
 * @param {string} [params.issue]      - Required for escalate mode — description of the issue
 * @returns {Promise<{success: boolean, healthScores: Array, escalations: Array, agenda?: string, specialist: string}>}
 */
async function run({ mode = 'health', clientSlug = null, issue = null } = {}) {
  console.log(`[BRIDGE] run() — mode: ${mode}, clientSlug: ${clientSlug || 'all'}`)

  const validModes = ['health', 'qbr', 'escalate']
  if (!validModes.includes(mode)) {
    return {
      success:      false,
      healthScores: [],
      escalations:  [],
      specialist:   SPECIALIST_ID,
    }
  }

  if (mode === 'qbr' && !clientSlug) {
    return {
      success:      false,
      healthScores: [],
      escalations:  [{ urgency: 'low', handler: 'none', summary: 'qbr mode requires a clientSlug' }],
      specialist:   SPECIALIST_ID,
    }
  }

  if (mode === 'escalate' && !issue) {
    return {
      success:      false,
      healthScores: [],
      escalations:  [{ urgency: 'low', handler: 'none', summary: 'escalate mode requires an issue description' }],
      specialist:   SPECIALIST_ID,
    }
  }

  const supabase = getSupabase()
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const since7d  = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString()

  // Pull clients
  let clientQuery = supabase
    .from('clients')
    .select('id, business_name, plan, industry, created_at, stripe_data, owner_cell')

  if (clientSlug) {
    clientQuery = clientQuery.or(`business_name.ilike.%${clientSlug}%,email.ilike.%${clientSlug}%`)
  }

  const { data: clients } = await clientQuery.limit(50)

  // Pull activity counts
  const { data: activity30d } = await supabase
    .from('activity_log')
    .select('client_id')
    .gte('created_at', since30d)
    .limit(2000)

  const { data: activity7d } = await supabase
    .from('activity_log')
    .select('client_id')
    .gte('created_at', since7d)
    .limit(1000)

  const { data: supportTickets } = await supabase
    .from('activity_log')
    .select('client_id')
    .eq('worker_name', 'support_ticket')
    .gte('created_at', since30d)
    .limit(500)

  // Build maps
  const map30d    = {}
  const map7d     = {}
  const mapSupport = {}
  for (const r of (activity30d || []))   map30d[r.client_id]     = (map30d[r.client_id] || 0) + 1
  for (const r of (activity7d || []))    map7d[r.client_id]      = (map7d[r.client_id] || 0) + 1
  for (const r of (supportTickets || [])) mapSupport[r.client_id] = (mapSupport[r.client_id] || 0) + 1

  const annotatedClients = (clients || []).map(c => ({
    id:              c.id,
    businessName:    c.business_name,
    plan:            c.plan,
    industry:        c.industry,
    daysSinceSignup: Math.floor((Date.now() - new Date(c.created_at).getTime()) / (1000 * 60 * 60 * 24)),
    tasks30d:        map30d[c.id]     || 0,
    tasks7d:         map7d[c.id]      || 0,
    supportTickets30d: mapSupport[c.id] || 0,
    paymentStatus:   c.stripe_data?.subscription_status,
    failedPayments:  c.stripe_data?.payment_failures || 0,
  }))

  const modeInstructions = {
    health:   'Score every client\'s health. Group into healthy (7-10), at-risk (4-6), and critical (1-3). For at-risk and critical clients, identify the top risk and top opportunity. Output JSON only.',
    qbr:      `Generate a detailed QBR agenda for ${clientSlug}. Include 4 sections: wins, current metrics vs goals, 90-day priorities, action items with owners. Format as readable markdown in the agenda field. Output JSON only.`,
    escalate: `Analyze this escalation: "${issue}". Determine urgency (critical/high/medium/low), the right handler (MJ, experience-director, or automated), and draft a concise escalation summary. Output JSON only.`,
  }

  const contextBlock = [
    `MODE: ${mode.toUpperCase()}`,
    clientSlug ? `CLIENT SCOPE: ${clientSlug}` : 'CLIENT SCOPE: full portfolio',
    '',
    `INSTRUCTION: ${modeInstructions[mode]}`,
    '',
    'CLIENT DATA:',
    JSON.stringify(annotatedClients, null, 2),
    mode === 'escalate' ? `\nESCALATION ISSUE: ${issue}` : '',
  ].filter(Boolean).join('\n')

  let rawOutput = null
  try {
    rawOutput = await call({
      modelString:  MODEL,
      systemPrompt: BRIDGE_SYSTEM,
      messages:     [{ role: 'user', content: contextBlock }],
      maxTokens:    2000,
    })
  } catch (err) {
    console.error('[BRIDGE] call failed:', err.message)
    return {
      success:      false,
      healthScores: [],
      escalations:  [{ urgency: 'critical', handler: 'MJ', summary: `BRIDGE AI call failed: ${err.message}` }],
      specialist:   SPECIALIST_ID,
    }
  }

  let parsed = { healthScores: [], escalations: [] }
  try {
    const jsonMatch = rawOutput?.match(/\{[\s\S]*\}/)
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0])
  } catch {
    parsed.escalations = [{ urgency: 'high', handler: 'MJ', summary: rawOutput || 'BRIDGE output could not be parsed' }]
  }

  console.log(`[BRIDGE] Output ready — ${parsed.healthScores?.length || 0} health scores, ${parsed.escalations?.length || 0} escalations`)
  return {
    success:      true,
    healthScores: parsed.healthScores || [],
    escalations:  parsed.escalations  || [],
    agenda:       parsed.agenda       || null,
    specialist:   SPECIALIST_ID,
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION }
