'use strict'
// ── GRIDHAND PROJECT ORCHESTRATOR ────────────────────────────────────────────
// SaaS Factory intelligence backbone — tracks patterns, builds playbooks,
// generates deployment plans for new clients/niches.
//
// Modes:
//   shadow    — observe a change, extract its reusable pattern, store to DB
//   playbook  — return the full blueprint library for a niche
//   replicate — generate a deployment plan for a new client/niche
//
// Model: groq/llama-3.3-70b-versatile throughout (read/analyze, NOT code-writing)
// Division: system
// Reports to: gridhand-commander
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../lib/ai-client')

const AGENT_ID   = 'project-orchestrator'
const GROQ_MODEL = 'groq/llama-3.3-70b-versatile'

// Valid blueprint_type values — keep in sync with system_blueprints table
const VALID_BLUEPRINT_TYPES = [
  'ui_pattern',
  'copy_pattern',
  'conversion_flow',
  'landing_section',
]

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// ── Utility: safe JSON parse from Groq response ───────────────────────────────
function parseJsonFromResponse(raw) {
  if (!raw) return null
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0])
  } catch (_) {
    return null
  }
}

// ── MODE: shadow ─────────────────────────────────────────────────────────────
// Observes a file change, extracts the reusable pattern, saves to system_blueprints.
// Optionally logs to client_knowledge if client_id provided.
//
// Input: { mode: 'shadow', file, changeDescription, patternType, niche, client_id? }
// Output: { success: boolean, blueprint_id?, blueprint_name?, error? }
async function shadowMode({ file, changeDescription, patternType, niche, client_id }) {
  if (!file || !changeDescription) {
    return { success: false, error: 'shadow mode requires file and changeDescription' }
  }

  const resolvedType = VALID_BLUEPRINT_TYPES.includes(patternType)
    ? patternType
    : 'ui_pattern'

  const resolvedNiche = niche || 'generic'

  // Groq extracts the reusable pattern from the change description
  let extracted = null
  try {
    const raw = await call({
      modelString: GROQ_MODEL,
      systemPrompt: `<role>You are the GRIDHAND SaaS Factory pattern extractor.</role>
<task>
Analyze a file change description and extract a reusable, niche-agnostic pattern
that can be templated for future client deployments.

Extract:
- A short slug name (snake_case, max 40 chars) — e.g. "hero_with_video_bg"
- A clean description of the pattern (1-2 sentences)
- The structural/copy formula (what makes it work, abstracted away from specifics)
- Any copy formulas used (headline formula, CTA formula, etc.)
- Conversion principles observed

Respond ONLY with valid JSON:
{
  "name": "pattern_slug",
  "description": "What this pattern does",
  "structure": "How it is built structurally",
  "copy_formula": "Headline formula or copy approach, if any",
  "conversion_principle": "Why this converts",
  "tags": ["tag1", "tag2"]
}
</task>
<rules>Never invent specifics. Only extract what's described. If uncertain, be general.</rules>`,
      messages: [{
        role: 'user',
        content: `<file>${file}</file>\n<pattern_type>${resolvedType}</pattern_type>\n<niche>${resolvedNiche}</niche>\n<change_description>${changeDescription}</change_description>`,
      }],
      maxTokens: 600,
    })
    extracted = parseJsonFromResponse(raw)
  } catch (err) {
    console.warn(`[${AGENT_ID}] Groq extraction failed:`, err.message)
    // Fall back to a minimal pattern record
    extracted = {
      name: `pattern_${Date.now()}`,
      description: changeDescription.slice(0, 120),
      structure: 'manual capture',
      copy_formula: null,
      conversion_principle: null,
      tags: [resolvedNiche],
    }
  }

  if (!extracted?.name) {
    return { success: false, error: 'pattern extraction returned no usable data' }
  }

  const supabase = getSupabase()

  // Insert blueprint record
  const { data: bp, error: bpErr } = await supabase
    .from('system_blueprints')
    .insert({
      blueprint_type:  resolvedType,
      name:            extracted.name,
      niche:           resolvedNiche,
      source_file:     file,
      pattern_data: {
        description:           extracted.description,
        structure:             extracted.structure,
        copy_formula:          extracted.copy_formula,
        conversion_principle:  extracted.conversion_principle,
        tags:                  extracted.tags || [],
        raw_change:            changeDescription.slice(0, 500),
      },
      is_template: false,
    })
    .select('id, name')
    .single()

  if (bpErr) {
    console.error(`[${AGENT_ID}] Failed to insert blueprint:`, bpErr.message)
    return { success: false, error: bpErr.message }
  }

  console.log(`[${AGENT_ID}] Shadowed pattern: ${bp.name} (${resolvedType}, niche: ${resolvedNiche})`)

  // Optionally log to client_knowledge if client_id provided
  if (client_id) {
    const knowledgeEntry = `Pattern captured: ${bp.name} — ${extracted.description}`
    await supabase
      .from('client_knowledge')
      .insert({
        client_id,
        content:  knowledgeEntry,
        category: 'saas_factory_pattern',
      })
      .then(({ error }) => {
        if (error) console.warn(`[${AGENT_ID}] client_knowledge log failed:`, error.message)
      })
  }

  return { success: true, blueprint_id: bp.id, blueprint_name: bp.name }
}

