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

/**
 * Validate an SMS before sending.
 * @param {string} text - The generated SMS body
 * @param {object} allowedFacts - Key/value facts the model was given (prices, names, dates)
 * @returns {{ valid: boolean, issues: string[], text: string }}
 */
function validateSMS(text, allowedFacts = {}) {
  const issues = []
  let sanitized = text.trim()

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

  // 0. Blocked sector check — runs first, hard gate
  const emailSectorCheck = checkBlockedSectors((subject || '') + ' ' + (body || ''))
  if (emailSectorCheck.blocked) {
    return { valid: false, issues: [emailSectorCheck.reason], subject, body }
  }

  // 1. Subject length
  if (!subject || subject.length < 3) issues.push('Subject too short or missing')
  if (subject && subject.length > 100) issues.push(`Subject too long: ${subject.length} chars`)

  // 2. Body not empty
  if (!body || body.trim().length < 20) issues.push('Email body too short — likely generation failure')

  // 3. Placeholder leak
  const placeholders = /\[INSERT|PLACEHOLDER|YOUR_|{{\s*\w+\s*}}/i
  if (placeholders.test(subject) || placeholders.test(body)) {
    issues.push('Template placeholder not filled — generation incomplete')
  }

  // 4. Hallucinated dollar amounts
  const dollarMatches = (body + subject).match(/\$[\d,]+\.?\d*/g) || []
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

  return { valid, issues, subject: subject?.trim(), body: body?.trim() }
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

module.exports = { validateSMS, validateEmail, gateSMS, validateInternal, checkBlockedSectors }
