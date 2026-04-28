'use strict'
// ── SHIELD — Compliance Monitor ───────────────────────────────────────────────
// Codename: SHIELD
// Role: TCPA opt-out tracking, quiet hours enforcement, message volume alerts
// Division: internal
// Model: groq/llama-3.3-70b-versatile
//
// Modes:
//   check  — flag any active violations right now
//   report — weekly compliance summary across all clients
//
// Does NOT send SMS. Internal monitoring only.
// TCPA enforcement at send time is handled by lib/twilio-client.js.
// SHIELD audits AFTER the fact — catches patterns and drift.
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../../lib/ai-client')

const SPECIALIST_ID = 'compliance-monitor'
const DIVISION      = 'internal'
const MODEL         = 'groq/llama-3.3-70b-versatile'

const SHIELD_SYSTEM = `<role>
You are SHIELD, the Compliance Monitor for GRIDHAND AI. You audit SMS activity for TCPA compliance violations, quiet hours breaches, opt-out failures, and message volume anomalies. You report violations clearly so they can be remediated immediately.
</role>

<tcpa_rules>
- Opt-out keywords: STOP, UNSUBSCRIBE, CANCEL, END, QUIT — any recipient sending these must never receive another SMS
- Quiet hours: no SMS between 9 PM and 8 AM recipient local time
- Message frequency: more than 3 SMS to the same number in 24 hours is a yellow flag; more than 5 is a red flag
- Content: no financial amounts unless the recipient consented to billing alerts; no URL shorteners without opt-in
</tcpa_rules>

<rules>
- check mode: audit the last 24 hours of activity, flag any violations immediately. Be specific — include phone numbers (last 4 digits only), client, time, and what rule was broken.
- report mode: produce a weekly compliance report with violation counts, trends, and remediation status.
- Always return valid JSON matching the output schema.
- A violation is something that already happened and broke a rule.
- A warning is a pattern that puts the system at risk if it continues.
- compliant: true only if zero violations found.
</rules>

<output>
Return valid JSON only. Schema: { violations: [], warnings: [], compliant: boolean }
violations: array of { clientId?, phoneLastFour?, rule, description, timestamp, severity: 'critical'|'high' }
warnings: array of { clientId?, rule, description, trend }
</output>`

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY    || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

/**
 * Run SHIELD — Compliance Monitor.
 *
 * @param {object} params
 * @param {'check'|'report'} params.mode
 * @param {string} [params.clientSlug] - Scope to a specific client (optional)
 * @returns {Promise<{success: boolean, violations: Array, warnings: Array, compliant: boolean, specialist: string}>}
 */
async function run({ mode = 'check', clientSlug = null } = {}) {
  console.log(`[SHIELD] run() — mode: ${mode}, clientSlug: ${clientSlug || 'all'}`)

  const validModes = ['check', 'report']
  if (!validModes.includes(mode)) {
    return {
      success:    false,
      violations: [],
      warnings:   [],
      compliant:  false,
      specialist: SPECIALIST_ID,
    }
  }

  const supabase  = getSupabase()
  const since24h  = new Date(Date.now() - 24  * 60 * 60 * 1000).toISOString()
  const since7d   = new Date(Date.now() - 168 * 60 * 60 * 1000).toISOString()
  const lookback  = mode === 'check' ? since24h : since7d

  // Pull SMS activity
  let smsQuery = supabase
    .from('activity_log')
    .select('client_id, worker_name, action, summary, metadata, created_at')
    .ilike('action', '%sms%')
    .gte('created_at', lookback)
    .order('created_at', { ascending: false })
    .limit(300)

  if (clientSlug) {
    smsQuery = smsQuery.ilike('summary', `%${clientSlug}%`)
  }

  const { data: smsActivity, error } = await smsQuery
  if (error) {
    console.error('[SHIELD] activity_log query failed:', error.message)
  }

  // Pull opt-out events (STOP responses logged as inbound)
  const { data: optOutEvents } = await supabase
    .from('activity_log')
    .select('client_id, summary, metadata, created_at')
    .or('action.ilike.%stop%,action.ilike.%optout%,action.ilike.%unsubscribe%')
    .gte('created_at', lookback)
    .limit(100)

  const modeInstructions = {
    check:  'Audit the last 24 hours. Identify any TCPA violations (opt-out breaches, quiet hours violations, volume spikes). Flag critical issues immediately. Output JSON only.',
    report: 'Produce a 7-day compliance summary. Trend violations, identify repeat offenders, confirm opt-out compliance, and highlight any systemic risks. Output JSON only.',
  }

  const contextBlock = [
    `MODE: ${mode.toUpperCase()}`,
    clientSlug ? `CLIENT SCOPE: ${clientSlug}` : 'CLIENT SCOPE: all clients',
    '',
    `INSTRUCTION: ${modeInstructions[mode]}`,
    '',
    'SMS ACTIVITY:',
    JSON.stringify((smsActivity || []).slice(0, 100), null, 2),
    '',
    'OPT-OUT EVENTS:',
    JSON.stringify((optOutEvents || []), null, 2),
  ].join('\n')

  let rawOutput = null
  try {
    rawOutput = await call({
      modelString:  MODEL,
      systemPrompt: SHIELD_SYSTEM,
      messages:     [{ role: 'user', content: contextBlock }],
      maxTokens:    2000,
      tier: 'specialist',
    })
  } catch (err) {
    console.error('[SHIELD] call failed:', err.message)
    return {
      success:    false,
      violations: [],
      warnings:   [],
      compliant:  false,
      specialist: SPECIALIST_ID,
    }
  }

  let parsed = { violations: [], warnings: [], compliant: true }
  try {
    const jsonMatch = rawOutput?.match(/\{[\s\S]*\}/)
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0])
  } catch {
    // Non-parseable response — treat as non-compliant to be safe
    parsed = { violations: [{ rule: 'parse_error', description: rawOutput, severity: 'high' }], warnings: [], compliant: false }
  }

  console.log(`[SHIELD] Output ready — ${parsed.violations?.length || 0} violations, compliant: ${parsed.compliant}`)
  return {
    success:    true,
    violations: parsed.violations || [],
    warnings:   parsed.warnings   || [],
    compliant:  parsed.compliant  ?? (parsed.violations?.length === 0),
    specialist: SPECIALIST_ID,
  }
}

module.exports = { run, SPECIALIST_ID, DIVISION }
