'use strict'
// ── ARSENAL SPECIALIST — TIER 3 ───────────────────────────────────────────────
// Pulse — Monthly Report Generator
// Division: intelligence
// Reports to: intelligence-director
// Runs: monthly (on-demand via Arsenal)
// Description: Auto-generates ROI summaries per client — calls handled, leads
//              captured, revenue impact, hours saved
// ──────────────────────────────────────────────────────────────────────────────

const aiClient = require('../../lib/ai-client')
const { fileInteraction } = require('../../lib/memory-client')

const AGENT_ID   = 'pulse'
const DIVISION   = 'intelligence'
const REPORTS_TO = 'intelligence-director'
// quality_escalate: Groq first, escalates to Sonnet only if report quality fails
const GROQ_MODEL = 'groq/llama-3.3-70b-versatile'

/**
 * Generate monthly ROI reports for clients.
 * @param {Array<{ clientId, businessName, month, callsHandled, leadsCapture, reviewsGenerated, estimatedRevenue }>} inputs
 */
async function run(inputs = []) {
  console.log(`[${AGENT_ID.toUpperCase()}] Starting run — ${inputs.length} monthly report(s) to generate`)
  const outcomes = []

  for (const input of inputs) {
    try {
      const result = await generateReport(input)
      if (result) outcomes.push(result)
    } catch (err) {
      console.error(`[${AGENT_ID}] Error for ${input.businessName || input.clientId}:`, err.message)
      outcomes.push({
        agentId: AGENT_ID,
        clientId: input.clientId,
        status: 'error',
        summary: `Monthly report failed: ${err.message}`,
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

async function generateReport(input) {
  const {
    clientId,
    businessName,
    month,
    callsHandled = 0,
    leadsCapture = 0,
    reviewsGenerated = 0,
    estimatedRevenue = 0,
  } = input

  // Estimate hours saved: 3 min per call, 5 min per lead, 8 min per review
  const hoursSaved = Math.round(((callsHandled * 3) + (leadsCapture * 5) + (reviewsGenerated * 8)) / 60)

  const systemPrompt = `<role>ROI Report Generator for GRIDHAND — you write clear, compelling monthly performance reports for small business clients.</role>
<rules>
- Lead with the most impressive metric in the first sentence
- Quantify everything — "saved X hours", "captured Y leads", "handled Z calls"
- Tone: confident, professional, outcome-first — not salesy
- Avoid jargon — business owner should understand every sentence
- Never say "AI software" — use "your GRIDHAND worker" or "your AI team"
- Never mention Make.com
- Keep summary under 120 words
- HTML report should use simple inline styles, no external CSS
</rules>
<output>
Respond with valid JSON only:
{
  "reportHtml": "full HTML as a string",
  "summary": "plain text summary under 120 words",
  "highlights": ["highlight1", "highlight2", "highlight3"]
}
</output>`

  const userMsg = `Generate a monthly performance report for:
Business: ${businessName || 'Client'}
Month: ${month || new Date().toLocaleString('default', { month: 'long', year: 'numeric' })}
Calls Handled: ${callsHandled}
Leads Captured: ${leadsCapture}
Reviews Generated: ${reviewsGenerated}
Estimated Revenue Impact: $${estimatedRevenue}
Hours Saved: ${hoursSaved}`

  try {
    const raw = await aiClient.call({
      modelString: GROQ_MODEL,
      tier: 'quality_escalate',
      clientApiKeys: {},
      systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 1200,
      _workerName: AGENT_ID,
    })

    let parsed
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw)
    } catch {
      parsed = {
        reportHtml: `<p>${raw}</p>`,
        summary: raw || 'Report generation incomplete.',
        highlights: [],
      }
    }

    return {
      agentId: AGENT_ID,
      clientId,
      timestamp: Date.now(),
      status: 'action_taken',
      summary: `Monthly report generated for ${businessName} (${month}): ${callsHandled} calls, ${leadsCapture} leads, $${estimatedRevenue} impact`,
      data: {
        reportHtml:  parsed.reportHtml || '',
        summary:     parsed.summary || '',
        highlights:  parsed.highlights || [],
        metrics: { callsHandled, leadsCapture, reviewsGenerated, estimatedRevenue, hoursSaved },
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
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount}/${outcomes.length} monthly reports generated`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
