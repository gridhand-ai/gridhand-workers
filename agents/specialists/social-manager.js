'use strict'
// ── OG GRIDHAND AGENT — TIER 3 ────────────────────────────────────────────────
// SocialManager — Monitors DMs/comments, routes to AI draft, flags human-review items
// Division: brand
// Reports to: brand-director
// Runs: on-demand (called by BrandDirector)
// ──────────────────────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')
const aiClient = require('../../lib/ai-client')
const { validateSMS } = require('../../lib/message-gate')

const AGENT_ID  = 'social-manager'
const DIVISION  = 'brand'
const REPORTS_TO = 'brand-director'

// Items that need human review vs auto-draft
const HUMAN_REVIEW_TRIGGERS = [
  /complaint/i, /legal/i, /lawsuit/i, /attorney/i, /terrible/i, /fraud/i,
  /refund/i, /scam/i, /disgusting/i, /health department/i, /bbb/i,
]

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

async function run(clients = []) {
  console.log(`[${AGENT_ID.toUpperCase()}] Starting run — ${clients.length} clients`)
  const reports = []

  for (const client of clients) {
    try {
      const result = await processClient(client)
      if (result) reports.push(result)
    } catch (err) {
      console.error(`[${AGENT_ID}] Error for client ${client.id}:`, err.message)
    }
  }

  return report(reports)
}

async function processClient(client) {
  const supabase = getSupabase()
  const now = Date.now()

  // Fetch unhandled social messages
  const { data: messages } = await supabase
    .from('social_inbox')
    .select('*')
    .eq('client_id', client.id)
    .is('handled_at', null)
    .order('received_at', { ascending: true })
    .limit(20)

  if (!messages?.length) return null

  let drafted = 0
  let flaggedForHuman = 0
  const handled = []

  for (const msg of messages) {
    const text = msg.content || ''
    const needsHuman = HUMAN_REVIEW_TRIGGERS.some(re => re.test(text))

    if (needsHuman) {
      // Flag for human review — don't draft
      await supabase.from('social_inbox').update({
        flagged_for_review: true,
        handled_at: new Date().toISOString(),
        draft_response: null,
      }).eq('id', msg.id)

      flaggedForHuman++
      handled.push({ id: msg.id, action: 'flagged_for_human' })
      continue
    }

    try {
      const draft = await generateDraftResponse(client, msg)
      if (!draft) continue

      const gateResult = validateSMS(draft, { businessName: client.business_name })
      if (!gateResult.valid) {
        console.warn(`[${AGENT_ID}] message-gate blocked social draft: ${gateResult.issues.join('; ')}`)
        continue
      }

      await supabase.from('social_inbox').update({
        draft_response: gateResult.text,
        drafted_at: new Date().toISOString(),
        handled_at: new Date().toISOString(),
        flagged_for_review: false,
      }).eq('id', msg.id)

      drafted++
      handled.push({ id: msg.id, action: 'drafted', platform: msg.platform })
    } catch (err) {
      console.error(`[${AGENT_ID}] Draft failed for message ${msg.id}:`, err.message)
    }
  }

  if (!drafted && !flaggedForHuman) return null

  return {
    agentId: AGENT_ID,
    clientId: client.id,
    timestamp: Date.now(),
    status: 'action_taken',
    summary: `Social inbox for ${client.business_name}: ${drafted} drafted, ${flaggedForHuman} flagged for human review`,
    data: { drafted, flaggedForHuman, handled },
    requiresDirectorAttention: flaggedForHuman > 0,
  }
}

async function generateDraftResponse(client, msg) {
  const systemPrompt = `<business>
Name: ${client.business_name}
Industry: ${client.industry || 'business'}
</business>

<message>
Platform: ${msg.platform || 'social media'}
Type: ${msg.type || 'comment'}
Content: ${msg.content}
</message>

<task>
Write a professional, friendly draft response for this social media message.
Match the tone of the platform (Instagram = casual, Google = professional, Facebook = friendly).
</task>

<rules>
- 2-4 sentences
- Acknowledge their message specifically
- End with an invitation to connect further if appropriate
- Sound like a real person, not corporate
- Sign off as ${client.business_name}
- Output ONLY the response text
</rules>`

  return aiClient.call({
    modelString: 'groq/llama-3.3-70b-versatile',
    clientApiKeys: {},
    systemPrompt,
    messages: [{ role: 'user', content: 'Write the draft response.' }],
    maxTokens: 200,
    _workerName: AGENT_ID,
  })
}

async function report(outcomes) {
  const summary = {
    agentId: AGENT_ID,
    division: DIVISION,
    reportsTo: REPORTS_TO,
    timestamp: Date.now(),
    totalClients: outcomes.length,
    actionsCount: outcomes.filter(o => o.status === 'action_taken').length,
    escalations: outcomes.filter(o => o.requiresDirectorAttention),
    outcomes,
  }
  console.log(`[${AGENT_ID.toUpperCase()}] Report: ${summary.actionsCount} social inboxes processed`)
  return summary
}

async function receive(childReport) {
  console.log(`[${AGENT_ID.toUpperCase()}] Received from ${childReport.agentId}: ${childReport.summary}`)
}

module.exports = { run, report, receive, AGENT_ID, DIVISION, REPORTS_TO }
