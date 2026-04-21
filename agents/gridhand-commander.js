'use strict'
// ── OG GRIDHAND COMMANDER — TIER 1 ───────────────────────────────────────────
// GridHandCommander — Master orchestrator. Runs every 15 min. Routes situations
// to Directors. Receives their reports. SMS MJ on high-severity findings.
//
// Chain of Command:
//   Commander (T1)
//     ├── AcquisitionDirector (T2) → lead-qualifier, prospect-nurturer, referral-activator, cold-outreach
//     ├── RevenueDirector (T2)     → invoice-recovery, upsell-timer, subscription-guard, pricing-optimizer
//     ├── ExperienceDirector (T2)  → churn-predictor, loyalty-coordinator, client-success, onboarding-conductor
//     └── BrandDirector (T2)       → review-orchestrator, social-manager, brand-sentinel, campaign-conductor
//
// Reports to: MJ (SMS via Twilio when severity >= HIGH)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { sendSMS }      = require('../lib/twilio-client')
const { call }         = require('../lib/ai-client')
const { scout }        = require('../lib/scout')

const acquisitionDirector   = require('./acquisition-director')
const revenueDirector       = require('./revenue-director')
const experienceDirector    = require('./experience-director')
const brandDirector         = require('./brand-director')
const intelligenceDirector  = require('./intelligence-director')

const OPUS_MODEL = 'claude-opus-4-7'

const AGENT_ID = 'gridhand-commander'
const DIVISION = 'command'

// Situation → Director routing map
const SITUATION_ROUTING = {
  new_lead:          'acquisition-director',
  lead_cold:         'acquisition-director',
  review_negative:   'brand-director',
  review_new:        'brand-director',
  invoice_overdue:   'revenue-director',
  payment_failed:    'revenue-director',
  client_inactive:   'experience-director',
  client_new:        'experience-director',
  upsell_opportunity: 'revenue-director',
  churn_risk:        'experience-director',
}

// MJ's phone(s) for high-severity alerts
const ADMIN_PHONES = (process.env.ADMIN_NOTIFY_PHONES || '').split(',').filter(Boolean)

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// ── Main orchestration run ───────────────────────────────────────────────────
async function run(clients = null) {
  const runId    = `cmd_${Date.now()}`
  const startedAt = new Date().toISOString()
  console.log(`[${AGENT_ID.toUpperCase()}] Run ${runId} starting`)

  const supabase = getSupabase()

  // Load active clients
  const clientList = clients || await getActiveClients(supabase)
  console.log(`[${AGENT_ID.toUpperCase()}] ${clientList.length} active client(s)`)

  if (!clientList.length) {
    await logRun(supabase, runId, startedAt, 'no_clients', {}, 0)
    return
  }

  // Detect situations requiring director action
  const situations = await detectSituations(supabase, clientList)
  console.log(`[${AGENT_ID.toUpperCase()}] ${situations.length} situation(s) detected`)

  // ── SCOUT: Groq reads everything — builds a rich brief for Opus ────────────
  console.log(`[${AGENT_ID.toUpperCase()}] Scout reading client portfolio...`)
  let commandBrief = null
  try {
    commandBrief = await scout({
      task: 'Analyze this client portfolio and situations. Identify which divisions need urgent action, which clients are at risk, what opportunities exist, and what the overall health of the business looks like.',
      sources: [
        { label: 'active_clients', content: clientList },
        { label: 'detected_situations', content: situations },
        { label: 'situation_routing_map', content: SITUATION_ROUTING },
      ],
    })
    console.log(`[${AGENT_ID.toUpperCase()}] Scout brief ready (${commandBrief.length} chars)`)
  } catch (err) {
    console.warn(`[${AGENT_ID}] Scout failed, proceeding without brief:`, err.message)
  }

  // ── OPUS: Strategic command decision based on scout brief ─────────────────
  let opusGuidance = null
  if (commandBrief) {
    try {
      opusGuidance = await call({
        modelString: OPUS_MODEL,
        systemPrompt: `You are GridHandCommander, the master AI orchestrator for GRIDHAND — an AI workforce platform serving small businesses.
Your job: read the intelligence brief and make strategic decisions about what actions to prioritize this cycle.
Output a JSON object with:
- priority_directors: array of director names that need urgent attention (e.g. ["revenue-director","experience-director"])
- severity_override: null | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
- key_risks: array of strings — top 3 risks to flag
- opportunities: array of strings — top 2 opportunities to act on
- mj_alert_reason: null or string — only set if something needs MJ's immediate attention`,
        messages: [{
          role: 'user',
          content: `INTELLIGENCE BRIEF FROM SCOUT:\n\n${commandBrief}\n\nProvide your command decision as valid JSON only. No other text.`,
        }],
        maxTokens: 600,
      })
      console.log(`[${AGENT_ID.toUpperCase()}] Opus command decision received`)
    } catch (err) {
      console.warn(`[${AGENT_ID}] Opus guidance failed, falling back to standard routing:`, err.message)
    }
  }

  // Parse Opus guidance if available
  let parsedGuidance = null
  if (opusGuidance) {
    try {
      const jsonMatch = opusGuidance.match(/\{[\s\S]*\}/)
      if (jsonMatch) parsedGuidance = JSON.parse(jsonMatch[0])
    } catch { /* use standard routing */ }
  }

  // ── Run Intelligence Director first — its brief feeds into the other four ──
  // This gives each director cross-division context before they dispatch specialists.
  let intelReport = null
  try {
    intelReport = await intelligenceDirector.run(
      clientList,
      situations.filter(s => SITUATION_ROUTING[s.type] === 'intelligence-director'),
    )
    await receive(intelReport)
    console.log(`[${AGENT_ID.toUpperCase()}] Intelligence Director complete — extracting brief`)
  } catch (intelErr) {
    console.error(`[${AGENT_ID}] Intelligence Director failed: ${intelErr.message}`)
    intelReport = {
      agentId:    'intelligence-director',
      division:   'intelligence',
      reportsTo:  AGENT_ID,
      timestamp:  Date.now(),
      actionsCount: 0,
      escalations: [],
      outcomes:   [{ status: 'error', summary: `Director failed: ${intelErr.message}`, requiresDirectorAttention: true }],
      error:      intelErr.message,
    }
  }

  // Pull the intelligence brief — null if Intel Director failed or hasn't run yet
  const intelligenceBrief = intelligenceDirector.getBrief ? intelligenceDirector.getBrief() : null
  if (intelligenceBrief) {
    console.log(`[${AGENT_ID.toUpperCase()}] Intelligence brief ready — injecting into director runs`)
  }

  // Build situation context per director, enriched with Opus insights
  const opusContext = parsedGuidance ? {
    keyRisks:      parsedGuidance.key_risks || [],
    opportunities: parsedGuidance.opportunities || [],
    prioritized:   parsedGuidance.priority_directors || [],
  } : {}

  // The four operational directors that receive the intelligence brief
  const operationalDirectors = {
    'acquisition-director': acquisitionDirector,
    'revenue-director':     revenueDirector,
    'experience-director':  experienceDirector,
    'brand-director':       brandDirector,
  }

  // Run the four operational directors in parallel, injecting the intel brief as commanderBrief
  const directorResults = await Promise.allSettled(
    Object.entries(operationalDirectors).map(([id, director]) =>
      director.run(
        clientList,
        situations.filter(s => SITUATION_ROUTING[s.type] === id),
        intelligenceBrief, // commanderBrief — third param added to all four directors
      )
    )
  )

  // Collect and process director reports — always get a valid object, never silent fail
  // Start with the intel report already collected above
  const directorReports = [intelReport]
  const directorNames   = Object.keys(operationalDirectors)
  for (let i = 0; i < directorResults.length; i++) {
    const result = directorResults[i]
    const name   = directorNames[i]
    if (result.status === 'fulfilled' && result.value) {
      const r = result.value
      await receive(r)
      directorReports.push(r)
    } else {
      const reason = result.status === 'rejected' ? result.reason?.message : 'returned null/undefined'
      console.error(`[${AGENT_ID}] Director ${name} failed: ${reason}`)
      // Always push a stub report so Commander knows it ran but failed
      directorReports.push({
        agentId:    name,
        division:   name.replace('-director', ''),
        reportsTo:  AGENT_ID,
        timestamp:  Date.now(),
        actionsCount: 0,
        escalations: [],
        outcomes:   [{ status: 'error', summary: `Director failed: ${reason}`, requiresDirectorAttention: true }],
        error:      reason,
      })
    }
  }

  // Assess overall severity — Opus override takes precedence if set
  const totalActions   = directorReports.reduce((sum, r) => sum + (r.actionsCount || 0), 0)
  const allEscalations = directorReports.flatMap(r => r.escalations || [])
  const baseSeverity   = assessSeverity(allEscalations, situations)
  const severity       = (parsedGuidance?.severity_override) || baseSeverity

  // SMS MJ if severity is HIGH or CRITICAL, or if Opus flagged something specific
  const mjAlertReason = parsedGuidance?.mj_alert_reason
  if (severity === 'HIGH' || severity === 'CRITICAL' || mjAlertReason) {
    await notifyMJ(allEscalations, severity, totalActions, mjAlertReason)
  }

  // Log run to Supabase
  await logRun(supabase, runId, startedAt, severity, {
    situations: situations.length,
    directorReports: directorReports.length,
    totalActions,
    escalations: allEscalations.length,
  }, totalActions)

  console.log(`[${AGENT_ID.toUpperCase()}] Run ${runId} complete — ${totalActions} total actions, severity: ${severity}`)
  return { runId, totalActions, severity, escalations: allEscalations.length }
}

