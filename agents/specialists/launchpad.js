'use strict'
// ── ARSENAL SPECIALIST — TIER 3 ───────────────────────────────────────────────
// Launchpad — Onboarding Coordinator
// Division: experience (client success)
// Reports to: acquisition-director (Arsenal tool, MJ-facing)
// Runs: on-demand when a new GRIDHAND client is onboarded
// Description: Walks new GRIDHAND clients through AI worker setup step-by-step,
//              generates personalized onboarding plans
// ──────────────────────────────────────────────────────────────────────────────

const aiClient = require('../../lib/ai-client')
const { fileInteraction } = require('../../lib/memory-client')

const AGENT_ID   = 'launchpad'
const DIVISION   = 'acquisition'
const REPORTS_TO = 'acquisition-director'
const GROQ_MODEL = 'groq/llama-3.3-70b-versatile'

/**
 * Generate onboarding plans for new GRIDHAND clients.
 * @param {Array<{ clientId, businessName, industry, currentTools, workerCount }>} inputs
 */
async function run(inputs = []) {
  console.log(`[${AGENT_ID.toUpperCase()}] Starting run — ${inputs.length} onboarding plan(s) to generate`)
  const outcomes = []

  for (const input of inputs) {
    try {
      const result = await generateOnboardingPlan(input)
      if (result) outcomes.push(result)
    } catch (err) {
      console.error(`[${AGENT_ID}] Error for ${input.businessName || input.clientId}:`, err.message)
      outcomes.push({
        agentId: AGENT_ID,
        clientId: input.clientId,
        status: 'error',
        summary: `Onboarding plan failed: ${err.message}`,
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

async function generateOnboardingPlan(input) {
  const { clientId, businessName, industry, currentTools = [], workerCount = 1 } = input

  const systemPrompt = `<role>Onboarding Coordinator for GRIDHAND — you create step-by-step AI worker setup plans for small business owners.</role>
<rules>
- Steps must be concrete and doable by a non-technical business owner
- Each step should take 5-30 minutes
- Order steps logically: account setup → worker config → first test → live
- Reference the client's specific industry and tools where relevant
- Total plan should be completable in under 2 hours for ${workerCount} worker(s)
- Never mention Make.com — refer to "our integration layer" or "the GRIDHAND dashboard"
- Use plain language, grade 7-8 reading level
</rules>
<output>
Respond with valid JSON only:
{
  "steps": [{ "order": number, "title": "string", "action": "string", "estimatedMinutes": number }],
  "totalTime": number
}
</output>`

  const toolsList = currentTools.length ? currentTools.join(', ') : 'none listed'
  const userMsg = `Generate an onboarding plan for:
Business: ${businessName || 'New Client'}
Industry: ${industry || 'small business'}
Current Tools: ${toolsList}
Workers to set up: ${workerCount}`

  try {
    const raw = await aiClient.call({
      modelString: GROQ_MODEL,
      clientApiKeys: {},
      systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 700,
      _workerName: AGENT_ID,
      tier: 'specialist',
    })

    let parsed
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw)
    } catch {
      parsed = { steps: [], totalTime: 0 }
    }

    const steps = parsed.steps || []
    const totalTime = parsed.totalTime || steps.reduce((acc, s) => acc + (s.estimatedMinutes || 0), 0)

    return {
      agentId: AGENT_ID,
      clientId,
      timestamp: Date.now(),
      status: steps.length ? 'action_taken' : 'no_action',
      summary: `Onboarding plan for ${businessName}: ${steps.length} steps, ~${totalTime} min`,
      data: { steps, totalTime },
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount}/${outcomes.length} onboarding plans created`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
