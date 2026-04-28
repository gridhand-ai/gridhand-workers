'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// SocialManager — Monitors DMs/comments, routes to AI draft, flags human-review items
// Division: brand
// Reports to: brand-director
// Runs: on-demand (called by BrandDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient         = require('../../lib/ai-client')
const exa              = require('../../lib/exa-client')
const { fileInteraction } = require('../../lib/memory-client')
const vault            = require('../../lib/memory-vault')

const AGENT_ID  = 'social-manager'
const DIVISION  = 'brand'
const REPORTS_TO = 'brand-director'

/**
 * Fetch current trending topics for the client's industry to inform response drafts.
 * Called once per client run — results shared across all messages for that client.
 */
async function fetchIndustryTrends(client) {
  const industry = client.industry || 'small business'
  const query    = `trending topics ${industry} small business social media customers 2025`
  try {
    const results = await exa.search(query, { numResults: 2, maxChars: 600 })
    if (!results?.results?.length) {
      // Self-correction: try just industry + trending to broaden results
      const retry = await exa.search(`${industry} trends customers 2025`, { numResults: 2, maxChars: 600 })
      if (!retry?.results?.length) return null
      return retry.results.map(r => r.highlights?.join(' ') || r.title).join('\n').slice(0, 800)
    }
    return results.results.map(r => r.highlights?.join(' ') || r.title).join('\n').slice(0, 800)
  } catch (err) {
    console.warn(`[${AGENT_ID}] Exa industry trends failed (non-blocking):`, err.message)
    return null
  }
}

// Items that need human review vs auto-draft
const HUMAN_REVIEW_TRIGGERS = [
  /complaint/i, /legal/i, /lawsuit/i, /attorney/i, /terrible/i, /fraud/i,
  /refund/i, /scam/i, /disgusting/i, /health department/i, /bbb/i,
]

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
  // Store brand voice (social engagement patterns) per client into shared vault
  for (const r of reports) {
    if (r.clientId) {
      await vault.store(r.clientId, vault.KEYS.BRAND_VOICE, {
        socialDraftGenerated: r.status === 'action_taken',
        summary: r.summary || 'social management cycle complete',
        timestamp: Date.now(),
      }, 5, AGENT_ID).catch(() => {})
    }
  }
  return specialistReport
}

async function processClient(client) {
  const supabase = getSupabase()
  const now = Date.now()

  // Fetch unhandled social messages
  const { data: messages } = await supabase
    .from('social_inbox')
    .select('*')
    .eq('client_id', client.id)
    .is('handled_at', null)
    .order('received_at', { ascending: true })
    .limit(20)

  if (!messages?.length) return null

  // Research trending topics ONCE per client — injected into all draft generation
  const industryTrends = await fetchIndustryTrends(client)

  let drafted = 0
  let flaggedForHuman = 0
  const handled = []

  for (const msg of messages) {
    const text = msg.content || ''
    const needsHuman = HUMAN_REVIEW_TRIGGERS.some(re => re.test(text))

    if (needsHuman) {
      // Flag for human review — don't draft
      await supabase.from('social_inbox').update({
        flagged_for_review: true,
        handled_at: new Date().toISOString(),
        draft_response: null,
      }).eq('id', msg.id)

      flaggedForHuman++
      handled.push({ id: msg.id, action: 'flagged_for_human' })
      continue
    }

    try {
      const generatedDraft = await generateDraftResponse(client, msg, industryTrends)

      // Social drafts don't go through SMS validator — different medium
      const draft = generatedDraft
      // Self-correction: if draft quality check fails, retry once with explicit tone instruction
      if (!draft || draft.length < 5 || draft.includes('{{') || draft.includes('undefined')) {
        console.warn(`[${AGENT_ID}] draft failed quality check, retrying with explicit tone instruction`)
        const retryDraft = await generateDraftResponse(client, msg, industryTrends, true)
        if (!retryDraft || retryDraft.length < 5) {
          console.warn(`[${AGENT_ID}] retry also failed quality check, skipping`)
          continue
        }
      }

      await supabase.from('social_inbox').update({
        draft_response: draft,
        drafted_at: new Date().toISOString(),
        handled_at: new Date().toISOString(),
        flagged_for_review: false,
      }).eq('id', msg.id)

      drafted++
      handled.push({ id: msg.id, action: 'drafted', platform: msg.platform })
    } catch (err) {
      console.error(`[${AGENT_ID}] Draft failed for message ${msg.id}:`, err.message)
    }
  }

  if (!drafted && !flaggedForHuman) return null

  return {
    agentId: AGENT_ID,
    clientId: client.id,
    timestamp: Date.now(),
    status: 'action_taken',
    summary: `Social inbox for ${client.business_name}: ${drafted} drafted, ${flaggedForHuman} flagged for human review`,
    data: { drafted, flaggedForHuman, handled },
    requiresDirectorAttention: flaggedForHuman > 0,
  }
}

async function generateDraftResponse(client, msg, industryTrends = null, retryMode = false) {
  const toneInstruction = retryMode
    ? 'IMPORTANT: Write in a warm, conversational tone. Do NOT use corporate language, generic phrases, or placeholder text. Be genuine and specific.'
    : 'Sound like a real person, not corporate.'

  const systemPrompt = `<role>Social Manager for GRIDHAND AI — draft professional, platform-appropriate responses to social media messages for small business clients.</role>
<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>
${industryTrends ? `<industry_context source="web_research">
${industryTrends}
Use this context to make responses feel informed and current — not generic.
</industry_context>` : ''}

<message>
Platform: ${msg.platform || 'social media'}
Type: ${msg.type || 'comment'}
Content: ${msg.content}
</message>

<task>
Write a professional, friendly draft response for this social media message.
Match the tone of the platform (Instagram = casual, Google = professional, Facebook = friendly).
If the message mentions a topic related to the industry context above, weave that awareness naturally into the response.
</task>

<rules>
- 2-4 sentences
- Acknowledge their message specifically
- End with an invitation to connect further if appropriate
- ${toneInstruction}
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

  return aiClient.call({
    modelString: 'groq/llama-3.3-70b-versatile',
    clientApiKeys: {},
    systemPrompt,
    messages: [{ role: 'user', content: 'Write the draft response.' }],
    maxTokens: 200,
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} social inboxes processed`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
