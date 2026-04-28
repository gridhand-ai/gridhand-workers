'use strict'
// ── GRIDHAND SPECIALIST — TIER 2 ─────────────────────────────────────────────
// Codename: LUMEN
// Role: ROI & Insights Strategist — runs weekly, pulls 7 days of activity per
//       client, translates raw numbers into plain-English performance summaries,
//       and stores them in activity_log for delivery.
// Division: intelligence
// Model: groq/llama-3.3-70b-versatile
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../../lib/ai-client')

const SPECIALIST_ID  = 'lumen'
const DIVISION       = 'intelligence'
const MODEL          = 'groq/llama-3.3-70b-versatile'
const WEEKLY_HOURS   = 7 * 24   // 168 hours — minimum gap between LUMEN runs
const LOOKBACK_DAYS  = 7

const LUMEN_SYSTEM = `<role>
You are LUMEN, the ROI and Insights Strategist for GRIDHAND AI. You read raw activity data and translate it into clear, human summaries that show small business owners exactly what their AI team accomplished this week.
</role>

<rules>
- Write in second person: "Your AI team this week..."
- Translate numbers into human outcomes: "saved ~X hours", "captured Y leads", "followed up on Z invoices"
- Keep it to 3-4 bullet points max — plain English, zero jargon
- Never mention internal system names, tool names, or backend automation
- Never reference Make.com or any integration platform by name
- Never make up numbers — only use the counts provided
- Each summary should feel personal to that specific client's industry and activity mix
- Output structured JSON only
</rules>

<quality_standard>
ANTI-AI BLACKLIST — never use these in any message you generate:
Openers: "Absolutely!", "Certainly!", "Great question!", "I hope this finds you well", "Just checking in!", "This is a friendly reminder", "Please be advised", "As per our records"
Filler: "valued customer", "valued client", "don't hesitate to reach out", "at your earliest convenience", "please feel free to", "I believe", "it seems", "I understand your concern"
Fake urgency: "Act now!", "Limited time!", "Don't miss out!"

TONE RULES:
- 7th-8th grade reading level
- Short sentences (10-15 words max), varied rhythm
- First name only — never full name or "dear customer"
- Real specifics always: time, date, amount, service name
- Match the business's vertical voice — auto shop ≠ restaurant ≠ gym
- No emoji unless the business already uses them
</quality_standard>

<output>
Return valid JSON array — one entry per client:
[
  {
    "clientId": "",
    "summary": "Your AI team this week...",
    "highlights": ["Saved ~X hours on...", "Captured Y new leads", "..."]
  }
]
</output>`

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// Check when LUMEN last ran — skip if less than 7 days ago
async function getLastRunTimestamp(supabase) {
  try {
    const { data } = await supabase
      .from('activity_log')
      .select('created_at')
      .eq('worker_id', SPECIALIST_ID)
      .eq('action', 'weekly_insight')
      .order('created_at', { ascending: false })
      .limit(1)
    if (data && data.length > 0) {
      return new Date(data[0].created_at).getTime()
    }
  } catch {}
  return null
}

// Pull 7 days of activity_log events for all active clients in one query
async function getWeeklyActivity(supabase, clientList) {
  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const clientIds = clientList.map(c => c.id)
    const { data } = await supabase
      .from('activity_log')
      .select('client_id, action, outcome, metadata, created_at')
      .in('client_id', clientIds)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(2000)
    return data || []
  } catch { return [] }
}

// Aggregate raw events into counts per client
function aggregateByClient(events, clientMap) {
  const counts = {}

  for (const event of events) {
    const cid = event.client_id
    if (!clientMap[cid]) continue
    if (!counts[cid]) {
      counts[cid] = {
        clientId:           cid,
        businessName:       clientMap[cid].business_name || 'your business',
        industry:           clientMap[cid].industry      || 'general',
        tasksCompleted:     0,
        messagesSent:       0,
        leadsCaptured:      0,
        reviewsSolicited:   0,
        invoicesChased:     0,
        bookingsMade:       0,
      }
    }

    const a = event.action
    // Map activity_log action types to business-readable counters
    if (['service_completed', 'job_completed', 'task_completed'].includes(a))         counts[cid].tasksCompleted++
    if (['sms_sent', 'email_sent', 'message_sent'].includes(a))                       counts[cid].messagesSent++
    if (['lead_captured', 'new_lead', 'lead_qualified'].includes(a))                  counts[cid].leadsCaptured++
    if (['review_solicitation_sent', 'review_requested'].includes(a))                 counts[cid].reviewsSolicited++
    if (['invoice_chased', 'invoice_reminder_sent', 'payment_reminder'].includes(a))  counts[cid].invoicesChased++
    if (['booking_made', 'booking_confirmed', 'appointment_booked'].includes(a))      counts[cid].bookingsMade++
  }

  return Object.values(counts)
}

