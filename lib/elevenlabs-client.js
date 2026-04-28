'use strict';
// lib/elevenlabs-client.js
// ElevenLabs Text-to-Speech REST client for the Client Orb.
// Returns mp3 audio as a Buffer. Returns null (never throws) on any error.
// Does NOT use WebSocket streaming — that's voice-bridge.js for Twilio calls.
// Uses Node.js native fetch (available since Node 18, confirmed on v25.8.1).

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel

/**
 * Convert text to speech via ElevenLabs REST API.
 *
 * @param {string} text        - The text to synthesize.
 * @param {string} [voiceId]   - ElevenLabs voice ID. Defaults to Rachel.
 * @returns {Promise<Buffer|null>} - mp3 audio as a Buffer, or null on any error.
 */
async function tts(text, voiceId = DEFAULT_VOICE_ID) {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.warn('[elevenlabs] ELEVENLABS_API_KEY not set — skipping TTS');
    return null;
  }

  if (!text || !text.trim()) {
    console.warn('[elevenlabs] tts called with empty text — skipping');
    return null;
  }

  const url = `${ELEVENLABS_API_BASE}/text-to-speech/${voiceId}`;

  const body = JSON.stringify({
    text: text.trim(),
    model_id: 'eleven_monolingual_v1',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
    },
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '(no body)');
      console.error(
        `[elevenlabs] API error ${response.status} ${response.statusText}: ${errorText}`
      );
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error('[elevenlabs] tts error:', err.message);
    return null;
  }
}

module.exports = { tts, DEFAULT_VOICE_ID };
