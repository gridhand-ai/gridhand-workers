'use strict'
// ── GRIDHAND SPECIALIST — TIER 2 ─────────────────────────────────────────────
// Codename: FORGE-PE (Prompt Engineer)
// Role: Audits, scores, and optimizes system prompts used by all agents in the
//       GRIDHAND fleet. Reads every agent file, extracts prompts via regex,
//       scores token efficiency / clarity / hierarchy alignment, generates
//       optimized versions, and writes a full report to docs/WORKER_UPGRADES.md.
//       NEVER overwrites agent files — report only. MJ decides what to apply.
// Division: intelligence
// Model: groq/llama-3.3-70b-versatile
// Reports to: intelligence-director
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs')
const path = require('path')
const { call } = require('../../lib/ai-client')

const SPECIALIST_ID = 'prompt-engineer'
const DIVISION      = 'intelligence'
const MODEL         = 'groq/llama-3.3-70b-versatile'

// Root of the workers repo — two levels up from agents/specialists/
const WORKERS_ROOT    = path.resolve(__dirname, '..', '..')
const AGENTS_DIR      = path.join(WORKERS_ROOT, 'agents')
const SPECIALISTS_DIR = path.join(WORKERS_ROOT, 'agents', 'specialists')
const DOCS_DIR        = path.join(WORKERS_ROOT, 'docs')
const REPORT_PATH     = path.join(DOCS_DIR, 'WORKER_UPGRADES.md')

// ── System prompt for FORGE-PE itself ────────────────────────────────────────
const FORGE_PE_SYSTEM = `<role>
You are FORGE-PE, the Prompt Engineer for GRIDHAND AI. Your job is to audit, score, and optimize system prompts used by all agents in the fleet. You are ruthless about clarity, token efficiency, and hierarchy alignment.
</role>

<scoring>
Score each prompt on three dimensions (0-100 each):
- Token Efficiency: Does it achieve its goal with minimal words? Remove redundancy ruthlessly.
- Clarity: Is the agent's job crystal clear? Could a new model follow it perfectly on first read?
- Hierarchy Alignment: Does the agent know its place in the GRIDHAND structure (Director → Specialist → Worker)? Does it know who it reports to and who it commands?
</scoring>

<optimization_rules>
- Use XML tags for all multi-section prompts (<role>, <rules>, <output>)
- Lead with the role identity — what the agent IS, not what it does
- Put behavioral constraints in <rules>, not scattered throughout
- Output format always last, in <output>
- Remove filler phrases: "You are a helpful...", "Your goal is to...", "Please ensure..."
- Every rule must be actionable — if it can't be violated, remove it
- Keep prompts under 400 tokens where possible
- Never mention Make.com, never include healthcare/dental/medical contexts
</optimization_rules>

<output>
For each agent, return a JSON array. Each element:
{
  "agentId": "...",
  "currentScores": { "tokenEfficiency": N, "clarity": N, "hierarchyAlignment": N },
  "issues": ["...", "..."],
  "optimizedPrompt": "...",
  "estimatedTokenSavings": N
}
Return the array only — no preamble, no markdown fences.
</output>`

// ── File scanning helpers ─────────────────────────────────────────────────────

/** Return all .js files directly in a directory (non-recursive) */
function scanDir(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.js'))
      .map(f => path.join(dir, f))
  } catch { return [] }
}

/** Extract the first system prompt from a JS source string.
 *  Looks for: const *_SYSTEM, const *_PROMPT, const systemPrompt, or
 *  a template literal that starts with <role> */
function extractPrompt(source) {
  // Named variable patterns — capture everything between backticks
  const patterns = [
    /(?:const|let|var)\s+\w*(?:SYSTEM|PROMPT|systemPrompt)\w*\s*=\s*`([\s\S]*?)`/,
    /(?:systemPrompt|system_prompt)\s*[:=]\s*`([\s\S]*?)`/,
    // Template literal containing <role> tag
    /`(<role>[\s\S]*?<\/role>[\s\S]*?)`/,
  ]
  for (const re of patterns) {
    const m = source.match(re)
    if (m && m[1].trim().length > 20) return m[1].trim()
  }
  return null
}

/** Collect all agent files with their extracted prompts */
function collectAgents(targetAgents = []) {
  const topLevel    = scanDir(AGENTS_DIR)
  const specialists = scanDir(SPECIALISTS_DIR)
  const allFiles    = [...topLevel, ...specialists]

  const agents = []
  for (const filePath of allFiles) {
    const agentId = path.basename(filePath, '.js')

    // Skip self — don't audit the auditor
    if (agentId === SPECIALIST_ID) continue
    if (targetAgents.length && !targetAgents.includes(agentId)) continue

    let source = ''
    try { source = fs.readFileSync(filePath, 'utf8') } catch { continue }

    const prompt = extractPrompt(source)
    if (!prompt) continue // no extractable system prompt — skip

    const isSpecialist = filePath.includes('/specialists/')
    const relPath      = isSpecialist
      ? `agents/specialists/${agentId}.js`
      : `agents/${agentId}.js`

    agents.push({ agentId, filePath: relPath, prompt })
  }
  return agents
}