// ── MODE: playbook ────────────────────────────────────────────────────────────
// Returns the full blueprint library for a niche, including generic patterns.
// Sorted by performance_score descending (nulls last).
//
// Input: { mode: 'playbook', niche }
// Output: { success: boolean, niche, total, blueprints: grouped-by-type }
async function playbookMode({ niche }) {
  const resolvedNiche = niche || 'generic'
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from('system_blueprints')
    .select('id, blueprint_type, name, niche, source_file, pattern_data, performance_score, is_template, created_at')
    .or(`niche.eq.${resolvedNiche},niche.eq.generic`)
    .order('performance_score', { ascending: false, nullsFirst: false })

  if (error) {
    console.error(`[${AGENT_ID}] Playbook query failed:`, error.message)
    return { success: false, error: error.message }
  }

  // Group by blueprint_type for structured output
  const grouped = {}
  for (const bp of data || []) {
    if (!grouped[bp.blueprint_type]) grouped[bp.blueprint_type] = []
    grouped[bp.blueprint_type].push(bp)
  }

  return {
    success:    true,
    niche:      resolvedNiche,
    total:      data?.length || 0,
    blueprints: grouped,
  }
}

// ── MODE: replicate ───────────────────────────────────────────────────────────
// Generates a deployment plan for a new client using top-performing blueprints.
// Groq synthesizes worker activation order, landing sections, copy formulas.
//
// Input: { mode: 'replicate', niche, clientSlug, targetIndustry }
// Output: { success: boolean, deployment_plan }
async function replicateMode({ niche, clientSlug, targetIndustry }) {
  if (!clientSlug) {
    return { success: false, error: 'replicate mode requires clientSlug' }
  }

  const resolvedNiche    = niche || 'generic'
  const resolvedIndustry = targetIndustry || resolvedNiche
  const supabase         = getSupabase()

  // Pull top-performing blueprints (score >= 60 or nulls) for this niche + generic
  const { data: blueprints, error } = await supabase
    .from('system_blueprints')
    .select('blueprint_type, name, niche, pattern_data, performance_score, is_template')
    .or(`niche.eq.${resolvedNiche},niche.eq.generic`)
    .or('performance_score.gte.60,performance_score.is.null')
    .order('performance_score', { ascending: false, nullsFirst: false })
    .limit(30)

  if (error) {
    console.error(`[${AGENT_ID}] Blueprints fetch failed:`, error.message)
    return { success: false, error: error.message }
  }

  const blueprintSummary = (blueprints || []).map(bp => ({
    type:        bp.blueprint_type,
    name:        bp.name,
    niche:       bp.niche,
    score:       bp.performance_score,
    is_template: bp.is_template,
    description: bp.pattern_data?.description,
    copy_formula: bp.pattern_data?.copy_formula,
    conversion_principle: bp.pattern_data?.conversion_principle,
  }))

  // Groq synthesizes a deployment plan
  let deployment_plan = null
  try {
    const raw = await call({
      modelString: GROQ_MODEL,
      systemPrompt: `<role>You are the GRIDHAND SaaS Factory deployment planner.</role>
<task>
Given a client's niche and the available blueprint library, generate a complete
deployment plan. Think like a growth operator: which pieces go live first, which
copy formulas apply, which workers to activate, in what order.

Produce a deployment_plan JSON object:
{
  "client_slug": "...",
  "niche": "...",
  "industry": "...",
  "phase_1_workers": ["worker-id-1", "worker-id-2"],
  "phase_2_workers": ["worker-id-3"],
  "landing_sections": [
    { "section": "hero", "blueprint": "blueprint_name", "copy_formula": "..." },
    { "section": "social_proof", "blueprint": "blueprint_name", "copy_formula": "..." },
    { "section": "cta", "blueprint": "blueprint_name", "copy_formula": "..." }
  ],
  "copy_system": {
    "headline_formula": "...",
    "value_prop_formula": "...",
    "cta_formula": "..."
  },
  "activation_sequence": ["step1", "step2", "step3"],
  "estimated_setup_days": 3,
  "priority_patterns": ["pattern_name_1", "pattern_name_2"]
}
</task>
<rules>
Only reference workers and blueprints by name, never invent IDs.
Base activation sequence on the blueprint performance scores and type.
Phase 1 = highest-impact, fastest to activate. Phase 2 = enhancement layer.
</rules>`,
      messages: [{
        role: 'user',
        content: `<client_slug>${clientSlug}</client_slug>\n<niche>${resolvedNiche}</niche>\n<industry>${resolvedIndustry}</industry>\n<blueprints>${JSON.stringify(blueprintSummary, null, 2)}</blueprints>`,
      }],
      maxTokens: 1200,
    })
    deployment_plan = parseJsonFromResponse(raw)
  } catch (err) {
    console.warn(`[${AGENT_ID}] Groq deployment plan failed:`, err.message)
  }

  if (!deployment_plan) {
    // Minimal fallback plan
    deployment_plan = {
      client_slug:        clientSlug,
      niche:              resolvedNiche,
      industry:           resolvedIndustry,
      phase_1_workers:    [],
      phase_2_workers:    [],
      landing_sections:   [],
      copy_system:        {},
      activation_sequence: ['manual review required — Groq plan generation failed'],
      estimated_setup_days: 5,
      priority_patterns:  blueprintSummary.slice(0, 3).map(b => b.name),
    }
  }

  return { success: true, deployment_plan }
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function run(params = {}) {
  const { mode } = params

  console.log(`[${AGENT_ID.toUpperCase()}] run() — mode: ${mode}`)

  try {
    switch (mode) {
      case 'shadow':
        return await shadowMode(params)
      case 'playbook':
        return await playbookMode(params)
      case 'replicate':
        return await replicateMode(params)
      default:
        return {
          success: false,
          error:   `Unknown mode: "${mode}". Valid modes: shadow, playbook, replicate`,
        }
    }
  } catch (err) {
    console.error(`[${AGENT_ID}] Unhandled error in run():`, err.message)
    return { success: false, error: err.message }
  }
}

module.exports = { run, shadowMode, playbookMode, replicateMode }
