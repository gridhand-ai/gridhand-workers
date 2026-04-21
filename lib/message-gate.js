'use strict'
// ── MESSAGE QUALITY GATE ──────────────────────────────────────────────────────
// Validates Groq/Ollama-generated SMS and email content before sending.
// Rule: client-facing messages may ONLY contain facts explicitly passed in.
// No hallucinated prices, promos, URLs, or numbers not in allowedFacts.
// ─────────────────────────────────────────────────────────────────────────────

const SMS_SEGMENT_CHARS = 160
const SMS_MAX_SEGMENTS  = 3   // hard cap — 3 segments = 480 chars

/**
 * Validate an SMS before sending.
 * @param {string} text - The generated SMS body
 * @param {object} allowedFacts - Key/value facts the model was given (prices, names, dates)
 * @returns {{ valid: boolean, issues: string[], text: string }}
 */
function validateSMS(text, allowedFacts = {}) {
  const issues = []
  let sanitized = text.trim()

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

module.exports = { validateSMS, validateEmail, gateSMS }
