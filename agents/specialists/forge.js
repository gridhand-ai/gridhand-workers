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

<design_standards>
All UI code generated for gridhand-portal MUST follow these standards — no exceptions:

STYLING:
- Inline styles ONLY — no Tailwind, no CSS modules, no external stylesheets
- Every style property goes in style={{}} — this is a hard constraint of the portal repo

COLOR SYSTEM:
- Background: #080812
- Surface: rgba(255,255,255,0.03)
- Border: rgba(255,255,255,0.08) | Active: rgba(255,255,255,0.16)
- Primary accent: #6366f1 (indigo) — never cyan, never purple
- Text primary: #ffffff | Secondary: rgba(255,255,255,0.6) | Muted: rgba(255,255,255,0.35)
- Success: #10b981 | Warning: #f59e0b | Error: #ef4444

TYPOGRAPHY — never Arial, Inter, Roboto, system-ui:
- Display/headlines: 'Clash Display', 'Space Grotesk', 'Sora'
- Body: 'DM Sans', 'Manrope', 'Plus Jakarta Sans'
- Max 3 font weights per section. fontWeight: 800 headline, 600 label, 400 body.

COMPONENT QUALITY (2026 App Store standard):
- Glass surfaces (modals, cards, overlays): backdropFilter: 'blur(24px) saturate(160%)' — never flat
- Shadows: multi-layer soft only — never single harsh boxShadow
  Card: '0 1px 3px rgba(0,0,0,0.3), 0 4px 12px rgba(0,0,0,0.18)'
  Modal: '0 8px 32px rgba(0,0,0,0.4), 0 32px 80px rgba(0,0,0,0.25)'
- Loading states: shimmer skeletons only — never bare spin wheels
- Button press states: onMouseDown transform: scale(0.97) on every interactive button
- Spacing: multiples of 8px only — 4, 8, 12, 16, 24, 32, 40, 48, 64

COMPONENT SOURCES (check in this order before building from scratch):
1. Run ui-ux-pro-max: python3 ~/.claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --design-system -p "GRIDHAND"
2. Check 21st.dev via mcp__magic__21st_magic_component_inspiration
3. Generate via mcp__magic__21st_magic_component_builder
4. Magic UI (magicui.design) patterns: animated gradients, spotlight, shimmer text, marquees
5. Build from scratch only as last resort — always convert any Tailwind to inline styles

ACCESSIBILITY:
- Body text contrast ≥ 4.5:1, large text ≥ 3:1
- Touch targets ≥ 44×44px
- Every icon-only button needs aria-label
- Never outline: none without a replacement focus ring
</design_standards>

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
      tier: 'specialist',
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
