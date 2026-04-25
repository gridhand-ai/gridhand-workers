'use strict'
// ── ARSENAL SPECIALIST — TIER 3 ───────────────────────────────────────────────
// Nova — Content Creator
// Division: brand
// Reports to: brand-director
// Runs: on-demand (MJ personal marketing tool)
// Description: Generates GRIDHAND marketing content for Instagram, LinkedIn,
//              TikTok about AI workforce for small businesses
// ──────────────────────────────────────────────────────────────────────────────

const aiClient = require('../../lib/ai-client')
const { fileInteraction } = require('../../lib/memory-client')

const AGENT_ID   = 'nova'
const DIVISION   = 'brand'
const REPORTS_TO = 'brand-director'
// Groq specialist — content generation handles well at this tier
const GROQ_MODEL = 'groq/llama-3.3-70b-versatile'

const PLATFORM_RULES = {
  instagram: 'Max 2,200 chars. Hook in first line. Emojis OK. Line breaks for readability.',
  linkedin:  'Max 3,000 chars. Professional but human tone. No emojis in body. Strong opening question or stat. Business owner audience.',
  tiktok:    'Script/caption style. Very short — under 300 chars for caption. Hook must hit in first 2 seconds. Conversational, energetic.',
}

/**
 * Generate marketing content for a specific platform.
 * @param {Array<{ platform, topic, tone, clientId? }>} inputs
 */
async function run(inputs = []) {
  console.log(`[${AGENT_ID.toUpperCase()}] Starting run — ${inputs.length} content piece(s) to generate`)
  const outcomes = []

  for (const input of inputs) {
    try {
      const result = await generateContent(input)
      if (result) outcomes.push(result)
    } catch (err) {
      console.error(`[${AGENT_ID}] Error for ${input.platform}/${input.topic}:`, err.message)
      outcomes.push({
        agentId: AGENT_ID,
        clientId: input.clientId || null,
        status: 'error',
        summary: `Content generation failed: ${err.message}`,
        data: null,
        requiresDirectorAttention: false,
      })
    }
  }

  const specialistReport = await report(outcomes)
  await fileInteraction(specialistReport, {
    workerId: AGENT_ID,
    interactionType: 'specialist_run',
  }).catch(() => {})

  return specialistReport
}

async function generateContent(input) {
  const { platform = 'instagram', topic, tone = 'confident', clientId } = input

  const platformRule = PLATFORM_RULES[platform] || PLATFORM_RULES.instagram

  const systemPrompt = `<role>Content Creator for GRIDHAND — you write compelling social media content about AI workforce solutions for small businesses.</role>
<brand>
GRIDHAND voice: direct, confident, outcome-first. We sell AI workers that handle real jobs for real small businesses.
Never say "AI software", "AI platform", "AI tool" — say "AI worker" or "your GRIDHAND team".
Never mention Make.com — it's an internal detail. Refer to "direct integrations" or "3,000+ app integrations" if needed.
Target audience: small business owners (restaurants, salons, auto shops, contractors, retailers).
</brand>
<platform rules>
Platform: ${platform}
${platformRule}
</platform rules>
<rules>
- Lead with a specific outcome or pain point — not a product feature
- Tone: ${tone}
- Hashtags must be relevant and specific — no generic #AI or #SmallBusiness spam
- CTA must be concrete — "DM us", "Link in bio", "Comment YES", etc.
- Zero fluff, zero corporate speak
</rules>
<output>
Respond with valid JSON only:
{
  "post": "full post content as a string",
  "hashtags": ["tag1", "tag2", "tag3"],
  "callToAction": "string"
}
</output>`

  const userMsg = `Create a ${platform} post about: ${topic || 'AI workers for small businesses'}`

  try {
    const raw = await aiClient.call({
      modelString: GROQ_MODEL,
      tier: 'specialist',
      clientApiKeys: {},
      systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 600,
      _workerName: AGENT_ID,
    })

    let parsed
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw)
    } catch {
      parsed = { post: raw || '', hashtags: [], callToAction: '' }
    }

    // Hard guard — never let Make.com slip through in generated content
    const postContent = (parsed.post || '').replace(/make\.com/gi, 'our integration layer')

    return {
      agentId: AGENT_ID,
      clientId: clientId || null,
      timestamp: Date.now(),
      status: 'action_taken',
      summary: `${platform} post generated — topic: ${topic}`,
      data: {
        post:          postContent,
        hashtags:      parsed.hashtags || [],
        callToAction:  parsed.callToAction || '',
        platform,
        topic,
      },
      requiresDirectorAttention: false,
    }
  } catch (err) {
    throw new Error(`AI call failed: ${err.message}`)
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount}/${outcomes.length} content pieces created`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
