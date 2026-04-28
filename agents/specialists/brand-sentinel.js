'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// BrandSentinel — Daily scan: competitor reviews, Google ranking, NAP consistency, keyword mentions
// Division: brand
// Reports to: brand-director
// Runs: on-demand (called by BrandDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient         = require('../../lib/ai-client')
const exa              = require('../../lib/exa-client')
const { sendSMS }      = require('../../lib/twilio-client')
const { validateSMS }  = require('../../lib/message-gate')
const { buildClientContext } = require('../../lib/client-context')
const { fileInteraction }    = require('../../lib/memory-client')
const vault                  = require('../../lib/memory-vault')

const AGENT_ID  = 'brand-sentinel'
const DIVISION  = 'brand'
const REPORTS_TO = 'brand-director'

const VERTICAL_GUIDANCE = {
  'vehicle-service':      'Focus on trust signals, response time to negative reviews, and consistency across listings.',
  'food-beverage':        'Focus on freshness mentions, service speed complaints, and atmosphere feedback.',
  'health-fitness':       'Focus on cleanliness concerns, equipment quality mentions, and trainer feedback.',
  'personal-care':        'Focus on wait time complaints, skill feedback, and atmosphere mentions.',
  'family-entertainment': 'Focus on safety mentions, staff friendliness reviews, and value-for-money sentiment.',
  'general':              'Focus on the most common complaint theme and identify one actionable fix.',
}

/**
 * Scan the web for brand mentions beyond in-app reviews via Exa.
 * Catches Reddit posts, local forums, social mentions, news articles.
 * Self-corrects: if primary search returns nothing, expands to include abbreviations.
 */
async function fetchWebMentions(client) {
  const name = client.business_name
  const city  = client.city || client.location || ''

  // Primary search — exact business name + city
  const primaryQuery = city ? `"${name}" ${city} reviews OR complaints OR mentions` : `"${name}" reviews OR complaints`
  try {
    const results = await exa.search(primaryQuery, {
      numResults:     5,
      maxChars:       1200,
      excludeDomains: ['facebook.com', 'instagram.com'], // social auth-walled — exa can't see these
    })

    if (results?.results?.length) {
      return results.results.map(r => ({
        title:      r.title,
        url:        r.url,
        highlights: r.highlights?.join(' ') || '',
        published:  r.published,
      }))
    }

    // Self-correction: try without quotes + add misspelling variants
    console.log(`[${AGENT_ID}] Primary brand scan returned no results — expanding search for ${name}`)
    const broadQuery = city
      ? `${name} ${city} customer review experience`
      : `${name} customer review experience`
    const broadResults = await exa.search(broadQuery, { numResults: 4, maxChars: 1200 })
    if (!broadResults?.results?.length) return []
    return broadResults.results.map(r => ({
      title:      r.title,
      url:        r.url,
      highlights: r.highlights?.join(' ') || '',
      published:  r.published,
    }))
  } catch (err) {
    console.warn(`[${AGENT_ID}] Exa web mention scan failed (non-blocking):`, err.message)
    return []
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
  // Store review sentiment (brand health signals) per client into shared vault
  for (const r of reports) {
    if (r.clientId) {
      await vault.store(r.clientId, vault.KEYS.REVIEW_SENTIMENT, {
        briefingSent: r.status === 'action_taken',
        summary: r.summary || 'brand monitoring cycle complete',
        timestamp: Date.now(),
      }, 6, AGENT_ID).catch(() => {})
    }
  }
  return specialistReport
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
    .in('action', ['review_received', 'review_positive', 'review_negative'])
    .gte('created_at', new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false })
    .limit(20)

  const positiveCount = recentReviews?.filter(r => r.action === 'review_positive').length || 0
  const negativeCount = recentReviews?.filter(r => r.action === 'review_negative').length || 0
  const totalReviews  = recentReviews?.length || 0

  // Scan the web for brand mentions beyond in-app reviews
  const webMentions = await fetchWebMentions(client)

  // Generate weekly brand briefing
  const briefing = await generateWeeklyBriefing(client, {
    positiveReviews: positiveCount,
    negativeReviews: negativeCount,
    totalReviews,
    recentReviews:   recentReviews?.slice(0, 5) || [],
    webMentions,
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
  const ctx              = buildClientContext(client)
  const verticalGuidance = VERTICAL_GUIDANCE[ctx.vertical] || VERTICAL_GUIDANCE['general']

  // Format web mentions for prompt injection
  const mentionSummary = metrics.webMentions?.length
    ? metrics.webMentions.slice(0, 3).map(m => `- ${m.title}: ${m.highlights?.slice(0, 120) || 'no excerpt'}`).join('\n')
    : null

  const systemPrompt = `<role>Brand Sentinel for GRIDHAND AI — deliver weekly brand health briefings to small business clients via SMS.</role>
${ctx.xml}

<brand_metrics week="this week">
Positive reviews: ${metrics.positiveReviews}
Negative reviews: ${metrics.negativeReviews}
Total review activity: ${metrics.totalReviews}
</brand_metrics>
${mentionSummary ? `<web_mentions source="external_scan">
${mentionSummary}
</web_mentions>` : ''}

<vertical_guidance>
${verticalGuidance}
</vertical_guidance>

<task>
Write a brief weekly brand health update for the business owner.
Be honest — if there are issues (negative reviews, negative web mentions), name them concisely.
If web mentions surface something notable (positive press or a complaint thread), mention it briefly.
If things look good, celebrate briefly and give one proactive tip aligned with the vertical guidance above.
</task>

<rules>
- 3-4 sentences max
- Data-driven and practical
- Reference web mentions only if they are notable and specific
- End with one actionable recommendation relevant to the vertical
- Sign off as GRIDHAND
- Output ONLY the SMS text
</rules>
<quality_standard>
SPECIALIST OUTPUT DISCIPLINE:
Never use: "I believe", "it seems", "perhaps", "it appears", "Certainly!", "Great!", "I'd be happy to", "Of course!", "I'm sorry", "Unfortunately", "I apologize", "I understand", "As an AI"
Outcome-first: lead with the brand health verdict, not the data dump
Never explain reasoning — output only the SMS text
If confidence < 0.7 (sparse data, ambiguous review sentiment), prefix the SMS with [LOW_CONFIDENCE] for the director to gate-keep before send.
</quality_standard>`

  return aiClient.call({
    modelString: 'groq/llama-3.3-70b-versatile',
    clientApiKeys: {},
    systemPrompt,
    messages: [{ role: 'user', content: 'Write the weekly brand briefing.' }],
    maxTokens: 220,
    _workerName: AGENT_ID,
    tier: 'specialist',
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
