'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// ReputationDefender — Monitors for incoming negative review signals and
// generates a professional, empathetic business owner response draft.
// Flags reviews that score 1-2 stars for immediate director attention and
// sends a private outreach SMS to the reviewer to resolve privately.
//
// Division: brand
// Reports to: brand-director
// Runs: on-demand (called by BrandDirector)
//
// @param {Array<Object>} clients - Active client objects from Supabase
// @returns {Object} Specialist report: actionsCount, escalations, outcomes
// Tools used: lib/ai-client (groq), lib/twilio-client, lib/message-gate,
//             lib/memory-client, lib/memory-vault
// ──────────────────────────────────────────────────────────────────────────────

const { createClient }    = require('@supabase/supabase-js')
const aiClient            = require('../../lib/ai-client')
const exa                 = require('../../lib/exa-client')
const { sendSMS }         = require('../../lib/twilio-client')
const { validateSMS }     = require('../../lib/message-gate')
const { fileInteraction } = require('../../lib/memory-client')
const vault               = require('../../lib/memory-vault')

/**
 * Scan the web for external mentions of the client that may contain complaints or
 * negative sentiment beyond what's tracked in client_reviews.
 * Self-corrects: if no results, expands to include abbreviations and misspellings.
 */
async function fetchExternalMentions(client) {
  const name = client.business_name
  const city  = client.city || client.location || ''

  // Primary: exact name + complaint-signal terms
  const primaryQuery = city
    ? `"${name}" ${city} complaint OR "bad experience" OR "disappointed" OR "avoid"`
    : `"${name}" complaint OR "bad experience" OR "disappointed"`

  try {
    let results = await exa.search(primaryQuery, { numResults: 4, maxChars: 800 })

    if (!results?.results?.length) {
      // Self-correction: try without quotes and add misspelling variants
      console.log(`[${AGENT_ID}] No external complaint mentions found for "${name}" — expanding search`)
      const broadQuery = city
        ? `${name} ${city} negative review forum Reddit`
        : `${name} negative review OR complaint forum`
      results = await exa.search(broadQuery, { numResults: 4, maxChars: 800 })
    }

    return (results?.results || []).map(r => ({
      title:      r.title,
      url:        r.url,
      highlights: r.highlights?.join(' ') || '',
      published:  r.published,
    }))
  } catch (err) {
    console.warn(`[${AGENT_ID}] Exa external mention scan failed (non-blocking):`, err.message)
    return []
  }
}

const AGENT_ID   = 'reputation-defender'
const DIVISION   = 'brand'
const REPORTS_TO = 'brand-director'

// Reviews at or below this star rating trigger immediate escalation
const CRITICAL_RATING_THRESHOLD = 2
// Reviews at or below this trigger a private outreach attempt
const OUTREACH_RATING_THRESHOLD = 3

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Main entry point — iterate clients, handle new negative reviews.
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
      await vault.store(r.clientId, vault.KEYS.REVIEW_SENTIMENT, {
        lastAction:     'negative_review_response',
        responded:      r.data?.responded || 0,
        escalated:      r.data?.escalated || 0,
        summary:        r.summary || 'reputation defender cycle complete',
        timestamp:      Date.now(),
      }, 9, AGENT_ID).catch(() => {})
    }
  }

  return specialistReport
}

/**
 * Process a single client — handle new unaddressed negative reviews.
 * @param {Object} client
 * @returns {Object|null}
 */
