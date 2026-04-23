'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// CampaignConductor — Seasonal campaigns: detects upcoming events, briefs client, launches sequence
// Division: brand
// Reports to: brand-director
// Runs: on-demand (called by BrandDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient }           = require('@supabase/supabase-js')
const aiClient                   = require('../../lib/ai-client')
const { sendSMS }                = require('../../lib/twilio-client')
const { validateSMS }            = require('../../lib/message-gate')
const { isHolidayRelevant, buildClientContext } = require('../../lib/client-context')
const { fileInteraction }        = require('../../lib/memory-client')
const vault                      = require('../../lib/memory-vault')
const { validateAndImprove }     = require('../../lib/offer-validator')
const { logCampaignResult }      = require('../../lib/campaign-feedback')

const AGENT_ID  = 'campaign-conductor'
const DIVISION  = 'brand'
const REPORTS_TO = 'brand-director'

// Campaign lead time per holiday (days before the event we send the brief)
const LEAD_DAYS = {
  new_year:      14,
  valentines:    14,
  spring:        14,
  memorial_day:  10,
  mothers_day:   14,
  fathers_day:   14,
  july4:         10,
  labor_day:     10,
  halloween:     14,
  thanksgiving:  14,
  christmas:     21,
  back_to_school: 14,
  spring_break:  10,
}

// ── Dynamic holiday date calculation ─────────────────────────────────────────

/**
 * Returns the Nth occurrence of dayOfWeek in the given month/year.
 * dayOfWeek: 0=Sun, 1=Mon … 6=Sat
 * nth: 1-based (1 = first, 2 = second, etc.)
 */
function getNthDayOfMonth(year, month, dayOfWeek, nth) {
  const date = new Date(year, month, 1)
  let count = 0
  while (date.getMonth() === month) {
    if (date.getDay() === dayOfWeek) {
      count++
      if (count === nth) return new Date(date)
    }
    date.setDate(date.getDate() + 1)
  }
  return null
}

/**
 * Returns the last occurrence of dayOfWeek in the given month/year.
 * dayOfWeek: 0=Sun, 1=Mon … 6=Sat
 */
function getLastDayOfMonth(year, month, dayOfWeek) {
  const date = new Date(year, month + 1, 0) // last calendar day of month
  while (date.getDay() !== dayOfWeek) date.setDate(date.getDate() - 1)
  return new Date(date)
}

/**
 * Returns all holidays falling within the next `daysAhead` days from now.
 * Handles year-rollover: if a fixed date has already passed this year,
 * it is calculated for next year instead.
 */
function getUpcomingHolidays(daysAhead = 45) {
  const now = new Date()
  const year = now.getFullYear()
  const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000)

  // Build raw list — floating holidays are computed fresh each run
  const candidates = [
    { key: 'new_year',      name: "New Year's Day",      date: new Date(year + 1, 0, 1) },
    { key: 'valentines',    name: "Valentine's Day",     date: new Date(year, 1, 14) },
    { key: 'spring_break',  name: 'Spring Break',        date: new Date(year, 2, 15) }, // approximate mid-March
    { key: 'spring',        name: 'Spring Season',       date: new Date(year, 2, 20) }, // spring equinox
    { key: 'mothers_day',   name: "Mother's Day",        date: getNthDayOfMonth(year, 4, 0, 2) },  // 2nd Sun May
    { key: 'memorial_day',  name: 'Memorial Day Weekend', date: getLastDayOfMonth(year, 4, 1) },    // last Mon May
    { key: 'fathers_day',   name: "Father's Day",        date: getNthDayOfMonth(year, 5, 0, 3) },  // 3rd Sun June
    { key: 'july4',         name: '4th of July',         date: new Date(year, 6, 4) },
    { key: 'back_to_school', name: 'Back to School',     date: new Date(year, 7, 20) },
    { key: 'labor_day',     name: 'Labor Day Weekend',   date: getNthDayOfMonth(year, 8, 1, 1) },  // 1st Mon Sep
    { key: 'halloween',     name: 'Halloween',           date: new Date(year, 9, 31) },
    { key: 'thanksgiving',  name: 'Thanksgiving',        date: getNthDayOfMonth(year, 10, 4, 4) }, // 4th Thu Nov
    { key: 'christmas',     name: 'Christmas',           date: new Date(year, 11, 25) },
  ]

  const upcoming = []
  for (const h of candidates) {
    if (!h.date) continue // getNthDayOfMonth can return null in edge cases
    let d = new Date(h.date)
    // If the date already passed this year, roll to next year for fixed holidays
    if (d < now) {
      // Floating holidays recalculate naturally with year; fixed ones need a bump
      const fixed = ['valentines', 'spring_break', 'spring', 'july4', 'back_to_school', 'halloween', 'christmas']
      if (fixed.includes(h.key)) {
        d = new Date(year + 1, d.getMonth(), d.getDate())
      } else {
        continue // floating holiday already passed — skip, next run will catch next year's
      }
    }
    if (d >= now && d <= cutoff) {
      const leadDays = LEAD_DAYS[h.key] || 14
      upcoming.push({ ...h, date: d, leadDays })
    }
  }

  return upcoming
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

async function run(clients = []) {
  console.log(`[${AGENT_ID.toUpperCase()}] Starting run — ${clients.length} clients`)
  const reports = []

  for (const client of clients) {
    try {
      const result = await processClient(client)
      if (result) reports.push(result)
    } catch (err) {
      console.error(`[${AGENT_ID}] Error for client ${client.id}:`, err.message)
    }
  }

  const specialistReport = await report(reports)
  await fileInteraction(specialistReport, {
    workerId: AGENT_ID,
    interactionType: 'specialist_run',
  }).catch(() => {})
  // Store offer structure (campaign launch state) per client into shared vault
  for (const r of reports) {
    if (r.clientId) {
      await vault.store(r.clientId, vault.KEYS.OFFER_STRUCTURE, {
        campaignLaunched: r.status === 'action_taken',
        summary: r.summary || 'campaign cycle complete',
        timestamp: Date.now(),
      }, 7, AGENT_ID).catch(() => {})
    }
  }
  return specialistReport
}

async function processClient(client) {
  const supabase = getSupabase()
  const now = new Date()
  const actionsTaken = []
  const campaignsSent = []

  const ctx = buildClientContext(client)

  // Pull upcoming holidays then filter to only those relevant for this vertical
  const upcomingHolidays = getUpcomingHolidays(45)
  const relevantHolidays = upcomingHolidays.filter(h => isHolidayRelevant(ctx.vertical, h.key))

  if (relevantHolidays.length === 0) {
    console.log(`[${AGENT_ID}] no relevant holidays for ${client.business_name} (${ctx.vertical}), skipping`)
    return null
  }

  for (const event of relevantHolidays) {
    const daysUntil = Math.floor((event.date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    if (daysUntil > event.leadDays || daysUntil < 0) continue

    // Check if we already started this campaign for this client this year
    const { data: campaignState } = await supabase
      .from('agent_state')
      .select('state')
      .eq('agent', 'campaign_conductor')
      .eq('client_id', client.id)
      .eq('entity_id', `campaign:${event.key}:${now.getFullYear()}`)
      .single()

    if (campaignState?.state?.briefSent) continue

    const ownerPhone = client.owner_cell
    if (!ownerPhone) continue

    try {
      // Phase 1: Brief the client (7+ days out)
      if (daysUntil >= 7) {
        const draft = await generateCampaignBrief(client, event, daysUntil, ctx)
        if (!draft) continue

        // ── Offer validation gate ─────────────────────────────────────────
        // Extract the offer concept from the draft brief for validation.
        // validateAndImprove will rewrite once if the offer scores below 6.
        const { finalOffer, validation, rewrote } = await validateAndImprove({
          bizName:   client.business_name,
          industry:  client.industry || ctx.vertical || 'business',
          offerText: draft,
          city:      client.city || client.location || '',
        })

        if (!validation.approved) {
          console.warn(`[${AGENT_ID}] Offer validation failed after rewrite for ${event.key} (score: ${validation.score}) — skipping campaign`)
          continue
        }

        if (rewrote) {
          console.log(`[${AGENT_ID}] Offer rewritten for ${event.key} — validation score: ${validation.score}`)
        }

        const brief = finalOffer

        const gateResult = validateSMS(brief, { businessName: client.business_name })
        if (!gateResult.valid) {
          console.warn(`[${AGENT_ID}] message-gate blocked campaign brief SMS: ${gateResult.issues.join('; ')}`)
          continue
        }

        await sendSMS({
          from: client.twilio_number || process.env.TWILIO_PHONE_NUMBER,
          to: ownerPhone,
          body: brief,
          clientApiKeys: {},
          clientSlug: client.email,
          clientTimezone: 'America/Chicago',
        })

        await supabase.from('agent_state').upsert({
          agent: 'campaign_conductor',
          client_id: client.id,
          entity_id: `campaign:${event.key}:${now.getFullYear()}`,
          state: {
            briefSent:        true,
            briefSentAt:      new Date().toISOString(),
            event:            event.name,
            daysOut:          daysUntil,
            offerScore:       validation.score,
            offerRewrote:     rewrote,
          },
          updated_at: new Date().toISOString(),
        }, { onConflict: 'agent,client_id,entity_id' })

        actionsTaken.push(`${event.name} campaign brief sent (${daysUntil} days out, offer score: ${validation.score})`)
        campaignsSent.push({ event: event.name, brief, offerScore: validation.score })
      }
    } catch (err) {
      console.error(`[${AGENT_ID}] Campaign brief failed for ${event.key}:`, err.message)
    }
  }

  if (!actionsTaken.length) return null

  // ── Compound learning: log campaign dispatch to memory ────────────────────
  if (campaignsSent.length > 0) {
    await logCampaignResult({
      clientId:     client.id,
      campaignType: 'seasonal_campaign',
      content:      campaignsSent.map(c => `${c.event}: ${c.brief}`).join(' | '),
      outcome:      { sent: campaignsSent.length, responded: 0, booked: 0, revenue: 0 },
      industry:     client.industry || ctx.vertical || 'business',
      bizName:      client.business_name,
      agentSource:  AGENT_ID,
    }).catch(() => {})
  }

  return {
    agentId: AGENT_ID,
    clientId: client.id,
    timestamp: Date.now(),
    status: 'action_taken',
    summary: `Campaign briefs for ${client.business_name}: ${actionsTaken.join('; ')}`,
    data: { campaigns: actionsTaken },
    requiresDirectorAttention: false,
  }
}

async function generateCampaignBrief(client, event, daysUntil, ctx) {
  const systemPrompt = `<role>Campaign Conductor for GRIDHAND AI — brief small business clients on targeted campaign opportunities via SMS.</role>
${ctx.xml}

<campaign>
Upcoming event: ${event.name}
Days until: ${daysUntil}
</campaign>

<task>
Brief the business owner on a campaign opportunity for ${event.name}.
Suggest 1 specific, actionable campaign idea that fits their industry and vertical (${ctx.vertical}).
Ask if they want GRIDHAND to run it.
</task>

<rules>
- 3-4 sentences max
- Specific to their industry — not generic holiday copy
- End with a yes/no question for approval
- Sign off as GRIDHAND
- Output ONLY the SMS text
</rules>`

  return aiClient.call({
    modelString: 'groq/llama-3.3-70b-versatile',
    clientApiKeys: {},
    systemPrompt,
    messages: [{ role: 'user', content: 'Write the campaign brief.' }],
    maxTokens: 180,
    _workerName: AGENT_ID,
  })
}

async function report(outcomes) {
  const summary = {
    agentId: AGENT_ID,
    division: DIVISION,
    reportsTo: REPORTS_TO,
    timestamp: Date.now(),
    totalClients: outcomes.length,
    actionsCount: outcomes.filter(o => o.status === 'action_taken').length,
    escalations: outcomes.filter(o => o.requiresDirectorAttention),
    outcomes,
  }
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} campaign briefs sent`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
