'use strict'
// tier: simple
// ── GRIDHAND INTERNAL SPECIALIST ──────────────────────────────────────────────
// VisualCI — Nightly visual regression monitor for gridhand-portal
// Division: internal
// Reports to: gridhand-commander
// Runs: nightly (via cron in server.js)
//
// Takes screenshots of key public portal pages, diffs them against stored
// baselines in Supabase Storage, and logs regressions to agent_runs.
// Zero AI token cost — pure Playwright + pixelmatch math.
//
// Baseline behavior:
//   - First run (no baseline): saves screenshots as new baseline, exits clean
//   - Subsequent runs: diffs against baseline, flags pages with >3% pixel change
//   - On regression: logs to agent_runs, updates baseline to current state
// ─────────────────────────────────────────────────────────────────────────────

const puppeteer   = require('puppeteer')
const pixelmatch  = require('pixelmatch')
const { PNG }     = require('pngjs')
const { createClient } = require('@supabase/supabase-js')

const SPECIALIST_ID = 'visual-ci'
const DIVISION      = 'internal'
const REPORTS_TO    = 'gridhand-commander'

// Pages to monitor — public routes only (no auth required)
const MONITORED_PAGES = [
  { name: 'home',         path: '/',              width: 1440, height: 900  },
  { name: 'home-mobile',  path: '/',              width: 390,  height: 844  },
  { name: 'login',        path: '/login',         width: 1440, height: 900  },
  { name: 'integrations', path: '/integrations',  width: 1440, height: 900  },
]

// Pixel change threshold — below this % is noise (fonts, animations, timestamps)
const REGRESSION_THRESHOLD = 0.03  // 3%

// Supabase Storage bucket for baselines
const BASELINE_BUCKET = 'visual-baselines'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

function getPortalBaseUrl() {
  return process.env.PORTAL_URL || 'https://gridhand-portal.vercel.app'
}

// ── Take a screenshot of a page ───────────────────────────────────────────────
async function takeScreenshot(browser, baseUrl, page) {
  const tab = await browser.newPage()
  await tab.setViewport({ width: page.width, height: page.height })

  try {
    await tab.goto(`${baseUrl}${page.path}`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    })
    // Wait for animations to settle
    await new Promise(r => setTimeout(r, 1500))

    const buffer = await tab.screenshot({ type: 'png', fullPage: false })
    return buffer
  } finally {
    await tab.close()
  }
}

