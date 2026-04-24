'use strict'
// ── ARSENAL SPECIALIST — TIER 3 ───────────────────────────────────────────────
// Pathfinder — Route Optimizer
// Division: acquisition
// Reports to: acquisition-director
// Runs: on-demand (MJ personal sales tool)
// Description: Plans optimal daily visit order for MJ by zone, priority, and
//              estimated travel time
// ──────────────────────────────────────────────────────────────────────────────

const aiClient = require('../../lib/ai-client')
const { fileInteraction } = require('../../lib/memory-client')

const AGENT_ID   = 'pathfinder'
const DIVISION   = 'acquisition'
const REPORTS_TO = 'acquisition-director'
const GROQ_MODEL = 'groq/llama-3.3-70b-versatile'

/**
 * Plan optimal visit route for MJ.
 * @param {Array<{ visits: Array<{ businessName, address, priority, estimatedDuration }> }>} inputs
 */
async function run(inputs = []) {
  console.log(`[${AGENT_ID.toUpperCase()}] Starting run — ${inputs.length} route request(s)`)
  const outcomes = []

  for (const input of inputs) {
    try {
      const result = await planRoute(input)
      if (result) outcomes.push(result)
    } catch (err) {
      console.error(`[${AGENT_ID}] Error:`, err.message)
      outcomes.push({
        agentId: AGENT_ID,
        clientId: input.clientId || null,
        status: 'error',
        summary: `Route planning failed: ${err.message}`,
        data: null,
        requiresDirectorAttention: false,
      })
    }
  }

  const specialistReport = await report(outcomes)
  await fileInteraction(specialistReport, {
    workerId: AGENT_ID,
    interactionType: 'specialist_run',
  }).catch(() => {})

  return specialistReport
}

async function planRoute(input) {
  const { visits = [], clientId } = input

  if (!visits.length) {
    return {
      agentId: AGENT_ID,
      clientId: clientId || null,
      timestamp: Date.now(),
      status: 'no_action',
      summary: 'No visits provided to optimize',
      data: { orderedVisits: [], estimatedTotalTime: 0, zones: [] },
      requiresDirectorAttention: false,
    }
  }

  const systemPrompt = `<role>Route Optimizer for GRIDHAND — you plan the most efficient daily visit order for a field sales rep (MJ).</role>
<rules>
- Group stops by geographic zone/area to minimize backtracking
- Within each zone, prioritize by priority score (1=highest)
- Consider estimatedDuration when calculating total time
- Add travel buffer of 15 minutes between zones, 5 minutes within zones
- Keep the plan realistic for a single business day (max 8 hours)
</rules>
<output>
Respond with valid JSON only:
{
  "orderedVisits": [{ "businessName": "string", "address": "string", "priority": number, "estimatedDuration": number, "zone": "string", "order": number }],
  "estimatedTotalTime": number,
  "zones": [{ "name": "string", "stopCount": number }]
}
</output>`

  const visitList = visits.map((v, i) =>
    `${i + 1}. ${v.businessName} — ${v.address} — priority ${v.priority || 3} — ${v.estimatedDuration || 30}min`
  ).join('\n')

  const userMsg = `Optimize this visit route:\n${visitList}`

  try {
    const raw = await aiClient.call({
      modelString: GROQ_MODEL,
      clientApiKeys: {},
      systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 600,
      _workerName: AGENT_ID,
    })

    let parsed
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw)
    } catch {
      parsed = { orderedVisits: visits, estimatedTotalTime: 0, zones: [] }
    }

    return {
      agentId: AGENT_ID,
      clientId: clientId || null,
      timestamp: Date.now(),
      status: 'action_taken',
      summary: `Optimized route for ${visits.length} visit(s) — est. ${parsed.estimatedTotalTime || '?'} min total`,
      data: {
        orderedVisits: parsed.orderedVisits || visits,
        estimatedTotalTime: parsed.estimatedTotalTime || 0,
        zones: parsed.zones || [],
      },
      requiresDirectorAttention: false,
    }
  } catch (err) {
    throw new Error(`AI call failed: ${err.message}`)
  }
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount}/${outcomes.length} routes planned`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
