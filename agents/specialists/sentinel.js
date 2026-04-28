'use strict'
// ── GRIDHAND SPECIALIST — TIER 2 ─────────────────────────────────────────────
// Codename: SENTINEL
// Role: Compliance & Quality Auditor — reads recent outbound messages and scores
//       them for TCPA risk, PII exposure, and brand voice alignment.
//       Pure auditor — never sends anything, only reads and flags.
// Division: intelligence
// Model: groq/llama-3.3-70b-versatile
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../../lib/ai-client')

const SPECIALIST_ID = 'sentinel'
const DIVISION      = 'intelligence'
const MODEL         = 'groq/llama-3.3-70b-versatile'

// Risk threshold — messages scoring 'high' on TCPA or with PII exposure are flagged
const HIGH_RISK_ACTIONS = ['high']

const SENTINEL_SYSTEM = `<role>
You are SENTINEL, the Compliance and Quality Auditor for GRIDHAND AI. You read outbound messages and score them for regulatory risk, privacy exposure, and brand voice alignment. You are the last line of defense before messages reach people.
</role>

<rules>
- Score each message on three dimensions: tcpaRisk, piiExposure, brandVoice
- tcpaRisk: "low" | "medium" | "high" — high means message could violate TCPA (solicitation during quiet hours claim, missing opt-out, unclear consent, promotional without disclosure)
- piiExposure: true | false — true if the message body contains a full name + phone/email/address combination, SSN, account numbers, or financial data
- brandVoice: "on" | "off" — off if the message is robotic, uses jargon, sounds automated, or contradicts a professional service business tone
- Set requiresReview: true if tcpaRisk is "high" OR piiExposure is true
- Include a brief reason field explaining any flag — one sentence max
- Output structured JSON only — no other text
- GRIDHAND serves SMB verticals only: auto repair, barbershops, salons, restaurants, gyms, retail, real estate, home services, cleaning, pest control
</rules>

<output>
Return valid JSON:
{
  "audits": [
    {
      "messageId": "",
      "clientId": "",
      "tcpaRisk": "low|medium|high",
      "piiExposure": false,
      "brandVoice": "on|off",
      "requiresReview": false,
      "reason": ""
    }
  ],
  "violationCount": 0
}
</output>`

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// Read the last 50 outbound messages from the past 6 hours
async function getRecentOutbound(supabase, clientList) {
  try {
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
    const clientIds = clientList.map(c => c.id)
    const { data } = await supabase
      .from('activity_log')
      .select('id, client_id, action, metadata, created_at')
      .in('client_id', clientIds)
      .in('action', ['sms_sent', 'email_sent'])
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(50)
    return data || []
  } catch { return [] }
}

// Submit messages to Groq for compliance scoring
async function auditMessages(messages, clientMap) {
  if (!messages.length) return { audits: [], violationCount: 0 }

  const sample = messages.map(m => ({
    messageId:    m.id,
    clientId:     m.client_id,
    businessName: clientMap[m.client_id]?.business_name || 'unknown',
    channel:      m.action,   // 'sms_sent' or 'email_sent'
    body:         m.metadata?.body || m.metadata?.message || m.metadata?.text || '[no content]',
    sentAt:       m.created_at,
  }))

  try {
    const raw = await call({
      modelString:  MODEL,
      systemPrompt: SENTINEL_SYSTEM,
      messages: [{
        role:    'user',
        content: `Audit these outbound messages for compliance and quality:

${JSON.stringify(sample)}

Score each message. Output JSON only.`,
      }],
      maxTokens:   1000,
      _workerName: SPECIALIST_ID,
      tier: 'specialist',
    })
    const match = raw?.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
  } catch (err) {
    console.warn(`[${SPECIALIST_ID.toUpperCase()}] Audit call failed:`, err.message)
  }
  return { audits: [], violationCount: 0 }
}

// Log each compliance violation to activity_log
async function logViolations(supabase, audits) {
  const violations = (audits || []).filter(a => a.requiresReview)
  for (const v of violations) {
    try {
      await supabase.from('activity_log').insert({
        worker_id:  SPECIALIST_ID,
        client_id:  v.clientId,
        action:     'compliance_violation',
        outcome:    'error',
        message:    `Compliance violation: ${v.reason || 'tcpa_risk'}`,
        metadata: {
          messageId:  v.messageId,
          tcpaRisk:   v.tcpaRisk,
          piiExposure: v.piiExposure,
          brandVoice: v.brandVoice,
          reason:     v.reason,
        },
        created_at: new Date().toISOString(),
      })
    } catch {}
  }
  return violations
}

async function run(clientList = []) {
  console.log(`[${SPECIALIST_ID.toUpperCase()}] Compliance audit cycle starting`)
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
  const messages  = await getRecentOutbound(supabase, clientList)

  if (!messages.length) {
    return {
      agentId: SPECIALIST_ID, division: DIVISION, actionsCount: 0,
      escalations: [], outcomes: [{ status: 'no_messages', summary: 'No outbound messages in last 6 hours' }],
    }
  }

  console.log(`[${SPECIALIST_ID.toUpperCase()}] Auditing ${messages.length} outbound message(s)`)

  const result     = await auditMessages(messages, clientMap)
  const violations = await logViolations(supabase, result.audits)

  const violationCount = violations.length
  const auditedCount   = (result.audits || []).length

  console.log(`[${SPECIALIST_ID.toUpperCase()}] ${auditedCount} message(s) audited — ${violationCount} violation(s) flagged`)

  return {
    agentId:      SPECIALIST_ID,
    division:     DIVISION,
    actionsCount: violationCount,
    escalations:  violations.map(v => ({
      clientId: v.clientId,
      data:     { ...v, type: 'compliance_violation' },
      requiresDirectorAttention: v.tcpaRisk === 'high' || v.piiExposure === true,
    })),
    outcomes: [{
      status:     violationCount > 0 ? 'action_taken' : 'ok',
      audited:    auditedCount,
      violations: violationCount,
      summary:    `SENTINEL: ${auditedCount} message(s) audited, ${violationCount} compliance violation(s) flagged.`,
    }],
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION }
