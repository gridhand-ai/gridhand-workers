'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// OnboardingConductor — Full new-client welcome: D1/D3/D7/D14/D30 sequence
// Division: experience
// Reports to: experience-director
// Runs: on-demand (called by ExperienceDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient = require('../../lib/ai-client')
const { sendSMS } = require('../../lib/twilio-client')
const { validateSMS } = require('../../lib/message-gate')
const { fileInteraction } = require('../../lib/memory-client')
const vault = require('../../lib/memory-vault')

const AGENT_ID  = 'onboarding-conductor'
const DIVISION  = 'experience'
const REPORTS_TO = 'experience-director'

const ONBOARDING_STEPS = [
  { day: 1,  key: 'welcome',      label: 'Welcome + intro call booking' },
  { day: 3,  key: 'checkin',      label: 'Day 3 check-in' },
  { day: 7,  key: 'first_results', label: 'First results report' },
  { day: 14, key: 'optimization', label: 'Optimization suggestions' },
  { day: 30, key: 'celebration',  label: '30-day success celebration' },
]

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

async function run(clients = [], owner = 'gridhand') {
  console.log(`[${AGENT_ID.toUpperCase()}] Starting run — ${clients.length} clients, owner: ${owner}`)
  const isClientContext = owner !== 'gridhand'
  const reports = []

  for (const client of clients) {
    try {
      const result = await processClient(client, isClientContext)
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
  // Store communication preferences (onboarding progress) per client into shared vault
  for (const r of reports) {
    if (r.clientId) {
      await vault.store(r.clientId, vault.KEYS.COMMUNICATION_PREFS, {
        onboardingStepSent: r.status === 'action_taken',
        summary: r.summary || 'onboarding sequence check complete',
        timestamp: Date.now(),
      }, 7, AGENT_ID).catch(() => {})
    }
  }
  return specialistReport
}

async function processClient(client, isClientContext = false) {
  const supabase = getSupabase()
  const now = Date.now()

  const daysSinceSignup = (now - new Date(client.created_at).getTime()) / (1000 * 60 * 60 * 24)

  // Only run for clients in the first 30 days
  if (daysSinceSignup > 31) return null

  const ownerPhone = client.owner_cell
  if (!ownerPhone) return null

  // Get completed onboarding steps
  const { data: progressData } = await supabase
    .from('agent_state')
    .select('state')
    .eq('agent', 'onboarding_conductor')
    .eq('client_id', client.id)
    .eq('entity_id', 'progress')
    .single()

  const completedSteps = progressData?.state?.completed || []
  const actionsTaken = []

  for (const step of ONBOARDING_STEPS) {
    if (completedSteps.includes(step.key)) continue
    if (daysSinceSignup < step.day) continue // Too early — not yet due

    // Check per-step state to support catch-up mode (handles missed cron runs)
    // Was: daysSinceSignup > step.day + 1 (skips forever if cron missed a day)
    // Now: check if step was already sent via agent_state — send regardless of how late
    const { data: alreadySent } = await supabase
      .from('agent_state')
      .select('id')
      .eq('client_id', client.id)
      .eq('agent', 'onboarding_conductor')
      .eq('entity_id', `onboarding-step-${step.day}`)
      .single()
    if (alreadySent) continue // Already sent this step, skip

    try {
      // Gather relevant stats for the step
      const startOfOnboarding = new Date(client.created_at).toISOString()
      const { count: tasksDone } = await supabase
        .from('activity_log')
        .select('*', { count: 'exact', head: true })
        .eq('client_id', client.id)
        .gte('created_at', startOfOnboarding)

      const message = await generateOnboardingMessage(client, step, {
        isClientContext,
        daysSinceSignup: Math.floor(daysSinceSignup),
        tasksDone: tasksDone || 0,
      })
      if (!message) continue

      const gateResult = validateSMS(message, { businessName: client.business_name })
      if (!gateResult.valid) {
        console.warn(`[${AGENT_ID}] message-gate blocked SMS: ${gateResult.issues.join('; ')}`)
        continue
      }

      await sendSMS({
        from: client.twilio_number || process.env.TWILIO_PHONE_NUMBER,
        to: ownerPhone,
        body: message,
        clientApiKeys: {},
        clientSlug: client.email,
        clientTimezone: 'America/Chicago',
      })

      const newCompleted = [...completedSteps, step.key]
      await supabase.from('agent_state').upsert({
        agent: 'onboarding_conductor',
        client_id: client.id,
        entity_id: 'progress',
        state: { completed: newCompleted },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'agent,client_id,entity_id' })

      // Also record per-step sentinel so catch-up guard can detect it
      await supabase.from('agent_state').upsert({
        agent: 'onboarding_conductor',
        client_id: client.id,
        entity_id: `onboarding-step-${step.day}`,
        state: { sentAt: new Date().toISOString(), stepKey: step.key },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'agent,client_id,entity_id' })

      actionsTaken.push(step.label)
    } catch (err) {
      console.error(`[${AGENT_ID}] Step ${step.key} failed:`, err.message)
    }
  }

  if (!actionsTaken.length) return null

  return {
    agentId: AGENT_ID,
    clientId: client.id,
    timestamp: Date.now(),
    status: 'action_taken',
    summary: `Onboarding steps sent for ${client.business_name}: ${actionsTaken.join(', ')}`,
    data: { steps: actionsTaken },
    requiresDirectorAttention: false,
  }
}

async function generateOnboardingMessage(client, step, stats) {
  const isClientContext = stats.isClientContext || false

  const ownerBlock = isClientContext
    ? `<owner_context>
This onboarding message is being sent to a sub-client of ${client.business_name}.
The message should reflect ${client.business_name}'s brand voice and onboarding experience — not GRIDHAND's.
Do not reference GRIDHAND by name unless the business has branded their service with GRIDHAND.
</owner_context>`
    : `<owner_context>
This onboarding message is from GRIDHAND to a new GRIDHAND client.
Sign off as GRIDHAND. Represent the GRIDHAND platform warmly and professionally.
</owner_context>`

  const stepInstructions = {
    welcome: `Day 1 welcome. Introduce GRIDHAND warmly, confirm their setup is live, mention they can book an intro call anytime. Make them feel excited.`,
    checkin: `Day 3 check-in. Ask how the first few days feel. Mention something specific GRIDHAND has already done for them (${stats.tasksDone} tasks completed).`,
    first_results: `Day 7 first results report. Share what GRIDHAND has done so far (${stats.tasksDone} automations). Make the value concrete.`,
    optimization: `Day 14 optimization suggestions. Offer 1-2 tips to get more out of GRIDHAND based on their industry.`,
    celebration: `Day 30 celebration. They made it to 30 days! Celebrate ${stats.tasksDone} tasks completed. Look forward together.`,
  }

  const systemPrompt = `${ownerBlock}

<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<onboarding>
Step: ${step.label}
Day: ${stats.daysSinceSignup}
Tasks completed: ${stats.tasksDone}
</onboarding>

<task>
${stepInstructions[step.key] || `Write a ${step.label} message.`}
</task>

<rules>
- 2-4 sentences max
- Warm and encouraging
- Specific to their progress, not generic
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
    messages: [{ role: 'user', content: 'Write the onboarding message.' }],
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} onboarding steps sent`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
