'use strict'
// ── ORACLE — GRIDHAND Strategic Intelligence ──────────────────────────────────
// Context: Admin/MJ only. Never touches client data.
// Model: claude-opus-4-7 (strategic judgment requires the best model)
// Role: Deep architectural analysis, tradeoff evaluation, system design decisions,
//       and business strategy for GRIDHAND itself.
//
// Modes:
//   architecture — evaluates system design decisions, tradeoffs, patterns
//   strategy     — business/product strategy thinking for GRIDHAND
//   research     — synthesizes information into a strategic brief
//
// Uses Opus because strategic judgment is exactly what Opus is for.
// Does NOT go through message-gate.js — internal output only.
// ─────────────────────────────────────────────────────────────────────────────

const { call } = require('../../lib/ai-client')

const SPECIALIST_ID = 'oracle'
const DIVISION      = 'internal'
const MODEL         = 'groq/llama-3.3-70b-versatile'

const ORACLE_SYSTEM = `<role>
You are ORACLE, the strategic intelligence specialist for GRIDHAND AI. You operate exclusively in MJ's internal context. You never reference client data, client IDs, or client business details unless they are provided as anonymized examples in the task.
</role>

<business>
GRIDHAND is a multi-tenant AI workforce platform for SMBs. An AI-powered team of agents (Commander, Directors, Specialists, Workers) runs autonomously on behalf of each client — handling SMS, lead qualification, reputation management, revenue recovery, and more.

Target verticals: restaurant, auto, salon, trades, gym, real estate, retail.

SaaS tiers:
- Free: limited workers
- $197/mo: core workforce
- $347/mo: full workforce
- $497/mo: enterprise workforce + priority routing

The internal vs client context distinction is critical: internal agents (FORGE, ORACLE, XRAY) build and improve GRIDHAND itself. Client-facing agents (specialists, workers, directors) serve paying clients.
</business>

<architecture>
Portal (Next.js 15, TypeScript, Vercel):
- /app/api/* — 80+ API routes. Dynamic routes: await params before use.
- /app/admin/* — MJ's internal operations dashboard
- /app/dashboard/* — client-facing dashboard
- Supabase: Postgres + RLS + Auth. Service role bypasses RLS — server-only.
- Stripe: checkout, portal, webhooks (idempotent — Stripe will retry)
- Twilio: inbound SMS signature verification required
- Resend: email delivery

Workers (Node.js/Express, Railway):
- /agents/gridhand-commander.js — master orchestrator, runs every 15 min
- /agents/*-director.js — 5 Directors (Acquisition/Revenue/Experience/Brand/Intelligence)
- /agents/specialists/ — 30 client-facing + 3 internal specialists
- /agents/executive-assistant.js — MJ's direct interface via Telegram
- /workers/ — 15 active SMS workers, 60+ on bench
- Bull + Redis: job queues
- ElevenLabs: voice bridge (ulaw_8000)
- Groq (llama-3.3-70b): fast client-action specialists
- Ollama (local): workers — read-only analysis, never code generation

Model routing (locked):
- claude-opus-4-7  → Commander, Directors, ORACLE
- claude-sonnet-4-6 → Grid agents, FORGE, XRAY, EA
- groq/llama-3.3-70b-versatile → Client specialists, Scout
- Ollama → Workers (analysis only)
</architecture>

<rules>
- Give the honest answer, not the comfortable one. MJ needs accurate tradeoffs to make good decisions.
- For architecture mode: always include a recommended path with clear reasoning. Don't just list options.
- For strategy mode: ground recommendations in GRIDHAND's actual constraints (Railway, Vercel, Supabase, Twilio, current MRR stage).
- For research mode: synthesize to a concise brief — no padding, no filler, no obvious statements.
- Never mention Make.com in your output. Refer to it as "the integration layer" if needed.
- If a decision has irreversible consequences (data migration, breaking API change, billing change), flag it explicitly.
</rules>

<output>
Structure: recommendation first, reasoning second, risks third. MJ makes the final call — give him what he needs to make a good one.
</output>`

/**
 * Run ORACLE with a strategic question or analysis task.
 *
 * @param {object} params
 * @param {string} params.question      - The strategic question or topic to analyze
 * @param {string} [params.context]     - Additional context (current state, constraints)
 * @param {'architecture'|'strategy'|'research'} params.mode
 * @param {string} [params.owner]       - 'gridhand' (default) for internal strategy, or a client_id for client-scoped intel
 * @returns {Promise<{success: boolean, output: string, mode: string, specialist: string}>}
 */
async function run({ question, context = '', mode = 'architecture', owner = 'gridhand' }) {
  console.log(`[ORACLE] run() — mode: ${mode}, owner: ${owner}, question: "${question.slice(0, 80)}..."`)

  const isClientContext = owner !== 'gridhand'

  const ownerBlock = isClientContext
    ? `<owner_context>
You are operating in client-context mode for client ID: ${owner}.
Your strategic analysis concerns that client's business — not GRIDHAND's internal operations.
Provide pre-call intel, prospect research, competitive landscape, and market positioning relevant to their vertical.
Do not reference GRIDHAND internal architecture, MJ's admin tools, or platform configuration unless asked.
</owner_context>`
    : `<owner_context>
You are operating in internal GRIDHAND mode.
Your strategic analysis serves MJ and the GRIDHAND platform.
You have full visibility into GRIDHAND's infrastructure, financials, growth stage, and competitive position.
</owner_context>`

  const systemPromptWithOwner = ORACLE_SYSTEM + '\n\n' + ownerBlock

  const validModes = ['architecture', 'strategy', 'research']
  if (!validModes.includes(mode)) {
    return {
      success: false,
      output: `Invalid mode "${mode}". Valid options: architecture, strategy, research.`,
      mode,
      specialist: SPECIALIST_ID,
    }
  }

  if (!question || !question.trim()) {
    return {
      success: false,
      output: 'question is required.',
      mode,
      specialist: SPECIALIST_ID,
    }
  }

  const modeInstructions = {
    architecture: 'Evaluate this system design question. Provide a concrete recommendation with tradeoff analysis. Flag any irreversible decisions, performance implications, security risks, or RLS policy requirements.',
    strategy: 'Analyze this business or product strategy question in the context of GRIDHAND\'s current stage, infrastructure, and target market. Give a direct recommendation MJ can act on.',
    research: 'Synthesize the provided information into a strategic brief. Surface the key insights, the decision points, and what MJ needs to act on. Cut everything that doesn\'t change the decision.',
  }

  const userContent = [
    `MODE: ${mode.toUpperCase()}`,
    `INSTRUCTION: ${modeInstructions[mode]}`,
    '',
    `QUESTION:\n${question}`,
    context ? `\nCONTEXT:\n${context}` : '',
  ].filter(Boolean).join('\n')

  let output = null
  try {
    output = await call({
      modelString: MODEL,
      systemPrompt: systemPromptWithOwner,
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 4000,
      tier: 'specialist',
    })
  } catch (err) {
    console.error(`[ORACLE] call failed:`, err.message)
    return {
      success: false,
      output: `ORACLE failed: ${err.message}`,
      mode,
      specialist: SPECIALIST_ID,
    }
  }

  console.log(`[ORACLE] Output ready (${output?.length || 0} chars)`)
  return {
    success: true,
    output: output || '',
    mode,
    specialist: SPECIALIST_ID,
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION }
