'use strict'
// lib/image-prompt-generator.js — Visual prompt generator for social content
//
// AgentScaler-parity: generates DALL-E/Midjourney style image prompts
// to accompany social posts. Does NOT call any image API — produces
// the prompt only. The prompt is stored in activity_log metadata as
// `image_prompt` for human review or future automation.
//
// No healthcare/dental/medical content per GRIDHAND sector restrictions.

const aiClient = require('./ai-client')

const AGENT_ID = 'image-prompt-generator'

// Style map: determines visual direction based on industry vertical
const INDUSTRY_STYLE_MAP = {
  restaurant:   'warm',
  food:         'warm',
  retail:       'bold',
  fitness:      'bold',
  gym:          'bold',
  salon:        'warm',
  beauty:       'warm',
  auto:         'professional',
  construction: 'professional',
  real_estate:  'professional',
  realty:       'professional',
  default:      'professional',
}

function detectStyle(industry = '') {
  const lower = industry.toLowerCase()
  for (const [key, style] of Object.entries(INDUSTRY_STYLE_MAP)) {
    if (lower.includes(key)) return style
  }
  return INDUSTRY_STYLE_MAP.default
}

/**
 * Generate a DALL-E/Midjourney style image prompt for a social post.
 * Uses Groq to write the prompt — no image API is called.
 *
 * @param {Object} options
 * @param {string} options.postContent  - The social post text (hook + angle)
 * @param {string} options.industry     - Business industry/vertical
 * @param {string} options.bizName      - Business name
 * @returns {Promise<{ prompt: string, style: 'professional'|'warm'|'bold' }>}
 */
async function generateImagePrompt({ postContent, industry, bizName }) {
  const style = detectStyle(industry)

  const styleDescriptions = {
    professional: 'clean, professional, high-contrast, modern business photography style',
    warm:         'warm natural lighting, inviting atmosphere, candid lifestyle photography',
    bold:         'bold composition, vibrant colors, energetic, action-forward photography',
  }

  const systemPrompt = `<role>Visual content director for GRIDHAND AI — write image generation prompts for small business social posts.</role>

<task>
Write a single image generation prompt (DALL-E/Midjourney style) for this social post.
The image should visually support the post content and feel authentic to the business.
</task>

<constraints>
- Style: ${styleDescriptions[style]}
- Industry: ${industry}
- Business: ${bizName}
- Do NOT include text, logos, or watermarks in the scene description
- Do NOT include people's faces in close-up (privacy)
- Keep the prompt under 60 words
- No healthcare, medical, or HIPAA-regulated content
</constraints>

<post_content>
${postContent}
</post_content>

<output>
Return a JSON object with exactly two fields:
- "prompt": the image generation prompt string
- "style": one of "professional", "warm", or "bold"

Return ONLY valid JSON. No other text.
</output>`

  try {
    const raw = await aiClient.call({
      tier:          'quality',
      clientApiKeys: {},
      systemPrompt,
      messages:      [{ role: 'user', content: 'Write the image prompt.' }],
      maxTokens:     200,
      _workerName:   AGENT_ID,
    })

    const jsonMatch = (raw || '').match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        prompt: parsed.prompt || '',
        style:  parsed.style  || style,
      }
    }

    // Fallback: raw text as prompt
    return { prompt: (raw || '').slice(0, 200).trim(), style }
  } catch (err) {
    console.error(`[${AGENT_ID}] Image prompt generation failed:`, err.message)
    return { prompt: '', style }
  }
}

module.exports = { generateImagePrompt }
