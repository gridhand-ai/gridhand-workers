/**
 * voice-bridge.js
 *
 * WebSocket bridge: Twilio Media Streams <-> ElevenLabs Conversational AI
 *
 * Flow:
 *   1. Twilio calls the owner, no answer → no-answer webhook fires
 *   2. no-answer returns <Connect><Stream url="wss://workers.railway.app/voice-stream?clientId=xxx"/>
 *   3. Twilio opens a WS here and streams raw mulaw 8kHz audio
 *   4. We open a WS to ElevenLabs ConvAI with ulaw_8000 format (no transcoding needed)
 *   5. We bridge audio both directions in real time
 *   6. ElevenLabs handles STT + LLM + TTS — all streaming, sub-second latency
 */

const WebSocket = require('ws')
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || ''

async function handleVoiceStream(twilioWs, url) {
  const clientId = url.searchParams.get('clientId') || ''
  const caller   = url.searchParams.get('caller') || ''

  console.log(`[VoiceBridge] New stream — clientId=${clientId} caller=${caller}`)

  let elWs        = null
  let streamSid   = null
  let callSid     = null
  let callLogId   = null
  let transcript  = []
  let audioBuffer = []   // buffer Twilio audio chunks until ElevenLabs WS is open

  // ── 1. Attach Twilio listeners IMMEDIATELY (sync) so no events are dropped ──
  // Twilio sends 'connected' + 'start' within milliseconds of WS open.
  // If we await anything before attaching, those events are lost and streamSid stays null.
  twilioWs.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    switch (msg.event) {
      case 'connected':
        console.log('[VoiceBridge] Twilio connected')
        break

      case 'start':
        streamSid = msg.streamSid
        callSid   = msg.start?.callSid
        console.log(`[VoiceBridge] Stream started — streamSid=${streamSid} callSid=${callSid}`)
        break

      case 'media':
        if (!msg.media?.payload) break
        if (elWs?.readyState === WebSocket.OPEN) {
          // ElevenLabs is ready — send directly
          elWs.send(JSON.stringify({ type: 'user_audio_chunk', user_audio_chunk: msg.media.payload }))
        } else {
          // Buffer until ElevenLabs connects (max 200 chunks ~8s)
          if (audioBuffer.length < 200) audioBuffer.push(msg.media.payload)
        }
        break

      case 'stop':
        console.log('[VoiceBridge] Twilio stream stopped')
        logCall()
        cleanup()
        break

      case 'mark':
        if (msg.mark?.name === 'end_of_response') {
          console.log('[VoiceBridge] Twilio confirmed audio playback complete')
          logCall()
          cleanup()
        }
        break
    }
  })

  twilioWs.on('error', (err) => console.error('[VoiceBridge] Twilio WS error:', err.message))
  twilioWs.on('close', () => {
    console.log('[VoiceBridge] Twilio WS closed')
    logCall()
    cleanup()
  })

  // ── 2. Async: fetch client + ElevenLabs signed URL ─────────────────────────
  const { data: client } = await supabase
    .from('clients')
    .select('elevenlabs_agent_id, business_name')
    .eq('id', clientId)
    .single()

  if (!client?.elevenlabs_agent_id) {
    console.log(`[VoiceBridge] No ElevenLabs agent for client ${clientId} — closing`)
    twilioWs.close()
    return
  }

  let elSignedUrl
  try {
    const sigRes = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${client.elevenlabs_agent_id}`,
      { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
    )
    if (!sigRes.ok) throw new Error(`EL signed URL ${sigRes.status}`)
    const sigData = await sigRes.json()
    elSignedUrl = sigData.signed_url + '&output_format=ulaw_8000'
  } catch (err) {
    console.error('[VoiceBridge] Failed to get ElevenLabs signed URL:', err.message)
    twilioWs.close()
    return
  }

  // ── 3. Connect to ElevenLabs ────────────────────────────────────────────────
  elWs = new WebSocket(elSignedUrl)

  elWs.on('open', () => {
    console.log(`[VoiceBridge] ElevenLabs WS opened for ${client.business_name}`)
    // Minimal init — prompt/first_message/voice are locked in ElevenLabs dashboard
    elWs.send(JSON.stringify({ type: 'conversation_initiation_client_data' }))

    // Flush buffered audio from caller
    if (audioBuffer.length > 0) {
      console.log(`[VoiceBridge] Flushing ${audioBuffer.length} buffered audio chunks`)
      for (const payload of audioBuffer) {
        elWs.send(JSON.stringify({ type: 'user_audio_chunk', user_audio_chunk: payload }))
      }
      audioBuffer = []
    }
  })

  elWs.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    switch (msg.type) {
      case 'conversation_initiation_metadata':
        console.log('[VoiceBridge] EL conversation started:', msg.conversation_initiation_metadata_event?.conversation_id)
        break

      case 'audio': {
        const audioPayload = msg.audio_event?.audio_base_64
        if (streamSid && audioPayload && twilioWs.readyState === WebSocket.OPEN) {
          // Split into 320-byte chunks (40ms of mulaw 8kHz each) so Twilio
          // can buffer and play smoothly instead of receiving one massive blob
          const CHUNK_BYTES = 320
          const raw = Buffer.from(audioPayload, 'base64')
          for (let i = 0; i < raw.length; i += CHUNK_BYTES) {
            const slice = raw.slice(i, i + CHUNK_BYTES)
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: slice.toString('base64') },
            }))
          }
        }
        break
      }

      case 'interruption':
        if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: 'clear', streamSid }))
        }
        break

      case 'transcript':
        if (msg.transcript_event?.final && msg.transcript_event?.message) {
          transcript.push({ role: msg.transcript_event.role, text: msg.transcript_event.message })
        }
        break

      case 'conversation_end':
        console.log('[VoiceBridge] EL conversation ended — waiting for audio drain')
        // Send a mark so Twilio tells us when all queued audio has played
        if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'end_of_response' } }))
        }
        // Fallback: force-close after 35s if mark never comes back
        setTimeout(() => { logCall(); cleanup() }, 35000)
        break

      case 'ping':
        elWs.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event?.event_id }))
        break
    }
  })

  elWs.on('error', (err) => console.error('[VoiceBridge] ElevenLabs WS error:', err.message))
  elWs.on('close', () => {
    console.log('[VoiceBridge] ElevenLabs WS closed — keeping Twilio open to drain audio')
    // Do NOT close Twilio here — audio may still be buffered and playing.
    // Twilio will close via the mark callback or the 35s fallback timeout.
  })

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function cleanup() {
    if (elWs && elWs.readyState === WebSocket.OPEN) {
      try { elWs.close() } catch {}
    }
  }

  async function logCall() {
    if (!callSid || callLogId) return
    callLogId = 'logged'
    const summary = transcript.map(t => `${t.role === 'user' ? 'Caller' : 'AI'}: ${t.text}`).join('\n')
    try {
      await supabase.from('call_logs').insert({
        client_id:     clientId,
        caller_number: caller,
        call_sid:      callSid,
        status:        'ai_answered',
        transcript,
        ai_summary:    summary || null,
      })
      console.log('[VoiceBridge] Call logged for', caller)
    } catch (err) {
      console.error('[VoiceBridge] Failed to log call:', err.message)
    }
  }
}

module.exports = { handleVoiceStream }
