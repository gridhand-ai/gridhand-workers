'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// ReputationRepair — Reputation Repair Specialist
// Detects clients with review average below 3.5 and generates a recovery plan.
// Logs the plan to client_knowledge. Escalates immediately if average < 2.5.
// Division: brand
// Reports to: brand-director
// Runs: on-demand (called by BrandDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../../lib/ai-client')

const SPECIALIST_ID        = 'reputation-repair'
const DIVISION             = 'brand'
const REPORTS_TO           = 'brand-director'
const GROQ_MODEL           = 'groq/llama-3.3-70b-versatile'
const ALERT_THRESHOLD      = 3.5  // below this: generate repair plan
const ESCALATION_THRESHOLD = 2.5  // below this: immediate escalation flag

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

async function run(clients = []) {
  console.log(`[${SPECIALIST_ID.toUpperCase()}] Starting run — ${clients.length} client(s)`)
  const supabase = getSupabase()
  const outcomes = []

  for (const client of clients) {
    try {
      const result = await processClient(client, supabase)
      if (result) outcomes.push(result)
    } catch (err) {
      console.error(`[${SPECIALIST_ID}] Error for client ${client.id}:`, err.message)
    }
  }

  return buildReport(outcomes)
}

async function processClient(client, supabase) {
  // Pull review_received events with a rating field from activity_log
  const thirtyAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: reviewLogs, error } = await supabase
    .from('activity_log')
    .select('metadata')
    .eq('client_id', client.id)
    .eq('action', 'review_received')
    .gte('created_at', thirtyAgo)
    .not('metadata', 'is', null)

  if (error) {
    console.warn(`[${SPECIALIST_ID}] review query failed for ${client.id}: ${error.message}`)
    return null
  }

  if (!reviewLogs || !reviewLogs.length) return null

  // Calculate average rating from metadata.rating
  const ratings = reviewLogs
    .map(r => typeof r.metadata?.rating === 'number' ? r.metadata.rating : null)
    .filter(r => r !== null)

  if (!ratings.length) return null

  const avg = ratings.reduce((sum, r) => sum + r, 0) / ratings.length

  // Only act when below the alert threshold
  if (avg >= ALERT_THRESHOLD) return null

  const needsEscalation = avg < ESCALATION_THRESHOLD
  console.log(`[${SPECIALIST_ID}] ${client.business_name || client.id}: avg rating=${avg.toFixed(2)}, escalate=${needsEscalation}`)

  // Generate a 2-sentence reputation recovery plan via Groq
  let plan = null
  try {
    plan = await call({
      modelString: GROQ_MODEL,
      systemPrompt: `<role>GRIDHAND reputation specialist for ${client.business_name || 'a local business'} (${client.industry || 'small business'}).</role>
<rules>Write a 2-sentence reputation recovery plan. Plain language, practical, actionable. No fake stats. No URLs. Grade 7 reading level.</rules>

<quality_standard>
ANTI-AI BLACKLIST — never use these in any message you generate:
Openers: "Absolutely!", "Certainly!", "Great question!", "I hope this finds you well", "Just checking in!", "This is a friendly reminder", "Please be advised", "As per our records"
Filler: "valued customer", "valued client", "don't hesitate to reach out", "at your earliest convenience", "please feel free to", "I believe", "it seems", "I understand your concern"
Fake urgency: "Act now!", "Limited time!", "Don't miss out!"

TONE RULES:
- 7th-8th grade reading level
- Short sentences (10-15 words max), varied rhythm
- First name only — never full name or "dear customer"
- Real specifics always: time, date, amount, service name
- Match the business's vertical voice — auto shop ≠ restaurant ≠ gym
- No emoji unless the business already uses them
</quality_standard>`,
      messages: [{
        role: 'user',
        content: `This business has an average review rating of ${avg.toFixed(1)} from ${ratings.length} recent reviews. Write a 2-sentence recovery plan.`,
      }],
      maxTokens: 120,
      _workerName: SPECIALIST_ID,
      tier: 'specialist',
    })
  } catch (aiErr) {
    console.warn(`[${SPECIALIST_ID}] AI failed for ${client.id}: ${aiErr.message}`)
    plan = `Average rating is ${avg.toFixed(1)} — focus on responding to negative reviews promptly and requesting feedback from satisfied customers.`
  }

  // Log plan to client_knowledge
  await supabase.from('client_knowledge').insert({
    client_id:  client.id,
    category:   'reputation_repair',
    content:    plan,
    created_at: new Date().toISOString(),
  }).catch(e => console.warn(`[${SPECIALIST_ID}] client_knowledge insert failed: ${e.message}`))

  // Log to activity_log
  await supabase.from('activity_log').insert({
    client_id:   client.id,
    worker_id:   SPECIALIST_ID,
    worker_name: 'Reputation Repair',
    action:      'reputation_repair_plan',
    message:     `Repair plan generated for avg rating ${avg.toFixed(1)}${needsEscalation ? ' — CRITICAL escalation' : ''}`,
    outcome:     needsEscalation ? 'error' : 'ok',
    metadata:    { avgRating: parseFloat(avg.toFixed(2)), reviewCount: ratings.length, needsEscalation },
    created_at:  new Date().toISOString(),
  }).catch(e => console.warn(`[${SPECIALIST_ID}] activity_log insert failed: ${e.message}`))

  return {
    agentId:      SPECIALIST_ID,
    clientId:     client.id,
    timestamp:    Date.now(),
    status:       'action_taken',
    actionsCount: 1,
    summary:      `${client.business_name || client.id}: avg rating ${avg.toFixed(1)} — repair plan generated${needsEscalation ? ' (CRITICAL)' : ''}`,
    escalations:  needsEscalation
      ? [{ agentId: SPECIALIST_ID, clientId: client.id, summary: `Critical reputation risk: avg ${avg.toFixed(1)}/5 — immediate director attention needed`, data: { avgRating: avg } }]
      : [],
    data:         { avgRating: parseFloat(avg.toFixed(2)), reviewCount: ratings.length, plan, needsEscalation },
    requiresDirectorAttention: needsEscalation,
  }
}

function buildReport(outcomes) {
  const totalActions = outcomes.reduce((sum, o) => sum + (o.actionsCount || 0), 0)
  const critical     = outcomes.filter(o => o.data?.needsEscalation)
  console.log(`[${SPECIALIST_ID.toUpperCase()}] Complete — ${totalActions} repair plan(s) generated, ${critical.length} critical`)
  return {
    agentId:      SPECIALIST_ID,
    division:     DIVISION,
    reportsTo:    REPORTS_TO,
    timestamp:    Date.now(),
    actionsCount: totalActions,
    escalations:  outcomes.flatMap(o => o.escalations || []),
    outcomes,
    data:         { repairsGenerated: totalActions, criticalCount: critical.length },
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION, REPORTS_TO }
