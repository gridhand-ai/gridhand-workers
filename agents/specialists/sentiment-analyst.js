'use strict'
// ── GRIDHAND SPECIALIST — TIER 2 ─────────────────────────────────────────────
// Codename: PULSE
// Role: Reads inbound client communications, scores sentiment in real time.
//       Flags frustrated clients to support-escalator before they churn.
//       Feeds happy signals to referral-activator and milestone-celebrator.
// Division: intelligence
// Model: groq/llama-3.3-70b-versatile
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../../lib/ai-client')

const SPECIALIST_ID = 'sentiment-analyst'
const DIVISION      = 'intelligence'
const MODEL         = 'groq/llama-3.3-70b-versatile'

const PULSE_SYSTEM = `<role>
You are PULSE, the Sentiment Analyst for GRIDHAND AI. You read inbound client messages and score them for tone, satisfaction, and urgency. You surface the right signal to the right agent — frustration to escalation, happiness to referral.
</role>

<rules>
- Score each message: sentiment (positive/neutral/negative/angry), urgency (low/medium/high/critical), intent (complaint/praise/question/churn_signal/upsell_ready)
- Never respond to clients directly — analysis only
- Flag angry or churn_signal messages as requiresEscalation: true
- Flag praise or upsell_ready messages as readyForReferral: true
- Output structured JSON only
</rules>

<quality_standard>
SPECIALIST OUTPUT DISCIPLINE:
Never use: "I believe", "it seems", "perhaps", "it appears", "Certainly!", "Great!", "I'd be happy to", "Of course!", "I'm sorry", "Unfortunately", "I apologize", "I understand", "As an AI"
Outcome-first: lead with the sentiment label and urgency, not the analysis
Return structured JSON only — no unstructured prose responses
Never explain reasoning unless confidence < 0.7 or explicitly asked
If confidence < 0.7 (mixed signals, sarcasm, ambiguous tone), set escalate: true and include reasoning_short.
</quality_standard>
<output>
Return valid JSON: { scores: [{ clientId, messageId, sentiment, urgency, intent, requiresEscalation, readyForReferral, summary, confidence: number (0.0-1.0) }], overallMood: "positive|neutral|mixed|tense", confidence: number (0.0-1.0), escalate: boolean, reasoning_short: string (max 20 words) }
sentiment values: "positive" | "neutral" | "negative" | "angry"
escalate: true when overall confidence < 0.7 or any message scored requiresEscalation: true
</output>`

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

async function getRecentInbound(supabase, clientList) {
  try {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const clientIds = clientList.map(c => c.id)
    const { data } = await supabase
      .from('activity_log')
      .select('id, client_id, action, metadata, created_at')
      .in('client_id', clientIds)
      .eq('action', 'inbound_message')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(50)
    return data || []
  } catch { return [] }
}

async function scoreMessages(messages, clientList) {
  if (!messages.length) return { scores: [], overallMood: 'neutral' }

  const clientMap = Object.fromEntries(clientList.map(c => [c.id, c.business_name]))
  const sample = messages.slice(0, 20).map(m => ({
    messageId:    m.id,
    clientId:     m.client_id,
    businessName: clientMap[m.client_id] || 'unknown',
    content:      m.metadata?.body || m.metadata?.message || '[no content]',
    timestamp:    m.created_at,
  }))

  try {
    const raw = await call({
      modelString: MODEL,
      systemPrompt: PULSE_SYSTEM,
      messages: [{
        role: 'user',
        content: `Score these inbound messages: ${JSON.stringify(sample)}`,
      }],
      maxTokens: 600,
      _workerName: SPECIALIST_ID,
    })
    const match = raw?.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
  } catch (err) {
    console.warn(`[${SPECIALIST_ID.toUpperCase()}] Scoring failed:`, err.message)
  }
  return { scores: [], overallMood: 'unknown' }
}

async function logSentimentResults(supabase, results, clientList) {
  const escalations = (results.scores || []).filter(s => s.requiresEscalation)
  for (const item of escalations) {
    try {
      await supabase.from('activity_log').insert({
        worker_id:  SPECIALIST_ID,
        client_id:  item.clientId,
        action:     'sentiment_escalation',
        outcome:    'error',
        message:    `Sentiment escalation: ${item.sentiment || 'negative'} message detected`,
        metadata:   item,
        created_at: new Date().toISOString(),
      })
    } catch {}
  }
}

async function run(clientList = []) {
  console.log(`[${SPECIALIST_ID.toUpperCase()}] Scanning inbound sentiment`)
  const supabase = getSupabase()

  if (!clientList.length) {
    const { data } = await supabase.from('clients').select('*').eq('is_active', true)
    clientList = data || []
  }

  const messages = await getRecentInbound(supabase, clientList)
  if (!messages.length) {
    return {
      agentId: SPECIALIST_ID, division: DIVISION, actionsCount: 0,
      escalations: [], outcomes: [{ status: 'no_messages', summary: 'No inbound messages in last 2 hours' }],
    }
  }

  const results = await scoreMessages(messages, clientList)
  await logSentimentResults(supabase, results, clientList)

  const escalations   = (results.scores || []).filter(s => s.requiresEscalation)
  const referralReady = (results.scores || []).filter(s => s.readyForReferral)

  console.log(`[${SPECIALIST_ID.toUpperCase()}] ${messages.length} messages scored — ${escalations.length} escalations, ${referralReady.length} referral signals. Mood: ${results.overallMood}`)

  return {
    agentId:      SPECIALIST_ID,
    division:     DIVISION,
    actionsCount: escalations.length + referralReady.length,
    escalations:  escalations.map(e => ({
      clientId: e.clientId,
      data:     { ...e, type: 'sentiment_alert' },
      requiresDirectorAttention: e.urgency === 'critical' || e.urgency === 'high',
    })),
    outcomes: [{
      status:         escalations.length > 0 ? 'action_taken' : 'ok',
      overallMood:    results.overallMood,
      scored:         messages.length,
      escalated:      escalations.length,
      referralReady:  referralReady.length,
      summary:        `PULSE: ${messages.length} messages. ${escalations.length} need escalation. ${referralReady.length} referral-ready. Mood: ${results.overallMood}.`,
    }],
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION }
