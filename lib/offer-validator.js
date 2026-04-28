'use strict'
// lib/offer-validator.js — Pre-campaign offer validation gate
//
// AgentScaler-parity: validates an offer concept before any campaign blast goes out.
// Returns a score, risk assessment, improvement suggestion, and an approval flag.
// If approved: false, the caller should rewrite the offer and re-validate once.
//
// APPROVAL THRESHOLD: score >= 6
// Re-validation: callers may run one rewrite pass using `improvement` before retrying.

const aiClient = require('./ai-client')

const AGENT_ID         = 'offer-validator'
const APPROVAL_SCORE   = 6   // Minimum score to approve
const MAX_RETRIES      = 1   // Max rewrite-and-revalidate cycles

/**
 * Validate an offer before a campaign blast.
 *
 * @param {Object} options
 * @param {string} options.bizName    - Business name
 * @param {string} options.industry   - Business industry/vertical
 * @param {string} options.offerText  - The offer copy to validate
 * @param {string} [options.city]     - City/region for local relevance check
 * @returns {Promise<{ score: number, risk: string, improvement: string, approved: boolean }>}
 */
async function validateOffer({ bizName, industry, offerText, city = '' }) {
  const systemPrompt = `<role>Offer validation specialist for GRIDHAND AI — assess campaign offers before they reach clients.</role>

<task>
Evaluate this offer for a ${industry} business${city ? ` in ${city}` : ''}.

Score it 1-10 based on:
- Compelling value: is the offer genuinely attractive? (not "call us today")
- Specificity: concrete discount/service/outcome vs vague promise
- Urgency: is there a real reason to act now?
- Local relevance: does it fit the ${city || 'local'} market and ${industry} vertical?
- Risk to brand: could this offer damage credibility or set bad expectations?

Then provide:
- A specific risk (one sentence — what could go wrong?)
- One concrete improvement that would raise the score by 2+ points
</task>

<offer>
Business: ${bizName}
Industry: ${industry}
Offer: ${offerText}
</offer>

<output>
Return a JSON object with exactly four fields:
- "score": number 1-10
- "risk": one sentence describing the main risk
- "improvement": one concrete suggestion to improve the offer
- "approved": boolean — true if score >= ${APPROVAL_SCORE}

Return ONLY valid JSON. No other text.
</output>`

  try {
    const raw = await aiClient.call({
      tier:          'simple',
      clientApiKeys: {},
      systemPrompt,
      messages:      [{ role: 'user', content: 'Validate this offer.' }],
      maxTokens:     250,
      _workerName:   AGENT_ID,
    })

    const jsonMatch = (raw || '').match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        score:       Number(parsed.score)      || 5,
        risk:        parsed.risk               || '',
        improvement: parsed.improvement        || '',
        approved:    Boolean(parsed.score >= APPROVAL_SCORE),
      }
    }

    // Fallback: approve with neutral score when validation itself fails
    console.warn(`[${AGENT_ID}] Could not parse validation response — defaulting to approved`)
    return { score: 6, risk: '', improvement: '', approved: true }
  } catch (err) {
    console.error(`[${AGENT_ID}] Offer validation failed:`, err.message)
    return { score: 6, risk: '', improvement: '', approved: true }
  }
}

/**
 * Rewrite an offer using improvement feedback from validateOffer.
 *
 * @param {Object} options
 * @param {string} options.bizName      - Business name
 * @param {string} options.industry     - Business industry/vertical
 * @param {string} options.offerText    - Original offer text
 * @param {string} options.improvement  - Feedback from validateOffer
 * @param {string} [options.city]       - City/region
 * @returns {Promise<string>} - Rewritten offer text
 */
async function rewriteOffer({ bizName, industry, offerText, improvement, city = '' }) {
  const systemPrompt = `<role>Campaign copywriter for GRIDHAND AI — rewrite offers to be more compelling.</role>

<task>
Rewrite this offer for ${bizName} (${industry}${city ? `, ${city}` : ''}).
Apply the improvement suggestion exactly.
Keep the offer concise (1-2 sentences max).
Output ONLY the rewritten offer text — no labels, no explanation.
</task>

<original_offer>
${offerText}
</original_offer>

<improvement_required>
${improvement}
</improvement_required>`

  try {
    const rewritten = await aiClient.call({
      tier:          'simple',
      clientApiKeys: {},
      systemPrompt,
      messages:      [{ role: 'user', content: 'Rewrite the offer.' }],
      maxTokens:     120,
      _workerName:   AGENT_ID,
    })
    return (rewritten || offerText).trim()
  } catch (err) {
    console.error(`[${AGENT_ID}] Offer rewrite failed:`, err.message)
    return offerText  // Return original on failure — caller still sends it
  }
}

/**
 * Full validation loop: validate → rewrite if needed → re-validate once.
 * Returns the final validated offer text plus the validation result.
 *
 * @param {Object} options
 * @param {string} options.bizName
 * @param {string} options.industry
 * @param {string} options.offerText
 * @param {string} [options.city]
 * @returns {Promise<{ finalOffer: string, validation: Object, rewrote: boolean }>}
 */
async function validateAndImprove({ bizName, industry, offerText, city = '' }) {
  let currentOffer = offerText
  let rewrote      = false

  const firstCheck = await validateOffer({ bizName, industry, offerText: currentOffer, city })

  if (!firstCheck.approved && firstCheck.improvement) {
    // One rewrite pass
    const newOffer = await rewriteOffer({
      bizName,
      industry,
      offerText:   currentOffer,
      improvement: firstCheck.improvement,
      city,
    })

    const secondCheck = await validateOffer({ bizName, industry, offerText: newOffer, city })
    currentOffer = newOffer
    rewrote      = true

    // Accept the rewrite regardless of second score — we've done our one pass
    return {
      finalOffer: currentOffer,
      validation: secondCheck,
      rewrote,
    }
  }

  return {
    finalOffer: currentOffer,
    validation: firstCheck,
    rewrote,
  }
}

module.exports = { validateOffer, rewriteOffer, validateAndImprove, APPROVAL_SCORE }
