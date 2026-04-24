'use strict'
// ── XRAY-AGENT ────────────────────────────────────────────────────────────────
// Deep-scraping specialist for the Mirror Engine discovery flow.
// Ingests a prospect URL and outputs a structured ClientManifest.
//
// Pipeline:
//   1. Firecrawl — deep crawl of up to 8 pages
//   2. Exa — supplementary web research (social links, brand mentions)
//   3. Groq (tier: 'specialist') — extract brand_voice, tone, services,
//      recommended_workers from raw content
//   4. message-gate validateInternal() — block hallucinations before returning
//
// HIPAA block: medical/health industries return a stub manifest immediately.
// ─────────────────────────────────────────────────────────────────────────────

const firecrawl     = require('../../lib/firecrawl-client')
const exa           = require('../../lib/exa-client')
const { call }      = require('../../lib/ai-client')
const { validateInternal } = require('../../lib/message-gate')

const AGENT_ID = 'xray-agent'

// ── HIPAA / blocked-sector keywords ─────────────────────────────────────────
const HIPAA_KEYWORDS = [
  'medical', 'dental', 'hipaa', 'healthcare', 'clinic', 'hospital',
  'physician', 'therapist', 'pharmacy', 'orthodont', 'optometrist',
  'chiropract', 'psychiatr', 'psycholog',
]

// ── Valid specialist IDs ─────────────────────────────────────────────────────
const SPECIALIST_MAP = [
  'appointment-setter',
  'brand-sentinel',
  'campaign-conductor',
  'churn-predictor',
  'conv-closer',
  'feedback-collector',
  'growth-catalyst',
  'invoice-recovery',
  'lead-qualifier',
  'loyalty-coordinator',
  'onboarding-conductor',
  'reputation-defender',
  'reputation-repair',
  'review-orchestrator',
  'review-velocity',
  'roi-reporter',
  'social-manager',
  'social-proof-amplifier',
  'support-escalator',
  'upsell-timer',
  'win-back-outreach',
]

// ── Stub manifest returned for HIPAA-blocked industries ──────────────────────
function hipaaStub(url) {
  return {
    url,
    business_name: null,
    industry: 'blocked',
    brand_voice: null,
    services: [],
    tone: null,
    social_links: [],
    phone: null,
    email: null,
    recommended_workers: [],
    knowledge_base_seed: [],
    hipaa_risk: true,
    scraped_at: new Date().toISOString(),
  }
}

// ── Fallback manifest when scraping yields no usable content ─────────────────
function emptyManifest(url) {
  return {
    url,
    business_name: null,
    industry: 'unknown',
    brand_voice: 'unknown',
    services: [],
    tone: 'professional',
    social_links: [],
    phone: null,
    email: null,
    recommended_workers: ['review-orchestrator', 'feedback-collector', 'lead-qualifier'],
    knowledge_base_seed: [],
    hipaa_risk: false,
    scraped_at: new Date().toISOString(),
  }
}

// ── Extract phone numbers from raw text ──────────────────────────────────────
function extractPhone(text) {
  const m = text.match(/(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/)
  return m ? m[0].trim() : null
}

// ── Extract email addresses from raw text ────────────────────────────────────
function extractEmail(text) {
  const m = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/)
  return m ? m[0].toLowerCase() : null
}