// ── Situation detection ───────────────────────────────────────────────────────
async function detectSituations(supabase, clients) {
  const situations = []
  const now = Date.now()
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString()

  try {
    // activity_log uses worker_name as the event type identifier
    const { data: recentEvents } = await supabase
      .from('activity_log')
      .select('client_id, worker_name, message, metadata, created_at')
      .in('worker_name', [
        'lead_created', 'review_negative', 'payment_failed',
        'invoice_overdue', 'client_created', 'churn_risk',
        'upsell_opportunity_flagged',
      ])
      .gte('created_at', oneHourAgo)
      .order('created_at', { ascending: false })
      .limit(100)

    for (const event of (recentEvents || [])) {
      const type = eventToSituation(event.worker_name)
      if (type) {
        situations.push({
          type,
          clientId: event.client_id,
          timestamp: new Date(event.created_at).getTime(),
          metadata: event.metadata || {},
          summary: event.message,
        })
      }
    }

    // Also detect churn risks from agent_state scores
    const { data: churnStates } = await supabase
      .from('agent_state')
      .select('client_id, state')
      .eq('agent', 'churn_predictor')
      .eq('entity_id', 'churn_score')
      .gte('updated_at', oneHourAgo)

    for (const row of (churnStates || [])) {
      if ((row.state?.score || 0) >= 7) {
        situations.push({
          type: 'churn_risk',
          clientId: row.client_id,
          timestamp: now,
          metadata: { score: row.state.score },
          summary: `Churn risk score: ${row.state.score}/10`,
        })
      }
    }
  } catch (err) {
    console.error(`[${AGENT_ID}] Situation detection failed:`, err.message)
  }

  return situations
}

function eventToSituation(workerName) {
  const map = {
    'lead_created':                'new_lead',
    'review_negative':             'review_negative',
    'payment_failed':              'payment_failed',
    'invoice_overdue':             'invoice_overdue',
    'client_created':              'client_new',
    'churn_risk':                  'churn_risk',
    'upsell_opportunity_flagged':  'upsell_opportunity',
  }
  return map[workerName] || null
}

