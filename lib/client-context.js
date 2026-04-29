'use strict'

const VERTICAL_MAP = {
  // Auto/Vehicle
  auto_repair: 'vehicle-service', auto_shop: 'vehicle-service', mechanic: 'vehicle-service',
  // Food/Beverage
  restaurant: 'food-beverage', cafe: 'food-beverage', coffee: 'food-beverage', bakery: 'food-beverage', bar: 'food-beverage',
  // Health/Fitness
  gym: 'health-fitness', fitness: 'health-fitness', yoga: 'health-fitness', crossfit: 'health-fitness',
  // Beauty/Personal Care
  barbershop: 'personal-care', salon: 'personal-care', spa: 'personal-care', nail: 'personal-care',
  // Family/Entertainment
  entertainment: 'family-entertainment', playland: 'family-entertainment', arcade: 'family-entertainment',
  // Retail
  retail: 'retail', boutique: 'retail', shop: 'retail',
  // Real Estate
  real_estate: 'real-estate', realty: 'real-estate',
  // Professional Services
  legal: 'professional-b2b', law: 'professional-b2b', accounting: 'professional-b2b', consulting: 'professional-b2b',
  // AI / SaaS / Automation
  saas: 'professional-b2b', 'ai_business': 'professional-b2b', automation: 'professional-b2b', software: 'professional-b2b',
}

const TONE_MAP = {
  'vehicle-service': 'direct-practical',
  'food-beverage': 'warm-inviting',
  'health-fitness': 'energetic-motivating',
  'personal-care': 'warm-friendly',
  'family-entertainment': 'fun-enthusiastic',
  'retail': 'helpful-friendly',
  'real-estate': 'professional-trustworthy',
  'professional-b2b': 'formal-precise',
}

// Holiday relevance by vertical — suppresses irrelevant campaigns
const HOLIDAY_RELEVANCE = {
  'professional-b2b': ['new_year', 'labor_day'],
  'vehicle-service': ['fathers_day', 'labor_day', 'memorial_day', 'new_year'],
  'food-beverage': ['valentines', 'mothers_day', 'fathers_day', 'thanksgiving', 'christmas', 'new_year', 'halloween'],
  'health-fitness': ['new_year', 'valentines', 'memorial_day', 'labor_day'],
  'personal-care': ['valentines', 'mothers_day', 'fathers_day', 'christmas', 'new_year'],
  'family-entertainment': ['valentines', 'mothers_day', 'fathers_day', 'halloween', 'christmas', 'thanksgiving', 'new_year', 'spring_break'],
  'retail': ['valentines', 'mothers_day', 'fathers_day', 'halloween', 'christmas', 'thanksgiving', 'new_year', 'labor_day'],
  'real-estate': ['new_year', 'spring', 'labor_day'],
}

function getVertical(industry) {
  if (!industry) return 'general'
  const key = industry.toLowerCase().replace(/\s+/g, '_')
  for (const [k, v] of Object.entries(VERTICAL_MAP)) {
    if (key.includes(k)) return v
  }
  return 'general'
}

function buildClientContext(client) {
  const vertical = getVertical(client.industry)
  const tone = TONE_MAP[vertical] || 'professional-friendly'

  const prefs = (client && typeof client.worker_preferences === 'object' && client.worker_preferences) || {}

  const lines = []
  lines.push('<client_context>')
  lines.push(`  Business: ${client.business_name || 'this business'}`)
  lines.push(`  Industry: ${client.industry || 'general'}`)
  lines.push(`  Vertical: ${vertical}`)
  lines.push(`  Plan: ${client.plan || 'starter'}`)
  lines.push(`  Tone: ${tone}`)
  if (client.city) lines.push(`  City: ${client.city}`)
  if (client.business_website) lines.push(`  Website: ${client.business_website}`)

  if (Array.isArray(client.services) && client.services.length > 0) {
    const items = client.services
      .map(s => {
        if (!s) return null
        if (typeof s === 'string') return s.trim()
        if (typeof s === 'object') {
          const name = s.name || s.title || ''
          const price = s.price ? ` (${s.price})` : ''
          return name ? `${name}${price}` : null
        }
        return null
      })
      .filter(Boolean)
    if (items.length > 0) {
      lines.push('  <services>')
      for (const item of items) lines.push(`    - ${item}`)
      lines.push('  </services>')
    }
  }

  if (client.special_instructions && String(client.special_instructions).trim()) {
    lines.push('  <instructions>')
    lines.push(`    ${String(client.special_instructions).trim()}`)
    lines.push('  </instructions>')
  }

  if (prefs.brand_voice && String(prefs.brand_voice).trim()) {
    lines.push('  <brand_voice>')
    lines.push(`    ${String(prefs.brand_voice).trim()}`)
    lines.push('  </brand_voice>')
  }

  if (Array.isArray(prefs.avoid) && prefs.avoid.length > 0) {
    const items = prefs.avoid.map(v => v && String(v).trim()).filter(Boolean)
    if (items.length > 0) {
      lines.push('  <avoid>')
      for (const item of items) lines.push(`    - ${item}`)
      lines.push('  </avoid>')
    }
  } else if (prefs.avoid && typeof prefs.avoid === 'string' && prefs.avoid.trim()) {
    lines.push('  <avoid>')
    lines.push(`    ${prefs.avoid.trim()}`)
    lines.push('  </avoid>')
  }

  if (prefs.prefer) {
    if (Array.isArray(prefs.prefer)) {
      const items = prefs.prefer.map(v => v && String(v).trim()).filter(Boolean)
      if (items.length > 0) {
        lines.push('  <prefer>')
        for (const item of items) lines.push(`    - ${item}`)
        lines.push('  </prefer>')
      }
    } else if (typeof prefs.prefer === 'string' && prefs.prefer.trim()) {
      lines.push('  <prefer>')
      lines.push(`    ${prefs.prefer.trim()}`)
      lines.push('  </prefer>')
    }
  }

  lines.push('</client_context>')

  return {
    vertical,
    tone,
    xml: lines.join('\n')
  }
}

function isHolidayRelevant(vertical, holidayKey) {
  const allowed = HOLIDAY_RELEVANCE[vertical] || Object.values(HOLIDAY_RELEVANCE).flat()
  return allowed.includes(holidayKey)
}

module.exports = { buildClientContext, getVertical, isHolidayRelevant }
