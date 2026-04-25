'use strict'
// ── GRIDHAND SPECIALIST — TIER 2 ─────────────────────────────────────────────
// Codename: VANGUARD
// Role: Reputation Specialist — solicits reviews after completed jobs, drafts
//       review responses, and flags clients with negative review patterns.
// Division: intelligence
// Model: groq/llama-3.3-70b-versatile
// ─────────────────────────────────────────────────────────────────────────────

const { createClient }  = require('@supabase/supabase-js')
const { call }          = require('../../lib/ai-client')
const { sendSMS }       = require('../../lib/twilio-client')
const { validateSMS }   = require('../../lib/message-gate')

const SPECIALIST_ID = 'vanguard'
const DIVISION      = 'intelligence'
const MODEL         = 'groq/llama-3.3-70b-versatile'

const VANGUARD_SYSTEM = `<role>
You are VANGUARD, the Reputation Specialist for GRIDHAND AI. You help small businesses protect and grow their online reputation by turning great service into genuine reviews and responding to existing feedback with care.
</role>

<rules>
- Write review solicitation SMS in a warm, authentic, conversational tone — never robotic or templated
- Draft review responses that are specific to what the reviewer said — never generic
- Flag negative review patterns as reputation risks that need attention
- Never mention internal system names, automation tools, or back-end processes
- Output structured JSON only
- Keep solicitation SMS under 160 characters when possible
- Never include URLs unless explicitly provided in allowedFacts
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
Return valid JSON:
{
  "solicitations": [{ "clientId": "", "customerId": "", "customerPhone": "", "businessName": "", "message": "" }],
  "responses": [{ "reviewId": "", "clientId": "", "rating": 0, "draft": "" }],
  "reputationAlerts": [{ "clientId": "", "reason": "" }]
}
</output>`

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// Pull completed jobs from the last 24 hours — these are candidates for review solicitation
async function getCompletedJobs(supabase, clientList) {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const clientIds = clientList.map(c => c.id)
    const { data } = await supabase
      .from('activity_log')
      .select('id, client_id, action, metadata, created_at')
      .in('client_id', clientIds)
      .in('action', ['service_completed', 'job_completed'])
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(50)
    return data || []
  } catch { return [] }
}

// Pull recent reviews that need a response (no response drafted yet)
async function getPendingReviews(supabase, clientList) {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const clientIds = clientList.map(c => c.id)
    const { data } = await supabase
      .from('activity_log')
      .select('id, client_id, action, metadata, created_at')
      .in('client_id', clientIds)
      .eq('action', 'review_received')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(30)
    return data || []
  } catch { return [] }
}

// Count negative reviews per client in the last 30 days to detect reputation risk patterns
async function getNegativeReviewCounts(supabase, clientList) {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const clientIds = clientList.map(c => c.id)
    const { data } = await supabase
      .from('activity_log')
      .select('client_id, metadata')
      .in('client_id', clientIds)
      .eq('action', 'review_received')
      .gte('created_at', since)
    return data || []
  } catch { return [] }
}

// Ask Groq to generate solicitations, response drafts, and reputation alerts in one pass
async function generateReputationActions(completedJobs, pendingReviews, clientMap) {
  if (!completedJobs.length && !pendingReviews.length) {
    return { solicitations: [], responses: [], reputationAlerts: [] }
  }

  const jobSample = completedJobs.slice(0, 15).map(j => ({
    jobId:        j.id,
    clientId:     j.client_id,
    businessName: clientMap[j.client_id]?.business_name || 'the business',
    customerName: j.metadata?.customer_name || 'there',
    customerPhone: j.metadata?.customer_phone || null,
    serviceType:  j.metadata?.service_type   || 'service',
    completedAt:  j.created_at,
  }))

  const reviewSample = pendingReviews.slice(0, 10).map(r => ({
    reviewId:     r.id,
    clientId:     r.client_id,
    businessName: clientMap[r.client_id]?.business_name || 'the business',
    rating:       r.metadata?.rating      || null,
    text:         r.metadata?.review_text || '[no text provided]',
    platform:     r.metadata?.platform    || 'unknown',
  }))

  try {
    const raw = await call({
      modelString:  MODEL,
      systemPrompt: VANGUARD_SYSTEM,
      messages: [{
        role:    'user',
        content: `Generate review solicitations for completed jobs and response drafts for pending reviews.

COMPLETED JOBS (solicit reviews):
${JSON.stringify(jobSample)}

PENDING REVIEWS (draft responses):
${JSON.stringify(reviewSample)}

Rules:
- Only generate a solicitation if customerPhone is present
- Make each solicitation warm and specific to the service performed
- Make each response specific to what the reviewer actually wrote
- Output JSON only`,
      }],
      maxTokens:   1200,
      _workerName: SPECIALIST_ID,
    })
    const match = raw?.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
  } catch (err) {
    console.warn(`[${SPECIALIST_ID.toUpperCase()}] AI generation failed:`, err.message)
  }
  return { solicitations: [], responses: [], reputationAlerts: [] }
}

// Send solicitation SMS through the TCPA-compliant pipeline
async function sendSolicitations(supabase, solicitations, clientMap) {
  let sent = 0
  for (const sol of solicitations) {
    if (!sol.customerPhone || !sol.message) continue
    const client = clientMap[sol.clientId]
    if (!client) continue

    try {
      const gateResult = validateSMS(sol.message, { businessName: client.business_name })
      if (!gateResult.valid) {
        console.warn(`[${SPECIALIST_ID.toUpperCase()}] message-gate blocked solicitation: ${(gateResult.issues || []).join('; ')}`)
        continue
      }

      await sendSMS({
        from:           client.twilio_number || process.env.TWILIO_PHONE_NUMBER,
        to:             sol.customerPhone,
        body:           gateResult.sanitized || sol.message,
        clientApiKeys:  {},
        clientSlug:     client.email || client.slug,
        clientTimezone: client.timezone || 'America/Chicago',
      })

      await supabase.from('activity_log').insert({
        worker_id:  SPECIALIST_ID,
        client_id:  sol.clientId,
        action:     'review_solicitation_sent',
        outcome:    'ok',
        message:    `Review solicitation sent to ${sol.customerPhone || 'customer'}`,
        metadata:   { customerId: sol.customerId, customerPhone: sol.customerPhone, message: sol.message },
        created_at: new Date().toISOString(),
      })
      sent++
    } catch (err) {
      console.error(`[${SPECIALIST_ID.toUpperCase()}] SMS send failed for client ${sol.clientId}:`, err.message)
    }
  }
  return sent
}

// Log response drafts to activity_log for human review / director pickup
async function logResponseDrafts(supabase, responses) {
  let logged = 0
  for (const resp of responses) {
    if (!resp.draft) continue
    try {
      await supabase.from('activity_log').insert({
        worker_id:  SPECIALIST_ID,
        client_id:  resp.clientId,
        action:     'review_response_drafted',
        outcome:    'ok',
        message:    `Review response drafted for rating: ${resp.rating ?? 'unknown'}`,
        metadata:   { reviewId: resp.reviewId, rating: resp.rating, draft: resp.draft },
        created_at: new Date().toISOString(),
      })
      logged++
    } catch {}
  }
  return logged
}

// Log reputation alerts for clients with 3+ negative reviews in 30 days
async function detectAndLogReputationAlerts(supabase, clientList, allRecentReviews, aiAlerts) {
  const negativeByClient = {}
  for (const row of allRecentReviews) {
    const rating = row.metadata?.rating
    if (rating && rating <= 2) {
      negativeByClient[row.client_id] = (negativeByClient[row.client_id] || 0) + 1
    }
  }

  const alerts = []
  for (const [clientId, count] of Object.entries(negativeByClient)) {
    if (count >= 3) {
      alerts.push({ clientId, reason: `${count} negative reviews (≤2 stars) in the last 30 days` })
    }
  }

  // Merge AI-generated alerts (deduplicate by clientId)
  const seenIds = new Set(alerts.map(a => a.clientId))
  for (const alert of (aiAlerts || [])) {
    if (alert.clientId && !seenIds.has(alert.clientId)) {
      alerts.push(alert)
      seenIds.add(alert.clientId)
    }
  }

  for (const alert of alerts) {
    try {
      await supabase.from('activity_log').insert({
        worker_id:  SPECIALIST_ID,
        client_id:  alert.clientId,
        action:     'reputation_alert',
        outcome:    'error',
        message:    `Reputation alert flagged: ${alert.reason || 'negative review spike'}`,
        metadata:   { reason: alert.reason, requiresAttention: true },
        created_at: new Date().toISOString(),
      })
    } catch {}
  }
  return alerts
}

async function run(clientList = []) {
  console.log(`[${SPECIALIST_ID.toUpperCase()}] Reputation cycle starting`)
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

  const clientMap = Object.fromEntries(clientList.map(c => [c.id, c]))

  // Gather all inputs in parallel
  const [completedJobs, pendingReviews, allRecentReviews] = await Promise.all([
    getCompletedJobs(supabase, clientList),
    getPendingReviews(supabase, clientList),
    getNegativeReviewCounts(supabase, clientList),
  ])

  console.log(`[${SPECIALIST_ID.toUpperCase()}] ${completedJobs.length} completed jobs, ${pendingReviews.length} pending reviews`)

  // Generate all AI actions in one Groq call
  const actions = await generateReputationActions(completedJobs, pendingReviews, clientMap)

  // Execute: send solicitations, log drafts, log alerts
  const [sentCount, draftedCount, alerts] = await Promise.all([
    sendSolicitations(supabase, actions.solicitations || [], clientMap),
    logResponseDrafts(supabase, actions.responses || []),
    detectAndLogReputationAlerts(supabase, clientList, allRecentReviews, actions.reputationAlerts || []),
  ])

  const actionsCount = sentCount + draftedCount + alerts.length

  console.log(`[${SPECIALIST_ID.toUpperCase()}] Complete — ${sentCount} solicitations sent, ${draftedCount} response drafts logged, ${alerts.length} reputation alert(s)`)

  return {
    agentId:      SPECIALIST_ID,
    division:     DIVISION,
    actionsCount,
    escalations:  alerts.map(a => ({
      clientId: a.clientId,
      data:     { ...a, type: 'reputation_alert' },
      requiresDirectorAttention: true,
    })),
    outcomes: [{
      status:    actionsCount > 0 ? 'action_taken' : 'ok',
      solicited: sentCount,
      responded: draftedCount,
      alerts:    alerts.length,
      summary:   `VANGUARD: ${sentCount} review solicitation(s) sent, ${draftedCount} response draft(s) logged, ${alerts.length} reputation alert(s) flagged.`,
    }],
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION }
