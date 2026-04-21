'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// CampaignConductor — Seasonal campaigns: detects upcoming events, briefs client, launches sequence
// Division: brand
// Reports to: brand-director
// Runs: on-demand (called by BrandDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient = require('../../lib/ai-client')
const { sendSMS } = require('../../lib/twilio-client')
const { validateSMS } = require('../../lib/message-gate')

const AGENT_ID  = 'campaign-conductor'
const DIVISION  = 'brand'
const REPORTS_TO = 'brand-director'

// Upcoming holidays/events with campaign lead time (days before)
const CAMPAIGN_CALENDAR = [
  { key: 'valentines',   name: "Valentine's Day",    month: 2,  day: 14,  leadDays: 14 },
  { key: 'mothers_day',  name: "Mother's Day",        month: 5,  day: 11,  leadDays: 14 }, // 2nd Sunday May
  { key: 'memorial_day', name: 'Memorial Day Weekend', month: 5,  day: 26,  leadDays: 10 },
  { key: 'fathers_day',  name: "Father's Day",         month: 6,  day: 15,  leadDays: 14 }, // 3rd Sunday June
  { key: 'july4',        name: '4th of July',           month: 7,  day: 4,   leadDays: 10 },
  { key: 'labor_day',    name: 'Labor Day Weekend',     month: 9,  day: 1,   leadDays: 10 },
  { key: 'halloween',    name: 'Halloween',             month: 10, day: 31,  leadDays: 14 },
  { key: 'thanksgiving', name: 'Thanksgiving',          month: 11, day: 27,  leadDays: 14 },
  { key: 'christmas',    name: 'Christmas',             month: 12, day: 25,  leadDays: 21 },
  { key: 'new_year',     name: "New Year's",            month: 1,  day: 1,   leadDays: 14 },
  { key: 'back_to_school', name: 'Back to School',      month: 8,  day: 20,  leadDays: 14 },
  { key: 'spring',       name: 'Spring Season',         month: 3,  day: 20,  leadDays: 14 },
]

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

  return report(reports)
}

async function processClient(client) {
  const supabase = getSupabase()
  const now = new Date()
  const actionsTaken = []

  for (const event of CAMPAIGN_CALENDAR) {
    const eventDate = new Date(now.getFullYear(), event.month - 1, event.day)
    // Handle events that might be next year
    if (eventDate < now) eventDate.setFullYear(now.getFullYear() + 1)

    const daysUntil = Math.floor((eventDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    if (daysUntil > event.leadDays || daysUntil < 0) continue

    // Check if we already started this campaign for this client
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
      // Phase 1: Brief the client (14+ days out)
      if (daysUntil >= 7) {
        const brief = await generateCampaignBrief(client, event, daysUntil)
        if (!brief) continue

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
          state: { briefSent: true, briefSentAt: new Date().toISOString(), event: event.name, daysOut: daysUntil },
          updated_at: new Date().toISOString(),
        }, { onConflict: 'agent,client_id,entity_id' })

        actionsTaken.push(`${event.name} campaign brief sent (${daysUntil} days out)`)
      }
    } catch (err) {
      console.error(`[${AGENT_ID}] Campaign brief failed for ${event.key}:`, err.message)
    }
  }

  if (!actionsTaken.length) return null

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

async function generateCampaignBrief(client, event, daysUntil) {
  const systemPrompt = `<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<campaign>
Upcoming event: ${event.name}
Days until: ${daysUntil}
</campaign>

<task>
Brief the business owner on a campaign opportunity for ${event.name}.
Suggest 1 specific, actionable campaign idea that fits their industry.
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
