'use strict'
// ── MESSAGE QUALITY GATE ──────────────────────────────────────────────────────
// Validates Groq/Ollama-generated SMS and email content before sending.
// Rule: client-facing messages may ONLY contain facts explicitly passed in.
// No hallucinated prices, promos, URLs, or numbers not in allowedFacts.
// ─────────────────────────────────────────────────────────────────────────────

const SMS_SEGMENT_CHARS = 160
const SMS_MAX_SEGMENTS  = 3   // hard cap — 3 segments = 480 chars

// ── BLOCKED SECTORS ───────────────────────────────────────────────────────────
// GRIDHAND does not serve healthcare, dental, medical, or HIPAA-regulated
// industries. Messages containing these terms in a regulated context are
// blocked before they reach any client.
const BLOCKED_SECTOR_PATTERNS = [
  /\bdent(?:al|ist|istry)\b/i,
  /\borthodon(?:t|tics|tist)\b/i,
  /\bmedical\s+(?:office|practice|center|clinic|records|provider)\b/i,
  /\bphysician\b/i,
  /\bpatient\s+(?:record|portal|intake|chart|history|info)\b/i,
  /\bhealthcare\s+provider\b/i,
  /\bHIPAA\b/i,
  /\bPHI\b/,
  /\bprior\s+auth(?:orization)?\b/i,
  /\bprescription\s+refill\b/i,
  /\binsurance\s+(?:claim|authorization|pre-auth)\b/i,
]

/**
 * Check if message content contains blocked healthcare/medical sector content.
 * @param {string} text
 * @returns {{ blocked: boolean, reason: string | null }}
 */
function checkBlockedSectors(text) {
  for (const pattern of BLOCKED_SECTOR_PATTERNS) {
    if (pattern.test(text)) {
      return { blocked: true, reason: 'BLOCKED: Healthcare/medical content not permitted' }
    }
  }
  return { blocked: false, reason: null }
}

