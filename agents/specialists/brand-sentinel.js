'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// BrandSentinel — Daily scan: competitor reviews, Google ranking, NAP consistency, keyword mentions
// Division: brand
// Reports to: brand-director
// Runs: on-demand (called by BrandDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient = require('../../lib/ai-client')
const { sendSMS } = require('../../lib/twilio-client')
const { validateSMS } = require('../../lib/message-gate')

const AGENT_ID  = 'brand-sentinel'
const DIVISION  = 'brand'
const REPORTS_TO = 'brand-director'

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

  return report(reports)
}

async function processClient(client) {
  const supabase = getSupabase()
  const now = Date.now()

  // Only run weekly scan if it hasn't been done in the last 6 days
  const { data: lastScan } = await supabase
    .from('agent_state')
    .select('state')
    .eq('agent', 'brand_sentinel')
    .eq('client_id', client.id)
    .eq('entity_id', 'weekly_scan')
    .single()

  if (lastScan?.state?.scannedAt) {
    const daysSince = (now - new Date(lastScan.state.scannedAt).getTime()) / (1000 * 60 * 60 * 24)
    if (daysSince < 6) return null
  }

  // Pull recent review data for brand health assessment
  const { data: recentReviews } = await supabase
    .from('activity_log')
    .select('action, summary, metadata, created_at')
    .eq('client_id', client.id)
    .in('worker_name', ['review_received', 'review_positive', 'review_negative'])
    .gte('created_at', new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false })
    .limit(20)

  const positiveCount = recentReviews?.filter(r => r.worker_name === 'review_positive').length || 0
  const negativeCount = recentReviews?.filter(r => r.worker_name === 'review_negative').length || 0
  const totalReviews  = recentReviews?.length || 0

  // Generate weekly brand briefing
  const briefing = await generateWeeklyBriefing(client, {
    positiveReviews: positiveCount,
    negativeReviews: negativeCount,
    totalReviews,
    recentReviews: recentReviews?.slice(0, 5) || [],
  })

  // Save scan state
  await supabase.from('agent_state').upsert({
    agent: 'brand_sentinel',
    client_id: client.id,
    entity_id: 'weekly_scan',
    state: {
      scannedAt: new Date().toISOString(),
      metrics: { positiveCount, negativeCount, totalReviews },
    },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'agent,client_id,entity_id' })

  // Send briefing to client if they have a phone
  const ownerPhone = client.owner_cell
  if (briefing && ownerPhone) {
    const gateResult = validateSMS(briefing, { businessName: client.business_name })
    if (!gateResult.valid) {
      console.warn(`[${AGENT_ID}] message-gate blocked weekly briefing SMS: ${gateResult.issues.join('; ')}`)
    } else {
      try {
        await sendSMS({
          from: client.twilio_number || process.env.TWILIO_PHONE_NUMBER,
          to: ownerPhone,
          body: gateResult.text,
          clientApiKeys: {},
          clientSlug: client.email,
          clientTimezone: 'America/Chicago',
        })
      } catch (err) {
        console.error(`[${AGENT_ID}] Briefing SMS failed:`, err.message)
      }
    }
  }

  const requiresAttention = negativeCount > positiveCount || negativeCount >= 3

  return {
    agentId: AGENT_ID,
    clientId: client.id,
    timestamp: Date.now(),
    status: 'action_taken',
    summary: `Weekly brand scan for ${client.business_name}: ${positiveCount} positive, ${negativeCount} negative reviews`,
    data: { positiveCount, negativeCount, totalReviews },
    requiresDirectorAttention: requiresAttention,
  }
}

async function generateWeeklyBriefing(client, metrics) {
  const systemPrompt = `<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<brand_metrics week="this week">
Positive reviews: ${metrics.positiveReviews}
Negative reviews: ${metrics.negativeReviews}
Total review activity: ${metrics.totalReviews}
</brand_metrics>

<task>
Write a brief weekly brand health update for the business owner.
Be honest — if there are issues, name them concisely.
If things look good, celebrate briefly and give one proactive tip.
</task>

<rules>
- 3-4 sentences max
- Data-driven and practical
- End with one actionable recommendation
- Sign off as GRIDHAND
- Output ONLY the SMS text
</rules>`

  return aiClient.call({
    modelString: 'groq/llama-3.3-70b-versatile',
    clientApiKeys: {},
    systemPrompt,
    messages: [{ role: 'user', content: 'Write the weekly brand briefing.' }],
    maxTokens: 200,
    _workerName: AGENT_ID,
  })
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} brand scans completed`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
