'use strict'
// ── HUMANIZER ─────────────────────────────────────────────────────────────────
// Strips AI writing patterns from client-facing messages before sending.
// Implements detection for the 37 patterns defined in
// ~/.claude/skills/humanizer/SKILL.md
//
// Conservative — only removes clear structural tells (filler transitions,
// certainty-softeners, sycophantic openers, corporate jargon). Does NOT
// rewrite meaning — that stays with the AI model.
//
// Usage: const { clean, hasSuspiciousPatterns, detectPatterns } = require('./humanizer')
// ─────────────────────────────────────────────────────────────────────────────

// ── PATTERN GROUPS ────────────────────────────────────────────────────────────
// Each entry: { name, pattern, replacement }
// Order matters — process longer/more-specific patterns first to avoid
// half-matching nested phrases.

// 1) Outright deletions — sycophantic openers, certainty-softeners,
//    AI self-references. These prefixes are removed wholesale (the comma
//    or trailing whitespace following them is also consumed).
const DELETE_PREFIXES = [
  // AI self-reference (must never appear, but gate it just in case)
  { name: 'as-an-ai',                   pattern: /^\s*As an AI[^.!?]*[.!?]\s*/i },

  // Filler transitions at start of sentence
  { name: 'furthermore',                pattern: /(^|[.!?]\s+)Furthermore,\s*/g },
  { name: 'moreover',                   pattern: /(^|[.!?]\s+)Moreover,\s*/g },
  { name: 'additionally',               pattern: /(^|[.!?]\s+)Additionally,\s*/g },
  { name: 'in-addition',                pattern: /(^|[.!?]\s+)In addition,\s*/g },
  { name: 'it-is-also-worth-mentioning',pattern: /(^|[.!?]\s+)It is also worth mentioning( that)?,?\s*/gi },

  // Empty conclusion pivots
  { name: 'in-conclusion',              pattern: /(^|[.!?]\s+)In conclusion,\s*/gi },
  { name: 'to-summarize',               pattern: /(^|[.!?]\s+)To summarize,\s*/gi },
  { name: 'in-summary',                 pattern: /(^|[.!?]\s+)In summary,\s*/gi },
  { name: 'ultimately',                 pattern: /(^|[.!?]\s+)Ultimately,\s*/g },

  // Fake momentum phrases
  { name: 'moving-forward',             pattern: /(^|[.!?]\s+)Moving forward,\s*/gi },
  { name: 'going-forward',              pattern: /(^|[.!?]\s+)Going forward,\s*/gi },
  { name: 'with-that-in-mind',          pattern: /(^|[.!?]\s+)With that in mind,\s*/gi },
  { name: 'that-being-said',            pattern: /(^|[.!?]\s+)That being said,\s*/gi },

  // Hollow bridges
  { name: 'at-the-end-of-the-day',      pattern: /(^|[.!?]\s+)At the end of the day,\s*/gi },
  { name: 'when-all-is-said-and-done',  pattern: /(^|[.!?]\s+)When all is said and done,\s*/gi },
  { name: 'the-bottom-line-is',         pattern: /(^|[.!?]\s+)The bottom line is,?\s*/gi },

  // Certainty-softening openers (longer phrases first)
  { name: 'its-worth-noting-that',      pattern: /(^|[.!?]\s+)(It[''']?s|It is) worth noting that\s*/gi },
  { name: 'its-important-to-remember',  pattern: /(^|[.!?]\s+)(It[''']?s|It is) important to (remember|note)( that)?,?\s*/gi },
  { name: 'keep-in-mind-that',          pattern: /(^|[.!?]\s+)Keep in mind that\s*/gi },
  { name: 'it-should-be-noted-that',    pattern: /(^|[.!?]\s+)It should be noted that\s*/gi },

  // Sycophantic openers — only when at the very start of message
  { name: 'great-question',             pattern: /^\s*Great question!?\s*/i },
  { name: 'excellent-point',            pattern: /^\s*Excellent point!?\s*/i },
  { name: 'thats-a-great-question',     pattern: /^\s*That[''']?s (a )?(really |very )?(great|interesting|good) (question|point|perspective)!?\s*/i },
  { name: 'absolutely-opener',          pattern: /^\s*Absolutely!?\s*/i },
  { name: 'certainly-opener',           pattern: /^\s*Certainly!?\s*/i },
  { name: 'of-course-opener',           pattern: /^\s*Of course!?\s*/i },
  { name: 'sure-opener',                pattern: /^\s*Sure!?\s*/i },
  { name: 'happy-to-help-opener',       pattern: /^\s*Happy to help!?\s*/i },

  // False empathy
  { name: 'i-hope-this-finds-you-well', pattern: /(^|[.!?]\s+)I hope this (message |email |note )?finds you well[.,!]?\s*/gi },

  // Redundant connectors
  { name: 'as-previously-mentioned',    pattern: /(^|[.!?]\s+)As previously mentioned,\s*/gi },
  { name: 'as-i-noted-earlier',         pattern: /(^|[.!?]\s+)As I noted earlier,\s*/gi },
  { name: 'circling-back-to',           pattern: /(^|[.!?]\s+)Circling back to\s*/gi },

  // Over-explanation
  { name: 'in-other-words',             pattern: /(^|[.!?]\s+)In other words,\s*/gi },
  { name: 'to-put-it-simply',           pattern: /(^|[.!?]\s+)To put it simply,\s*/gi },
  { name: 'that-is-to-say',             pattern: /(^|[.!?]\s+)That is to say,\s*/gi },

  // Stating the obvious
  { name: 'as-you-probably-know',       pattern: /(^|[.!?]\s+)As you (probably |may |might )?know,\s*/gi },
  { name: 'as-we-all-know',             pattern: /(^|[.!?]\s+)As we all know,\s*/gi },
  { name: 'it-goes-without-saying',     pattern: /(^|[.!?]\s+)It goes without saying,?\s*(but\s*)?/gi },
]

// 2) Trailing trims — typical AI sign-off filler removed from end of text
const DELETE_SUFFIXES = [
  // "Let me know if you have any questions" variants
  { name: 'let-me-know-questions',
    pattern: /\s*(Please\s+)?(Feel\s+free\s+to\s+|Don[''']?t\s+hesitate\s+to\s+)?Let me know if you have any (further |other |additional )?questions[.!]*\s*$/i },
  { name: 'feel-free-to-reach-out',
    pattern: /\s*(Please\s+)?Feel free to reach out (if you have any questions|with any questions|anytime)[.!]*\s*$/i },
  { name: 'dont-hesitate-to-reach-out',
    pattern: /\s*(Please\s+)?Don[''']?t hesitate to reach out (if you have any questions|with any questions|anytime)[.!]*\s*$/i },
  { name: 'happy-to-help-suffix',
    pattern: /\s*(I[''']?m\s+|We[''']?re\s+)?(Always\s+)?Happy to help[.!]*\s*$/i },
]

// 3) Word-level replacements — corporate/consultant jargon to plain English
const WORD_REPLACEMENTS = [
  // Action-noun inflation
  { name: 'utilize',         pattern: /\butilize\b/g,        replacement: 'use' },
  { name: 'utilizes',        pattern: /\butilizes\b/g,       replacement: 'uses' },
  { name: 'utilized',        pattern: /\butilized\b/g,       replacement: 'used' },
  { name: 'utilizing',       pattern: /\butilizing\b/g,      replacement: 'using' },
  { name: 'leverage',        pattern: /\bleverage\b/g,       replacement: 'use' },
  { name: 'leverages',       pattern: /\bleverages\b/g,      replacement: 'uses' },
  { name: 'leveraged',       pattern: /\bleveraged\b/g,      replacement: 'used' },
  { name: 'leveraging',      pattern: /\bleveraging\b/g,     replacement: 'using' },
  { name: 'facilitate',      pattern: /\bfacilitate\b/g,     replacement: 'help' },
  { name: 'facilitates',     pattern: /\bfacilitates\b/g,    replacement: 'helps' },
  { name: 'ensure',          pattern: /\bensure\b/g,         replacement: 'make sure' },
  { name: 'ensures',         pattern: /\bensures\b/g,        replacement: 'makes sure' },
  { name: 'ensured',         pattern: /\bensured\b/g,        replacement: 'made sure' },
  { name: 'commence',        pattern: /\bcommence\b/g,       replacement: 'start' },
  { name: 'commences',       pattern: /\bcommences\b/g,      replacement: 'starts' },

  // Solution-speak — soften/strip standalone over-used adjectives.
  // Conservative: only remove when clearly used as filler before
  // generic nouns ("solution", "approach", "framework", "platform").
  { name: 'robust-solution',         pattern: /\brobust\s+(solution|platform|system|framework)\b/gi,        replacement: '$1' },
  { name: 'cutting-edge-solution',   pattern: /\bcutting[- ]edge\s+(solution|platform|system|technology)\b/gi, replacement: '$1' },
  { name: 'comprehensive-solution',  pattern: /\bcomprehensive\s+(solution|platform|approach|framework)\b/gi, replacement: '$1' },
  { name: 'holistic-approach',       pattern: /\bholistic\s+(approach|solution|framework)\b/gi,             replacement: '$1' },
  { name: 'seamless-integration',    pattern: /\bseamless\s+(integration|experience|process|solution)\b/gi, replacement: '$1' },
]

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Detect AI writing patterns in a piece of text.
 * Returns an array of pattern names that matched.
 * @param {string} text
 * @returns {string[]}
 */
function detectPatterns(text) {
  if (!text || typeof text !== 'string') return []
  const hits = []
  try {
    for (const { name, pattern } of DELETE_PREFIXES) {
      if (pattern.test(text)) hits.push(name)
      pattern.lastIndex = 0
    }
    for (const { name, pattern } of DELETE_SUFFIXES) {
      if (pattern.test(text)) hits.push(name)
      pattern.lastIndex = 0
    }
    for (const { name, pattern } of WORD_REPLACEMENTS) {
      if (pattern.test(text)) hits.push(name)
      pattern.lastIndex = 0
    }
  } catch {
    // never crash — return what we have
  }
  return hits
}

/**
 * Returns true if text has 3+ AI tells (threshold-based).
 * @param {string} text
 * @returns {boolean}
 */
function hasSuspiciousPatterns(text) {
  return detectPatterns(text).length >= 3
}

/**
 * Clean: removes/rewrites the most egregious AI patterns from text.
 * Conservative — only structural tells. Never crashes; on error, returns
 * the original text unchanged.
 * @param {string} text
 * @returns {string}
 */
function clean(text) {
  if (!text || typeof text !== 'string') return text
  try {
    let out = text

    // Pass 1 — delete prefix patterns (preserve sentence boundary captured in $1)
    for (const { pattern } of DELETE_PREFIXES) {
      out = out.replace(pattern, (match, boundary) => boundary || '')
    }

    // Pass 2 — trim trailing sign-off filler
    for (const { pattern } of DELETE_SUFFIXES) {
      out = out.replace(pattern, '')
    }

    // Pass 3 — word-level replacements
    for (const { pattern, replacement } of WORD_REPLACEMENTS) {
      out = out.replace(pattern, replacement)
    }

    // Final cleanup — collapse double-spaces and stray leading punctuation
    out = out.replace(/[ \t]{2,}/g, ' ')
    out = out.replace(/\s+([.,!?;:])/g, '$1')
    out = out.replace(/^\s*[,;:]\s*/, '')
    out = out.trim()

    return out
  } catch {
    return text
  }
}

module.exports = { clean, hasSuspiciousPatterns, detectPatterns }
