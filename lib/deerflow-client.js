'use strict'

// DeerFlow client — submits long-horizon research tasks to the DeerFlow SuperAgent harness
// DeerFlow is a separate Railway service (Python FastAPI + LangGraph)
//
// Architecture:
//   DeerFlow gateway runs at DEERFLOW_URL (FastAPI on port 8001, exposed via Railway)
//   Runs API: POST /api/runs/wait   → blocking, returns final output
//             POST /api/runs/stream → SSE stream (not used here)
//   Health:   GET  /health          → { status: "healthy" }
//
// Setup: after deploying DeerFlow on Railway, set DEERFLOW_URL on gridhand-workers:
//   railway variables set DEERFLOW_URL=https://<deerflow-service>.up.railway.app

const DEERFLOW_URL = process.env.DEERFLOW_URL
const DEERFLOW_API_KEY = process.env.DEERFLOW_API_KEY  // optional Bearer token

/**
 * Build request headers — includes auth if DEERFLOW_API_KEY is set.
 * @returns {Record<string, string>}
 */
function _headers () {
  const h = { 'Content-Type': 'application/json' }
  if (DEERFLOW_API_KEY) h['Authorization'] = `Bearer ${DEERFLOW_API_KEY}`
  return h
}

/**
 * Submit a research task and wait for the final result (blocking).
 * Uses POST /api/runs/wait — DeerFlow runs the full agent loop and returns
 * the completed state once done.
 *
 * @param {string} task - Natural language research task
 * @param {object} opts
 * @param {string} [opts.model]        - Model name from DeerFlow config (default: 'claude-sonnet')
 * @param {string} [opts.assistantId]  - DeerFlow assistant/agent ID (default: 'lead_agent')
 * @param {number} [opts.timeoutMs]    - Max wait time in ms (default: 300000 = 5 min)
 * @param {string} [opts.threadId]     - Reuse an existing thread for conversation continuity
 * @returns {Promise<object|null>}     - DeerFlow final state object, or null on failure
 */
async function submitAndWait (task, opts = {}) {
  if (!DEERFLOW_URL) {
    console.warn('[deerflow] DEERFLOW_URL not set — skipping task submission')
    return null
  }

  const timeoutMs = opts.timeoutMs || 300000
  const assistantId = opts.assistantId || 'lead_agent'
  const modelName = opts.model || 'claude-sonnet'

  const body = {
    assistant_id: assistantId,
    input: {
      messages: [
        { role: 'human', content: task }
      ]
    },
    context: {
      model_name: modelName,
      thinking_enabled: false,
    },
    on_completion: 'keep',
    on_disconnect: 'continue',
  }

  // If a thread_id is provided, set it in config.configurable so DeerFlow
  // reuses the thread and preserves conversation history.
  if (opts.threadId) {
    body.config = { configurable: { thread_id: opts.threadId } }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${DEERFLOW_URL}/api/runs/wait`, {
      method: 'POST',
      headers: _headers(),
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[deerflow] Run failed: HTTP ${res.status} — ${text}`)
      return null
    }

    const data = await res.json()
    return data
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`[deerflow] Task timed out after ${timeoutMs}ms`)
    } else {
      console.warn('[deerflow] Task submission error:', err.message)
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Extract the final text answer from a DeerFlow run result.
 * DeerFlow returns a LangGraph state object — the answer is in the last
 * AI message in the messages array.
 *
 * @param {object|null} result - Output from submitAndWait
 * @returns {string|null}
 */
function extractAnswer (result) {
  if (!result) return null

  // LangGraph state format: { messages: [...] }
  const messages = result.messages || result?.values?.messages || []
  if (!messages.length) return null

  // Walk backward to find the last AI/assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const role = msg.type || msg.role
    if (role === 'ai' || role === 'assistant') {
      return typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          : null
    }
  }

  return null
}

/**
 * Convenience wrapper — submit a research task and return the extracted text answer.
 *
 * @param {string} task - Natural language research task
 * @param {object} opts - Same as submitAndWait opts
 * @returns {Promise<string|null>}
 */
async function research (task, opts = {}) {
  const result = await submitAndWait(task, opts)
  return extractAnswer(result)
}

/**
 * Health check — verify DeerFlow service is reachable.
 * @returns {Promise<boolean>}
 */
async function ping () {
  if (!DEERFLOW_URL) return false
  try {
    const res = await fetch(`${DEERFLOW_URL}/health`, {
      headers: _headers(),
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json()
    return data?.status === 'healthy'
  } catch {
    return false
  }
}

/**
 * Structured research wrapper — submit a research task and return a structured object.
 * Alias-style export over `research()` that returns { ok, answer, raw } so callers
 * can branch on success/failure without inspecting null vs string.
 *
 * @param {string} task - Natural language research task
 * @param {object} opts - Same as submitAndWait opts
 * @returns {Promise<{ ok: boolean, answer: string|null, raw: object|null, reason?: string }>}
 */
async function researchStructured (task, opts = {}) {
  if (!DEERFLOW_URL) {
    return { ok: false, answer: null, raw: null, reason: 'DEERFLOW_URL not set' }
  }
  const raw = await submitAndWait(task, opts)
  if (!raw) {
    return { ok: false, answer: null, raw: null, reason: 'submission_failed_or_timeout' }
  }
  const answer = extractAnswer(raw)
  if (!answer) {
    return { ok: false, answer: null, raw, reason: 'no_answer_extracted' }
  }
  return { ok: true, answer, raw }
}

/**
 * Availability check — alias for ping(). Returns true when the DeerFlow service
 * is reachable and reports healthy.
 * @returns {Promise<boolean>}
 */
async function isAvailable () {
  return ping()
}

module.exports = { submitAndWait, extractAnswer, research, ping, researchStructured, isAvailable }
