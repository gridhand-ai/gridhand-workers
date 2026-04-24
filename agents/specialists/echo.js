'use strict'
// ── ARSENAL SPECIALIST — TIER 3 ───────────────────────────────────────────────
// Echo — Call Script Writer
// Division: acquisition
// Reports to: acquisition-director
// Runs: on-demand (MJ personal sales tool)
// Description: Generates tailored call scripts per business based on pipeline
//              stage, industry, and last touchpoint
// ──────────────────────────────────────────────────────────────────────────────

const aiClient = require('../../lib/ai-client')
const { fileInteraction } = require('../../lib/memory-client')

const AGENT_ID   = 'echo'
const DIVISION   = 'acquisition'
const REPORTS_TO = 'acquisition-director'
const GROQ_MODEL = 'groq/llama-3.3-70b-versatile'

/**
 * Generate call scripts for a list of prospect/client contexts.
 * @param {Array<{ clientId, businessName, industry, pipelineStage, lastTouchpoint }>} inputs
 */
async function run(inputs = []) {
  console.log(`[${AGENT_ID.toUpperCase()}] Starting run — ${inputs.length} script request(s)`)
  const outcomes = []

  for (const input of inputs) {
    try {
      const result = await generateScript(input)
      if (result) outcomes.push(result)
    } catch (err) {
      console.error(`[${AGENT_ID}] Error for ${input.businessName || input.clientId}:`, err.message)
      outcomes.push({
        agentId: AGENT_ID,
        clientId: input.clientId,
        status: 'error',
        summary: `Script generation failed: ${err.message}`,
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

async function generateScript(input) {
  const { clientId, businessName, industry, pipelineStage, lastTouchpoint } = input

  const systemPrompt = `<role>Call Script Writer for GRIDHAND — you write tailored, concise sales call scripts for MJ, a field sales rep.</role>
<rules>
- Scripts must be natural-sounding, not robotic
- Keep opening under 15 seconds
- Include specific objection handlers for common pushbacks
- Talking points must reference the prospect's industry and stage
- Never mention Make.com — refer to "direct integrations" if relevant
- Grade 7-8 reading level, conversational tone
</rules>
<output>
Respond with valid JSON only:
{
  "script": "full call script as a string with [PAUSE] markers",
  "talkingPoints": ["point1", "point2", "point3"],
  "objectionHandlers": [{ "objection": "string", "response": "string" }]
}
</output>`

  const userMsg = `Generate a call script for:
Business: ${businessName || 'Unknown'}
Industry: ${industry || 'small business'}
Pipeline Stage: ${pipelineStage || 'cold'}
Last Touchpoint: ${lastTouchpoint || 'none'}`

  try {
    const raw = await aiClient.call({
      modelString: GROQ_MODEL,
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
      parsed = {
        script: raw || 'Script generation returned no content.',
        talkingPoints: [],
        objectionHandlers: [],
      }
    }

    return {
      agentId: AGENT_ID,
      clientId,
      timestamp: Date.now(),
      status: 'action_taken',
      summary: `Call script generated for ${businessName} (stage: ${pipelineStage})`,
      data: {
        script: parsed.script || '',
        talkingPoints: parsed.talkingPoints || [],
        objectionHandlers: parsed.objectionHandlers || [],
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount}/${outcomes.length} scripts generated`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
