'use strict'
// ── AGENT STATE — TTL-AWARE SUPABASE HELPERS ─────────────────────────────────
// Read/write agent state with automatic TTL enforcement.
// Rule: state older than STATE_TTL_DAYS is treated as a fresh start.
// Prevents stale decisions from months-old runs affecting current behavior.
// ─────────────────────────────────────────────────────────────────────────────

const STATE_TTL_DAYS = 7

/**
 * Get agent state. Returns null if not found OR if older than TTL.
 * @param {object} supabase - Supabase client
 * @param {string} agent    - Agent name (e.g. 'churn-predictor')
 * @param {string} clientId - Client UUID
 * @param {string} entityId - Specific entity within that agent (e.g. 'churn_score')
 */
async function getState(supabase, agent, clientId, entityId) {
  try {
    const { data, error } = await supabase
      .from('agent_state')
      .select('state, updated_at')
      .eq('agent', agent)
      .eq('client_id', clientId)
      .eq('entity_id', entityId)
      .single()

    if (error || !data) return null

    // TTL check — treat stale state as fresh start
    const age = Date.now() - new Date(data.updated_at).getTime()
    const ttlMs = STATE_TTL_DAYS * 24 * 60 * 60 * 1000
    if (age > ttlMs) {
      console.log(`[agent-state] State for ${agent}/${entityId} is ${Math.floor(age / 86400000)}d old — treating as fresh`)
      return null
    }

    return data.state
  } catch (err) {
    console.warn(`[agent-state] getState failed (${agent}/${entityId}):`, err.message)
    return null
  }
}

/**
 * Set (upsert) agent state. Always updates updated_at.
 */
async function setState(supabase, agent, clientId, entityId, state) {
  try {
    const { error } = await supabase
      .from('agent_state')
      .upsert({
        agent,
        client_id: clientId,
        entity_id: entityId,
        state,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'agent,client_id,entity_id' })

    if (error) throw error
    return true
  } catch (err) {
    console.warn(`[agent-state] setState failed (${agent}/${entityId}):`, err.message)
    return false
  }
}

/**
 * Clear state for an agent/client pair (force fresh start).
 */
async function clearState(supabase, agent, clientId, entityId = null) {
  try {
    let query = supabase.from('agent_state').delete().eq('agent', agent).eq('client_id', clientId)
    if (entityId) query = query.eq('entity_id', entityId)
    const { error } = await query
    if (error) throw error
    return true
  } catch (err) {
    console.warn(`[agent-state] clearState failed:`, err.message)
    return false
  }
}

/**
 * Get all state entries for an agent across all clients.
 * Filters out stale entries automatically.
 */
async function getAllState(supabase, agent) {
  try {
    const cutoff = new Date(Date.now() - STATE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await supabase
      .from('agent_state')
      .select('client_id, entity_id, state, updated_at')
      .eq('agent', agent)
      .gte('updated_at', cutoff)

    if (error) throw error
    return data || []
  } catch (err) {
    console.warn(`[agent-state] getAllState failed (${agent}):`, err.message)
    return []
  }
}

module.exports = { getState, setState, clearState, getAllState, STATE_TTL_DAYS }
