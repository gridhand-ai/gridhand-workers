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
const tokenTracker     = require('../lib/token-tracker')
const { fileInteraction, retrieveMemory, buildMemoryBriefing } = require('../lib/memory-client')
const vault            = require('../lib/memory-vault')
const linear           = require('../lib/linear-client')

const acquisitionDirector   = require('./acquisition-director')
const revenueDirector       = require('./revenue-director')
const experienceDirector    = require('./experience-director')
const brandDirector         = require('./brand-director')
const intelligenceDirector  = require('./intelligence-director')

const OPUS_MODEL = 'deepseek/deepseek-v4-pro'
const REFLECTION_MODEL = 'deepseek/deepseek-v4-pro'

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

  // Reset per-run token counters — tracks cumulative usage across full hierarchy
  tokenTracker.resetRun(runId)

  // ── MEMORY: Pull recent agent history before doing anything else ──────────
  let memoryBriefing = ''
  try {
    const recentMemories = await retrieveMemory({ limit: 15 })
    memoryBriefing = await buildMemoryBriefing(recentMemories)
    console.log(`[${AGENT_ID.toUpperCase()}] Memory briefing: ${memoryBriefing.slice(0, 200)}...`)
  } catch (e) {
    console.warn(`[${AGENT_ID.toUpperCase()}] Memory retrieval failed: ${e.message}`)
  }

  const supabase = getSupabase()

  // Load active clients
  const clientList = clients || await getActiveClients(supabase)
  console.log(`[${AGENT_ID.toUpperCase()}] ${clientList.length} active client(s)`)

  if (!clientList.length) {
    await logRun(supabase, runId, startedAt, 'no_clients', {}, 0)
    return
  }

  // Load assigned_workers — used to filter each director's client list so
  // specialists only run for clients that have toggled those workers ON.
  const clientIds = clientList.map(c => c.id)
  const assignmentMap = await loadAssignedWorkers(supabase, clientIds)
  const assignedCount = assignmentMap
    ? Object.values(assignmentMap).reduce((n, s) => n + s.size, 0)
    : 'unknown (fallback mode)'
  console.log(`[${AGENT_ID.toUpperCase()}] ${assignedCount} active worker assignment(s) loaded`)

  // ── CROSS-DIRECTOR MEMORY: Load client_knowledge for all active clients ──────
  // Each client object gets a `clientKnowledge` array attached before directors run.
  // Directors use this to give specialists relevant historical context per client.
  console.log(`[${AGENT_ID.toUpperCase()}] Loading client knowledge for ${clientIds.length} client(s)`)
  const clientKnowledgeMap = await loadClientKnowledge(supabase, clientIds)
  const knowledgeCount = Object.values(clientKnowledgeMap).reduce((n, arr) => n + arr.length, 0)
  console.log(`[${AGENT_ID.toUpperCase()}] ${knowledgeCount} client knowledge row(s) loaded`)

  // Attach knowledge to each client object — directors/specialists access via client.clientKnowledge
  const clientListWithKnowledge = clientList.map(c => ({
    ...c,
    clientKnowledge: clientKnowledgeMap[c.id] || [],
  }))

  // Detect situations requiring director action
  const situations = await detectSituations(supabase, clientListWithKnowledge)
  console.log(`[${AGENT_ID.toUpperCase()}] ${situations.length} situation(s) detected`)

  // ── VAULT: Load shared memory context for all active clients ──────────────
  const vaultContexts = {}
  for (const client of clientList) {
    try {
      vaultContexts[client.id] = await vault.getContext(client.id)
    } catch (_) {}
  }
  const vaultSummary = Object.values(vaultContexts).filter(Boolean).join('\n\n')

  // ── SCOUT: Groq reads everything — builds a rich brief for Opus ────────────
  console.log(`[${AGENT_ID.toUpperCase()}] Scout reading client portfolio...`)
  let commandBrief = null
  try {
    commandBrief = await scout({
      task: 'Analyze this client portfolio and situations. Identify which divisions need urgent action, which clients are at risk, what opportunities exist, and what the overall health of the business looks like.',
      sources: [
        { label: 'active_clients', content: clientListWithKnowledge },
        { label: 'detected_situations', content: situations },
        { label: 'situation_routing_map', content: SITUATION_ROUTING },
        { label: 'memory_briefing', content: memoryBriefing || 'No prior memory available.' },
        { label: 'vault_context', content: vaultSummary || 'No vault context yet.' },
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
        systemPrompt: `<role>GridHandCommander — master AI orchestrator for GRIDHAND AI workforce platform serving small businesses.</role>
<rules>Read the intelligence brief and make strategic decisions about what actions to prioritize this cycle.</rules>
<output>Respond with valid JSON only:
{
  "priority_directors": ["director1", "director2"],
  "severity_override": null,
  "key_risks": ["risk1", "risk2", "risk3"],
  "opportunities": ["opportunity1", "opportunity2"],
  "mj_alert_reason": null
}
severity_override values: null | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
mj_alert_reason: null unless something requires MJ's immediate attention</output>`,
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
      clientListWithKnowledge,
      situations.filter(s => SITUATION_ROUTING[s.type] === 'intelligence-director'),
    )
    await receive(intelReport)
    console.log(`[${AGENT_ID.toUpperCase()}] Intelligence Director complete — extracting brief`)

    // If system_health is RED, create a Linear issue immediately — don't wait for notifyMJ
    const systemHealth = intelReport?.payload?.system_health || intelReport?.system_health
    if (systemHealth === 'RED') {
      await linear.createIssue({
        title:       '[GRIDHAND] Intelligence Director — system_health RED',
        description: `Intelligence Director reported RED system health.\n\nTimestamp: ${new Date().toISOString()}\n\nReport summary: ${JSON.stringify((intelReport?.outcomes || []).slice(0, 3))}`,
        priority:    1,
      }).catch(() => {})
    }
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

    // Intel director crash is itself a Linear issue
    await linear.createIssue({
      title:       '[GRIDHAND] Intelligence Director crashed',
      description: `Commander detected Intelligence Director failure.\n\nError: ${intelErr.message}\n\nTimestamp: ${new Date().toISOString()}`,
      priority:    2,
    }).catch(() => {})
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

  // Run the four operational directors staggered by 2s each to spread Groq TPM load.
  // Full parallel (Promise.allSettled) caused 429 storms — 16+ concurrent Groq calls at once.
  // Staggering keeps us under the 6k TPM free-tier limit without serializing the work.
  const directorEntries = Object.entries(operationalDirectors)
  const directorResults = await Promise.allSettled(
    directorEntries.map(([id, director], idx) =>
      new Promise((resolve, reject) => {
        setTimeout(() => {
          // Filter clients to only those with this director's workers active.
          // This is how the client's dashboard toggle connects to actual work:
          // assigned_workers.active = true → client appears in this director's run.
          // clientListWithKnowledge has clientKnowledge attached per client.
          const directorClients = filterClientsForDirector(clientListWithKnowledge, assignmentMap, id)
          console.log(`[${AGENT_ID.toUpperCase()}] ${id}: ${directorClients.length}/${clientList.length} clients have active workers`)
          if (!directorClients.length) {
            resolve({ agentId: id, division: id.replace('-director', ''), reportsTo: AGENT_ID, timestamp: Date.now(), actionsCount: 0, escalations: [], outcomes: [] })
            return
          }
          director.run(
            directorClients,
            situations.filter(s => SITUATION_ROUTING[s.type] === id),
            intelligenceBrief,
          ).then(resolve).catch(reject)
        }, idx * 2000) // 2s stagger per director
      })
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

  // Capture token usage across entire hierarchy for this run
  const tokenSummary = tokenTracker.runSummary()
  // Only report Claude (Anthropic) spend — Groq and Ollama are free, no need to surface them.
  if (tokenSummary.tokens.anthropic > 0) {
    console.log(
      `[${AGENT_ID.toUpperCase()}] Claude token usage — ` +
      `${tokenSummary.tokens.anthropic}tok, ` +
      `cost: $${tokenSummary.cost_usd.anthropic}, ` +
      `day total: ${tokenSummary.day_tokens.anthropic}tok`
    )
  }
  if (tokenSummary.warnings.length) {
    const claudeWarnings = tokenSummary.warnings.filter(w => w.includes('anthropic'))
    if (claudeWarnings.length) {
      console.warn(`[${AGENT_ID.toUpperCase()}] ⚠️  Claude token warnings: ${claudeWarnings.join(' | ')}`)
    }
  }

  // ── SELF-CORRECTION LOOP: Reflect on specialist outcomes ─────────────────────
  // Runs AFTER all directors report. Never blocks the report — errors are swallowed.
  let reflection = null
  try {
    reflection = await reflectOnOutcomes(supabase, directorReports, situations)
    console.log(`[${AGENT_ID.toUpperCase()}] Reflection: quality=${reflection?.overallQuality}, flagged=${reflection?.flagged?.length || 0}`)
  } catch (reflectErr) {
    console.warn(`[${AGENT_ID}] Reflection step failed: ${reflectErr.message}`)
  }

  // Log run to Supabase
  await logRun(supabase, runId, startedAt, severity, {
    situations: situations.length,
    directorReports: directorReports.length,
    totalActions,
    escalations: allEscalations.length,
    tokens: tokenSummary.tokens,
    cost_usd: tokenSummary.cost_usd,
    token_warnings: tokenSummary.warnings,
    reflection: reflection || null,
  }, totalActions)

  // Persist token usage for all providers to Supabase
  await tokenTracker.persistRun(supabase, runId).catch(e =>
    console.warn(`[${AGENT_ID}] Token persist failed: ${e.message}`)
  )

  // File this run's summary into agent memory for future context
  await fileInteraction({
    runId,
    totalActions,
    severity,
    situations: situations.length,
    directorReports: directorReports.length,
    tokenSummary: tokenSummary.tokens,
  }, {
    workerId: AGENT_ID,
    interactionType: 'run_summary',
    severity,
    runId,
  }).catch(() => {})

  console.log(`[${AGENT_ID.toUpperCase()}] Run ${runId} complete — ${totalActions} total actions, severity: ${severity}`)
  return { runId, totalActions, severity, escalations: allEscalations.length, tokens: tokenSummary.tokens, data: { reflection } }
}

// ── Self-correction: reflect on what specialists did vs what was needed ────────
// Runs post-Promise.allSettled. Calls Groq to flag misses. Logs to director_reasoning
// if quality is 'poor' or too many items are flagged.
async function reflectOnOutcomes(supabase, directorReports, originalSituations) {
  const summaries = directorReports.map(r => ({
    agent: r.agentId,
    actions: r.actionsCount || 0,
    escalations: (r.escalations || []).length,
    topOutcome: (r.outcomes || [])[0]?.summary || null,
    error: r.error || null,
  }))

  const situationSummary = originalSituations.slice(0, 10).map(s =>
    `${s.type} (client: ${s.clientId || 'unknown'})`
  ).join(', ') || 'scheduled_run'

  const raw = await call({
    modelString: REFLECTION_MODEL,
    systemPrompt: `<role>GridHandCommander self-correction module. Review specialist/director outcomes against the original situation and flag quality gaps.</role>
<rules>Be concise. Only flag genuine misses — not expected no-actions. Return valid JSON only.</rules>
<output>{ "flagged": [{ "agentId": "string", "reason": "string" }], "overallQuality": "good" }</output>
overallQuality: "good" | "partial" | "poor"</output>`,
    messages: [{
      role: 'user',
      content: `Original situations: ${situationSummary}\n\nDirector outcomes:\n${JSON.stringify(summaries, null, 2)}\n\nReturn JSON only.`,
    }],
    maxTokens: 400,
    _workerName: 'commander-reflection',
  })

  let parsed = null
  try {
    const match = raw?.match(/\{[\s\S]*\}/)
    if (match) parsed = JSON.parse(match[0])
  } catch (_) {}

  if (!parsed) return { flagged: [], overallQuality: 'unknown' }

  // Log to director_reasoning if quality is poor or too many flags
  if (parsed.overallQuality === 'poor' || (parsed.flagged || []).length > 2) {
    try {
      await supabase.from('director_reasoning').insert({
        director_id: AGENT_ID,
        reasoning: `Self-correction triggered: ${parsed.overallQuality} quality. ${(parsed.flagged || []).length} agent(s) flagged.`,
        specialists_chosen: (parsed.flagged || []).map(f => f.agentId),
        vertical: null,
        situation: 'self_correction_triggered',
        created_at: new Date().toISOString(),
      })
    } catch (logErr) {
      console.warn(`[${AGENT_ID}] Reflection log failed: ${logErr.message}`)
    }
  }

  return parsed
}

// ── Situation detection ───────────────────────────────────────────────────────
async function detectSituations(supabase, clients) {
  const situations = []
  const now = Date.now()
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString()

  try {
    // activity_log.worker_id holds machine-readable event identifiers.
    // Portal writes: 'lead-followup', 'invoice-chaser', 'recall-worker', 'review-worker'
    // Specialists write: 'churn_risk', 'payment_failed', 'upsell_opportunity'
    const { data: recentEvents } = await supabase
      .from('activity_log')
      .select('client_id, worker_id, worker_name, message, metadata, created_at')
      .in('worker_id', [
        'lead-followup', 'review-worker', 'invoice-chaser',
        'recall-worker', 'churn_risk', 'payment_failed',
        'upsell_opportunity',
      ])
      .gte('created_at', oneHourAgo)
      .order('created_at', { ascending: false })
      .limit(100)

    for (const event of (recentEvents || [])) {
      const type = eventToSituation(event.worker_id)
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

// Maps activity_log.worker_id values to situation types.
// Portal writes worker_id as slug identifiers; specialists use event-code worker_ids.
function eventToSituation(workerId) {
  const map = {
    // Portal commander worker_ids
    'lead-followup':     'new_lead',
    'review-worker':     'review_new',
    'invoice-chaser':    'invoice_overdue',
    'recall-worker':     'churn_risk',
    // Specialist worker_ids written by workers agents
    'churn_risk':        'churn_risk',
    'payment_failed':    'payment_failed',
    'upsell_opportunity': 'upsell_opportunity',
  }
  return map[workerId] || null
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

  // Create a Linear issue for every HIGH/CRITICAL alert so nothing slips through
  const topEscalation = escalations[0]
  const issueTitle = `[GRIDHAND] ${severity} alert — ${topEscalation?.summary || opusReason || 'Commander escalation'}`
  const issueDesc = [
    `Commander detected a ${severity} situation requiring attention.`,
    '',
    opusReason ? `Reason: ${opusReason}` : '',
    `Total actions this cycle: ${totalActions}`,
    `Escalations (${escalations.length}):`,
    ...escalations.slice(0, 5).map(e => `- ${e.summary || e.agentId}`),
    escalations.length > 5 ? `...and ${escalations.length - 5} more.` : '',
    '',
    `Timestamp: ${new Date().toISOString()}`,
  ].filter(l => l !== null && l !== undefined).join('\n')

  await linear.createIssue({
    title:       issueTitle,
    description: issueDesc,
    priority:    severity === 'CRITICAL' ? 1 : 2,
  }).catch(() => {})
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
    // status must be 'ok' or 'error' to match all other agents — severity lives in payload
    const normalizedStatus = (severity === 'CRITICAL' || severity === 'error') ? 'error' : 'ok'
    await supabase.from('agent_runs').insert({
      agent_id: AGENT_ID,
      status: normalizedStatus,
      summary: `Commander run ${runId}: ${actionsCount} actions, severity ${severity}`,
      payload: { runId, startedAt, completedAt: new Date().toISOString(), actionsCount, severity, ...data },
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

// ── Client knowledge loader ───────────────────────────────────────────────────
// Batches a query for client_knowledge rows across all active client IDs.
// Returns a map: clientId → Array<{ category, content, created_at }>
// Limit 5 most-recent entries per client to keep context compact.
async function loadClientKnowledge(supabase, clientIds) {
  if (!clientIds || !clientIds.length) return {}
  try {
    const { data, error } = await supabase
      .from('client_knowledge')
      .select('client_id, category, content, created_at')
      .in('client_id', clientIds)
      .order('created_at', { ascending: false })
      .limit(clientIds.length * 5) // fetch up to 5 per client
    if (error) {
      console.warn(`[${AGENT_ID}] client_knowledge fetch failed: ${error.message}`)
      return {}
    }
    const map = {}
    for (const row of (data || [])) {
      if (!map[row.client_id]) map[row.client_id] = []
      if (map[row.client_id].length < 5) map[row.client_id].push(row)
    }
    return map
  } catch (err) {
    console.warn(`[${AGENT_ID}] loadClientKnowledge error: ${err.message}`)
    return {}
  }
}

// ── Worker assignment filter ──────────────────────────────────────────────────
// Loads assigned_workers for all active clients and returns a map:
//   clientId → Set of active worker_id strings
// Specialists are only dispatched to clients where the corresponding worker
// has been toggled ON in the dashboard (active = true).
async function loadAssignedWorkers(supabase, clientIds) {
  if (!clientIds.length) return {}
  const { data, error } = await supabase
    .from('assigned_workers')
    .select('client_id, worker_id')
    .in('client_id', clientIds)
    .eq('active', true)
  if (error) {
    console.warn(`[${AGENT_ID}] assigned_workers fetch failed: ${error.message} — running all specialists as fallback`)
    return null // null = fallback to full client list
  }
  const map = {}
  for (const row of data || []) {
    if (!map[row.client_id]) map[row.client_id] = new Set()
    map[row.client_id].add(row.worker_id)
  }
  return map
}

// Worker IDs that correspond to each director's division.
// These must match the worker_id values written to assigned_workers by the portal.
const DIRECTOR_WORKER_IDS = {
  'brand-director': [
    'social-manager', 'content-scheduler', 'review-orchestrator',
    'brand-sentinel', 'campaign-conductor', 'reputation-defender',
    // Arsenal
    'nova',
  ],
  'acquisition-director': [
    'lead-qualifier', 'prospect-nurturer', 'referral-activator', 'cold-outreach',
    // Arsenal
    'echo', 'pathfinder', 'apex', 'launchpad',
  ],
  'revenue-director': [
    'invoice-recovery', 'upsell-timer', 'subscription-guard', 'pricing-optimizer',
    'payment-dunner', 'revenue-forecaster',
  ],
  'experience-director': [
    'churn-predictor', 'loyalty-coordinator', 'client-success',
    'onboarding-conductor', 'milestone-celebrator', 'feedback-collector',
  ],
  'intelligence-director': [
    // Arsenal
    'pulse',
  ],
}

// ── Arsenal Registry — MJ's personal AI sales tools ─────────────────────────
// These are on-demand specialists not dispatched during automated runs.
// They are wired into their respective directors but called explicitly by MJ.
const ARSENAL_REGISTRY = {
  'echo':       { director: 'acquisition-director', description: 'Call Script Writer — tailored scripts per prospect stage and industry' },
  'pathfinder': { director: 'acquisition-director', description: 'Route Optimizer — optimal daily visit order by zone and priority' },
  'apex':       { director: 'acquisition-director', description: 'Deal Analyst — pipeline review, close/nurture/cut recommendations' },
  'launchpad':  { director: 'acquisition-director', description: 'Onboarding Coordinator — personalized GRIDHAND client setup plans' },
  'pulse':      { director: 'intelligence-director', description: 'Monthly Report Generator — ROI summaries per client' },
  'nova':       { director: 'brand-director',        description: 'Content Creator — Instagram/LinkedIn/TikTok marketing posts' },
}

// Log Arsenal availability on startup
console.log(`[GRIDHAND-COMMANDER] Arsenal loaded: ${Object.keys(ARSENAL_REGISTRY).join(', ')}`)

// ── Tool Registry — Cross-cutting capabilities available to directors ────────
// These tools are NOT dispatched on a schedule — directors invoke them when
// their specialist work needs the capability. Commander documents them here so
// any director (or a future routing layer) can discover and call the right one.
const TOOL_REGISTRY = {
  humanizer: {
    type:        'skill',
    location:    '~/.claude/skills/humanizer/SKILL.md',
    purpose:     'Rewrite AI-generated text to sound human. 37 AI-pattern detectors + 5 voice profiles.',
    useFor:      ['SMS copy', 'email copy', 'review responses', 'client-facing narrative in reports'],
    invokedBy:   ['reputation-agent', 'retention-agent', 'lead-nurture-agent', 'brand-director', 'revenue-director', 'client-health-director'],
  },
  remotion: {
    type:        'mcp',
    server:      'remotion-video',
    purpose:     'Generate videos from React components. Animated reports, brand reels, analytics videos.',
    useFor:      ['monthly client reports', 'brand video content', 'analytics dashboards as video'],
    invokedBy:   ['brand-director', 'revenue-director', 'client-health-director', 'executive-assistant', 'finance-director'],
  },
  notebooklm: {
    type:        'mcp',
    server:      'notebooklm',
    purpose:     'Query GRIDHAND knowledge bases and research notebooks for context-grounded analysis. Internal research only.',
    useFor:      ['research grounding', 'industry context', 'client-history retrieval', 'executive summaries'],
    invokedBy:   ['intelligence-director', 'acquisition-director', 'executive-assistant'],
  },
  bananaClaude: {
    type:        'mcp',
    server:      'nano-banana',
    skill:       '~/.claude/skills/banana-claude/SKILL.md',
    purpose:     'Gemini-powered image generation for brand, marketing, and content assets.',
    useFor:      ['social-post imagery', 'campaign creative', 'client brand mockups'],
    invokedBy:   ['brand-director', 'acquisition-director'],
  },
}

console.log(`[GRIDHAND-COMMANDER] Tool registry loaded: ${Object.keys(TOOL_REGISTRY).join(', ')}`)

// Given the full client list and the assignment map, return only clients that
// have at least one of this director's workers toggled on.
// Falls back to the full list when the map is null (DB error) so the run
// continues safely rather than silently doing nothing.
function filterClientsForDirector(clients, assignmentMap, directorId) {
  if (assignmentMap === null) return clients // fallback: run all
  const workerIds = DIRECTOR_WORKER_IDS[directorId] || []
  if (!workerIds.length) return clients
  return clients.filter(c => {
    const assigned = assignmentMap[c.id]
    if (!assigned) return false
    return workerIds.some(wid => assigned.has(wid))
  })
}

module.exports = {
  run,
  receive,
  AGENT_ID,
  DIVISION,
  SITUATION_ROUTING,
  ARSENAL_REGISTRY,
  TOOL_REGISTRY,
  schedule: '0 */12 * * *',
  tier: 1,
  reportsTo: 'MJ',
}