// ── Severity assessment ───────────────────────────────────────────────────────
function assessSeverity(escalations, situations) {
  if (!escalations.length && !situations.length) return 'LOW'

  const criticalTriggers = escalations.filter(e =>
    e.data?.totalAtRisk > 1000 ||
    e.data?.score >= 9 ||
    e.data?.negativeCount >= 5
  )
  if (criticalTriggers.length) return 'CRITICAL'

  const highTriggers = escalations.filter(e =>
    e.data?.totalAtRisk > 500 ||
    e.data?.score >= 7 ||
    e.requiresDirectorAttention
  )
  if (highTriggers.length >= 2) return 'HIGH'
  if (highTriggers.length === 1) return 'MEDIUM'

  return escalations.length ? 'MEDIUM' : 'LOW'
}

// ── MJ notification ───────────────────────────────────────────────────────────
async function notifyMJ(escalations, severity, totalActions, opusReason = null) {
  if (!ADMIN_PHONES.length) {
    console.log(`[${AGENT_ID}] No ADMIN_NOTIFY_PHONES set — skipping MJ alert`)
    return
  }

  const lines = [
    `GRIDHAND COMMANDER — ${severity} ALERT`,
    `${totalActions} actions taken this cycle.`,
  ]
  if (opusReason) lines.push(`⚡ ${opusReason}`)
  lines.push(`${escalations.length} escalation(s) need attention:`)

  for (const esc of escalations.slice(0, 3)) {
    lines.push(`• ${esc.summary || esc.agentId}`)
  }
  if (escalations.length > 3) {
    lines.push(`...and ${escalations.length - 3} more.`)
  }

  const body = lines.join('\n')

  for (const phone of ADMIN_PHONES) {
    try {
      await sendSMS({
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone.trim(),
        body,
        clientApiKeys: {},
        clientSlug: 'gridhand-commander',
        clientTimezone: 'America/Chicago',
      })
      console.log(`[${AGENT_ID}] Alert sent to MJ at ${phone.slice(-4)}`)
    } catch (err) {
      console.error(`[${AGENT_ID}] Alert failed for ${phone}:`, err.message)
    }
  }
}

// ── Receive director reports ──────────────────────────────────────────────────
async function receive(directorReport) {
  const { agentId, actionsCount, escalations } = directorReport
  console.log(
    `[${AGENT_ID.toUpperCase()}] Received from ${agentId}: ${actionsCount || 0} actions, ${(escalations || []).length} escalation(s)`
  )
}

// ── Log run to Supabase ───────────────────────────────────────────────────────
async function logRun(supabase, runId, startedAt, severity, data, actionsCount) {
  try {
    // agent_runs schema: id, agent_id, status, summary, payload, ran_at
    await supabase.from('agent_runs').insert({
      agent_id: AGENT_ID,
      status: severity,
      summary: `Commander run ${runId}: ${actionsCount} actions, severity ${severity}`,
      payload: { runId, startedAt, completedAt: new Date().toISOString(), actionsCount, ...data },
      ran_at: new Date().toISOString(),
    })
  } catch (err) {
    // Non-critical — log but don't crash
    console.error(`[${AGENT_ID}] Failed to log run:`, err.message)
  }
}

// ── Client loader ─────────────────────────────────────────────────────────────
async function getActiveClients(supabase) {
  const sb = supabase || getSupabase()
  const { data, error } = await sb
    .from('clients')
    .select('*')
    .eq('is_active', true)
  if (error) {
    console.error(`[${AGENT_ID}] Failed to load clients:`, error.message)
    return []
  }
  return data || []
}

module.exports = {
  run,
  receive,
  AGENT_ID,
  DIVISION,
  SITUATION_ROUTING,
  schedule: '*/15 * * * *',
  tier: 1,
  reportsTo: 'MJ',
}
