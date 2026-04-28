// lib/mem0-client.js
// Per-client personalized AI memory via Mem0 (mem0ai SDK).
// Each client (user_id = clientId) has their own persistent memory
// stream — facts, preferences, history — fetched at conversation start
// and saved fire-and-forget after the reply.
//
// All calls are fully wrapped in try/catch — Mem0 outages NEVER break
// a worker reply. On any error, returns '' or no-ops.
'use strict';

const { MemoryClient } = require('mem0ai');

let _client = null;

function getClient() {
  if (_client) return _client;
  if (!process.env.MEM0_API_KEY) return null;
  try {
    _client = new MemoryClient({ apiKey: process.env.MEM0_API_KEY });
    return _client;
  } catch (err) {
    console.error('[mem0] init error:', err.message);
    return null;
  }
}

// Fetch all memories for a client. Returns a newline-joined string
// suitable for direct injection into a system prompt (inside an XML tag
// — see workers/base.js). Never throws.
async function getClientMemory(clientId) {
  if (!clientId) return '';
  const client = getClient();
  if (!client) return '';
  try {
    const memories = await client.getAll({ user_id: clientId });
    if (!memories || memories.length === 0) return '';
    return memories.map(m => m.memory).join('\n');
  } catch (err) {
    console.error('[mem0] getClientMemory error:', err.message);
    return '';
  }
}

// Save a conversation turn (user + assistant messages) to Mem0.
// Mem0 extracts facts/preferences automatically. Called fire-and-forget
// from base.js so SMS responses are never slowed by this network hop.
async function saveConversationMemory(clientId, messages) {
  if (!clientId || !messages || messages.length === 0) return;
  const client = getClient();
  if (!client) return;
  try {
    await client.add(messages, { user_id: clientId });
  } catch (err) {
    console.error('[mem0] saveConversationMemory error:', err.message);
  }
}

module.exports = { getClientMemory, saveConversationMemory };