// ── Load baseline from Supabase Storage ───────────────────────────────────────
async function loadBaseline(supabase, pageName) {
  try {
    const { data, error } = await supabase
      .storage
      .from(BASELINE_BUCKET)
      .download(`${pageName}.png`)

    if (error || !data) return null

    const arrayBuffer = await data.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch (err) {
    console.warn(`[${SPECIALIST_ID}] No baseline found for ${pageName}:`, err.message)
    return null
  }
}

// ── Save screenshot as new baseline ──────────────────────────────────────────
async function saveBaseline(supabase, pageName, buffer) {
  const { error } = await supabase
    .storage
    .from(BASELINE_BUCKET)
    .upload(`${pageName}.png`, buffer, {
      contentType: 'image/png',
      upsert: true,
    })

  if (error) {
    console.warn(`[${SPECIALIST_ID}] Failed to save baseline for ${pageName}:`, error.message)
  }
}

// ── Compare two PNG buffers, return diff ratio ─────────────────────────────────
function diffScreenshots(baselineBuffer, currentBuffer) {
  try {
    const baseline = PNG.sync.read(baselineBuffer)
    const current  = PNG.sync.read(currentBuffer)

    // If dimensions changed — that's a regression by itself
    if (baseline.width !== current.width || baseline.height !== current.height) {
      return {
        diffRatio: 1.0,
        reason: `Dimensions changed: ${baseline.width}x${baseline.height} → ${current.width}x${current.height}`,
      }
    }

    const { width, height } = baseline
    const diff = new PNG({ width, height })

    const numDiffPixels = pixelmatch(
      baseline.data, current.data, diff.data,
      width, height,
      { threshold: 0.15, alpha: 0.3 }
    )

    const totalPixels = width * height
    const diffRatio   = numDiffPixels / totalPixels

    return { diffRatio, reason: null }
  } catch (err) {
    return { diffRatio: -1, reason: `Diff failed: ${err.message}` }
  }
}

// ── Log regression to agent_runs ──────────────────────────────────────────────
async function logRegression(supabase, pageName, diffRatio, reason) {
  const details = reason || `${(diffRatio * 100).toFixed(1)}% pixels changed`
  console.warn(`[${SPECIALIST_ID.toUpperCase()}] REGRESSION on ${pageName}: ${details}`)

  await supabase.from('agent_runs').insert({
    agent_name: SPECIALIST_ID,
    status:     'error',
    details:    {
      page:      pageName,
      diffRatio: Math.round(diffRatio * 10000) / 100,
      message:   `Visual regression detected on ${pageName}: ${details}`,
      severity:  diffRatio > 0.15 ? 'high' : 'medium',
    },
    created_at: new Date().toISOString(),
  }).catch(() => {})
}

// ── Main run ──────────────────────────────────────────────────────────────────
async function run() {
  console.log(`[${SPECIALIST_ID.toUpperCase()}] Starting visual CI run`)

  const supabase  = getSupabase()
  const baseUrl   = getPortalBaseUrl()
  const regressions = []
  const newBaselines = []
  let browser

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    })

    for (const page of MONITORED_PAGES) {
      console.log(`[${SPECIALIST_ID.toUpperCase()}] Checking ${page.name} (${page.width}x${page.height})`)

      let currentBuffer
      try {
        currentBuffer = await takeScreenshot(browser, baseUrl, page)
      } catch (err) {
        console.error(`[${SPECIALIST_ID}] Screenshot failed for ${page.name}:`, err.message)
        await logRegression(supabase, page.name, 1.0, `Screenshot failed: ${err.message}`)
        regressions.push({ page: page.name, reason: `Screenshot failed: ${err.message}` })
        continue
      }

      const baselineBuffer = await loadBaseline(supabase, page.name)

      if (!baselineBuffer) {
        // No baseline yet — save this as the first baseline
        await saveBaseline(supabase, page.name, currentBuffer)
        newBaselines.push(page.name)
        console.log(`[${SPECIALIST_ID.toUpperCase()}] Baseline saved for ${page.name}`)
        continue
      }

      const { diffRatio, reason } = diffScreenshots(baselineBuffer, currentBuffer)

      if (diffRatio < 0) {
        // Diff errored — log but don't update baseline
        await logRegression(supabase, page.name, 1.0, reason)
        regressions.push({ page: page.name, reason })
      } else if (diffRatio > REGRESSION_THRESHOLD) {
        await logRegression(supabase, page.name, diffRatio, reason)
        regressions.push({ page: page.name, diffRatio, reason })
        // Update baseline so next run compares against the new state
        await saveBaseline(supabase, page.name, currentBuffer)
      } else {
        console.log(`[${SPECIALIST_ID.toUpperCase()}] ${page.name} clean (${(diffRatio * 100).toFixed(2)}% diff)`)
      }
    }

  } finally {
    if (browser) await browser.close()
  }

  // Log the run summary
  await supabase.from('agent_runs').insert({
    agent_name: SPECIALIST_ID,
    status:     regressions.length > 0 ? 'error' : 'success',
    details:    {
      pagesChecked:   MONITORED_PAGES.length,
      regressions:    regressions.length,
      newBaselines:   newBaselines.length,
      baseUrl,
      regressionList: regressions,
    },
    created_at: new Date().toISOString(),
  }).catch(() => {})

  console.log(`[${SPECIALIST_ID.toUpperCase()}] Done — ${regressions.length} regressions, ${newBaselines.length} new baselines`)

  return {
    agentId:      SPECIALIST_ID,
    division:     DIVISION,
    reportsTo:    REPORTS_TO,
    actionsCount: regressions.length,
    escalations:  regressions.filter(r => (r.diffRatio || 1) > 0.15),
    outcomes:     [{ regressions, newBaselines, pagesChecked: MONITORED_PAGES.length }],
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION, REPORTS_TO }
