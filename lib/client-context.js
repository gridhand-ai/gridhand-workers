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
  return {
    vertical,
    tone,
    xml: `<client_context>
  Business: ${client.business_name || 'this business'}
  Industry: ${client.industry || 'general'}
  Vertical: ${vertical}
  Plan: ${client.plan || 'starter'}
  Tone: ${tone}
  City: ${client.city || ''}
</client_context>`
  }
}

function isHolidayRelevant(vertical, holidayKey) {
  const allowed = HOLIDAY_RELEVANCE[vertical] || Object.values(HOLIDAY_RELEVANCE).flat()
  return allowed.includes(holidayKey)
}

module.exports = { buildClientContext, getVertical, isHolidayRelevant }
