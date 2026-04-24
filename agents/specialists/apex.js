'use strict'
// ── ARSENAL SPECIALIST — TIER 3 ───────────────────────────────────────────────
// Apex — Deal Analyst
// Division: acquisition
// Reports to: acquisition-director
// Runs: on-demand (MJ personal sales tool)
// Description: Reviews full pipeline, identifies who's close/stalling/should
//              be cut, with strategic recommendations
// ──────────────────────────────────────────────────────────────────────────────

const aiClient = require('../../lib/ai-client')
const { fileInteraction } = require('../../lib/memory-client')

const AGENT_ID   = 'apex'
const DIVISION   = 'acquisition'
const REPORTS_TO = 'acquisition-director'
// Claude for strategic judgment — deal analysis requires nuanced reasoning
const CLAUDE_MODEL = 'claude-sonnet-4-5'

/**
 * Analyze the sales pipeline and surface who to close, nurture, or cut.
 * @param {Array<{ clientId?, pipeline: Array<{ businessName, stage, lastContact, value, notes }> }>} inputs
 */
async function run(inputs = []) {
  console.log(`[${AGENT_ID.toUpperCase()}] Starting run — ${inputs.length} pipeline(s) to analyze`)
  const outcomes = []

  for (const input of inputs) {
    try {
      const result = await analyzePipeline(input)
      if (result) outcomes.push(result)
    } catch (err) {
      console.error(`[${AGENT_ID}] Error:`, err.message)
      outcomes.push({
        agentId: AGENT_ID,
        clientId: input.clientId || null,
        status: 'error',
        summary: `Deal analysis failed: ${err.message}`,
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

async function analyzePipeline(input) {
  const { clientId, pipeline = [] } = input

  if (!pipeline.length) {
    return {
      agentId: AGENT_ID,
      clientId: clientId || null,
      timestamp: Date.now(),
      status: 'no_action',
      summary: 'No pipeline deals to analyze',
      data: { closeNow: [], nurture: [], cut: [], recommendations: 'Pipeline is empty.' },
      requiresDirectorAttention: false,
    }
  }

  const systemPrompt = `<role>Deal Analyst for GRIDHAND — you review sales pipelines and make clear, decisive recommendations for a field sales rep (MJ).</role>
<rules>
- Be direct and specific — no vague advice
- closeNow = prospects with buying signals, recent contact, and strong fit
- nurture = has potential but needs more touches or is early stage
- cut = no contact in 30+ days with no momentum, or clearly not a fit
- Recommendations must be actionable (specific next steps)
- If a deal has been in the same stage for 14+ days with no notes, lean toward cut
- Never mention Make.com — refer to "our integration layer" if relevant
</rules>
<output>
Respond with valid JSON only:
{
  "closeNow": [{ "businessName": "string", "reason": "string" }],
  "nurture": [{ "businessName": "string", "nextStep": "string" }],
  "cut": [{ "businessName": "string", "reason": "string" }],
  "recommendations": "overall pipeline strategy in 2-3 sentences"
}
</output>`

  const dealList = pipeline.map((d, i) =>
    `${i + 1}. ${d.businessName} | Stage: ${d.stage} | Last Contact: ${d.lastContact || 'unknown'} | Value: $${d.value || 0} | Notes: ${d.notes || 'none'}`
  ).join('\n')

  const userMsg = `Analyze this pipeline:\n${dealList}`

  try {
    const raw = await aiClient.call({
      modelString: CLAUDE_MODEL,
      clientApiKeys: {},
      systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 800,
      _workerName: AGENT_ID,
    })

    let parsed
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw)
    } catch {
      parsed = { closeNow: [], nurture: [], cut: [], recommendations: raw || 'Analysis incomplete.' }
    }

    const closeCount = (parsed.closeNow || []).length
    const cutCount   = (parsed.cut || []).length

    return {
      agentId: AGENT_ID,
      clientId: clientId || null,
      timestamp: Date.now(),
      status: 'action_taken',
      summary: `Pipeline analyzed: ${closeCount} close now, ${(parsed.nurture || []).length} nurture, ${cutCount} cut`,
      data: {
        closeNow:        parsed.closeNow || [],
        nurture:         parsed.nurture || [],
        cut:             parsed.cut || [],
        recommendations: parsed.recommendations || '',
      },
      requiresDirectorAttention: closeCount > 0,
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} pipeline(s) analyzed`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