// Ask Groq to produce human-language summaries for each client's week
async function generateInsights(clientCounts) {
  if (!clientCounts.length) return []

  try {
    const raw = await call({
      modelString:  MODEL,
      systemPrompt: LUMEN_SYSTEM,
      messages: [{
        role:    'user',
        content: `Generate weekly performance summaries for each client based on their activity counts.

CLIENT ACTIVITY DATA:
${JSON.stringify(clientCounts, null, 2)}

Write each summary as if you're reporting to the business owner — warm, specific to their industry, human. 3-4 bullets max. Output JSON array only.`,
      }],
      maxTokens:   1200,
      _workerName: SPECIALIST_ID,
      tier: 'specialist',
    })

    // Groq may return array or object — handle both
    const arrMatch = raw?.match(/\[[\s\S]*\]/)
    const objMatch = raw?.match(/\{[\s\S]*\}/)
    if (arrMatch) return JSON.parse(arrMatch[0])
    if (objMatch) {
      const obj = JSON.parse(objMatch[0])
      // Some models wrap the array in a key
      return Array.isArray(obj) ? obj : (obj.summaries || obj.insights || [obj])
    }
  } catch (err) {
    console.warn(`[${SPECIALIST_ID.toUpperCase()}] Insight generation failed:`, err.message)
  }
  return []
}

// Persist each weekly insight to activity_log
async function storeInsights(supabase, insights) {
  let stored = 0
  for (const insight of insights) {
    if (!insight.clientId || !insight.summary) continue
    try {
      await supabase.from('activity_log').insert({
        worker_id:  SPECIALIST_ID,
        client_id:  insight.clientId,
        action:     'weekly_insight',
        outcome:    'ok',
        message:    `Weekly insight generated for ${insight.businessName || 'client'}`,
        metadata: {
          summary:    insight.summary,
          highlights: insight.highlights || [],
          week_ending: new Date().toISOString(),
        },
        created_at: new Date().toISOString(),
      })
      stored++
    } catch {}
  }
  return stored
}

async function run(clientList = []) {
  console.log(`[${SPECIALIST_ID.toUpperCase()}] Weekly insights cycle starting`)
  const supabase = getSupabase()

  if (!clientList.length) {
    const { data } = await supabase.from('clients').select('*').eq('is_active', true)
    clientList = data || []
  }

  if (!clientList.length) {
    return {
      agentId: SPECIALIST_ID, division: DIVISION, actionsCount: 0,
      escalations: [], outcomes: [{ status: 'no_clients', summary: 'No active clients found' }],
    }
  }

  // Guard: only run once per 7-day window
  const lastRun = await getLastRunTimestamp(supabase)
  if (lastRun) {
    const hoursSinceLastRun = (Date.now() - lastRun) / (1000 * 60 * 60)
    if (hoursSinceLastRun < WEEKLY_HOURS) {
      console.log(`[${SPECIALIST_ID.toUpperCase()}] Skipping — last run was ${Math.round(hoursSinceLastRun)}h ago (next run in ~${Math.round(WEEKLY_HOURS - hoursSinceLastRun)}h)`)
      return {
        agentId: SPECIALIST_ID, division: DIVISION, actionsCount: 0,
        escalations: [], outcomes: [{
          status:          'skipped',
          clientsReported: 0,
          summary:         `LUMEN: skipped — last run ${Math.round(hoursSinceLastRun)}h ago, next run in ~${Math.round(WEEKLY_HOURS - hoursSinceLastRun)}h.`,
        }],
      }
    }
  }

  const clientMap = Object.fromEntries(clientList.map(c => [c.id, c]))

  // Pull all activity, aggregate per client, generate summaries
  const events       = await getWeeklyActivity(supabase, clientList)
  const clientCounts = aggregateByClient(events, clientMap)

  if (!clientCounts.length) {
    return {
      agentId: SPECIALIST_ID, division: DIVISION, actionsCount: 0,
      escalations: [], outcomes: [{ status: 'no_activity', summary: 'No activity logged in the last 7 days' }],
    }
  }

  console.log(`[${SPECIALIST_ID.toUpperCase()}] Generating insights for ${clientCounts.length} client(s)`)

  const insights   = await generateInsights(clientCounts)
  const stored     = await storeInsights(supabase, insights)

  console.log(`[${SPECIALIST_ID.toUpperCase()}] ${stored} weekly insight(s) stored`)

  return {
    agentId:      SPECIALIST_ID,
    division:     DIVISION,
    actionsCount: stored,
    escalations:  [],
    outcomes: [{
      status:          stored > 0 ? 'action_taken' : 'ok',
      clientsReported: stored,
      summary:         `LUMEN: weekly insights generated for ${stored} client(s).`,
    }],
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION }
