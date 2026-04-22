'use strict'
// ── FORGE — GRIDHAND Internal Code Builder ────────────────────────────────────
// Context: Admin/MJ only. Never touches client data.
// Model: claude-sonnet-4-6 (production-quality code generation)
// Role: Translates MJ's build requests into detailed implementation specs
//       that can be handed to Claude Code grid agents.
//
// Output types:
//   spec     — detailed implementation spec (file paths, what to change, why)
//   review   — reviews a piece of code/plan for correctness
//   plan     — breaks a large feature into ordered build steps
//
// Does NOT go through message-gate.js — internal output only.
// ─────────────────────────────────────────────────────────────────────────────

const { call } = require('../../lib/ai-client')

const SPECIALIST_ID = 'forge'
const DIVISION      = 'internal'
const MODEL         = 'groq/llama-3.3-70b-versatile'

const FORGE_SYSTEM = `<role>
You are FORGE, the internal code builder for GRIDHAND AI. You work exclusively in MJ's admin context. You never touch client data, client IDs, or client-facing code unless you are analyzing its structure for a build task.
</role>

<architecture>
GRIDHAND has two repos:

Portal (Next.js 15, TypeScript, Vercel):
- /app/api/* — 80+ API routes (dynamic routes must await params)
- /app/admin/* — MJ's internal dashboard
- /app/dashboard/* — client-facing dashboard
- /app/home/* — marketing landing page
- /lib/* — shared utilities
- Supabase client: createClient from @supabase/ssr (server), @supabase/js (client)
- All new tables: RLS enabled in the same migration. Service role key = server-only.

Workers (Node.js/Express, Railway):
- /agents/ — Commander, Directors (Acquisition/Revenue/Experience/Brand/Intelligence), EA
- /agents/specialists/ — 30 client-facing specialists + 3 internal (forge/oracle/xray)
- /lib/ — ai-client, twilio-client, message-gate, scout, token-tracker, memory-vault, memory-client
- /workers/ — SMS worker processes (15 active)
- server.js — Express entry point
</architecture>

<model_routing>
Use these model assignments — never deviate without flagging it:
- claude-opus-4-7  → Commander, all 4 Directors, ORACLE (strategic judgment)
- claude-sonnet-4-6 → Grid agents (frontend/backend/devops/qa), FORGE, XRAY, EA
- groq/llama-3.3-70b-versatile → Client-facing specialists, Scout pre-reads
- Ollama (local) → Workers, read-only tasks — NEVER used for code generation
</model_routing>

<rules>
- Output must be production-grade. No TODOs, no lorem ipsum, no placeholders.
- For spec mode: always include exact file paths, the exact function/line to change, and why.
- For plan mode: number every step. Each step must be independently executable.
- For review mode: call out every issue found — don't soften criticism.
- Never mention Make.com in any output. Use "direct integrations" or "integration layer" instead.
- All SMS sending must go through lib/twilio-client.js — never raw Twilio SDK calls.
- All Groq-generated client SMS/email must run through lib/message-gate.js.
- Webhook handlers must verify signatures before processing the body.
</rules>

<output>
Be direct and precise. Format specs with headers and code blocks. No filler prose.
</output>`

/**
 * Run FORGE with a build task.
 *
 * @param {object} params
 * @param {string} params.task        - What MJ wants built or reviewed
 * @param {string} [params.context]   - Additional context (existing code, constraints)
 * @param {'spec'|'review'|'plan'} params.outputType
 * @param {string} [params.owner]     - 'gridhand' (default) for internal ops, or a client_id for client-scoped builds
 * @returns {Promise<{success: boolean, output: string, outputType: string, specialist: string}>}
 */
async function run({ task, context = '', outputType = 'spec', owner = 'gridhand' }) {
  console.log(`[FORGE] run() — outputType: ${outputType}, owner: ${owner}, task: "${task.slice(0, 80)}..."`)

  const isClientContext = owner !== 'gridhand'

  const ownerBlock = isClientContext
    ? `<owner_context>
You are operating in client-context mode for client ID: ${owner}.
Your output serves that client's business — not GRIDHAND's internal infrastructure.
Scope all file paths, recommendations, and specs to that client's configuration.
Do not reference internal GRIDHAND admin routes, MJ's dashboard, or internal tooling unless directly relevant to the client build task.
</owner_context>`
    : `<owner_context>
You are operating in internal GRIDHAND mode.
Your output serves MJ and the GRIDHAND platform directly.
You have full visibility into the internal architecture and may reference admin routes, internal tooling, and platform configuration.
</owner_context>`

  const systemPromptWithOwner = FORGE_SYSTEM + '\n\n' + ownerBlock

  const validTypes = ['spec', 'review', 'plan']
  if (!validTypes.includes(outputType)) {
    return {
      success: false,
      output: `Invalid outputType "${outputType}". Valid options: spec, review, plan.`,
      outputType,
      specialist: SPECIALIST_ID,
    }
  }

  if (!task || !task.trim()) {
    return {
      success: false,
      output: 'task is required.',
      outputType,
      specialist: SPECIALIST_ID,
    }
  }

  const modeInstructions = {
    spec: 'Generate a detailed implementation spec. Include: exact file paths to create or modify, the specific function/lines to change, the complete code to write, and why each change is needed. This spec will be handed directly to a Claude Code grid agent.',
    review: 'Review the provided code or plan. Identify: correctness issues, missing edge cases, security gaps (OWASP top 10), RLS policy gaps for any DB tables, TypeScript type errors, missing error handling, and any violations of GRIDHAND architecture rules. Be thorough and direct.',
    plan: 'Break this feature into an ordered sequence of build steps. Number each step. Each step must be independently executable and testable. Flag which steps need Supabase migrations, which need env var additions, and which touch client-facing routes.',
  }

  const userContent = [
    `OUTPUT TYPE: ${outputType.toUpperCase()}`,
    `INSTRUCTION: ${modeInstructions[outputType]}`,
    '',
    `TASK:\n${task}`,
    context ? `\nADDITIONAL CONTEXT:\n${context}` : '',
  ].filter(Boolean).join('\n')

  let output = null
  try {
    output = await call({
      modelString: MODEL,
      systemPrompt: systemPromptWithOwner,
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 4000,
    })
  } catch (err) {
    console.error(`[FORGE] call failed:`, err.message)
    return {
      success: false,
      output: `FORGE failed: ${err.message}`,
      outputType,
      specialist: SPECIALIST_ID,
    }
  }

  console.log(`[FORGE] Output ready (${output?.length || 0} chars)`)
  return {
    success: true,
    output: output || '',
    outputType,
    specialist: SPECIALIST_ID,
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION }
