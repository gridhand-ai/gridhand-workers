'use strict'
// ── GRIDHAND SPECIALIST — TIER 3 ──────────────────────────────────────────────
// SocialProofAmplifier — Turns new 4-5 star reviews into shareable social content
// Division: brand
// Reports to: brand-director
// Runs: on-demand (called by BrandDirector)
//
// Bridges the gap between reputation-defender (monitors reviews) and
// social-manager (posts content). Takes fresh positive reviews and generates
// an Instagram caption + Facebook post draft for the business owner.
//
// Logs: activity_log (action: 'social_content_generated')
// Tools: lib/ai-client (groq), lib/message-gate (validateInternal)
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient         = require('../../lib/ai-client')
const { validateInternal } = require('../../lib/message-gate')

const SPECIALIST_ID = 'social-proof-amplifier'
const DIVISION      = 'brand'
const REPORTS_TO    = 'brand-director'
const GROQ_MODEL    = 'groq/llama-3.3-70b-versatile'

// Only amplify reviews this recent (avoid re-amplifying old reviews each run)
const LOOKBACK_HOURS = 25

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// ── Pull fresh positive reviews from activity_log ────────────────────────────
async function fetchFreshPositiveReviews(supabase, clientId) {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('activity_log')
    .select('id, details, metadata, created_at')
    .eq('client_id', clientId)
    .eq('action', 'review_received')
    .gte('metadata->>rating', '4')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(3)

  if (error) {
    console.warn(`[${SPECIALIST_ID}] Failed to fetch reviews for ${clientId}:`, error.message)
    return []
  }
  return data || []
}

// ── Check if we already amplified this review ─────────────────────────────────
async function alreadyAmplified(supabase, clientId, reviewActivityId) {
  const { count } = await supabase
    .from('activity_log')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('action', 'social_content_generated')
    .eq('details', `source:${reviewActivityId}`)

  return (count || 0) > 0
}

// ── Generate social content from review text ──────────────────────────────────
async function generateSocialContent(client, reviewText) {
  const businessName = client.business_name || 'the business'
  const industry     = client.industry || 'small business'
  const tone         = client.tone || 'friendly and professional'

  const prompt = `You are writing social media posts for ${businessName}, a ${industry} business.

A customer just left this 5-star review:
"${reviewText}"

Write TWO short posts:
1. INSTAGRAM CAPTION (max 150 chars, no hashtags yet — owner adds those): A warm, authentic caption that highlights what the customer loved. First-person business voice. End with a call-to-action like "Book today" or "Come see us."
2. FACEBOOK POST (max 200 chars): A slightly more detailed version. Can mention the service or experience specifically. Professional but warm.

Output format — use these exact labels:
INSTAGRAM: [caption text]
FACEBOOK: [post text]

Rules: Never make up details not in the review. Never use fake statistics. Never mention any AI. Tone: ${tone}.`

  try {
    const raw = await aiClient.call({
      modelString: GROQ_MODEL,
      systemPrompt: `You write authentic, non-AI-sounding social media posts for small businesses. Never use buzzwords. Never mention AI. Be real.

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
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 400,
      tier: 'specialist',
    })

    const instagramMatch = raw?.match(/INSTAGRAM:\s*(.+?)(?=FACEBOOK:|$)/s)
    const facebookMatch  = raw?.match(/FACEBOOK:\s*(.+?)$/s)

    return {
      instagram: instagramMatch?.[1]?.trim() || null,
      facebook:  facebookMatch?.[1]?.trim()  || null,
      raw,
    }
  } catch (err) {
    console.warn(`[${SPECIALIST_ID}] Content generation failed:`, err.message)
    return null
  }
}

// ── Process a single client ───────────────────────────────────────────────────
async function processClient(supabase, client) {
  const clientId = client.id
  let actionsCount = 0
  const outcomes   = []

  const freshReviews = await fetchFreshPositiveReviews(supabase, clientId)
  if (!freshReviews.length) {
    return { clientId, actionsCount: 0, outcomes: [], status: 'no_new_reviews' }
  }

  for (const review of freshReviews) {
    // Skip if already amplified
    const done = await alreadyAmplified(supabase, clientId, review.id)
    if (done) continue

    const reviewText = review.details || ''
    if (!reviewText || reviewText.length < 20) continue

    const content = await generateSocialContent(client, reviewText)
    if (!content?.instagram && !content?.facebook) continue

    // Validate brand alignment on the instagram caption
    const igText = content.instagram || ''
    if (igText) {
      const check = validateInternal ? validateInternal(igText) : { valid: true }
      if (check && !check.valid) {
        console.warn(`[${SPECIALIST_ID}] Brand gate blocked content for ${clientId}: ${check.reason}`)
        continue
      }
    }

    // Log the generated content so social-manager or the client can use it
    await supabase.from('activity_log').insert({
      client_id:  clientId,
      worker_id:  SPECIALIST_ID,
      action:     'social_content_generated',
      details:    `source:${review.id}`,
      metadata:   {
        instagram: content.instagram,
        facebook:  content.facebook,
        reviewSnippet: reviewText.slice(0, 100),
      },
      created_at: new Date().toISOString(),
    }).catch(err => console.warn(`[${SPECIALIST_ID}] Log failed:`, err.message))

    actionsCount++
    outcomes.push({
      clientId,
      reviewId:  review.id,
      instagram: content.instagram,
      facebook:  content.facebook,
      status:    'content_generated',
    })

    console.log(`[${SPECIALIST_ID.toUpperCase()}] Generated social content for ${client.business_name} from review ${review.id}`)
  }

  return { clientId, actionsCount, outcomes, status: actionsCount > 0 ? 'action_taken' : 'no_action' }
}

// ── Main run ──────────────────────────────────────────────────────────────────
async function run(clientList = []) {
  console.log(`[${SPECIALIST_ID.toUpperCase()}] Starting run — ${clientList.length} clients`)
  const supabase = getSupabase()
  const results  = []

  for (const client of clientList) {
    try {
      const result = await processClient(supabase, client)
      results.push(result)
    } catch (err) {
      console.error(`[${SPECIALIST_ID}] Error for client ${client.id}:`, err.message)
      results.push({ clientId: client.id, actionsCount: 0, outcomes: [], status: 'error' })
    }
  }

  const totalActions = results.reduce((sum, r) => sum + (r.actionsCount || 0), 0)
  console.log(`[${SPECIALIST_ID.toUpperCase()}] Done — ${totalActions} pieces of social content generated`)

  return {
    agentId:      SPECIALIST_ID,
    division:     DIVISION,
    reportsTo:    REPORTS_TO,
    actionsCount: totalActions,
    escalations:  [],
    outcomes:     results,
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION, REPORTS_TO }
