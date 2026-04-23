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
const Anthropic = require('@anthropic-ai/sdk')
const twilio = require('twilio')
const { sendCriticalAlert } = require('./lib/events')

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
        // Decode caller — it arrives URL-encoded from TwiML <Parameter> (e.g. %2B12625551234)
        caller    = decodeURIComponent(msg.start?.customParameters?.caller || '')

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

        console.log(`[VoiceBridge] Stream started — streamSid=${streamSid} callSid=${callSid} clientId=${clientId} caller=***${caller.slice(-4)}`)
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
          // EL user audio format: { user_audio_chunk: base64 } — NO type field.
          // Including type: 'user_audio_chunk' makes EL treat it as a typed message
          // and ignore the audio, causing silence timeout → conversation_end.
          elWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }))
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
    sendCriticalAlert('voice-bridge:elevenlabs_connection_failed', err.message, { clientId }).catch(() => {})
    twilioWs.close()
    return
  }

  // ── 6. Connect to ElevenLabs ────────────────────────────────────────────────
  elWs = new WebSocket(elSignedUrl)

  elWs.on('open', () => {
    console.log(`[VoiceBridge] ElevenLabs WS opened for ${client.business_name}`)
    // Do NOT send conversation_initiation_client_data with invalid fields.
    // The agent is already configured with ulaw_8000 input/output in the EL dashboard.
    // The signed URL already includes ?output_format=ulaw_8000 for TTS output.
    // Sending unknown fields (e.g. asr.user_input_audio_format) causes EL to emit
    // an internal error and close the WS right after the greeting plays.
    elReady = true

    // Drop pre-connection buffer — these are stale Twilio connection chunks captured
    // before EL was ready. Flushing them confuses EL's turn detection and causes
    // conversation_end to fire immediately after the greeting. Discard them.
    if (audioBuffer.length > 0) {
      console.log(`[VoiceBridge] Dropping ${audioBuffer.length} pre-connection audio chunks (stale)`)
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

  elWs.on('error', (err) => {
    console.error('[VoiceBridge] ElevenLabs WS error:', err.message)
    // EL is gone — log the call and tear down. Without this, the Twilio call
    // would hang in silence for up to 5 minutes until maxCallTimer fires.
    logCall()
    cleanup()
  })
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
    // Also close the Twilio WS — otherwise Twilio holds the call open in silence
    // after EL disconnects or the 5-min cap fires.
    if (twilioWs && twilioWs.readyState === WebSocket.OPEN) {
      try { twilioWs.close() } catch {}
    }
  }

  async function buildCallNotes(transcriptLines, businessName) {
    if (!transcriptLines || transcriptLines.length === 0) return null
    try {
      const convo = transcriptLines
        .map(t => `${t.role === 'user' ? 'Caller' : 'Nova'}: ${t.text}`)
        .join('\n')

      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const res = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `You are summarizing a phone call to ${businessName} handled by an AI receptionist named Nova.

Transcript:
${convo}

Write a short call summary for the business owner. Use this EXACT format — no extra text:

INTENT: [one phrase — e.g. "Party booking inquiry", "Pricing question", "Left a message", "General info", "Complaint"]
TOPICS: [comma-separated list of what was discussed]
CALLER NAME: [name if mentioned, otherwise "Not provided"]
CALLER NUMBER: [phone number from context if mentioned, otherwise "Not provided"]
RESOLVED: [Yes / Partially / No]
FOLLOW-UP NEEDED: [Yes — describe what / No]
MESSAGE LEFT: [Yes / No]
MESSAGE CONTENT: [exact message the caller wanted to leave, or "N/A" if none]
NOTES: [1-2 sentences of anything else the owner should know]

Be concise. Owner reads this on their phone.`
        }]
      })
      return res.content[0]?.text || null
    } catch (err) {
      console.error('[VoiceBridge] Call notes generation failed:', err.message)
      return transcriptLines.map(t => `${t.role === 'user' ? 'Caller' : 'Nova'}: ${t.text}`).join('\n')
    }
  }

  function parseNotes(summary) {
    if (!summary) return {}
    const get = (field) => {
      const match = summary.match(new RegExp(`${field}:\\s*(.+)`, 'i'))
      return match ? match[1].trim() : null
    }
    return {
      intent:          get('INTENT'),
      callerName:      get('CALLER NAME'),
      callerNumber:    get('CALLER NUMBER'),
      messagLeft:      (get('MESSAGE LEFT') || '').toLowerCase() === 'yes',
      messageContent:  get('MESSAGE CONTENT'),
      followUpNeeded:  get('FOLLOW-UP NEEDED'),
    }
  }

  async function notifyOwner({ clientData, callerNum, notes, summary }) {
    const ownerCell = clientData?.owner_cell
    const twilioNum = clientData?.twilio_number || process.env.TWILIO_FROM_NUMBER
    const bizName   = clientData?.business_name || 'Your business'

    if (!ownerCell || !twilioNum) {
      console.log('[VoiceBridge] No owner_cell set — skipping SMS notification')
      return
    }

    // Build SMS
    let smsBody
    if (notes.messagLeft && notes.messageContent && notes.messageContent !== 'N/A') {
      const name = notes.callerName !== 'Not provided' ? notes.callerName : callerNum
      smsBody = `📞 ${bizName} — Message from ${name}:\n\n"${notes.messageContent}"\n\nNumber: ${callerNum}\nFull log in your dashboard.`
    } else {
      const intent = notes.intent || 'Inquiry'
      const name   = notes.callerName !== 'Not provided' ? notes.callerName : callerNum
      smsBody = `📞 ${bizName} — Nova handled a call from ${name}.\n\nTopic: ${intent}\nFollow-up: ${notes.followUpNeeded || 'None'}\n\nFull log in your dashboard.`
    }

    try {
      const tc = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
      await tc.messages.create({ from: twilioNum, to: ownerCell, body: smsBody })
      console.log(`[VoiceBridge] Owner notified via SMS: ${ownerCell}`)
    } catch (err) {
      console.error('[VoiceBridge] SMS notify failed:', err.message)
    }

    // Post to Commander dashboard
    try {
      const label = notes.messagLeft ? '📩 Message received via Nova' : '📞 Call handled by Nova'
      await supabase.from('commander_messages').insert({
        client_id: clientId,
        role:      'assistant',
        content:   `${label}\n\n${summary}`,
        channel:   'voice',
      })
      console.log('[VoiceBridge] Commander message posted')
    } catch (err) {
      console.error('[VoiceBridge] Commander insert failed:', err.message)
    }
  }

  async function logCall() {
    if (!callSid || callLogId) return
    callLogId = 'logging'  // set synchronously to block concurrent calls before any await

    let clientData = null
    try {
      const { data } = await supabase
        .from('clients')
        .select('business_name, owner_cell, twilio_number')
        .eq('id', clientId)
        .single()
      clientData = data
    } catch {}

    const businessName = clientData?.business_name || 'the business'
    const aiSummary    = await buildCallNotes(transcript, businessName)
    const notes        = parseNotes(aiSummary)

    try {
      await supabase.from('call_logs').insert({
        client_id:     clientId,
        caller_number: caller,
        call_sid:      callSid,
        status:        'ai_answered',
        transcript,
        ai_summary:    aiSummary || null,
      })
      callLogId = 'logged'
      console.log('[VoiceBridge] Call logged for', caller)
    } catch (err) {
      callLogId = null
      console.error('[VoiceBridge] Failed to log call:', err.message)
      return
    }

    // Notify owner — fire and forget, don't block cleanup
    notifyOwner({ clientData, callerNum: caller, notes, summary: aiSummary }).catch(err =>
      console.error('[VoiceBridge] notifyOwner failed:', err.message)
    )
  }
}

module.exports = { handleVoiceStream }
