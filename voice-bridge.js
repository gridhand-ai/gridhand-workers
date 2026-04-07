/**
 * voice-bridge.js
 *
 * WebSocket bridge: Twilio Media Streams <-> ElevenLabs Conversational AI
 *
 * Flow:
 *   1. Twilio calls the owner, no answer → no-answer webhook fires
 *   2. no-answer returns <Connect><Stream> with <Parameter> elements for clientId/caller
 *   3. Twilio opens a WS here and streams raw mulaw 8kHz audio
 *   4. We wait for the 'start' event to get clientId/caller from customParameters
 *   5. We open a WS to ElevenLabs ConvAI requesting ulaw_8000 output
 *   6. We pass mulaw audio in both directions — no transcoding needed
 *      ElevenLabs handles internal format conversion for STT + TTS
 *   7. ElevenLabs handles STT + LLM + TTS — all streaming, sub-second latency
 */

const WebSocket = require('ws')
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || ''

const START_TIMEOUT_MS    = 10_000    // max wait for Twilio 'start' event
const MAX_CALL_DURATION_MS = 300_000  // 5-minute hard cap per call

async function handleVoiceStream(twilioWs, authClaim = null) {
  let clientId  = ''
  let caller    = ''
  let elWs      = null
  let streamSid = null
  let callSid   = null
  let callLogId = null
  let started   = false
  let transcript  = []
  let audioBuffer = []   // safety-net buffer until ElevenLabs WS is open
  let elReady     = false
  let drainTimer  = null
  let maxCallTimer = null

  console.log('[VoiceBridge] New stream — waiting for start event')

  // ── 1. Wait for 'start' event ───────────────────────────────────────────────
  // Single persistent handler. Until `started` flips true we only look for the
  // start/connected envelope; afterward we route media/stop/mark normally.
  let resolveStart, rejectStart
  const startPromise = new Promise((resolve, reject) => {
    resolveStart = resolve
    rejectStart  = reject
  })
  const startTimeout = setTimeout(() => {
    if (!started) rejectStart(new Error('Timeout waiting for Twilio start event'))
  }, START_TIMEOUT_MS)

  twilioWs.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (!started) {
      if (msg.event === 'connected') {
        console.log('[VoiceBridge] Twilio connected')
        return
      }
      if (msg.event === 'start') {
        streamSid = msg.streamSid
        callSid   = msg.start?.callSid
        clientId  = msg.start?.customParameters?.clientId || ''
        caller    = msg.start?.customParameters?.caller   || ''

        // Enforce auth claim — callSid + clientId MUST match the signed token.
        if (authClaim) {
          if (authClaim.callSid && authClaim.callSid !== callSid) {
            console.warn(`[VoiceBridge] callSid mismatch token=${authClaim.callSid} start=${callSid} — closing`)
            clearTimeout(startTimeout)
            try { twilioWs.close() } catch {}
            rejectStart(new Error('callSid mismatch'))
            return
          }
          if (authClaim.clientId && authClaim.clientId !== clientId) {
            console.warn(`[VoiceBridge] clientId mismatch token=${authClaim.clientId} start=${clientId} — closing`)
            clearTimeout(startTimeout)
            try { twilioWs.close() } catch {}
            rejectStart(new Error('clientId mismatch'))
            return
          }
        }

        console.log(`[VoiceBridge] Stream started — streamSid=${streamSid} callSid=${callSid} clientId=${clientId} caller=${caller}`)
        started = true
        clearTimeout(startTimeout)
        resolveStart()
        return
      }
      // Unknown pre-start event — drop it
      return
    }

    // Post-start routing
    switch (msg.event) {
      case 'media':
        if (!msg.media?.payload) break
        if (elReady && elWs?.readyState === WebSocket.OPEN) {
          // Pass mulaw base64 directly — EL accepts mulaw 8kHz natively
          elWs.send(JSON.stringify({ type: 'user_audio_chunk', user_audio_chunk: msg.media.payload }))
        } else {
          // Safety net — briefly buffer until EL WS opens
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

  // ── 2. Wait for start, then connect to ElevenLabs ──────────────────────────
  try {
    await startPromise
  } catch (err) {
    console.error('[VoiceBridge] Start failed — closing connection:', err.message)
    try { twilioWs.close() } catch {}
    return
  }

  maxCallTimer = setTimeout(() => {
    console.warn('[VoiceBridge] Max call duration reached — forcing cleanup')
    logCall()
    cleanup()
  }, MAX_CALL_DURATION_MS)

  if (!clientId) {
    console.log('[VoiceBridge] No clientId in start event — closing')
    twilioWs.close()
    return
  }

  // ── 4. Fetch client from Supabase ───────────────────────────────────────────
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

  // ── 5. Get ElevenLabs signed URL ────────────────────────────────────────────
  // Request ulaw_8000 output so EL returns mulaw 8kHz — matches Twilio natively
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

  // ── 6. Connect to ElevenLabs ────────────────────────────────────────────────
  elWs = new WebSocket(elSignedUrl)

  elWs.on('open', () => {
    console.log(`[VoiceBridge] ElevenLabs WS opened for ${client.business_name}`)
    elWs.send(JSON.stringify({ type: 'conversation_initiation_client_data' }))
    elReady = true

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
      case 'conversation_initiation_metadata': {
        const meta = msg.conversation_initiation_metadata_event
        console.log(`[VoiceBridge] EL conversation started: id=${meta?.conversation_id} output_format=${meta?.agent_output_audio_format} input_format=${meta?.user_input_audio_format}`)
        break
      }

      case 'audio': {
        const audioPayload = msg.audio_event?.audio_base_64
        if (streamSid && audioPayload && twilioWs.readyState === WebSocket.OPEN) {
          // EL returns ulaw_8000 — forward directly to Twilio, chunked in 320-byte pieces
          const buf = Buffer.from(audioPayload, 'base64')
          const CHUNK_BYTES = 320  // 40ms of mulaw 8kHz per chunk
          for (let i = 0; i < buf.length; i += CHUNK_BYTES) {
            const slice = buf.slice(i, i + CHUNK_BYTES)
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
        if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'end_of_response' } }))
        }
        if (drainTimer) clearTimeout(drainTimer)
        drainTimer = setTimeout(() => { logCall(); cleanup() }, 35_000)
        break

      case 'ping':
        elWs.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event?.event_id }))
        break
    }
  })

  elWs.on('error', (err) => console.error('[VoiceBridge] ElevenLabs WS error:', err.message))
  elWs.on('close', () => {
    console.log('[VoiceBridge] ElevenLabs WS closed — keeping Twilio open to drain audio')
  })

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function cleanup() {
    if (drainTimer)   { clearTimeout(drainTimer);   drainTimer   = null }
    if (maxCallTimer) { clearTimeout(maxCallTimer);  maxCallTimer = null }
    audioBuffer = []
    if (elWs && elWs.readyState === WebSocket.OPEN) {
      try { elWs.close() } catch {}
    }
  }

  async function logCall() {
    if (!callSid || callLogId) return
    callLogId = 'logging'  // set synchronously to block concurrent calls before any await
    // NOTE: do NOT overwrite callLogId here — keep it as 'logging' until insert succeeds,
    // so any concurrent logCall() calls that slip through before the first await are blocked.
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
      callLogId = 'logged'
      console.log('[VoiceBridge] Call logged for', caller)
    } catch (err) {
      callLogId = null  // reset so a retry attempt is possible on error
      console.error('[VoiceBridge] Failed to log call:', err.message)
    }
  }
}

module.exports = { handleVoiceStream }