// ── AI scoring in batches of 5 ────────────────────────────────────────────────

async function scoreBatch(batch) {
  const payload = batch.map(a => ({
    agentId:       a.agentId,
    currentPrompt: a.prompt,
  }))

  try {
    const raw = await call({
      modelString:  MODEL,
      systemPrompt: FORGE_PE_SYSTEM,
      messages: [{
        role:    'user',
        content: `Audit these agent prompts and return a JSON array of results:\n\n${JSON.stringify(payload, null, 2)}`,
      }],
      maxTokens:   2000,
      _workerName: SPECIALIST_ID,
      tier:        'specialist',
    })

    // Strip markdown fences if model wrapped the response
    const cleaned = (raw || '').replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim()
    const match   = cleaned.match(/\[[\s\S]*\]/)
    if (match) return JSON.parse(match[0])
  } catch (err) {
    console.warn(`[${SPECIALIST_ID.toUpperCase()}] Batch scoring failed:`, err.message)
  }
  return []
}

async function scoreAllAgents(agents) {
  const BATCH_SIZE = 5
  const results    = []

  for (let i = 0; i < agents.length; i += BATCH_SIZE) {
    const batch = agents.slice(i, i + BATCH_SIZE)
    console.log(`[${SPECIALIST_ID.toUpperCase()}] Scoring batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(agents.length / BATCH_SIZE)} (${batch.map(a => a.agentId).join(', ')})`)
    const batchResults = await scoreBatch(batch)

    // Merge file path back in from the original list
    for (const result of batchResults) {
      const original = agents.find(a => a.agentId === result.agentId)
      results.push({ ...result, filePath: original?.filePath || 'unknown' })
    }
  }
  return results
}

// ── Report generation ─────────────────────────────────────────────────────────

function buildReport(results, toolFindings) {
  const timestamp = new Date().toISOString()

  const withScores = results.filter(r => r.currentScores)
  const avgEff   = withScores.length ? Math.round(withScores.reduce((s, r) => s + (r.currentScores?.tokenEfficiency || 0), 0) / withScores.length) : 0
  const avgClar  = withScores.length ? Math.round(withScores.reduce((s, r) => s + (r.currentScores?.clarity || 0), 0) / withScores.length) : 0
  const avgHier  = withScores.length ? Math.round(withScores.reduce((s, r) => s + (r.currentScores?.hierarchyAlignment || 0), 0) / withScores.length) : 0
  const totalSav = results.reduce((s, r) => s + (r.estimatedTokenSavings || 0), 0)

  const lines = [
    '# GRIDHAND Worker Upgrades Report',
    `Generated: ${timestamp}`,
    '',
    '## Summary',
    `- Agents audited: ${results.length}`,
    `- Average token efficiency: ${avgEff}`,
    `- Average clarity: ${avgClar}`,
    `- Average hierarchy alignment: ${avgHier}`,
    `- Total estimated token savings: ${totalSav} tokens/run`,
    '',
    '---',
    '',
    '## Agent Reports',
    '',
  ]

  for (const r of results) {
    const scores = r.currentScores || {}
    lines.push(`### ${r.agentId}`)
    lines.push(`**File:** ${r.filePath}`)
    lines.push(`**Current scores:** Token efficiency: ${scores.tokenEfficiency ?? 'N/A'} | Clarity: ${scores.clarity ?? 'N/A'} | Hierarchy: ${scores.hierarchyAlignment ?? 'N/A'}`)

    if (r.issues?.length) {
      lines.push('**Issues found:**')
      for (const issue of r.issues) {
        lines.push(`- ${issue}`)
      }
    }

    if (r.optimizedPrompt) {
      lines.push('**Optimized prompt:**')
      lines.push('```')
      lines.push(r.optimizedPrompt)
      lines.push('```')
    }

    lines.push(`**Estimated savings:** ${r.estimatedTokenSavings ?? 0} tokens`)
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('## Recommended MCPs & Tools by Division')
  lines.push('')

  if (toolFindings) {
    lines.push(toolFindings)
  } else {
    lines.push('_Research not available — run with web search enabled._')
  }

  lines.push('')
  lines.push('---')
  lines.push(`_Report generated by FORGE-PE (${SPECIALIST_ID}) — GRIDHAND AI Intelligence Division_`)

  return lines.join('\n')
}

function writeReport(content) {
  try {
    if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true })
    fs.writeFileSync(REPORT_PATH, content, 'utf8')
    console.log(`[${SPECIALIST_ID.toUpperCase()}] Report written to ${REPORT_PATH}`)
    return true
  } catch (err) {
    console.error(`[${SPECIALIST_ID.toUpperCase()}] Failed to write report:`, err.message)
    return false
  }
}

// ── Tool research section ─────────────────────────────────────────────────────

async function researchDivisionTools() {
  const queries = [
    { division: 'Acquisition', query: 'best lead generation and cold outreach automation APIs 2025' },
    { division: 'Intelligence', query: 'best web scraping and competitive intelligence APIs 2025' },
    { division: 'Brand/Social', query: 'social media monitoring and scheduling API 2025' },
    { division: 'Revenue', query: 'invoice automation and subscription management API 2025' },
    { division: 'Experience', query: 'customer success platform API 2025' },
  ]

  const sectionLines = []

  for (const { division, query } of queries) {
    try {
      const raw = await call({
        modelString:  MODEL,
        systemPrompt: `<role>
You are a technical researcher for GRIDHAND AI. You find the best external APIs and tools for specific business divisions.
</role>
<rules>
- Return 3-4 specific named tools/APIs with: name, what it does, why it fits
- Keep each entry to 2-3 sentences max
- Focus on APIs with good developer experience and clear pricing
- No filler or marketing language
</rules>
<output>
Return a markdown list, no headers, just bullet points.
</output>`,
        messages: [{
          role:    'user',
          content: `Research query: ${query}\n\nList the top 3-4 tools for the ${division} division of a small business AI workforce platform.`,
        }],
        maxTokens:   400,
        _workerName: SPECIALIST_ID,
        tier:        'specialist',
      })

      sectionLines.push(`### ${division}`)
      sectionLines.push(raw?.trim() || '_No results returned._')
      sectionLines.push('')
    } catch (err) {
      console.warn(`[${SPECIALIST_ID.toUpperCase()}] Tool research failed for ${division}:`, err.message)
      sectionLines.push(`### ${division}`)
      sectionLines.push('_Research failed — check Groq availability._')
      sectionLines.push('')
    }
  }

  return sectionLines.join('\n')
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run(targetAgents = []) {
  console.log(`[${SPECIALIST_ID.toUpperCase()}] Starting prompt audit${targetAgents.length ? ` (targeting: ${targetAgents.join(', ')})` : ' (all agents)'}`)

  let agents   = []
  let results  = []
  let written  = false
  let toolText = null

  try {
    // 1. Collect all agent files with extractable prompts
    agents = collectAgents(targetAgents)
    console.log(`[${SPECIALIST_ID.toUpperCase()}] Found ${agents.length} agents with extractable prompts`)

    if (!agents.length) {
      return {
        agentId:      SPECIALIST_ID,
        division:     DIVISION,
        actionsCount: 0,
        escalations:  [],
        outcomes: [{
          status:  'no_prompts',
          summary: 'FORGE-PE: No extractable system prompts found in agent files.',
        }],
      }
    }

    // 2. Score + optimize all agents in batches
    results = await scoreAllAgents(agents)

    // 3. Research tools per division (non-blocking — failure is acceptable)
    try {
      toolText = await researchDivisionTools()
    } catch (err) {
      console.warn(`[${SPECIALIST_ID.toUpperCase()}] Tool research skipped:`, err.message)
    }

    // 4. Build and write the report
    const reportContent = buildReport(results, toolText)
    written = writeReport(reportContent)

  } catch (err) {
    console.error(`[${SPECIALIST_ID.toUpperCase()}] Run failed:`, err.message)
    return {
      agentId:      SPECIALIST_ID,
      division:     DIVISION,
      actionsCount: 0,
      escalations:  [],
      outcomes: [{ status: 'error', summary: `FORGE-PE failed: ${err.message}` }],
    }
  }

  // 5. Compute summary stats
  const withScores = results.filter(r => r.currentScores)
  const lowEfficiency = withScores.filter(r => (r.currentScores?.tokenEfficiency || 0) < 60)
  const totalSavings  = results.reduce((s, r) => s + (r.estimatedTokenSavings || 0), 0)

  const summary = `FORGE-PE: ${agents.length} agents audited, ${results.length} scored. ${lowEfficiency.length} need token efficiency work. Est. ${totalSavings} tokens saved/run. Report: docs/WORKER_UPGRADES.md`
  console.log(`[${SPECIALIST_ID.toUpperCase()}] ${summary}`)

  return {
    agentId:      SPECIALIST_ID,
    division:     DIVISION,
    actionsCount: results.length,
    escalations:  lowEfficiency.map(r => ({
      clientId:                  'system',
      data:                      { agentId: r.agentId, scores: r.currentScores, issues: r.issues, type: 'low_prompt_efficiency' },
      requiresDirectorAttention: (r.currentScores?.tokenEfficiency || 0) < 40,
    })),
    outcomes: [{
      status:         written ? 'action_taken' : 'partial',
      agentsAudited:  agents.length,
      agentsScored:   results.length,
      totalSavings,
      reportWritten:  written,
      reportPath:     REPORT_PATH,
      summary,
    }],
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION }
