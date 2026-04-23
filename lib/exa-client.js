'use strict'
// ── Exa Search Client ─────────────────────────────────────────────────────────
// Wraps the exa-js SDK for use by directors and specialists.
// All searches use type:"auto" and highlights by default — token-efficient.
// Structured output (outputSchema) supported for enrichment workflows.
// ─────────────────────────────────────────────────────────────────────────────

const Exa = require('exa-js').default || require('exa-js')

let _client = null

function getClient() {
  if (!_client) {
    const key = process.env.EXA_API_KEY
    if (!key) throw new Error('EXA_API_KEY not set')
    _client = new Exa(key)
  }
  return _client
}

/**
 * Search the web. Returns clean highlights by default.
 * @param {string} query
 * @param {object} opts
 * @param {number}  opts.numResults   default 5
 * @param {string}  opts.type         default 'auto'
 * @param {number}  opts.maxChars     default 4000
 * @param {object}  opts.outputSchema optional — returns structured JSON in result.output.content
 * @param {string[]} opts.includeDomains
 * @param {string[]} opts.excludeDomains
 */
async function search(query, opts = {}) {
  const exa = getClient()
  const {
    numResults    = 5,
    type          = 'auto',
    maxChars      = 4000,
    outputSchema  = null,
    includeDomains,
    excludeDomains,
  } = opts

  const params = {
    type,
    numResults,
    contents: {
      highlights: { maxCharacters: maxChars },
    },
  }

  if (outputSchema)    params.outputSchema  = outputSchema
  if (includeDomains)  params.includeDomains = includeDomains
  if (excludeDomains)  params.excludeDomains = excludeDomains

  const res = await exa.search(query, params)

  // Return structured output if schema was provided
  if (outputSchema && res.output) {
    return { structured: res.output.content, grounding: res.output.grounding, raw: res }
  }

  // Otherwise return clean highlights array
  return {
    results: (res.results || []).map(r => ({
      title:      r.title,
      url:        r.url,
      highlights: r.highlights || [],
      published:  r.publishedDate,
    })),
    raw: res,
  }
}

/**
 * Get clean content from known URLs.
 * @param {string[]} urls
 * @param {number} maxChars default 4000
 */
async function getContents(urls, maxChars = 4000) {
  const exa = getClient()
  const res = await exa.getContents(urls, {
    highlights: { maxCharacters: maxChars },
  })
  return (res.results || []).map(r => ({
    title:      r.title,
    url:        r.url,
    highlights: r.highlights || [],
  }))
}

module.exports = { search, getContents }
