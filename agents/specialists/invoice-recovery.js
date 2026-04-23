'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// InvoiceRecovery — Intelligent invoice chasing: D1 polite, D3 firm, D7 email+SMS, D14 escalate
// Division: revenue
// Reports to: revenue-director
// Runs: on-demand (called by RevenueDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient = require('../../lib/ai-client')
const { sendSMS } = require('../../lib/twilio-client')
const { validateSMS } = require('../../lib/message-gate')
const { fileInteraction } = require('../../lib/memory-client')
const vault = require('../../lib/memory-vault')

const AGENT_ID  = 'invoice-recovery'
const DIVISION  = 'revenue'
const REPORTS_TO = 'revenue-director'

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
  // Store contact history (invoice recovery attempts) per client into shared vault
  for (const r of reports) {
    if (r.clientId) {
      await vault.store(r.clientId, vault.KEYS.CONTACT_HISTORY, {
        lastAction: 'invoice_recovery',
        chaseSent: r.status === 'action_taken',
        totalAtRisk: r.data?.totalAtRisk,
        summary: r.summary || 'invoice recovery cycle complete',
        timestamp: Date.now(),
      }, 7, AGENT_ID).catch(() => {})
    }
  }
  return specialistReport
}

async function processClient(client) {
  const supabase = getSupabase()
  const now = Date.now()

  // Fetch overdue invoices from client's invoice data
  const { data: invoices } = await supabase
    .from('client_invoices')
    .select('*')
    .eq('client_id', client.id)
    .eq('status', 'overdue')
    .order('due_date', { ascending: true })

  if (!invoices?.length) return null

  let actionsTaken = 0
  let escalations = 0
  const recovered = []

  for (const invoice of invoices) {
    const dueDate = new Date(invoice.due_date).getTime()
    const daysOverdue = (now - dueDate) / (1000 * 60 * 60 * 24)
    const chaseState = invoice.chase_state || {}
    const lastChaseDays = chaseState.lastChaseDays || 0

    let chaseDay = null
    let tone = 'polite'

    if (daysOverdue >= 14 && lastChaseDays < 14) { chaseDay = 14; tone = 'escalate' }
    else if (daysOverdue >= 7 && lastChaseDays < 7) { chaseDay = 7; tone = 'urgent' }
    else if (daysOverdue >= 3 && lastChaseDays < 3) { chaseDay = 3; tone = 'firm' }
    else if (daysOverdue >= 1 && lastChaseDays < 1) { chaseDay = 1; tone = 'polite' }

    if (!chaseDay) continue

    const customerPhone = invoice.customer_phone
    if (!customerPhone && tone !== 'escalate') continue

    if (tone === 'escalate') {
      // Escalate to client owner — mark for director attention
      await supabase.from('client_invoices').update({
        chase_state: { ...chaseState, lastChaseDays: 14, escalatedAt: new Date().toISOString() },
      }).eq('id', invoice.id)
      escalations++
      continue
    }

    try {
      const message = await generateChaseMessage(client, invoice, tone, daysOverdue)
      if (!message) continue

      const gateResult = validateSMS(message, {
        businessName: client.business_name,
        amount: invoice.amount ? String(invoice.amount) : undefined,
      })
      if (!gateResult.valid) {
        console.warn(`[${AGENT_ID}] message-gate blocked SMS: ${gateResult.issues.join('; ')}`)
        continue
      }

      await sendSMS({
        from: client.twilio_number || process.env.TWILIO_PHONE_NUMBER,
        to: customerPhone,
        body: message,
        clientApiKeys: {},
        clientSlug: client.email,
        clientTimezone: 'America/Chicago',
      })

      await supabase.from('client_invoices').update({
        chase_state: {
          ...chaseState,
          lastChaseDays: chaseDay,
          [`day${chaseDay}SentAt`]: new Date().toISOString(),
        },
      }).eq('id', invoice.id)

      actionsTaken++
      recovered.push({ invoiceId: invoice.id, amount: invoice.amount, daysOverdue: Math.floor(daysOverdue), tone })
    } catch (err) {
      console.error(`[${AGENT_ID}] Chase failed for invoice ${invoice.id}:`, err.message)
    }
  }

  if (!actionsTaken && !escalations) return null

  const totalAtRisk = invoices.reduce((sum, inv) => sum + (inv.amount || 0), 0)

  return {
    agentId: AGENT_ID,
    clientId: client.id,
    timestamp: Date.now(),
    status: 'action_taken',
    summary: `${actionsTaken} invoice chase(s) sent, ${escalations} escalated for ${client.business_name}. Total at risk: $${totalAtRisk}`,
    data: { recovered, escalations, totalAtRisk },
    requiresDirectorAttention: escalations > 0 || totalAtRisk > 500,
  }
}

async function generateChaseMessage(client, invoice, tone, daysOverdue) {
  const toneInstructions = {
    polite: 'Friendly reminder — just in case it slipped through. Helpful, no pressure.',
    firm: 'Firmer tone. Acknowledge it\'s been a few days. Ask them to resolve it today.',
    urgent: 'Urgent. This needs immediate attention. Professional but direct.',
  }

  const systemPrompt = `<role>Invoice Recovery Agent for GRIDHAND AI — write invoice follow-up SMS messages on behalf of small business clients.</role>
<business>
Name: ${client.business_name}
</business>

<invoice>
Amount: $${invoice.amount || 'unpaid balance'}
Days overdue: ${Math.floor(daysOverdue)}
Invoice ID: ${invoice.invoice_number || invoice.id}
</invoice>

<task>
Write an invoice follow-up SMS. Tone: ${toneInstructions[tone]}
Include the amount owed and reference the invoice.
</task>

<rules>
- 2 sentences max
- Professional but human
- Include a clear action (pay now, reply, call)
- Sign off as ${client.business_name}
- Output ONLY the SMS text
</rules>`

  return aiClient.call({
    modelString: 'groq/llama-3.3-70b-versatile',
    clientApiKeys: {},
    systemPrompt,
    messages: [{ role: 'user', content: 'Write the invoice chase message.' }],
    maxTokens: 130,
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} actions taken`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
