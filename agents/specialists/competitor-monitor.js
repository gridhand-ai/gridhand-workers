'use strict'
// ── COMPETITOR MONITOR — INTELLIGENCE SPECIALIST ──────────────────────────────
// Runs in two modes:
//   Mode A (internal): Aggregates city/industry-wide data from open data portals
//                      → saves to industry_intelligence table
//   Mode B (client):   Monitors specific competitors per client via web scraping
//                      → saves to competitor_monitoring table
//
// Model: Groq llama-3.3-70b-versatile ONLY (read/analyze work, not code gen)
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../../lib/ai-client')
const { scrapeUrl }    = require('../../lib/web-scraper')
const firecrawl        = require('../../lib/firecrawl-client')

const SPECIALIST_ID = 'competitor-monitor'
const GROQ_MODEL    = 'groq/llama-3.3-70b-versatile'

// Milwaukee CKAN open data endpoints
const CKAN_ENDPOINTS = {
  liquor_licenses: {
    url: 'https://data.milwaukee.gov/api/3/action/datastore_search?resource_id=45c027b5-fa66-4de2-aa7e-d9314292093d&limit=500',
    label: 'Liquor Licenses',
  },
  building_permits: {
    url: 'https://data.milwaukee.gov/api/3/action/datastore_search?resource_id=828e9630-d7cb-42e4-960e-964eae916397&limit=500',
    label: 'Building Permits',
  },
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY     || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MODE A — Internal industry intelligence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch raw data from a CKAN datastore endpoint.
 * Returns { records, total, source_label } or null on failure.
 */
async function fetchCkanData(endpointKey) {
  const endpoint = CKAN_ENDPOINTS[endpointKey]
  if (!endpoint) return null

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    const res = await fetch(endpoint.url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'GRIDHAND-Intelligence/1.0' },
    })
    clearTimeout(timer)

    if (!res.ok) {
      console.warn(`[${SPECIALIST_ID}] CKAN ${endpointKey} returned ${res.status}`)
      return null
    }

    const json = await res.json()
    if (!json?.success || !json?.result?.records) {
      console.warn(`[${SPECIALIST_ID}] CKAN ${endpointKey} malformed response`)
      return null
    }

    return {
      records: json.result.records,
      total:   json.result.total || json.result.records.length,
      source_label: endpoint.label,
    }
  } catch (err) {
    console.warn(`[${SPECIALIST_ID}] CKAN ${endpointKey} fetch failed:`, err.message)
    return null
  }
}

/**
 * Mode A: Aggregate city/industry data from open data portals.
 * Saves a row to industry_intelligence. Returns the saved record summary.
 *
 * @param {object} params
 * @param {string} params.industry - 'restaurant' | 'auto' | 'salon' | 'retail' | 'cleaning'
 * @param {string} params.city     - e.g. 'Milwaukee'
 * @param {string} params.state    - e.g. 'WI'
 */