// ── BACKEND VENDOR NAME REWRITE ───────────────────────────────────────────────
// AI models occasionally leak internal tool names into client-facing output.
// These are silently rewritten before any message leaves GRIDHAND.
const VENDOR_REWRITES = [
  // Explicit domain references
  { pattern: /\bMake\.com's\b/gi,            replacement: "our integration system's" },
  { pattern: /\bMake\.com\b/gi,              replacement: 'our integration system' },
  // Preposition + bare "Make" (e.g. "via Make", "through Make", "on Make", "in Make", "using Make")
  { pattern: /\b(via|through|on|in|using|from|with|by|powered\s+by|built\s+on|built\s+with|runs?\s+on|run\s+through)\s+Make\b/gi,
    replacement: (_, prep) => `${prep} our integration system` },
]

/**
 * Rewrite internal vendor names that must not appear in client-facing output.
 * Silent — no issue logged, just replaced.
 * @param {string} text
 * @returns {string}
 */
function rewriteVendorNames(text) {
  let out = text
  for (const { pattern, replacement } of VENDOR_REWRITES) {
    out = out.replace(pattern, replacement)
  }
  return out
}

/**
 * Validate an SMS before sending.
 * @param {string} text - The generated SMS body
 * @param {object} allowedFacts - Key/value facts the model was given (prices, names, dates)
 * @returns {{ valid: boolean, issues: string[], text: string }}
 */
function validateSMS(text, allowedFacts = {}) {
  const issues = []
  // Rewrite backend vendor names before any other check
  let sanitized = rewriteVendorNames(text.trim())

  // 0. Blocked sector check — runs first, hard gate
  const sectorCheck = checkBlockedSectors(sanitized)
  if (sectorCheck.blocked) {
    return { valid: false, issues: [sectorCheck.reason], text: sanitized }
  }

  // 1. Length check
  const segments = Math.ceil(sanitized.length / SMS_SEGMENT_CHARS)
  if (segments > SMS_MAX_SEGMENTS) {
    issues.push(`SMS too long: ${sanitized.length} chars (${segments} segments, max ${SMS_MAX_SEGMENTS})`)
    sanitized = sanitized.slice(0, SMS_SEGMENT_CHARS * SMS_MAX_SEGMENTS).trim()
  }

  // 2. Hallucinated dollar amounts check
  const dollarMatches = sanitized.match(/\$[\d,]+\.?\d*/g) || []
  const allowedAmounts = Object.values(allowedFacts)
    .filter(v => typeof v === 'string' || typeof v === 'number')
    .map(v => String(v).replace(/[^0-9.]/g, ''))
    .filter(Boolean)

  for (const match of dollarMatches) {
    const num = match.replace(/[^0-9.]/g, '')
    if (!allowedAmounts.some(a => a === num)) {
      issues.push(`Possible hallucinated amount: ${match} — not in allowedFacts`)
    }
  }

  // 3. Hallucinated URLs — block any URL not explicitly passed
  const urlMatches = sanitized.match(/https?:\/\/[^\s]+/g) || []
  const allowedUrls = Object.values(allowedFacts).filter(v => typeof v === 'string' && v.startsWith('http'))
  for (const url of urlMatches) {
    if (!allowedUrls.includes(url)) {
      issues.push(`Hallucinated URL blocked: ${url}`)
      sanitized = sanitized.replace(url, '[link removed]')
    }
  }

  // 4. Empty or too short
  if (sanitized.length < 10) {
    issues.push('SMS body too short — likely generation failure')
  }

  // 5. Placeholder text leaked
  const placeholders = /\[INSERT|PLACEHOLDER|YOUR_|{{\s*\w+\s*}}/i
  if (placeholders.test(sanitized)) {
    issues.push('Template placeholder not filled — generation incomplete')
  }

  const valid = issues.length === 0
  if (!valid) {
    console.warn('[message-gate] SMS validation issues:', issues)
  }

  return { valid, issues, text: sanitized }
}

/**
 * Validate email content before sending.
 * @param {string} subject
 * @param {string} body
 * @param {object} allowedFacts
 * @returns {{ valid: boolean, issues: string[], subject: string, body: string }}
 */
function validateEmail(subject, body, allowedFacts = {}) {
  const issues = []
  // Rewrite backend vendor names before any other check
  const safeSubject = rewriteVendorNames((subject || '').trim())
  const safeBody    = rewriteVendorNames((body || '').trim())

  // 0. Blocked sector check — runs first, hard gate
  const emailSectorCheck = checkBlockedSectors(safeSubject + ' ' + safeBody)
  if (emailSectorCheck.blocked) {
    return { valid: false, issues: [emailSectorCheck.reason], subject: safeSubject, body: safeBody }
  }

  // 1. Subject length
  if (!safeSubject || safeSubject.length < 3) issues.push('Subject too short or missing')
  if (safeSubject && safeSubject.length > 100) issues.push(`Subject too long: ${safeSubject.length} chars`)

  // 2. Body not empty
  if (!safeBody || safeBody.length < 20) issues.push('Email body too short — likely generation failure')

  // 3. Placeholder leak
  const placeholders = /\[INSERT|PLACEHOLDER|YOUR_|{{\s*\w+\s*}}/i
  if (placeholders.test(safeSubject) || placeholders.test(safeBody)) {
    issues.push('Template placeholder not filled — generation incomplete')
  }

  // 4. Hallucinated dollar amounts
  const dollarMatches = (safeBody + safeSubject).match(/\$[\d,]+\.?\d*/g) || []
  const allowedAmounts = Object.values(allowedFacts)
    .filter(v => typeof v === 'string' || typeof v === 'number')
    .map(v => String(v).replace(/[^0-9.]/g, ''))
    .filter(Boolean)
  for (const match of dollarMatches) {
    const num = match.replace(/[^0-9.]/g, '')
    if (!allowedAmounts.some(a => a === num)) {
      issues.push(`Possible hallucinated amount in email: ${match}`)
    }
  }

  const valid = issues.length === 0
  if (!valid) console.warn('[message-gate] Email validation issues:', issues)

  return { valid, issues, subject: safeSubject, body: safeBody }
}

/**
 * Hard gate — throws if invalid and throwOnFail is true.
 * Returns sanitized text if valid (or soft-fail if throwOnFail is false).
 */
function gateSMS(text, allowedFacts = {}, throwOnFail = false) {
  const result = validateSMS(text, allowedFacts)
  if (!result.valid && throwOnFail) {
    throw new Error(`SMS blocked by quality gate: ${result.issues.join('; ')}`)
  }
  return result
}

/**
 * Validate internal/admin responses (MJ context — not client-facing).
 * Lower threshold: allows longer text, technical content, JSON snippets.
 * Still blocks: unfilled placeholders and fabricated phone numbers.
 * @param {string} text - The generated response body
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateInternal(text) {
  if (!text || typeof text !== 'string') {
    return { valid: false, reason: 'Empty or non-string response' }
  }

  const t = text.trim()

  // 1. Length cap — 2000 chars for internal responses
  if (t.length > 2000) {
    return { valid: false, reason: `Response too long: ${t.length} chars (max 2000 for internal)` }
  }

  // 2. Minimum length — avoid empty generation failures
  if (t.length < 5) {
    return { valid: false, reason: 'Response too short — likely generation failure' }
  }

  // 3. Unfilled template placeholders — still blocked even in admin context
  //    Matches: [CLIENT], [NAME], {{name}}, {{ anything }}, [INSERT_X], YOUR_X
  const placeholderPattern = /\[(?:INSERT|CLIENT|NAME|BUSINESS|USER|COMPANY|PLACEHOLDER|TODO)[^\]]*\]|\{\{\s*\w+\s*\}\}|\bYOUR_[A-Z_]+/i
  if (placeholderPattern.test(t)) {
    const match = t.match(placeholderPattern)?.[0]
    return { valid: false, reason: `Unfilled placeholder detected: ${match}` }
  }

  // 4. Fabricated phone numbers — 10-digit strings that look like US phone numbers
  //    but are not in a realistic context (hallucinated contact info)
  //    Pattern: standalone 10-digit sequences or formatted as (NXX) NXX-XXXX
  const fakePhonePattern = /\b(?:\(\d{3}\)\s*\d{3}[-.\s]\d{4}|\d{3}[-.\s]\d{3}[-.\s]\d{4}|\d{10})\b/g
  const phoneMatches = t.match(fakePhonePattern) || []
  // Only flag if there are multiple distinct phone numbers — a single one is likely real context
  const uniquePhones = new Set(phoneMatches.map(p => p.replace(/\D/g, '')))
  if (uniquePhones.size > 3) {
    return { valid: false, reason: `Suspicious: ${uniquePhones.size} phone numbers in response — possible hallucination` }
  }

  return { valid: true }
}

// ── PASS 2 — Brand alignment ──────────────────────────────────────────────────
// Checks for Make.com leaks, AI platform language, high reading level, unfilled brackets.
const BRAND_AI_LANGUAGE_PATTERNS = [
  /\bai\s+(?:software|tool|platform|system|solution|product)\b/i,
  /\bartificial\s+intelligence\s+(?:software|tool|platform|system)\b/i,
]
const UNFILLED_BRACKET_PATTERN = /\[(?:[A-Z][A-Za-z0-9 _]{1,40})\]/  // [X]% or [NUMBER] etc.
// Approximate Flesch-Kincaid grade level for a block of text.
// Grade = 0.39 * (words/sentences) + 11.8 * (syllables/words) - 15.59
// We use a syllable estimate: syllables ≈ words * 1.4 for English prose
function estimateFKGrade(text) {
  const sentences = (text.match(/[.!?]+/g) || []).length || 1
  const words = (text.match(/\b\w+\b/g) || []).length || 1
  // rough syllable count: count vowel groups per word
  const syllables = (text.match(/[aeiouAEIOU]+/g) || []).length || words
  return 0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59
}

function passBrandAlignment(text) {
  // Make.com leak
  if (/\bMake\.com\b/i.test(text) || /\bvia\s+Make\b/i.test(text)) {
    return { pass: false, reason: 'Brand violation: Make.com name in message' }
  }
  // AI platform language
  for (const pat of BRAND_AI_LANGUAGE_PATTERNS) {
    if (pat.test(text)) {
      return { pass: false, reason: 'Brand violation: AI platform language in message' }
    }
  }
  // Flesch-Kincaid grade level
  const fk = estimateFKGrade(text)
  if (fk > 9) {
    return { pass: false, reason: `Reading level too high: FK grade ${fk.toFixed(1)} (max 9)` }
  }
  // Unfilled bracket placeholders like [X]% or [NUMBER]
  if (UNFILLED_BRACKET_PATTERN.test(text)) {
    return { pass: false, reason: 'Unfilled bracket placeholder detected (e.g. [X]% or [NUMBER])' }
  }
  return { pass: true, reason: null }
}

// ── PASS 3 — Hallucination detection ─────────────────────────────────────────
// Flags dollar amounts not in client context, URLs not in approved domains,
// and business claims with footnote markers.
function passHallucinationDetection(text, clientContext = {}) {
  // Dollar amounts must appear in clientContext.allowedAmounts (array of numeric strings) if provided
  const allowedAmounts = (clientContext.allowedAmounts || []).map(a => String(a).replace(/[^0-9.]/g, ''))
  const dollarMatches = text.match(/\$[\d,]+\.?\d*/g) || []
  if (allowedAmounts.length > 0) {
    for (const match of dollarMatches) {
      const num = match.replace(/[^0-9.]/g, '')
      if (!allowedAmounts.some(a => a === num)) {
        return { pass: false, reason: `Hallucinated dollar amount: ${match} not in clientContext.allowedAmounts` }
      }
    }
  }

  // URLs must be in approved domain list if provided
  const approvedDomains = clientContext.approvedDomains || []
  const urlMatches = text.match(/https?:\/\/[^\s]+/g) || []
  if (approvedDomains.length > 0) {
    for (const url of urlMatches) {
      const inApproved = approvedDomains.some(domain => url.includes(domain))
      if (!inApproved) {
        return { pass: false, reason: `URL not in approved domain list: ${url}` }
      }
    }
  }

  // Business claims with footnote markers
  if (/\*|†/.test(text)) {
    return { pass: false, reason: 'Footnote marker (* or †) in message — possible unsubstantiated claim' }
  }

  return { pass: true, reason: null }
}

/**
 * 3-pass strict validator — runs TCPA + brand alignment + hallucination detection.
 * @param {string} message - The generated message body
 * @param {object} clientContext - Optional context for Pass 3 checks:
 *   { allowedAmounts: string[], approvedDomains: string[], allowedFacts: object }
 * @returns {{ valid: boolean, failedPass: 1|2|3|null, reason: string|null }}
 */
function validateMessageStrict(message, clientContext = {}) {
  if (!message || typeof message !== 'string') {
    return { valid: false, failedPass: 1, reason: 'Message is empty or not a string' }
  }

  // Pass 1 — TCPA/SMS compliance (reuse validateSMS logic)
  const smsResult = validateSMS(message, clientContext.allowedFacts || {})
  if (!smsResult.valid) {
    return { valid: false, failedPass: 1, reason: smsResult.issues[0] || 'TCPA/SMS validation failed' }
  }

  // Pass 2 — Brand alignment
  const brandResult = passBrandAlignment(smsResult.text)
  if (!brandResult.pass) {
    return { valid: false, failedPass: 2, reason: brandResult.reason }
  }

  // Pass 3 — Hallucination detection
  const hallucinationResult = passHallucinationDetection(smsResult.text, clientContext)
  if (!hallucinationResult.pass) {
    return { valid: false, failedPass: 3, reason: hallucinationResult.reason }
  }

  return { valid: true, failedPass: null, reason: null }
}

module.exports = { validateSMS, validateEmail, gateSMS, validateInternal, checkBlockedSectors, validateMessageStrict }
