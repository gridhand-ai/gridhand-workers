'use strict'
// Linear — auto issue creation for system failures and agent escalations

let LinearClient
try {
  LinearClient = require('@linear/sdk').LinearClient
} catch (e) {
  LinearClient = null
}

let _client = null

function getClient() {
  if (!LinearClient) { console.warn('[linear] @linear/sdk not installed'); return null }
  if (!_client) {
    const key = process.env.LINEAR_API_KEY
    if (!key) { console.warn('[linear] LINEAR_API_KEY not set'); return null }
    _client = new LinearClient({ apiKey: key })
  }
  return _client
}

// Create an issue in Linear. teamId defaults to env var.
async function createIssue({ title, description, priority = 2, labelNames = [] }) {
  const linear = getClient()
  if (!linear) return null
  try {
    const teams = await linear.teams()
    const team  = teams.nodes[0]
    if (!team) { console.warn('[linear] No teams found'); return null }

    const issue = await linear.createIssue({
      teamId:      team.id,
      title,
      description,
      priority, // 1=urgent, 2=high, 3=medium, 4=low
    })
    const result = await issue.issue
    console.log(`[linear] Issue created: ${result?.identifier} — ${title}`)
    return result
  } catch (err) {
    console.warn('[linear] createIssue failed:', err.message)
    return null
  }
}

module.exports = { createIssue }
