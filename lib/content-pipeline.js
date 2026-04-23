'use strict'
// lib/content-pipeline.js — Multi-step content generation pipeline
//
// AgentScaler-parity: ideate → draft → score → refine → output
// Replaces single-shot Groq calls in content-scheduler with a 4-step pipeline
// that self-edits before committing to output.
//
// Step 1: Research   — what's relevant/trending for this vertical + city this week
// Step 2: Draft      — generate CONTENT_BATCH_SIZE ideas using research context
// Step 3: Score      — Groq rates each idea 1-10 on relevance, tone, CTA clarity
// Step 4: Refine     — rewrite ideas scoring < 7 with feedback from step 3
// Step 5: Return     — final ideas array + aggregate score

const aiClient             = require('./ai-client')
const imagePromptGenerator = require('./image-prompt-generator')

const SCORE_THRESHOLD = 7   // Ideas below this get one rewrite pass
const AGENT_ID        = 'content-pipeline'

/**
 * Run the full multi-step content pipeline for a single client.
 *
 * @param {Object} options
 * @param {Object} options.client       - Supabase client row
 * @param {string} [options.topic]      - Optional specific topic override
 * @param {string} [options.type]       - Content type: 'social_post' | 'email' | 'sms'
 * @param {number} [options.batchSize]  - Number of content ideas to generate (default 5)
 * @param {string} [options.brandVoice] - Existing brand voice context from vault
 * @returns {Promise<{ ideas: Array<Object>, avgScore: number, pipelineLog: Array<Object> }>}
 */
async function runContentPipeline({
  client,
  topic      = null,
  type       = 'social_post',
  batchSize  = 5,
  brandVoice = null,
}) {
  const bizName  = client.business_name || 'this business'
  const industry = client.industry      || 'business'
  const city     = client.city          || client.location || 'your city'
  const pipelineLog = []

  // ── Step 1: Research ──────────────────────────────────────────────────────
  let researchContext = ''
  try {
    const researchPrompt = `<role>Content researcher for GRIDHAND AI.</role>
<task>
What themes, seasonal hooks, local events, or trending topics would be most relevant
for a ${industry} business in ${city} right now (week of ${new Date().toDateString()})?
${topic ? `Focus specifically on: ${topic}` : ''}
List 3-5 specific angles as bullet points. Be concrete — no generic advice.
</task>
<output>Return ONLY bullet points. No intro text.</output>`

    researchContext = await aiClient.call({
      modelString:   'groq/llama-3.3-70b-versatile',
      clientApiKeys: {},
      systemPrompt:  researchPrompt,
      messages:      [{ role: 'user', content: 'What is trending and relevant this week?' }],
      maxTokens:     300,
      _workerName:   AGENT_ID,
    }) || ''

    pipelineLog.push({ step: 'research', status: 'ok', length: researchContext.length })
  } catch (err) {
    pipelineLog.push({ step: 'research', status: 'error', error: err.message })
    // Non-fatal — continue without research context
  }

  // ── Step 2: Draft ─────────────────────────────────────────────────────────
  let draftIdeas = []
  try {
    const draftPrompt = `<role>Content creator for GRIDHAND AI — social media content for small businesses.</role>
<business>
Name: ${bizName}
Industry: ${industry}
City: ${city}
${brandVoice ? `<brand_voice>${brandVoice}</brand_voice>` : ''}
</business>

<research>
Relevant themes this week:
${researchContext || 'No research available — use general best practices.'}
</research>

<task>
Generate ${batchSize} unique ${type} content ideas for ${bizName}.
Each must be rooted in one of the research themes above when possible.
</task>

<output>
Return a JSON array of objects. Each object has:
- "type": one of "tip", "story", "offer", "question", "behind-the-scenes"
- "hook": the opening line or headline (max 12 words, punchy)
- "angle": 1-sentence description of the content angle
- "researchHook": which research theme this connects to (or "general")

Return ONLY valid JSON. No other text.
</output>`

    const raw = await aiClient.call({
      modelString:   'groq/llama-3.3-70b-versatile',
      clientApiKeys: {},
      systemPrompt:  draftPrompt,
      messages:      [{ role: 'user', content: 'Generate the content ideas.' }],
      maxTokens:     800,
      _workerName:   AGENT_ID,
    })

    const jsonMatch = (raw || '').match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      draftIdeas = JSON.parse(jsonMatch[0])
    }

    pipelineLog.push({ step: 'draft', status: 'ok', count: draftIdeas.length })
  } catch (err) {
    pipelineLog.push({ step: 'draft', status: 'error', error: err.message })
    return { ideas: [], avgScore: 0, pipelineLog }
  }

  if (!draftIdeas.length) {
    pipelineLog.push({ step: 'draft', status: 'empty' })
    return { ideas: [], avgScore: 0, pipelineLog }
  }

  // ── Step 3: Score ─────────────────────────────────────────────────────────
  let scoredIdeas = draftIdeas.map(idea => ({ ...idea, score: 7, feedback: '' }))
  try {
    const scorePrompt = `<role>Content quality reviewer for GRIDHAND AI.</role>
<business>
Industry: ${industry}
City: ${city}
</business>

<task>
Score each content idea below 1-10 based on:
- Relevance to ${industry} in ${city}
- Tone (authentic, not corporate)
- CTA clarity (does it drive action or engagement?)

For any idea scoring below ${SCORE_THRESHOLD}, include 1 specific improvement suggestion.
</task>

<content>
${JSON.stringify(draftIdeas, null, 2)}
</content>

<output>
Return a JSON array matching the input order. Each object has:
- "score": number 1-10
- "feedback": improvement suggestion (empty string if score >= ${SCORE_THRESHOLD})

Return ONLY valid JSON array. No other text.
</output>`

    const scoreRaw = await aiClient.call({
      modelString:   'groq/llama-3.3-70b-versatile',
      clientApiKeys: {},
      systemPrompt:  scorePrompt,
      messages:      [{ role: 'user', content: 'Score these content ideas.' }],
      maxTokens:     500,
      _workerName:   AGENT_ID,
    })

    const scoreMatch = (scoreRaw || '').match(/\[[\s\S]*\]/)
    if (scoreMatch) {
      const scores = JSON.parse(scoreMatch[0])
      scoredIdeas = draftIdeas.map((idea, i) => ({
        ...idea,
        score:    scores[i]?.score    ?? 7,
        feedback: scores[i]?.feedback ?? '',
      }))
    }

    pipelineLog.push({ step: 'score', status: 'ok', lowScoreCount: scoredIdeas.filter(i => i.score < SCORE_THRESHOLD).length })
  } catch (err) {
    pipelineLog.push({ step: 'score', status: 'error', error: err.message })
    // Non-fatal — proceed with draft scores (default 7)
  }

  // ── Step 4: Refine (one pass for ideas below threshold) ───────────────────
  const needsRefine = scoredIdeas.filter(idea => idea.score < SCORE_THRESHOLD && idea.feedback)
  if (needsRefine.length > 0) {
    try {
      const refinePrompt = `<role>Content refiner for GRIDHAND AI.</role>
<business>
Name: ${bizName}
Industry: ${industry}
City: ${city}
</business>

<task>
Rewrite each content idea below using the provided feedback.
Keep the same "type" value. Improve hook and angle based on the feedback.
</task>

<ideas_to_refine>
${JSON.stringify(needsRefine.map(i => ({ type: i.type, hook: i.hook, angle: i.angle, feedback: i.feedback })), null, 2)}
</ideas_to_refine>

<output>
Return a JSON array (same length as input). Each object has:
- "type": same as input
- "hook": rewritten hook
- "angle": rewritten angle
- "researchHook": keep original or update if relevant

Return ONLY valid JSON array. No other text.
</output>`

      const refineRaw = await aiClient.call({
        modelString:   'groq/llama-3.3-70b-versatile',
        clientApiKeys: {},
        systemPrompt:  refinePrompt,
        messages:      [{ role: 'user', content: 'Refine these content ideas.' }],
        maxTokens:     600,
        _workerName:   AGENT_ID,
      })

      const refineMatch = (refineRaw || '').match(/\[[\s\S]*\]/)
      if (refineMatch) {
        const refined = JSON.parse(refineMatch[0])
        let refineIdx = 0
        scoredIdeas = scoredIdeas.map(idea => {
          if (idea.score < SCORE_THRESHOLD && idea.feedback && refineIdx < refined.length) {
            const replacement = refined[refineIdx++]
            return {
              ...idea,
              hook:         replacement.hook   || idea.hook,
              angle:        replacement.angle  || idea.angle,
              researchHook: replacement.researchHook || idea.researchHook || 'general',
              refined:      true,
            }
          }
          return idea
        })
        pipelineLog.push({ step: 'refine', status: 'ok', refined: needsRefine.length })
      }
    } catch (err) {
      pipelineLog.push({ step: 'refine', status: 'error', error: err.message })
      // Non-fatal — keep the draft versions
    }
  } else {
    pipelineLog.push({ step: 'refine', status: 'skipped', reason: 'all ideas above threshold' })
  }

  // ── Step 5: Image prompts for social posts ────────────────────────────────
  if (type === 'social_post') {
    for (const idea of scoredIdeas) {
      try {
        const imgResult = await imagePromptGenerator.generateImagePrompt({
          postContent: `${idea.hook} — ${idea.angle}`,
          industry,
          bizName,
        })
        idea.image_prompt = imgResult.prompt
        idea.image_style  = imgResult.style
      } catch {
        // Non-fatal — image prompt is optional
        idea.image_prompt = null
        idea.image_style  = null
      }
    }
    pipelineLog.push({ step: 'image_prompts', status: 'ok' })
  }

  // ── Final output ──────────────────────────────────────────────────────────
  const avgScore = scoredIdeas.length
    ? Math.round((scoredIdeas.reduce((sum, i) => sum + (i.score || 7), 0) / scoredIdeas.length) * 10) / 10
    : 0

  pipelineLog.push({ step: 'complete', avgScore, totalIdeas: scoredIdeas.length })

  return { ideas: scoredIdeas, avgScore, pipelineLog }
}

module.exports = { runContentPipeline }
