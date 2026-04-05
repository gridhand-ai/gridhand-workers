/**
 * Deploy Watch — monitors portal + workers uptime and alerts MJ via Telegram.
 *
 * Runs as a background process inside the workers server (started in server.js).
 * Pings the portal health endpoint every 5 minutes.
 * If 2 consecutive checks fail, sends a Telegram alert.
 * Sends a recovery notification when the service comes back up.
 */

const PORTAL_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://gridhand-portal.vercel.app'
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN
const CHAT_ID    = process.env.MJ_TELEGRAM_CHAT_ID

const CHECK_INTERVAL_MS = 5 * 60 * 1000   // 5 minutes
const FAIL_THRESHOLD    = 2                // alert after 2 consecutive failures

const state = {
  portalFails:   0,
  portalDown:    false,
  lastAlertAt:   0,
  alertCooldown: 30 * 60 * 1000, // don't re-alert for same service within 30 min
}

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[DeployWatch] Telegram not configured (BOT_TOKEN or MJ_TELEGRAM_CHAT_ID missing) — skipping alert')
    return
  }
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
    })
  } catch (err) {
    console.error('[DeployWatch] Telegram send failed:', err.message)
  }
}

async function checkPortal() {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    const res = await fetch(`${PORTAL_URL}/api/health`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'GRIDHAND-DeployWatch/1.0' },
    })
    clearTimeout(timeout)

    if (res.ok) {
      if (state.portalDown) {
        // Recovery
        state.portalDown  = false
        state.portalFails = 0
        console.log('[DeployWatch] Portal recovered')
        await sendTelegram(`<b>GRIDHAND Portal — RECOVERED</b>\n\nPortal is back online at ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago' })} CT`)
      } else {
        state.portalFails = 0
      }
      return
    }

    // Non-2xx response
    state.portalFails++
    console.warn(`[DeployWatch] Portal check failed (${res.status}) — strike ${state.portalFails}/${FAIL_THRESHOLD}`)
  } catch (err) {
    state.portalFails++
    console.warn(`[DeployWatch] Portal unreachable — strike ${state.portalFails}/${FAIL_THRESHOLD}:`, err.message)
  }

  if (state.portalFails >= FAIL_THRESHOLD && !state.portalDown) {
    const now = Date.now()
    if (now - state.lastAlertAt > state.alertCooldown) {
      state.portalDown  = true
      state.lastAlertAt = now
      const ts = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago' })

      console.error(`[DeployWatch] Portal is DOWN — alerting MJ`)
      await sendTelegram(
        `<b>GRIDHAND Portal — DOWN</b>\n\n` +
        `Portal is unreachable at ${ts} CT\n` +
        `URL: ${PORTAL_URL}\n\n` +
        `Check Vercel: <a href="https://vercel.com/gridhand-ai">vercel.com/gridhand-ai</a>`
      )
    }
  }
}

function start() {
  console.log(`[DeployWatch] Started — checking portal every ${CHECK_INTERVAL_MS / 60000} min`)
  // First check after 1 minute (give server time to fully start)
  setTimeout(() => {
    checkPortal()
    setInterval(checkPortal, CHECK_INTERVAL_MS)
  }, 60_000)
}

module.exports = { start }
