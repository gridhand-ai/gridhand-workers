'use strict';
// lib/orb-handler.js
// Brain for the Client Orb — voice AI companion.
// Accepts clientId + message, fetches Mem0 memory, calls AI, returns reply + audioUrl.

const mem0Client = require('./mem0-client');
const aiClient = require('./ai-client');

// Lazy-require ElevenLabs — parallel agent may create it after this file
function getElevenLabs() {
  try { return require('./elevenlabs-client'); } catch { return null; }
}

async function handle(clientId, message) {
  // Fetch client memory (non-blocking if mem0 unavailable)
  const memory = await mem0Client.getClientMemory(clientId);

  const systemPrompt = [
    'You are Aria, a friendly AI voice companion for this business.',
    'Keep replies conversational, warm, and under 2 sentences.',
    'Answer questions about appointments, services, and hours if you know them.',
    memory ? `<memory>\n${memory}\n</memory>` : ''
  ].filter(Boolean).join('\n');

  let reply;
  try {
    reply = await aiClient.call(message, systemPrompt);
  } catch (err) {
    console.error('[orb-handler] AI call error:', err.message);
    return { reply: "I'm having a little trouble right now. Please try again in a moment.", audioUrl: null };
  }

  // Fire-and-forget memory save
  mem0Client.saveConversationMemory(clientId, [
    { role: 'user', content: message },
    { role: 'assistant', content: reply }
  ]).catch(() => {});

  // ElevenLabs TTS — graceful degradation if not available
  let audioUrl = null;
  const el = getElevenLabs();
  if (el && typeof el.tts === 'function') {
    try {
      const audioBuffer = await el.tts(reply);
      if (audioBuffer) {
        audioUrl = 'data:audio/mp3;base64,' + audioBuffer.toString('base64');
      }
    } catch (err) {
      console.error('[orb-handler] ElevenLabs TTS error:', err.message);
    }
  }

  return { reply, audioUrl };
}

module.exports = { handle };