async function runInternal({ industry, city, state }) {
  console.log(`[${SPECIALIST_ID}] Mode A — internal intelligence: ${industry} / ${city}, ${state}`)
  const supabase = getSupabase()

  // Fetch all available CKAN datasets in parallel
  const [liquorData, permitData] = await Promise.all([
    fetchCkanData('liquor_licenses'),
    fetchCkanData('building_permits'),
  ])

  const rawSnapshot = {}
  const contextParts = []

  if (liquorData) {
    rawSnapshot.liquor_licenses = {
      total: liquorData.total,
      sample: liquorData.records.slice(0, 20),
    }
    contextParts.push(`Liquor Licenses dataset: ${liquorData.total} total records. Sample fields: ${Object.keys(liquorData.records[0] || {}).join(', ')}.`)
  }

  if (permitData) {
    rawSnapshot.building_permits = {
      total: permitData.total,
      sample: permitData.records.slice(0, 20),
    }
    contextParts.push(`Building Permits dataset: ${permitData.total} total records. Sample fields: ${Object.keys(permitData.records[0] || {}).join(', ')}.`)
  }

  if (contextParts.length === 0) {
    console.warn(`[${SPECIALIST_ID}] No CKAN data available — skipping intelligence run`)
    return { status: 'skipped', reason: 'no_data_available' }
  }

  // Use Groq to analyze the raw data and generate benchmarks
  let metrics = {}
  try {
    const prompt = `<task>Analyze the following open city data for ${city}, ${state} and generate industry benchmarks for the "${industry}" sector. Focus on business counts, distribution by type, density patterns, and any seasonal or geographic signals relevant to a local business competing in this market.</task>

<data>
${contextParts.join('\n\n')}
</data>

<output>
Return valid JSON only with these fields:
{
  "count": number (total businesses/licenses relevant to this industry),
  "top_categories": string[] (top 3-5 business types found),
  "avg_capacity": string (estimated capacity or scale if determinable, else null),
  "market_density": "low" | "medium" | "high",
  "key_signals": string[] (2-4 actionable market observations),
  "benchmarks": object (any numeric benchmarks extracted)
}
</output>`

    const groqResponse = await call({
      modelString: GROQ_MODEL,
      systemPrompt: 'You are a market intelligence analyst. Extract structured benchmarks from city open data. Return only valid JSON.',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 800,
    })

    const match = groqResponse?.match(/\{[\s\S]*\}/)
    if (match) {
      metrics = JSON.parse(match[0])
    } else {
      console.warn(`[${SPECIALIST_ID}] Groq response unparseable — storing raw counts`)
      metrics = {
        count:          liquorData?.total || 0,
        permits_total:  permitData?.total || 0,
        key_signals:    ['Raw data collected — analysis pending'],
      }
    }
  } catch (err) {
    console.warn(`[${SPECIALIST_ID}] Groq analysis failed:`, err.message)
    metrics = {
      count:         liquorData?.total || 0,
      permits_total: permitData?.total || 0,
    }
  }

  // Save to industry_intelligence
  const { data: saved, error } = await supabase
    .from('industry_intelligence')
    .insert({
      industry,
      city,
      state,
      data_source:  'city_portal',
      metrics,
      raw_snapshot: rawSnapshot,
      collected_at: new Date().toISOString(),
    })
    .select('id, industry, city, collected_at')
    .single()

  if (error) {
    console.error(`[${SPECIALIST_ID}] Supabase insert failed:`, error.message)
    return { status: 'error', reason: error.message }
  }

  console.log(`[${SPECIALIST_ID}] Saved industry_intelligence row ${saved.id}`)
  return {
    status:       'saved',
    id:           saved.id,
    industry,
    city,
    state,
    metrics_summary: {
      count:        metrics.count,
      top_categories: metrics.top_categories,
      market_density: metrics.market_density,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MODE B — Client competitor monitoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mode B: Monitor specific competitors for a client.
 * Scrapes competitor URLs, generates insight summaries, saves to competitor_monitoring.
 * Does NOT send alerts — alert delivery is handled separately.
 *
 * @param {object} params
 * @param {string} params.clientId
 * @param {Array<{name: string, url: string, platform: string}>} params.competitors
 */
async function runClient({ clientId, competitors }) {
  console.log(`[${SPECIALIST_ID}] Mode B — client monitoring: clientId=${clientId}, ${competitors.length} competitors`)
  const supabase = getSupabase()

  if (!competitors || competitors.length === 0) {
    return { status: 'skipped', reason: 'no_competitors_configured' }
  }

  const results = []

  for (const competitor of competitors) {
    const { name, url, platform = 'google' } = competitor

    let pageContent = null
    if (url) {
      try {
        pageContent = await scrapeUrl(url, { timeout: 15000 })
        // Truncate to avoid token overflow — 3000 chars is plenty for signal extraction
        if (pageContent && pageContent.length > 3000) {
          pageContent = pageContent.slice(0, 3000) + '...[truncated]'
        }
      } catch (err) {
        console.warn(`[${SPECIALIST_ID}] Scrape failed for ${name} (${url}):`, err.message)
      }

      // If basic scrape returned sparse content (<200 chars), try Firecrawl for richer markdown
      if (url && (!pageContent || pageContent.length < 200)) {
        try {
          const fcResult = await firecrawl.scrape(url)
          if (fcResult.content && fcResult.content.length > (pageContent || '').length) {
            pageContent = fcResult.content.slice(0, 3000) + (fcResult.content.length > 3000 ? '...[truncated]' : '')
            console.log(`[${SPECIALIST_ID}] Firecrawl enriched content for ${name} (${pageContent.length} chars)`)
          }
        } catch (fcErr) {
          console.warn(`[${SPECIALIST_ID}] Firecrawl failed for ${name}:`, fcErr.message)
          // firecrawl failure does not block the agent — continue with whatever pageContent we have
        }
      }
    }

    // Generate insight via Groq
    let insights = []
    try {
      const contentContext = pageContent
        ? `<page_content>${pageContent}</page_content>`
        : '<page_content>No page content available — analyze based on business name and platform.</page_content>'

      const prompt = `<task>Analyze this competitor business and identify any notable insights that a competing local business should know about. Look for: promotions, pricing signals, service changes, review sentiment, new offerings, or any competitive threats or opportunities.</task>

<competitor>
Name: ${name}
Platform: ${platform}
URL: ${url || 'not provided'}
</competitor>

${contentContext}

<output>
Return a JSON array of insight objects (1-3 max). Each object:
{
  "insight_type": "new_promo" | "rating_change" | "new_review" | "price_change" | "menu_change" | "general",
  "summary": "One clear sentence describing the insight",
  "sentiment": "positive" | "negative" | "neutral"
}
Return [] if no meaningful insights found.
</output>`

      const groqResponse = await call({
        modelString: GROQ_MODEL,
        systemPrompt: 'You are a competitive intelligence analyst for local businesses. Extract actionable competitor insights. Return only valid JSON.',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 600,
      })

      const match = groqResponse?.match(/\[[\s\S]*\]/)
      if (match) {
        insights = JSON.parse(match[0])
      }
    } catch (err) {
      console.warn(`[${SPECIALIST_ID}] Groq insight generation failed for ${name}:`, err.message)
      insights = [{
        insight_type: 'general',
        summary:      `Monitored ${name} — no structured insights extracted this cycle.`,
        sentiment:    'neutral',
      }]
    }

    // Save each insight as a separate row
    for (const insight of insights) {
      const { data: saved, error } = await supabase
        .from('competitor_monitoring')
        .insert({
          client_id:       clientId,
          competitor_name: name,
          competitor_url:  url || null,
          platform,
          insight_type:    insight.insight_type,
          summary:         insight.summary,
          sentiment:       insight.sentiment || 'neutral',
          raw_data:        pageContent ? { page_excerpt: pageContent.slice(0, 500) } : null,
          alert_sent:      false,
        })
        .select('id')
        .single()

      if (error) {
        console.error(`[${SPECIALIST_ID}] Insert failed for ${name}:`, error.message)
        results.push({ competitor: name, status: 'error', reason: error.message })
      } else {
        results.push({ competitor: name, insight_type: insight.insight_type, id: saved.id, status: 'saved' })
      }
    }

    if (insights.length === 0) {
      results.push({ competitor: name, status: 'no_insights' })
    }
  }

  const saved = results.filter(r => r.status === 'saved').length
  const errors = results.filter(r => r.status === 'error').length
  console.log(`[${SPECIALIST_ID}] Client monitoring complete — ${saved} insights saved, ${errors} errors`)

  return {
    status:     errors === 0 ? 'complete' : 'partial',
    clientId,
    saved,
    errors,
    results,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {'internal'|'client'} params.mode
 * For mode 'internal': { mode, industry, city, state }
 * For mode 'client':   { mode, clientId, competitors }
 */
async function run(params = {}) {
  const { mode } = params

  if (mode === 'internal') {
    const { industry, city, state } = params
    if (!industry || !city || !state) {
      throw new Error(`[${SPECIALIST_ID}] Mode 'internal' requires industry, city, state`)
    }
    return runInternal({ industry, city, state })
  }

  if (mode === 'client') {
    const { clientId, competitors } = params
    if (!clientId) throw new Error(`[${SPECIALIST_ID}] Mode 'client' requires clientId`)
    return runClient({ clientId, competitors: competitors || [] })
  }

  throw new Error(`[${SPECIALIST_ID}] Unknown mode: ${mode}. Use 'internal' or 'client'.`)
}

module.exports = { run, runInternal, runClient, SPECIALIST_ID }
