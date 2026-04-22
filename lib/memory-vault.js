'use strict';
// lib/memory-vault.js — GRIDHAND Universal Memory Vault
// Shared knowledge base for all agents. Every agent reads before acting,
// writes after learning. No manual handoffs needed — one brain, many hands.

const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// ─── Standard memory keys (all agents use these — no free-form keys) ───────
const KEYS = {
  BRAND_VOICE:          'brand_voice',
  CUSTOMER_PAIN_POINTS: 'customer_pain_points',
  OFFER_STRUCTURE:      'offer_structure',
  LAST_LEAD_OUTCOME:    'last_lead_outcome',
  COMMUNICATION_PREFS:  'communication_prefs',
  CHURN_SIGNALS:        'churn_signals',
  UPSELL_TRIGGERS:      'upsell_triggers',
  REVIEW_SENTIMENT:     'review_sentiment',
  CONTACT_HISTORY:      'contact_history',
  BUSINESS_GOALS:       'business_goals',
};

// ─── store: upsert a memory entry ──────────────────────────────────────────
// Upserts by (client_id, key) — newer value replaces older for same key.
async function store(clientId, key, content, importance = 5, agentSource = 'unknown') {
  if (!clientId || !key || content === undefined) return;
  const supabase = getSupabase();
  const { error } = await supabase.from('memory_vault').upsert({
    client_id:    clientId,
    key,
    content:      typeof content === 'object' ? content : { value: content },
    importance,
    agent_source: agentSource,
    updated_at:   new Date().toISOString(),
  }, { onConflict: 'client_id,key' });
  if (error) console.warn(`[memory-vault] store failed (${key}): ${error.message}`);
}

// ─── recall: retrieve specific keys for a client ───────────────────────────
async function recall(clientId, keys = []) {
  if (!clientId) return [];
  const supabase = getSupabase();
  let query = supabase
    .from('memory_vault')
    .select('key, content, importance, agent_source, updated_at')
    .eq('client_id', clientId)
    .order('importance', { ascending: false })
    .limit(20);
  if (keys.length > 0) query = query.in('key', keys);
  const { data, error } = await query;
  if (error) { console.warn(`[memory-vault] recall failed: ${error.message}`); return []; }
  return data || [];
}

// ─── getContext: format memories as an AI prompt injection string ───────────
async function getContext(clientId) {
  const memories = await recall(clientId);
  if (!memories.length) return '';
  const lines = memories.map(m => {
    const val = typeof m.content === 'object'
      ? (m.content.value || JSON.stringify(m.content))
      : String(m.content);
    return `• ${m.key}: ${val} [importance: ${m.importance}/10, source: ${m.agent_source}]`;
  });
  return `SHARED CLIENT MEMORY (from GRIDHAND collective):\n${lines.join('\n')}`;
}

module.exports = { store, recall, getContext, KEYS };
