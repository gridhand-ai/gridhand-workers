'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// ConvCloser — Conversation Closer
// Closes open leads after 48h of no response with a final check-in SMS.
// Division: acquisition
// Reports to: acquisition-director
// Runs: on-demand (called by AcquisitionDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../../lib/ai-client')
const { validateSMS }  = require('../../lib/message-gate')
const { sendSMS }      = require('../../lib/twilio-client')

const SPECIALIST_ID = 'conv-closer'
const DIVISION      = 'acquisition'
const REPORTS_TO    = 'acquisition-director'
const GROQ_MODEL    = 'groq/llama-3.3-70b-versatile'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

async function run(clients = []) {
  console.log(`[${SPECIALIST_ID.toUpperCase()}] Starting run — ${clients.length} client(s)`)
  const supabase = getSupabase()
  const reports  = []

  for (const client of clients) {
    try {
      const result = await processClient(client, supabase)
      if (result) reports.push(result)
    } catch (err) {
      console.error(`[${SPECIALIST_ID}] Error for client ${client.id}:`, err.message)
    }
  }

  return buildReport(reports)
}

async function processClient(client, supabase) {
  // Find leads with status = 'contacted' and updated_at > 48 hours ago
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

  const { data: staleLeads, error } = await supabase
    .from('leads')
    .select('id, name, phone, status, updated_at')
    .eq('client_id', client.id)
    .eq('status', 'contacted')
    .lt('updated_at', cutoff)
    .limit(10)

  if (error) {
    console.warn(`[${SPECIALIST_ID}] leads query failed for ${client.id}: ${error.message}`)
    return null
  }

  if (!staleLeads || !staleLeads.length) {
    return null
  }

  console.log(`[${SPECIALIST_ID}] ${staleLeads.length} stale lead(s) for ${client.business_name || client.id}`)

  const followUpsSent = []

  for (const lead of staleLeads) {
    if (!lead.phone) continue

    // Generate a 1-sentence follow-up SMS via Groq
    let smsText = null
    try {
      smsText = await call({
        modelString: GROQ_MODEL,
        systemPrompt: `<role>GRIDHAND follow-up specialist for ${client.business_name || 'a local business'}.</role>
<rules>Write one short, friendly follow-up SMS to a lead who hasn't responded in 48 hours. Plain language, grade 7 reading level. No fake stats. No URLs. Under 160 chars.</rules>

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
</quality_standard>`,
        messages: [{
          role: 'user',
          content: `Lead name: ${lead.name || 'there'}. Business: ${client.business_name || 'us'}. Write a gentle 1-sentence follow-up.`,
        }],
        maxTokens: 80,
        _workerName: SPECIALIST_ID,
        tier: 'specialist',
      })
    } catch (aiErr) {
      console.warn(`[${SPECIALIST_ID}] AI failed for lead ${lead.id}: ${aiErr.message}`)
      continue
    }

    if (!smsText) continue

    // Validate through message gate
    const gateResult = validateSMS(smsText, { businessName: client.business_name })
    if (!gateResult.valid) {
      console.warn(`[${SPECIALIST_ID}] SMS blocked for lead ${lead.id}: ${gateResult.issues.join(', ')}`)
      continue
    }

    // Send via Twilio
    try {
      await sendSMS({
        from:         client.twilio_number || process.env.TWILIO_PHONE_NUMBER,
        to:           lead.phone,
        body:         gateResult.text,
        clientApiKeys: client.apiKeys || {},
        clientSlug:   client.slug || client.id,
        clientTimezone: client.timezone || 'America/Chicago',
      })
      followUpsSent.push(lead.id)
    } catch (smsErr) {
      console.error(`[${SPECIALIST_ID}] SMS send failed for lead ${lead.id}: ${smsErr.message}`)
      continue
    }

    // Log to activity_log
    await supabase.from('activity_log').insert({
      client_id:    client.id,
      worker_id:    SPECIALIST_ID,
      worker_name:  'Conversation Closer',
      action:       'lead_followup',
      message:      `48h follow-up sent to lead ${lead.name || lead.id}`,
      outcome:      'ok',
      metadata:     { lead_id: lead.id, lead_name: lead.name },
      created_at:   new Date().toISOString(),
    }).catch(e => console.warn(`[${SPECIALIST_ID}] activity_log insert failed: ${e.message}`))

    // Update lead updated_at so we don't re-contact in next cycle
    await supabase.from('leads')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', lead.id)
      .catch(() => {})
  }

  if (!followUpsSent.length) return null

  return {
    agentId:    SPECIALIST_ID,
    clientId:   client.id,
    timestamp:  Date.now(),
    status:     'action_taken',
    actionsCount: followUpsSent.length,
    summary:    `${followUpsSent.length} 48h follow-up(s) sent for ${client.business_name || client.id}`,
    escalations: [],
    data:       { followUpsSent },
    requiresDirectorAttention: false,
  }
}

function buildReport(outcomes) {
  const totalActions = outcomes.reduce((sum, o) => sum + (o.actionsCount || 0), 0)
  console.log(`[${SPECIALIST_ID.toUpperCase()}] Complete — ${totalActions} follow-up(s) sent`)
  return {
    agentId:      SPECIALIST_ID,
    division:     DIVISION,
    reportsTo:    REPORTS_TO,
    timestamp:    Date.now(),
    actionsCount: totalActions,
    escalations:  outcomes.filter(o => o.requiresDirectorAttention),
    outcomes,
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION, REPORTS_TO }
