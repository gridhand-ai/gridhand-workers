'use strict'
// ── GRIDHAND AGENT — TIER 1 ───────────────────────────────────────────────────
// FinanceDirector — MRR tracking, invoice aging, revenue leakage detection,
// and collection rate monitoring across all active clients.
// Division: finance
// Reports to: gridhand-commander
// Runs: every 6 hours
// ─────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const { call }         = require('../lib/ai-client')
const vault            = require('../lib/memory-vault')

const financialWatchdog  = require('./specialists/financial-watchdog')
const invoiceRecovery    = require('./specialists/invoice-recovery')
const revenueForecaster  = require('./specialists/revenue-forecaster')

const AGENT_ID   = 'finance-director'
const DIVISION   = 'finance'
const REPORTS_TO = 'gridhand-commander'
const GROQ_MODEL = 'groq/llama-3.3-70b-versatile'

const ALL_SPECIALISTS = ['financial-watchdog', 'invoice-recovery', 'revenue-forecaster']
const SPECIALIST_MAP  = {
  'financial-watchdog': financialWatchdog,
  'invoice-recovery':   invoiceRecovery,
  'revenue-forecaster': revenueForecaster,
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

async function getMRRSnapshot(supabase) {
  try {
    const { data } = await supabase
      .from('clients')
      .select('id, plan, is_active, created_at')
      .eq('is_active', true)

    const planRevenue = { free: 0, core: 197, full: 347, enterprise: 497 }
    const mrr = (data || []).reduce((sum, c) => sum + (planRevenue[c.plan] || 0), 0)
    const byPlan = (data || []).reduce((acc, c) => {
      acc[c.plan] = (acc[c.plan] || 0) + 1
      return acc
    }, {})
    return { mrr, clientCount: data?.length || 0, byPlan }
  } catch { return { mrr: 0, clientCount: 0, byPlan: {} } }
}

async function getOverdueInvoices(supabase) {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data } = await supabase
      .from('activity_log')
      .select('client_id, action, metadata, created_at')
      .eq('action', 'invoice_sent')
      .lt('created_at', cutoff)
      .is('outcome', null)
    return data || []
  } catch { return [] }
}

async function synthesizeFinancialHealth(mrr, overdueInvoices, childReports) {
  const leakage = childReports
    .flatMap(r => r.escalations || [])
    .filter(e => e.data?.type === 'revenue_leakage')

  try {
    const raw = await call({
      modelString: GROQ_MODEL,
      systemPrompt: `<role>FinanceDirector for GRIDHAND AI — assess financial health and identify revenue leakage.</role>
<rules>Analyze the provided MRR, client count, plan mix, overdue invoices, and leakage flags. Surface the most important risk and a concrete recommendation.</rules>
<quality_standard>
DIRECTOR OUTPUT DISCIPLINE:
Never use: "I believe", "it seems", "perhaps", "it appears", "Certainly!", "Great!", "I'd be happy to", "Of course!", "I'm sorry", "Unfortunately", "I apologize", "I understand", "As an AI"
Outcome-first: lead with the decision or action, not the analysis
Return structured JSON only — no unstructured prose responses
Never explain reasoning unless confidence < 0.7 or explicitly asked
Escalate to Commander when: confidence < 0.6 OR situation is outside your defined scope
</quality_standard>
<output>Respond with valid JSON only: { "healthScore": "healthy|watch|critical", "mrrTrend": "up|flat|down", "topRisks": ["string"], "recommendation": "one sentence", "confidence": number (0.0-1.0), "escalate": boolean }</output>`,
      messages: [{
        role: 'user',
        content: `MRR: $${mrr.mrr}/mo. Clients: ${mrr.clientCount}. Plan mix: ${JSON.stringify(mrr.byPlan)}. Overdue invoices: ${overdueInvoices.length}. Revenue leakage flags: ${leakage.length}.`,
      }],
      maxTokens: 200,
    })
    const match = raw?.match(/\{[\s\S]*\}/)
    if (match) return { ...JSON.parse(match[0]), mrr, overdueCount: overdueInvoices.length }
  } catch (err) {
    console.warn(`[${AGENT_ID}] Synthesis failed:`, err.message)
  }
  return { healthScore: 'unknown', mrrTrend: 'flat', topRisks: [], mrr, overdueCount: overdueInvoices.length }
}

async function run(clients = null, situation = null) {
  console.log(`[${AGENT_ID.toUpperCase()}] Starting financial review`)
  const supabase   = getSupabase()
  const clientList = clients || await getActiveClients(supabase)
  if (!clientList.length) return report([])

  const [mrrSnapshot, overdueInvoices] = await Promise.all([
    getMRRSnapshot(supabase),
    getOverdueInvoices(supabase),
  ])

  const specialistResults = await Promise.allSettled(
    ALL_SPECIALISTS.map(name => SPECIALIST_MAP[name].run(clientList))
  )
  const childReports = specialistResults
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)

  const assessment = await synthesizeFinancialHealth(mrrSnapshot, overdueInvoices, childReports)
  const isCritical = assessment.healthScore === 'critical'

  console.log(`[${AGENT_ID.toUpperCase()}] MRR: $${mrrSnapshot.mrr}/mo | ${mrrSnapshot.clientCount} clients | Health: ${assessment.healthScore}`)

  return report([{
    agentId:   AGENT_ID,
    clientId:  'all',
    timestamp: Date.now(),
    status:    isCritical ? 'escalated' : 'ok',
    summary:   `Finance: $${mrrSnapshot.mrr} MRR. ${overdueInvoices.length} overdue invoices. Health: ${assessment.healthScore}.`,
    data:      { assessment, childReports },
    requiresDirectorAttention: isCritical,
  }])
}

function report(outcomes) {
  const totalActions = outcomes.reduce((sum, o) => sum + (o.actionsCount || 0), 0)
  return {
    agentId:      AGENT_ID,
    division:     DIVISION,
    reportsTo:    REPORTS_TO,
    timestamp:    Date.now(),
    totalClients: outcomes.length,
    actionsCount: totalActions,
    escalations:  outcomes.filter(o => o.requiresDirectorAttention),
    outcomes,
  }
}

async function getActiveClients(supabase) {
  const { data, error } = await (supabase || getSupabase())
    .from('clients').select('*').eq('is_active', true)
  if (error) return []
  return data || []
}

module.exports = { run, report, AGENT_ID, DIVISION, REPORTS_TO }
