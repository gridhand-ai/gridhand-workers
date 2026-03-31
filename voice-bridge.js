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

/**
 * Called from server.js on WebSocket upgrade events for /voice-stream
 * @param {WebSocket} twilioWs - the WebSocket connection from Twilio
 * @param {URL} url - the full request URL (contains clientId, caller query params)
 */
async function handleVoiceStream(twilioWs, url) {
  const clientId = url.searchParams.get('clientId') || ''
  const caller   = url.searchParams.get('caller') || ''

  console.log(`[VoiceBridge] New stream — clientId=${clientId} caller=${caller}`)

  let elWs = null            // ElevenLabs WebSocket
  let streamSid = null       // Twilio stream SID (needed to send audio back)
  let callSid   = null       // Twilio call SID (for logging)
  let callLogId = null       // Supabase call_logs row id
  let transcript = []        // [{role, text}] accumulator

  // ── Fetch client info from Supabase ────────────────────────────────────────
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

  const agentId     = client.elevenlabs_agent_id
  const businessName = client.business_name || 'this business'

  // ── Open ElevenLabs ConvAI WebSocket ───────────────────────────────────────
  // Using signed URL flow so we can pass overrides
  let elSignedUrl
  try {
    const sigRes = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
      { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
    )
    if (!sigRes.ok) throw new Error(`EL signed URL error: ${sigRes.status}`)
    const sigData = await sigRes.json()
    // Append output_format so ElevenLabs sends mulaw 8kHz — matches Twilio exactly
    elSignedUrl = sigData.signed_url + '&output_format=ulaw_8000'
  } catch (err) {
    console.error(`[VoiceBridge] Failed to get ElevenLabs signed URL: ${err.message}`)
    twilioWs.close()
    return
  }

  elWs = new WebSocket(elSignedUrl)

  // ── ElevenLabs WS: open ─────────────────────────────────────────────────────
  elWs.on('open', () => {
    console.log(`[VoiceBridge] ElevenLabs WS opened for ${businessName}`)

    // Minimal init — agent prompt/first_message/voice are configured in ElevenLabs dashboard
    // Overriding those fields is locked by the agent config and causes an immediate 1008 close
    elWs.send(JSON.stringify({ type: 'conversation_initiation_client_data' }))
  })

  // ── ElevenLabs WS: messages ─────────────────────────────────────────────────
  elWs.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    switch (msg.type) {
      case 'conversation_initiation_metadata':
        console.log(`[VoiceBridge] EL conversation started: ${msg.conversation_initiation_metadata_event?.conversation_id}`)
        break

      case 'audio':
        // ElevenLabs sending TTS audio — forward to Twilio as mulaw
        if (streamSid && msg.audio_event?.audio_base_64) {
          const payload = {
            event: 'media',
            streamSid,
            media: { payload: msg.audio_event.audio_base_64 },
          }
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify(payload))
          }
        }
        break

      case 'interruption':
        // Caller interrupted the AI — tell Twilio to clear its buffer
        if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: 'clear', streamSid }))
        }
        break

      case 'transcript':
        // Accumulate transcript for logging
        if (msg.transcript_event) {
          const { role, message: text, final } = msg.transcript_event
          if (final && text) {
            transcript.push({ role, text })
          }
        }
        break

      case 'agent_response':
        // AI finished speaking a turn — nothing to do, audio already sent above
        break

      case 'conversation_end':
        console.log(`[VoiceBridge] EL conversation ended`)
        logCall({ clientId, caller, callSid, transcript })
        cleanup()
        break

      case 'ping':
        elWs.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event?.event_id }))
        break

      default:
        // Ignore other event types
        break
    }
  })

  elWs.on('error', (err) => {
    console.error(`[VoiceBridge] ElevenLabs WS error: ${err.message}`)
  })

  elWs.on('close', () => {
    console.log(`[VoiceBridge] ElevenLabs WS closed`)
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close()
  })

  // ── Twilio WS: messages ──────────────────────────────────────────────────────
  twilioWs.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    switch (msg.event) {
      case 'connected':
        console.log(`[VoiceBridge] Twilio WS connected`)
        break

      case 'start':
        streamSid = msg.streamSid
        callSid   = msg.start?.callSid
        console.log(`[VoiceBridge] Stream started — streamSid=${streamSid} callSid=${callSid}`)
        break

      case 'media':
        // Caller audio — forward to ElevenLabs as base64 mulaw
        if (elWs?.readyState === WebSocket.OPEN && msg.media?.payload) {
          elWs.send(JSON.stringify({
            type: 'user_audio_chunk',
            user_audio_chunk: msg.media.payload,
          }))
        }
        break

      case 'stop':
        console.log(`[VoiceBridge] Twilio stream stopped`)
        logCall({ clientId, caller, callSid, transcript })
        cleanup()
        break

      default:
        break
    }
  })

  twilioWs.on('error', (err) => {
    console.error(`[VoiceBridge] Twilio WS error: ${err.message}`)
  })

  twilioWs.on('close', () => {
    console.log(`[VoiceBridge] Twilio WS closed`)
    logCall({ clientId, caller, callSid, transcript })
    cleanup()
  })

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function cleanup() {
    if (elWs && elWs.readyState === WebSocket.OPEN) {
      try { elWs.close() } catch {}
    }
  }

  async function logCall({ clientId, caller, callSid, transcript }) {
    if (!callSid || callLogId) return // Already logged or no callSid yet
    callLogId = 'logged' // Prevent duplicate logs

    const summary = transcript
      .map(t => `${t.role === 'user' ? 'Caller' : 'AI'}: ${t.text}`)
      .join('\n')

    try {
      await supabase.from('call_logs').insert({
        client_id:     clientId,
        caller_number: caller,
        call_sid:      callSid,
        status:        'ai_answered',
        transcript:    transcript,
        ai_summary:    summary || null,
      })
      console.log(`[VoiceBridge] Call logged for ${caller}`)
    } catch (err) {
      console.error(`[VoiceBridge] Failed to log call: ${err.message}`)
    }
  }
}

module.exports = { handleVoiceStream }
