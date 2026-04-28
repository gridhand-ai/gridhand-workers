'use strict'
// ── GRIDHAND EXECUTIVE ASSISTANT ─────────────────────────────────────────────
// Layer 2 between MJ (CEO) and Claude Code CFO.
// Always-on via Telegram. Routes MJ's direction into the task queue.
// Asks CFO for updates, escalates to MJ only when genuinely needed.
//
// Chain: MJ → EA → CFO → Directors → Specialists → Workers
//
// Model: Sonnet (routing decisions) + Opus (strategic judgment when needed)
// Status: Foundation — full Telegram integration wired via server.js
// ─────────────────────────────────────────────────────────────────────────────

const { call }   = require('../lib/ai-client')
const { scout }  = require('../lib/scout')
const { notify } = require('../lib/terminal-notifier')
const { createClient } = require('@supabase/supabase-js')

// ── New Tools Available (2026-04-27) ──────────────────────────────────────────
// humanizer  — ~/.claude/skills/humanizer/SKILL.md — apply to ALL client-facing copy before sending
// remotion   — MCP: remotion-video — animated reports, video deliverables, dashboard recordings
// notebooklm — MCP: notebooklm — internal research only, query GRIDHAND docs and architecture
// gemini-image — MCP: gemini-image — generate design references, UI mockups, client visual assets
// Access via TOOL_REGISTRY in gridhand-commander.js

const AGENT_ID   = 'executive-assistant'
const EA_MODEL   = 'groq/llama-3.3-70b-versatile'  // routing = Groq (free, subscription-safe)
const OPUS_MODEL = 'groq/llama-3.3-70b-versatile'  // strategic calls → Groq, heavy work → queue to COO

const EA_SYSTEM = `<role>Executive Assistant for GRIDHAND AI — bridge between MJ (CEO) and the CFO (Claude Code). Direct, sharp, no fluff. Sound like a competent chief of staff.</role>

<hierarchy>
- MJ gives direction
- Route build/code tasks to CFO's queue, or answer directly if no build work needed
- Escalate to MJ ONLY when his actual judgment is required — not for status updates
</hierarchy>

<context>GRIDHAND AI workforce platform for small businesses. Workers (Ollama/Groq), Agents (Groq), Directors (Opus), Commander (Opus), CFO (Sonnet), EA (Sonnet/Opus), MJ (CEO).</context>

<internal_specialists>
Three internal builder specialists available for GRIDHAND's own development work:
- FORGE: Code builder. Translates build requests into implementation specs, reviews code, and breaks large features into ordered build steps. Route when MJ asks to build, code, or implement something.
- ORACLE: Strategic intelligence. Deep architectural analysis, tradeoff evaluation, system design decisions, and business strategy. Route when MJ asks about architecture decisions, tradeoffs, or strategic direction.
- XRAY: Code analysis and debugging. Explains code, finds root causes of bugs, scans for security issues, identifies performance problems. Route when MJ asks why something is broken, how code works, or whether something is secure.
These specialists are INTERNAL ONLY — they never touch client data.
When routing to a specialist, flag your response with [FORGE_NEEDED], [ORACLE_NEEDED], or [XRAY_NEEDED].
</internal_specialists>

<rules>
- "Fix X" / "Build Y" / "Add Z" → queue to CFO immediately, confirm to MJ
- "Analyze / review / debug X" → flag [XRAY_NEEDED]
- "Design / architect X" → flag [ORACLE_NEEDED]
- "Generate spec / implementation plan for X" → flag [FORGE_NEEDED]
- "What's the status of X" → check task queue / Supabase, report back
- "What do you think about X" → answer directly with context
- "Should we do X or Y" → give recommendation, ask MJ to decide
- Anything needing approval of real money, client contact, or irreversible action → escalate to MJ
</rules>
<quality_standard>
DIRECTOR OUTPUT DISCIPLINE:
Never use: "I believe", "it seems", "perhaps", "it appears", "Certainly!", "Great!", "I'd be happy to", "Of course!", "I'm sorry", "Unfortunately", "I apologize", "I understand", "As an AI"
Outcome-first: lead with the decision or action, not the analysis
Return structured JSON only — no unstructured prose responses
Never explain reasoning unless confidence < 0.7 or explicitly asked
Escalate to Commander when: confidence < 0.6 OR situation is outside your defined scope
</quality_standard>
<output>
Return valid JSON: { "action": string, "confidence": number, "escalate": boolean, "rationale": string (max 15 words) }
</output>`

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Process an incoming message from MJ.
 * Returns the EA's response text.
 */
