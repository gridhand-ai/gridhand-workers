'use strict'
// ── GRIDHAND TERMINAL NOTIFIER ────────────────────────────────────────────────
// Writes real-time alerts to ~/.mj_terminal_feed so MJ sees them in terminal.
// Mirrors critical alerts to Telegram always.
// Usage: notify({ message, level, source })
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs')
const path = require('path')
const os   = require('os')
const https = require('https')

const FEED_FILE = path.join(os.homedir(), '.mj_terminal_feed')
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID || process.env.MJ_TELEGRAM_CHAT_ID

const LEVELS = {
  info:     '💬',
  success:  '✅',
  warning:  '⚠️ ',
  error:    '🚨',
  critical: '🔴',
}

/**
 * Send notification to terminal feed + optionally Telegram
 * @param {object} opts
 * @param {string} opts.message   - What to say
 * @param {string} opts.level     - info | success | warning | error | critical
 * @param {string} opts.source    - Which agent is sending (e.g. 'executive-assistant')
 * @param {boolean} opts.telegram - Force Telegram even for low-level (default: level >= warning)
 */
function notify({ message, level = 'info', source = 'system', telegram = null }) {
  const icon    = LEVELS[level] || '💬'
  const time    = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  const srcTag  = source.toUpperCase().replace(/-/g, ' ')
  const line    = `[${time}] ${icon} ${srcTag}: ${message}\n`

  // Always write to terminal feed
  try {
    fs.appendFileSync(FEED_FILE, line)
  } catch (err) {
    console.warn('[NOTIFIER] Could not write to terminal feed:', err.message)
  }

  // Terminal feed: only what's worth interrupting active work
  // warning / error / critical + major completions (success with 'complete'|'done'|'failed'|'deployed')
  const terminalWorthy = ['warning', 'error', 'critical'].includes(level) ||
    (level === 'success' && /complete|done|failed|deployed|finished|ready/i.test(message))

  if (!terminalWorthy) {
    // Wipe the line we just wrote — terminal doesn't need it
    try {
      const lines = fs.readFileSync(FEED_FILE, 'utf8').split('\n')
      lines.pop(); lines.pop() // remove empty + the line we just wrote
      fs.writeFileSync(FEED_FILE, lines.join('\n') + '\n')
    } catch {}
  }

  // Telegram: always, every level
  if (BOT_TOKEN && CHAT_ID) {
    sendTelegram(`${icon} *${srcTag}*\n${message}`)
  }
}

function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) return
  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown' })
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  })
  req.on('error', () => {}) // silent fail
  req.write(body)
  req.end()
}

/**
 * Clear the terminal feed (keeps last 100 lines)
 */
function trimFeed() {
  try {
    if (!fs.existsSync(FEED_FILE)) return
    const lines = fs.readFileSync(FEED_FILE, 'utf8').split('\n').filter(Boolean)
    if (lines.length > 100) {
      fs.writeFileSync(FEED_FILE, lines.slice(-100).join('\n') + '\n')
    }
  } catch {}
}

module.exports = { notify, sendTelegram, trimFeed, FEED_FILE }
