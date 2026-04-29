'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// ClientSuccess — Monthly "here's what we did for you" summary + feedback ask
// Division: experience
// Reports to: experience-director
// Runs: on-demand (called by ExperienceDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient = require('../../lib/ai-client')
const { sendSMS } = require('../../lib/twilio-client')
const { validateSMS } = require('../../lib/message-gate')
const { clean: humanize } = require('../../lib/humanizer')
const { fileInteraction } = require('../../lib/memory-client')
const vault = require('../../lib/memory-vault')

const AGENT_ID  = 'client-success'
const DIVISION  = 'experience'
const REPORTS_TO = 'experience-director'

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
  // Store business goals (client success summary) per client into shared vault
  for (const r of reports) {
    if (r.clientId) {
      await vault.store(r.clientId, vault.KEYS.BUSINESS_GOALS, {
        successReportSent: r.status === 'action_taken',
        summary: r.summary || 'client success check complete',
        timestamp: Date.now(),
      }, 6, AGENT_ID).catch(() => {})
    }
  }
  return specialistReport
}

async function processClient(client) {
  const supabase = getSupabase()
  const now = Date.now()

  // Only send monthly — check if already sent this month
  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const { data: lastCheckIn } = await supabase
    .from('agent_state')
    .select('state')
    .eq('agent', 'client_success')
    .eq('client_id', client.id)
    .eq('entity_id', 'monthly_checkin')
    .single()

  if (lastCheckIn?.state?.sentAt) {
    const lastSent = new Date(lastCheckIn.state.sentAt)
    if (lastSent >= startOfMonth) return null // Already sent this month
  }

  const ownerPhone = client.owner_cell
  if (!ownerPhone) return null

  // Gather this month's stats
  const [
    { count: totalTasks },
    { count: smsSent },
    { count: reviewsRequested },
    { data: recentActivity },
  ] = await Promise.all([
    supabase.from('activity_log').select('*', { count: 'exact', head: true }).eq('client_id', client.id).gte('created_at', startOfMonth.toISOString()),
    supabase.from('activity_log').select('*', { count: 'exact', head: true }).eq('client_id', client.id).eq('worker_name', 'sms_sent').gte('created_at', startOfMonth.toISOString()),
    supabase.from('activity_log').select('*', { count: 'exact', head: true }).eq('client_id', client.id).eq('worker_name', 'review_request_sent').gte('created_at', startOfMonth.toISOString()),
    supabase.from('activity_log').select('worker_name, message').eq('client_id', client.id).gte('created_at', startOfMonth.toISOString()).order('created_at', { ascending: false }).limit(10),
  ])

  const stats = {
    totalTasks: totalTasks || 0,
    smsSent: smsSent || 0,
    reviewsRequested: reviewsRequested || 0,
    topActions: [...new Set((recentActivity || []).map(a => a.worker_name))].slice(0, 3),
  }

  const ACTION_LABELS = {
    review_request_sent: 'review requests sent',
    sms_sent: 'SMS messages sent',
    task_completed: 'tasks completed',
    appointment_confirmed: 'appointments confirmed',
    lead_qualified: 'leads qualified',
    invoice_sent: 'invoices sent',
    follow_up_sent: 'follow-ups sent',
  }
  const readableActions = (stats.topActions || []).map(a => ACTION_LABELS[a] || a.replace(/_/g, ' '))
  stats.readableActions = readableActions

  try {
    const message = await generateMonthlyReport(client, stats)
    if (!message) return null

    const gateResult = validateSMS(message, { businessName: client.business_name })
    if (!gateResult.valid) {
      console.warn(`[${AGENT_ID}] message-gate blocked SMS: ${gateResult.issues.join('; ')}`)
      return null
    }

    await sendSMS({
      from: client.twilio_number || process.env.TWILIO_PHONE_NUMBER,
      to: ownerPhone,
      body: humanize(gateResult.text || message),
      clientApiKeys: {},
      clientSlug: client.email,
      clientTimezone: client.timezone || process.env.DEFAULT_TIMEZONE || 'America/Chicago',
    })

    await supabase.from('agent_state').upsert({
      agent: 'client_success',
      client_id: client.id,
      entity_id: 'monthly_checkin',
      state: { sentAt: new Date().toISOString(), stats },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'agent,client_id,entity_id' })

    return {
      agentId: AGENT_ID,
      clientId: client.id,
      timestamp: Date.now(),
      status: 'action_taken',
      summary: `Monthly success report sent to ${client.business_name} (${stats.totalTasks} tasks this month)`,
      data: { stats },
      requiresDirectorAttention: false,
    }
  } catch (err) {
    console.error(`[${AGENT_ID}] Report failed for ${client.id}:`, err.message)
    return null
  }
}

async function generateMonthlyReport(client, stats) {
  const monthName = new Date().toLocaleString('default', { month: 'long' })

  const systemPrompt = `<role>Client Success Agent for GRIDHAND AI — write warm, concrete monthly success update SMS messages for small business clients.</role>
<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<stats month="${monthName}">
Total automations completed: ${stats.totalTasks}
SMS sent on their behalf: ${stats.smsSent}
Review requests sent: ${stats.reviewsRequested}
Top activity types: ${(stats.readableActions || stats.topActions || []).join(', ') || 'various'}
</stats>

<task>
Write a brief monthly success update SMS.
Summarize the value GRIDHAND delivered this month in plain terms.
End with a quick question: "Anything you'd like us to focus on next month?"
</task>

<rules>
- 3-4 sentences max
- Concrete numbers, not vague claims
- Warm and proud tone — celebrate their growth
- Sign off as GRIDHAND
- Output ONLY the SMS text
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
</quality_standard>`

  return aiClient.call({
    modelString: 'groq/llama-3.3-70b-versatile',
    clientApiKeys: {},
    systemPrompt,
    messages: [{ role: 'user', content: 'Write the monthly report.' }],
    maxTokens: 200,
    _workerName: AGENT_ID,
    tier: 'specialist',
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} monthly reports sent`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