async function processMessage({ text, from = 'MJ', sessionContext = [] }) {
  console.log(`[${AGENT_ID.toUpperCase()}] Message from ${from}: "${text.slice(0, 80)}..."`)

  // Scout reads system state before EA responds
  let systemBrief = null
  try {
    const supabase = getSupabase()
    const [clientsRes, runsRes] = await Promise.allSettled([
      supabase.from('clients').select('id, business_name, plan, is_active').eq('is_active', true).limit(20),
      supabase.from('agent_runs').select('agent_id, status, summary, ran_at').order('ran_at', { ascending: false }).limit(10),
    ])
    const systemData = {
      active_clients: clientsRes.status === 'fulfilled' ? clientsRes.value.data || [] : [],
      recent_agent_runs: runsRes.status === 'fulfilled' ? runsRes.value.data || [] : [],
    }
    systemBrief = await scout({
      task: `MJ sent this message: "${text}". Understand the context needed to respond or route this correctly.`,
      sources: [{ label: 'system_state', content: systemData }],
      maxTokens: 1500,
    })
  } catch (err) {
    console.warn(`[${AGENT_ID}] Scout failed:`, err.message)
  }

  // Build conversation context
  const messages = [
    ...(sessionContext || []),
    {
      role: 'user',
      content: systemBrief
        ? `SYSTEM CONTEXT:\n${systemBrief}\n\nMJ SAYS: ${text}`
        : text,
    },
  ]

  // Sonnet handles routing and standard responses
  let response = null
  try {
    response = await call({
      modelString: EA_MODEL,
      systemPrompt: EA_SYSTEM,
      messages,
      maxTokens: 400,
    })
  } catch (err) {
    console.error(`[${AGENT_ID}] Haiku failed:`, err.message)
  }

  // If Sonnet flags it needs Opus-level judgment, escalate
  if (response && (response.includes('[OPUS_NEEDED]') || response.includes('[ESCALATE_MJ]'))) {
    try {
      response = await call({
        modelString: OPUS_MODEL,
        systemPrompt: EA_SYSTEM,
        messages,
        maxTokens: 600,
      })
    } catch (err) {
      console.error(`[${AGENT_ID}] Opus fallback failed:`, err.message)
    }
  }

  console.log(`[${AGENT_ID.toUpperCase()}] Response ready`)

  // Notify MJ through both channels
  if (response) {
    const isUrgent = /error|fail|critical|urgent|alert|down|broken/i.test(response)
    notify({
      message: response.slice(0, 280),
      level: isUrgent ? 'error' : 'info',
      source: AGENT_ID,
    })
  }

  return response || "I'm having trouble processing that right now. Try again in a moment."
}

/**
 * Queue a task to the CFO (writes to task queue file).
 * CFO picks it up on next cycle.
 */
async function queueToCFO({ task, project = 'portal', priority = 'normal' }) {
  const { execSync } = require('child_process')
  try {
    execSync(`bash ~/.claude/bin/queue-task.sh "${task.replace(/"/g, '\\"')}" ${project}`, {
      timeout: 10000,
      stdio: 'pipe',
    })
    return true
  } catch (err) {
    console.error(`[${AGENT_ID}] Failed to queue task:`, err.message)
    return false
  }
}

/**
 * Get current task queue status for MJ.
 */
async function getStatus() {
  const { execSync } = require('child_process')
  try {
    return execSync('bash ~/.claude/bin/task-status.sh --telegram', { timeout: 10000, stdio: 'pipe' }).toString()
  } catch {
    return 'Task queue unavailable.'
  }
}

module.exports = { processMessage, queueToCFO, getStatus, AGENT_ID }
