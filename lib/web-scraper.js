// web-scraper.js — lightweight website scraping using Carbonyl (headless Chromium)
// Falls back to plain fetch for simple HTML pages
// Use this in agents/workers that need to read client website content

const { execSync, spawn } = require('child_process')

/**
 * Scrape a URL and return the page text content.
 * Uses Carbonyl for JS-rendered pages, plain fetch for simple HTML.
 *
 * @param {string} url
 * @param {object} opts
 * @param {boolean} opts.jsRequired - Force Carbonyl even for simple pages (default: auto-detect)
 * @param {number} opts.timeout - Timeout in ms (default: 15000)
 * @returns {Promise<string>} Page text content
 */
async function scrapeUrl(url, opts = {}) {
  const { timeout = 15000 } = opts

  // Try plain fetch first — fast, zero overhead
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GRIDHAND-Bot/1.0)' },
    })
    clearTimeout(timer)
    const html = await res.text()

    // If page has substantial content and doesn't look SPA-only, return it
    const textContent = htmlToText(html)
    if (textContent.length > 200) return textContent

    // If content is thin, fall through to Carbonyl
  } catch (_) {
    // fetch failed, try Carbonyl
  }

  return scrapeWithCarbonyl(url, timeout)
}

/**
 * Scrape using Carbonyl (full Chromium engine — handles React/Vue/JS-heavy sites)
 */
async function scrapeWithCarbonyl(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`Carbonyl timeout after ${timeout}ms for ${url}`))
    }, timeout)

    // carbonyl --dump prints page text to stdout and exits
    const proc = spawn('npx', ['carbonyl', '--dump', url], {
      timeout,
      env: { ...process.env, DISPLAY: '' },
    })

    let output = ''
    let error = ''

    proc.stdout.on('data', (d) => { output += d.toString() })
    proc.stderr.on('data', (d) => { error += d.toString() })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (output.length > 50) {
        resolve(output.trim())
      } else {
        reject(new Error(`Carbonyl returned empty output for ${url}: ${error}`))
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * Strip HTML tags and return readable text
 */
function htmlToText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

/**
 * Scrape multiple URLs concurrently (max 3 at a time)
 */
async function scrapeMultiple(urls, opts = {}) {
  const results = []
  const chunks = []
  for (let i = 0; i < urls.length; i += 3) {
    chunks.push(urls.slice(i, i + 3))
  }
  for (const chunk of chunks) {
    const batch = await Promise.allSettled(chunk.map((url) => scrapeUrl(url, opts)))
    for (let i = 0; i < batch.length; i++) {
      results.push({
        url: chunk[i],
        content: batch[i].status === 'fulfilled' ? batch[i].value : null,
        error: batch[i].status === 'rejected' ? batch[i].reason?.message : null,
      })
    }
  }
  return results
}

module.exports = { scrapeUrl, scrapeWithCarbonyl, scrapeMultiple }
