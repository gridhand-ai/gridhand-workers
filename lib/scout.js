'use strict'
// ── GRIDHAND SCOUT MODULE ─────────────────────────────────────────────────────
// Scout reads everything with Groq/Ollama — no limits on input.
// Produces a comprehensive brief for Opus to act on.
// Rule: Scout burns Groq/Ollama (free). Opus only touches the brief output.
// ─────────────────────────────────────────────────────────────────────────────

const { call } = require('./ai-client')

// Scout uses tier='standard' — Ollama first (when OLLAMA_BASE_URL set), Groq 70b fallback.
// Old hardcoded fallback model retained for last-resort raw passthrough only.
const FALLBACK_MODEL = 'ollama/qwen3:8b'

const SCOUT_SYSTEM = `You are the intelligence analyst for GRIDHAND AI.
Your job: read ALL raw context and extract everything relevant to the task.

Rules:
- Be exhaustive, not brief. More detail = better Opus performance.
- Include numbers, dates, names, patterns, anomalies, history.
- Flag anything unusual, at-risk, or requiring special attention.
- Note what's working well and what isn't.
- Format with clear labeled sections so Opus can navigate fast.
- Never summarize away a specific fact — keep all specifics.`

/**
 * Core scout function.
 * @param {string} task - What Opus will be doing with this brief
 * @param {Array<{label: string, content: any}>} sources - Everything to read
 * @param {number} maxTokens - Max output tokens (default 4000 — be generous)
 */
async function scout({ task, sources, maxTokens = 4000 }) {
  const contextBlock = sources
    .map(s => {
      const body = typeof s.content === 'object'
        ? JSON.stringify(s.content, null, 2)
        : String(s.content || '')
      return `<${s.label}>\n${body}\n</${s.label}>`
    })
    .join('\n\n')

  const message = `TASK OPUS WILL PERFORM: ${task}

RAW CONTEXT (read everything, extract all relevant details):
${contextBlock}

Produce a comprehensive intelligence brief. Include every detail, pattern, constraint, and piece of history that will help Opus perform this task at the highest level. Do not omit specifics.`

  // tier='standard' — ai-client routes Ollama first (if OLLAMA_BASE_URL is set)
  // and falls back to Groq llama-3.3-70b-versatile if Ollama is unreachable or
  // returns a low-quality response. Provider used is logged inside ai-client.
  try {
    const brief = await call({
      tier: 'standard',
      systemPrompt: SCOUT_SYSTEM,
      messages: [{ role: 'user', content: message }],
      maxTokens,
      _workerName: 'scout',
    })
    if (brief && brief.length > 50) return brief
  } catch (err) {
    console.warn('[SCOUT] standard tier unavailable:', err.message)
  }

  // Last-ditch fallback: try raw Ollama directly via legacy modelString path
  try {
    const brief = await call({
      modelString: FALLBACK_MODEL,
      systemPrompt: SCOUT_SYSTEM,
      messages: [{ role: 'user', content: message }],
      maxTokens,
    })
    if (brief && brief.length > 50) return brief
  } catch (err) {
    console.warn('[SCOUT] Ollama legacy fallback also unavailable:', err.message)
  }

  // Last resort: pass raw context to Opus (still better than nothing)
  return `[Scout unavailable — raw context below]\n\n${contextBlock.slice(0, 8000)}`
}

/**
 * Scout a Supabase client list — reads full client profiles.
 */
async function scoutClients({ clients, task, extras = [] }) {
  const sources = [
    { label: 'active_clients', content: clients },
    ...extras,
  ]
  return scout({ task, sources })
}

/**
 * Scout disk files — reads as much as Groq can handle per file.
 */
async function scoutFiles({ filePaths, task, extras = [] }) {
  const fs = require('fs')
  const sources = filePaths
    .filter(p => { try { return fs.existsSync(p) } catch { return false } })
    .map(p => ({
      label: p.split('/').pop(),
      content: fs.readFileSync(p, 'utf8'), // no size limit — Groq handles it
    }))
  return scout({ task, sources: [...sources, ...extras] })
}

/**
 * Scout arbitrary key-value context (DB rows, API responses, etc.)
 */
async function scoutData({ data, task }) {
  const sources = Object.entries(data).map(([label, content]) => ({ label, content }))
  return scout({ task, sources })
}

module.exports = { scout, scoutClients, scoutFiles, scoutData }
