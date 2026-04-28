// lib/memory-client.js
// Persistent agent memory — file and retrieve specialist interactions.
// Summarization runs on Ollama (local/free). Raw data stored in Supabase agent_memory table.
'use strict';

const { createClient } = require('@supabase/supabase-js');
const aiClient = require('./ai-client');

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// ─── Summarize via tier='simple' (Ollama → Groq 8B fallback) ──────────────────
async function summarizeLocally(rawContent, workerLabel) {
  const systemPrompt = `You are filing specialist agent interactions into long-term memory for GRIDHAND AI.
Write a concise memory entry (3-6 sentences). Include:
- What the agent did
- Key outcomes or actions taken
- Any pending tasks or escalations
- Relevant client names or data points
Output ONLY the memory entry text. No labels, no JSON.`;

  const userMsg = `Worker: ${workerLabel}
Output:
${JSON.stringify(rawContent, null, 2).slice(0, 3000)}`;

  try {
    const result = await aiClient.call({
      tier:         'simple',
      systemPrompt,
      messages:     [{ role: 'user', content: userMsg }],
      maxTokens:    300,
      _workerName:  'memory-client/summarize',
    });
    if (result && result.length > 20) return result.trim();
  } catch (_) {}

  return null; // summary stays null if both unavailable
}

// ─── File an interaction (called by every specialist after completing work) ───
// report: the specialist's output object (actionsCount, outcomes, escalations, etc.)
// meta: { workerId, clientId?, interactionType, runId?, severity? }
async function fileInteraction(report, meta) {
  const {
    workerId,
    clientId         = null,
    interactionType  = 'specialist_run',
    runId            = null,
    severity         = null,
  } = meta;

  // Summarize async — don't block the specialist from returning
  const summary = await summarizeLocally(report, workerId).catch(() => null);

  const supabase = getSupabase();
  const { error } = await supabase.from('agent_memory').insert({
    client_id:        clientId,
    worker_id:        workerId,
    interaction_type: interactionType,
    raw_content:      report,
    summary,
    severity,
    run_id:           runId,
  });

  if (error) {
    console.warn(`[memory-client] Failed to file interaction for ${workerId}: ${error.message}`);
  } else {
    console.log(`[memory-client] Filed → ${workerId} / ${interactionType}${summary ? ' (summarized)' : ' (no summary)'}`);
  }
}

// ─── Retrieve memory summaries for a briefing ─────────────────────────────────
// Used by Commander before each run to pull recent context.
// Returns array of memory objects sorted by recency.
async function retrieveMemory({ workerIds = [], clientId = null, limit = 20, since = null } = {}) {
  const supabase = getSupabase();

  let query = supabase
    .from('agent_memory')
    .select('id, created_at, worker_id, interaction_type, summary, severity, run_id, client_id')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (workerIds.length > 0) query = query.in('worker_id', workerIds);
  if (clientId) query = query.eq('client_id', clientId);
  if (since) query = query.gte('created_at', since);

  const { data, error } = await query;
  if (error) {
    console.warn(`[memory-client] Retrieve failed: ${error.message}`);
    return [];
  }
  return data || [];
}

// ─── Fetch raw content for a specific memory entry ────────────────────────────
// Used when a summary isn't enough — Commander asks for the full raw_content.
async function fetchRawMemory(memoryId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('agent_memory')
    .select('*')
    .eq('id', memoryId)
    .single();
  if (error) return null;
  return data;
}

// ─── Build a memory briefing string for Commander ─────────────────────────────
// Asks local model to synthesize recent memories into a briefing paragraph.
async function buildMemoryBriefing(memories) {
  if (!memories.length) return 'No prior memory entries found for this run.';

  const memoryText = memories.map(m =>
    `[${m.created_at?.slice(0, 16)}] ${m.worker_id} (${m.interaction_type}): ${m.summary || 'No summary available.'}`
  ).join('\n');

  const systemPrompt = `You are briefing the GRIDHAND Commander AI before it starts a new orchestration run.
Write a brief (3-5 sentence) operational briefing: What has the system been working on?
Any patterns, escalations, or unresolved items the Commander should know about?
Output ONLY the briefing text.`;

  const userMsg = `Recent agent memory (most recent first):
${memoryText}`;

  try {
    const result = await aiClient.call({
      tier:        'simple',
      systemPrompt,
      messages:    [{ role: 'user', content: userMsg }],
      maxTokens:   250,
      _workerName: 'memory-client/briefing',
    });
    if (result && result.length > 20) return result.trim();
  } catch (_) {}

  // Fallback: concatenate summaries directly
  return memories
    .filter(m => m.summary)
    .map(m => `${m.worker_id}: ${m.summary}`)
    .join('\n') || 'Memory available but local model unreachable for briefing.';
}

module.exports = { fileInteraction, retrieveMemory, fetchRawMemory, buildMemoryBriefing };
