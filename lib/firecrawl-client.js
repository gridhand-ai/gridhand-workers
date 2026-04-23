'use strict'
// Firecrawl — deep page scraping for competitor and reputation agents

let FirecrawlApp
try {
  const mod = require('@mendable/firecrawl-js')
  FirecrawlApp = mod.default || mod
} catch (e) {
  FirecrawlApp = null
}

let _client = null

function getClient() {
  if (!FirecrawlApp) throw new Error('@mendable/firecrawl-js not installed')
  if (!_client) {
    const key = process.env.FIRECRAWL_API_KEY
    if (!key) throw new Error('FIRECRAWL_API_KEY not set')
    _client = new FirecrawlApp({ apiKey: key })
  }
  return _client
}

// Scrape a single URL — returns clean markdown content
async function scrape(url, opts = {}) {
  const app = getClient()
  const res = await app.scrapeUrl(url, {
    formats: ['markdown'],
    ...opts,
  })
  return {
    url,
    content: res.markdown || '',
    metadata: res.metadata || {},
  }
}

// Crawl a site with depth limit — returns array of pages
async function crawl(url, opts = {}) {
  const app = getClient()
  const { limit = 5, ...rest } = opts
  const res = await app.crawlUrl(url, {
    limit,
    scrapeOptions: { formats: ['markdown'] },
    ...rest,
  })
  return (res.data || []).map(p => ({
    url: p.metadata?.sourceURL || url,
    content: p.markdown || '',
    metadata: p.metadata || {},
  }))
}

module.exports = { scrape, crawl }