async function processClient(client) {
  const supabase   = getSupabase()
  const oneDayAgo  = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Find new negative reviews not yet addressed
  const { data: reviews } = await supabase
    .from('client_reviews')
    .select('*')
    .eq('client_id', client.id)
    .lte('rating', OUTREACH_RATING_THRESHOLD)
    .gte('received_at', oneDayAgo)
    .is('defender_handled_at', null)
    .order('rating', { ascending: true })
    .limit(10)

  // Also scan web for external complaints not captured in client_reviews
  const externalMentions = await fetchExternalMentions(client)
  const externalNegative = externalMentions.filter(m =>
    /complaint|disappoint|avoid|bad|terrible|worst|scam|fraud/i.test(m.highlights + m.title)
  )
  if (externalNegative.length > 0) {
    console.log(`[${AGENT_ID}] Found ${externalNegative.length} external negative mention(s) for ${client.business_name}`)
    // Store external mentions in vault for director visibility
    await vault.store(client.id, vault.KEYS.REVIEW_SENTIMENT, {
      externalNegativeMentions: externalNegative.slice(0, 3),
      scannedAt: new Date().toISOString(),
    }, 9, AGENT_ID).catch(() => {})
  }

  if (!reviews?.length && externalNegative.length === 0) return null
  if (!reviews?.length) {
    // Only external mentions found — escalate without reviews
    return {
      agentId:                   AGENT_ID,
      clientId:                  client.id,
      timestamp:                 Date.now(),
      status:                    'action_taken',
      summary:                   `${externalNegative.length} external complaint mention(s) found online for ${client.business_name} — no in-app reviews to handle`,
      data:                      { responded: 0, escalated: 0, externalNegativeMentions: externalNegative.length, actions: [`External mentions scanned: ${externalNegative.map(m => m.url).join(', ')}`] },
      requiresDirectorAttention: true,
    }
  }

  let responded   = 0
  let escalations = 0
  const actions   = []

  for (const review of reviews) {
    const isCritical = review.rating <= CRITICAL_RATING_THRESHOLD

    // Generate response draft and store it regardless of outreach
    const responseDraft = await generateResponseDraft(client, review)
    if (responseDraft) {
      await supabase.from('client_reviews').update({
        response_draft:     responseDraft,
        defender_handled_at: new Date().toISOString(),
      }).eq('id', review.id)
      responded++
      actions.push(`Response draft generated for ${review.rating}-star review`)
    }

    // Attempt private outreach SMS if phone is available
    const phone = review.reviewer_phone
    if (phone) {
      try {
        const outreachMsg = await generateOutreachMessage(client, review)
        if (outreachMsg) {
          const gateResult = validateSMS(outreachMsg, { businessName: client.business_name })
          if (gateResult.valid) {
            await sendSMS({
              from:           client.twilio_number || process.env.TWILIO_PHONE_NUMBER,
              to:             phone,
              body:           outreachMsg,
              clientApiKeys:  {},
              clientSlug:     client.email,
              clientTimezone: client.timezone || process.env.DEFAULT_TIMEZONE || 'America/Chicago',
            })
            await supabase.from('client_reviews').update({
              outreach_sent_at: new Date().toISOString(),
            }).eq('id', review.id)
            actions.push(`Private outreach SMS sent to ${review.rating}-star reviewer`)
          } else {
            console.warn(`[${AGENT_ID}] message-gate blocked outreach: ${gateResult.issues.join('; ')}`)
          }
        }
      } catch (err) {
        console.error(`[${AGENT_ID}] Outreach SMS failed for review ${review.id}:`, err.message)
      }
    }

    if (isCritical) escalations++
  }

  if (!responded && !escalations) return null

  return {
    agentId:                   AGENT_ID,
    clientId:                  client.id,
    timestamp:                 Date.now(),
    status:                    'action_taken',
    summary:                   `${responded} review response(s) drafted, ${escalations} critical review(s) escalated, ${externalNegative.length} external mention(s) flagged for ${client.business_name}`,
    data:                      { responded, escalated: escalations, externalNegativeMentions: externalNegative.length, actions },
    requiresDirectorAttention: escalations > 0 || externalNegative.length > 0,
  }
}

/**
 * Generate a professional public response draft to a negative review via Groq.
 * @param {Object} client
 * @param {Object} review
 * @returns {Promise<string|null>}
 */
async function generateResponseDraft(client, review) {
  const systemPrompt = `<role>Reputation Defender for GRIDHAND AI — draft professional, empathetic public review responses for small business clients.</role>
<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<review>
Rating: ${review.rating}/5
Text: "${review.review_text || 'No text provided'}"
Platform: ${review.platform || 'review platform'}
</review>

<task>
Write a professional, empathetic public response to this negative review from the
business owner's perspective. Acknowledge the concern, apologize for the experience,
and offer to resolve it offline.
</task>

<rules>
- 3 sentences max
- Empathetic and professional — never defensive
- Invite them to contact the business directly to resolve
- Sign off as ${client.business_name}
- Output ONLY the response text
</rules>

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
</quality_standard>`

  try {
    return await aiClient.call({
      modelString:   'groq/llama-3.3-70b-versatile',
      clientApiKeys: {},
      systemPrompt,
      messages:      [{ role: 'user', content: 'Write the review response draft.' }],
      maxTokens:     200,
      _workerName:   AGENT_ID,
      tier: 'specialist',
    })
  } catch (err) {
    console.error(`[${AGENT_ID}] Response draft AI call failed:`, err.message)
    return null
  }
}

/**
 * Generate a private outreach SMS for a dissatisfied reviewer via Groq.
 * @param {Object} client
 * @param {Object} review
 * @returns {Promise<string|null>}
 */
async function generateOutreachMessage(client, review) {
  const systemPrompt = `<business>
Name: ${client.business_name}
</business>

<review>
Rating: ${review.rating}/5
Issue: "${review.review_text?.slice(0, 100) || 'their experience'}"
</review>

<task>
Write a brief, private SMS reaching out to this customer to resolve their issue.
Be genuine and empathetic — this is a real human who had a bad experience.
</task>

<rules>
- 2 sentences max
- Personal and sincere — not corporate scripted
- Offer to personally make it right
- Sign off as ${client.business_name}
- Output ONLY the SMS text
</rules>

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
</quality_standard>`

  try {
    return await aiClient.call({
      modelString:   'groq/llama-3.3-70b-versatile',
      clientApiKeys: {},
      systemPrompt,
      messages:      [{ role: 'user', content: 'Write the private outreach SMS.' }],
      maxTokens:     130,
      _workerName:   AGENT_ID,
      tier: 'specialist',
    })
  } catch (err) {
    console.error(`[${AGENT_ID}] Outreach AI call failed:`, err.message)
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} reputation defense actions taken`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