// ── Extract social links from raw text and page metadata ─────────────────────
function extractSocialLinks(text, exaResults = []) {
  const socialPatterns = [
    /https?:\/\/(?:www\.)?(?:facebook|fb)\.com\/[^\s"'<>)]+/gi,
    /https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>)]+/gi,
    /https?:\/\/(?:www\.)?twitter\.com\/[^\s"'<>)]+/gi,
    /https?:\/\/(?:www\.)?x\.com\/[^\s"'<>)]+/gi,
    /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[^\s"'<>)]+/gi,
    /https?:\/\/(?:www\.)?youtube\.com\/(?:channel|user|@)[^\s"'<>)]+/gi,
    /https?:\/\/(?:www\.)?tiktok\.com\/@[^\s"'<>)]+/gi,
    /https?:\/\/(?:www\.)?yelp\.com\/biz\/[^\s"'<>)]+/gi,
  ]

  const found = new Set()

  for (const pattern of socialPatterns) {
    const matches = text.match(pattern) || []
    for (const m of matches) {
      // Trim trailing punctuation that may have been scraped
      found.add(m.replace(/[,.)]+$/, ''))
    }
  }

  // Also pull from Exa highlight URLs
  for (const r of exaResults) {
    if (r.url && socialPatterns.some(p => { p.lastIndex = 0; return p.test(r.url) })) {
      found.add(r.url)
    }
  }

  return [...found].slice(0, 10)
}

// ── Validate and filter recommended_workers to known IDs only ────────────────
function sanitizeWorkers(rawList) {
  if (!Array.isArray(rawList)) return []
  return rawList
    .map(w => String(w).trim().toLowerCase())
    .filter(w => SPECIALIST_MAP.includes(w))
    .slice(0, 8)
}

// ── Main discovery function ───────────────────────────────────────────────────
/**
 * @param {string} url - Prospect website URL
 * @returns {Promise<object>} ClientManifest
 */
async function discover(url) {
  console.log(`[${AGENT_ID.toUpperCase()}] Starting discovery for: ${url}`)

  // ── Step 0: HIPAA pre-check on the URL itself ────────────────────────────
  const urlLower = url.toLowerCase()
  for (const kw of HIPAA_KEYWORDS) {
    if (urlLower.includes(kw)) {
      console.warn(`[${AGENT_ID}] HIPAA keyword in URL — blocking: ${kw}`)
      return hipaaStub(url)
    }
  }

  // ── Step 1: Firecrawl deep crawl ─────────────────────────────────────────
  let pages = []
  try {
    pages = await firecrawl.crawl(url, { limit: 8 })
    console.log(`[${AGENT_ID}] Firecrawl returned ${pages.length} pages`)
  } catch (crawlErr) {
    console.warn(`[${AGENT_ID}] Crawl failed (${crawlErr.message}) — trying single scrape`)
    try {
      const single = await firecrawl.scrape(url)
      if (single?.content) pages = [single]
    } catch (scrapeErr) {
      console.warn(`[${AGENT_ID}] Single scrape also failed: ${scrapeErr.message}`)
    }
  }

  // If we got nothing at all, return a minimal fallback manifest
  if (!pages || pages.length === 0) {
    console.warn(`[${AGENT_ID}] No content scraped — returning empty manifest`)
    return emptyManifest(url)
  }

  // Concatenate all page content, capped at 12,000 chars to keep Groq within token budget
  const rawText = pages
    .map(p => p.content || '')
    .join('\n\n---PAGE---\n\n')
    .slice(0, 12000)

  // ── Step 1b: HIPAA keyword check on scraped content ─────────────────────
  const rawLower = rawText.toLowerCase()
  for (const kw of HIPAA_KEYWORDS) {
    if (rawLower.includes(kw)) {
      console.warn(`[${AGENT_ID}] HIPAA keyword found in scraped content — blocking: ${kw}`)
      return hipaaStub(url)
    }
  }

  // ── Step 2: Exa supplementary research ──────────────────────────────────
  let exaResults = []
  try {
    const domain = new URL(url).hostname.replace('www.', '')
    const { results } = await exa.search(`${domain} business social media reviews`, {
      numResults: 5,
      maxChars: 2000,
    })
    exaResults = results || []
    console.log(`[${AGENT_ID}] Exa returned ${exaResults.length} results`)
  } catch (exaErr) {
    console.warn(`[${AGENT_ID}] Exa search failed: ${exaErr.message}`)
  }

  // ── Step 3: Extract contact info from raw text ───────────────────────────
  const phone = extractPhone(rawText)
  const email = extractEmail(rawText)

  // Combine raw text + exa highlights for social link extraction
  const exaHighlightText = exaResults.map(r => r.highlights?.join(' ') || '').join(' ')
  const socialLinks = extractSocialLinks(rawText + ' ' + exaHighlightText, exaResults)

  // ── Step 4: Groq extraction — brand, services, workers ──────────────────
  console.log(`[${AGENT_ID}] Calling Groq for brand extraction...`)

  const systemPrompt = `<role>You are a brand intelligence specialist for GRIDHAND AI. Your job is to analyze a business website's content and extract structured intelligence about the brand.</role>

<rules>
- Extract ONLY information that is explicitly present in the provided content
- Never invent, guess, or hallucinate any business details
- If you cannot determine a field, use null or an empty array
- business_name must come from the actual site — look for logos, headers, footer copyright
- industry must be a single short label: "restaurant", "salon", "retail", "fitness", "auto", "legal", "real estate", "home services", "pet services", "education", "hospitality", or "local business" if unclear
- brand_voice: describe the tone of the copy in 3-5 adjectives (e.g. "warm, conversational, family-focused")
- tone: pick exactly ONE from: "professional", "casual", "friendly", "authoritative"
- services: list the main services or products mentioned, max 8 items
- recommended_workers: select 4-6 worker IDs from this exact list that best match this business type:
  ${SPECIALIST_MAP.join(', ')}
- knowledge_base_seed: create 2-3 knowledge entries with "content" and "category" fields where category is one of: "services", "hours", "pricing", "faq", "about"
</rules>

<output>
Respond with valid JSON only. No markdown, no explanation. Schema:
{
  "business_name": "string or null",
  "industry": "string",
  "brand_voice": "string or null",
  "services": ["string"],
  "tone": "professional|casual|friendly|authoritative",
  "recommended_workers": ["worker-id"],
  "knowledge_base_seed": [{"content": "string", "category": "string"}]
}
</output>`

  const userMessage = `<website_content>
${rawText}
</website_content>

<supplementary_research>
${exaResults.map(r => `[${r.title}] ${(r.highlights || []).join(' ')}`).join('\n').slice(0, 2000)}
</supplementary_research>

Extract the brand intelligence from this website content. Return valid JSON only.`

  let extracted = null
  try {
    const groqResponse = await call({
      tier: 'specialist',
      systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: 1200,
      _workerName: AGENT_ID,
    })

    // Parse JSON from the response
    const jsonMatch = groqResponse.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      extracted = JSON.parse(jsonMatch[0])
    }
  } catch (aiErr) {
    console.warn(`[${AGENT_ID}] Groq extraction failed: ${aiErr.message}`)
  }

  // ── Step 5: Validate AI-generated text through message-gate ─────────────
  // validateInternal blocks hallucinations, unfilled placeholders, fabricated phones
  if (extracted) {
    // Check brand_voice
    if (extracted.brand_voice) {
      const gateResult = validateInternal(extracted.brand_voice)
      if (!gateResult.valid) {
        console.warn(`[${AGENT_ID}] brand_voice blocked by gate: ${gateResult.reason}`)
        extracted.brand_voice = null
      }
    }

    // Check each knowledge_base_seed content field
    if (Array.isArray(extracted.knowledge_base_seed)) {
      extracted.knowledge_base_seed = extracted.knowledge_base_seed.filter(entry => {
        if (!entry?.content) return false
        const gateResult = validateInternal(entry.content)
        if (!gateResult.valid) {
          console.warn(`[${AGENT_ID}] knowledge entry blocked by gate: ${gateResult.reason}`)
          return false
        }
        return true
      })
    }

    // Sanitize recommended_workers to only valid IDs
    extracted.recommended_workers = sanitizeWorkers(extracted.recommended_workers)
  }

  // ── Step 6: Re-check extracted industry for HIPAA risk ──────────────────
  const industryLower = (extracted?.industry || '').toLowerCase()
  const hipaaRisk = HIPAA_KEYWORDS.some(kw => industryLower.includes(kw))
  if (hipaaRisk) {
    console.warn(`[${AGENT_ID}] HIPAA industry detected in AI extraction — blocking`)
    return hipaaStub(url)
  }

  // ── Assemble final manifest ──────────────────────────────────────────────
  const manifest = {
    url,
    business_name:      extracted?.business_name   || null,
    industry:           extracted?.industry        || 'local business',
    brand_voice:        extracted?.brand_voice     || null,
    services:           extracted?.services        || [],
    tone:               extracted?.tone            || 'professional',
    social_links:       socialLinks,
    phone,
    email,
    recommended_workers: extracted?.recommended_workers?.length
      ? extracted.recommended_workers
      : ['review-orchestrator', 'feedback-collector', 'lead-qualifier'],
    knowledge_base_seed: extracted?.knowledge_base_seed || [],
    hipaa_risk:         false,
    scraped_at:         new Date().toISOString(),
  }

  console.log(`[${AGENT_ID.toUpperCase()}] Discovery complete — business: ${manifest.business_name || 'unknown'}, industry: ${manifest.industry}, workers: ${manifest.recommended_workers.length}`)
  return manifest
}

module.exports = { discover, AGENT_ID, SPECIALIST_MAP }
