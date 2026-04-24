#!/usr/bin/env node
/**
 * GRIDHAND Fleet Monitor
 * Split view: Claude's live actions (top) + autonomous agent fleet (bottom)
 * Run: node scripts/monitor.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const { createClient } = require('@supabase/supabase-js')
const fs   = require('fs')
const path = require('path')

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ptmfbjynqqwjgdjmvfdc.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
const ACTION_LOG   = path.join(process.env.HOME || '', '.claude/session-actions.log')

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing Supabase credentials')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ── ANSI ──────────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',  bold:   '\x1b[1m',  dim:    '\x1b[2m',
  green:  '\x1b[32m', red:    '\x1b[31m', yellow: '\x1b[33m',
  cyan:   '\x1b[36m', blue:   '\x1b[34m', magenta:'\x1b[35m',
  white:  '\x1b[37m', gray:   '\x1b[90m',
  bgDark: '\x1b[48;5;234m',
  clear:  '\x1b[2J\x1b[H',
}

const cols = () => process.stdout.columns || 100
const hr = (char = '─') => C.gray + char.repeat(cols()) + C.reset
const pad  = (s, n) => String(s).slice(0, n).padEnd(n)
const rpad = (s, n) => String(s).slice(0, n).padStart(n)

function ts(iso) {
  if (!iso) return '--:--'
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function now() {
  return new Date().toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  })
}

// ── Claude action log reader ──────────────────────────────────────────────────
function readClaudeActions(limit = 12) {
  try {
    if (!fs.existsSync(ACTION_LOG)) return []
    const raw = fs.readFileSync(ACTION_LOG, 'utf8').trim()
    if (!raw) return []
    return raw.split('\n')
      .slice(-limit)
      .reverse()
      .map(line => {
        try { return JSON.parse(line) } catch { return null }
      })
      .filter(Boolean)
  } catch { return [] }
}

function toolColor(tool) {
  if (!tool) return C.gray
  if (tool === 'Agent')        return C.magenta
  if (tool === 'Bash')         return C.yellow
  if (tool === 'Edit' || tool === 'Write') return C.cyan
  if (tool === 'Read')         return C.blue
  if (tool.startsWith('mcp__claude_ai_Vercel')) return C.white
  if (tool.startsWith('mcp__claude_ai_Supabase')) return C.green
  if (tool.startsWith('mcp__playwright'))  return C.yellow
  if (tool.startsWith('mcp__github'))      return C.white
  return C.gray
}

// ── Fleet data fetch ──────────────────────────────────────────────────────────
async function fetchFleet() {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const since2h  = new Date(Date.now() -  2 * 60 * 60 * 1000).toISOString()

  // agent_runs is the portal-side operational heartbeat (372 rows, active every 15min)
  // activity_log is client-event ledger (only fills when real clients generate events)
  const { data: rows, error } = await supabase
    .from('agent_runs')
    .select('agent_id, status, summary, ran_at')
    .gte('ran_at', since24h)
    .order('ran_at', { ascending: false })
    .limit(200)

  if (error) return { error: error.message, agents: [], feed: [] }

  const agentMap = new Map()
  for (const row of rows || []) {
    const id = row.agent_id || 'unknown'
    if (!agentMap.has(id)) {
      agentMap.set(id, { name: id, runs: 0, errors: 0, lastActive: row.ran_at, lastError: null })
    }
    const a = agentMap.get(id)
    a.runs++
    if (row.status === 'error') { a.errors++; if (!a.lastError) a.lastError = row.summary }
  }

  const agents = [...agentMap.values()].map(a => ({
    ...a,
    errorRate: a.runs > 0 ? a.errors / a.runs : 0,
    activeNow: a.lastActive >= since2h,
    status: a.errors / Math.max(a.runs, 1) > 0.3 ? 'down'
           : a.errors / Math.max(a.runs, 1) >= 0.1 ? 'degraded'
           : a.lastActive < since2h ? 'idle' : 'healthy',
  })).sort((a, b) => b.lastActive.localeCompare(a.lastActive))

  // Map agent_runs fields to the display shape the renderer expects
  const feed = (rows || []).slice(0, 10).map(r => ({
    worker_name: r.agent_id,
    outcome: r.status === 'ok' ? 'ok' : r.status === 'error' ? 'error' : 'skip',
    message: r.summary || r.status,
    action: r.status,
    created_at: r.ran_at,
  }))

  return { agents, feed, error: null }
}

// ── Status dots ───────────────────────────────────────────────────────────────
function dot(status) {
  return status === 'healthy' ? C.green + '●' + C.reset
       : status === 'degraded'? C.yellow+ '◐' + C.reset
       : status === 'down'    ? C.red   + '●' + C.reset
       : C.gray + '·' + C.reset
}

function icon(outcome) {
  return outcome === 'ok'    ? C.green + '✓' + C.reset
       : outcome === 'error' ? C.red   + '✗' + C.reset
       : C.gray + '·' + C.reset
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(actions, fleet) {
  const w = cols()
  let out = C.clear

  // ── Header ─────────────────────────────────────────────────────────────────
  const title = ' GRIDHAND LIVE MONITOR '
  const t = ' ' + now() + ' '
  const gap = Math.max(w - title.length - t.length, 1)
  out += C.bold + C.cyan + title + C.reset
  out += C.gray + '─'.repeat(gap) + C.reset
  out += C.dim + t + C.reset + '\n'

  // ══ SECTION 1: CLAUDE ACTIONS ══════════════════════════════════════════════
  out += '\n'
  out += C.bold + C.magenta + '  ◈ CLAUDE — LIVE ACTIONS' + C.reset
  out += C.gray + C.dim + '  (what I\'m doing right now, in this session)' + C.reset + '\n'
  out += hr() + '\n'

  if (actions.length === 0) {
    out += C.gray + C.dim + '  Waiting for first action this session…\n' + C.reset
  } else {
    for (const a of actions) {
      const color = toolColor(a.tool)
      const toolLabel = pad(a.tool || '?', 28)
      const desc = (a.desc || '').slice(0, w - 50)
      const time = ts(a.ts)
      out += `  ${color}${toolLabel}${C.reset}  ${C.gray}${time}${C.reset}  ${desc}\n`
    }
  }

  out += '\n'

  // ── Prompt flow diagram ─────────────────────────────────────────────────────
  out += C.dim + C.gray + '  FLOW  ' + C.reset
  out += C.white  + 'YOUR PROMPT' + C.reset
  out += C.gray   + ' → ' + C.reset
  out += C.cyan   + 'COO (Claude)' + C.reset
  out += C.gray   + ' → brainstorm+plan → ' + C.reset
  out += C.yellow + 'Gemini' + C.reset
  out += C.gray   + ' refines brief → ' + C.reset
  out += C.green  + 'YOU APPROVE' + C.reset
  out += C.gray   + ' → coo-dispatch → ' + C.reset
  out += C.magenta+ 'Grid District' + C.reset
  out += C.gray   + ' → ' + C.reset
  out += C.yellow + 'Workers/Railway' + C.reset
  out += '\n'
  out += C.dim + C.gray + '  AUTO   ' + C.reset
  out += C.cyan   + 'Commander (Opus)' + C.reset
  out += C.gray   + ' → ' + C.reset
  out += C.magenta+ 'Directors x4 (Opus)' + C.reset
  out += C.gray   + ' → ' + C.reset
  out += C.yellow + '16 Specialists (Groq)' + C.reset
  out += C.gray   + ' → ' + C.reset
  out += C.green  + 'Workers (Railway)' + C.reset
  out += C.gray   + '  [runs independently of Claude]\n' + C.reset

  out += '\n' + hr('═') + '\n'

  // ══ SECTION 2: FLEET ═══════════════════════════════════════════════════════
  out += '\n'
  out += C.bold + C.yellow + '  ◈ AUTONOMOUS FLEET — 24h STATUS' + C.reset
  out += C.gray + C.dim + '  (workers running on Railway, independent of Claude)' + C.reset + '\n'
  out += hr() + '\n'

  if (fleet.error) {
    out += C.red + '  DB error: ' + fleet.error + C.reset + '\n'
  } else {
    const { agents, feed } = fleet
    const active   = agents.filter(a => a.activeNow).length
    const degraded = agents.filter(a => a.status === 'degraded').length
    const down     = agents.filter(a => a.status === 'down').length
    const totalRuns   = agents.reduce((s, a) => s + a.runs, 0)
    const totalErrors = agents.reduce((s, a) => s + a.errors, 0)
    const rate = totalRuns > 0 ? ((totalErrors / totalRuns) * 100).toFixed(1) : '0.0'

    out += `\n  ${C.bold}STATUS${C.reset}  `
    out += C.green + active + ' active' + C.reset + '  '
    out += (degraded ? C.yellow : C.gray) + degraded + ' degraded' + C.reset + '  '
    out += (down ? C.red : C.gray) + down + ' down' + C.reset + '  '
    out += C.gray + totalRuns + ' runs  ' + rate + '% error rate' + C.reset + '\n\n'

    for (const a of agents.slice(0, 8)) {
      const r = ((a.errorRate || 0) * 100).toFixed(0)
      const rColor = a.errorRate > 0.3 ? C.red : a.errorRate >= 0.1 ? C.yellow : C.green
      out += `  ${dot(a.status)}  ${pad(a.name, 26)}${C.gray}${rpad(a.runs + ' runs', 10)}${C.reset}${rColor}${rpad(r + '% err', 10)}${C.reset}${C.gray}  ${ts(a.lastActive)}${C.reset}\n`
    }

    if (feed.length > 0) {
      out += '\n' + hr() + '\n'
      for (const row of feed) {
        const msg = (row.message || row.action || '—').slice(0, w - 48)
        out += `  ${icon(row.outcome)}  ${C.gray}${ts(row.created_at)}${C.reset}  ${C.dim}${pad(row.worker_name || '?', 22)}${C.reset}  ${msg}\n`
      }
    }
  }

  out += '\n' + hr() + '\n'
  out += C.gray + C.dim + '  Ctrl+C to exit  ·  5s refresh  ·  gridhand.ai/admin/mission-control\n' + C.reset

  process.stdout.write(out)
}

// ── Main loop ─────────────────────────────────────────────────────────────────
let lastFleet = { agents: [], feed: [], error: null }

async function tick() {
  try {
    const actions = readClaudeActions(12)
    try { lastFleet = await fetchFleet() } catch {}
    render(actions, lastFleet)
  } catch (e) {
    process.stdout.write(C.clear + C.red + '  Error: ' + e.message + C.reset + '\n')
  }
}

process.on('SIGINT', () => {
  process.stdout.write('\x1b[?25h')
  process.stdout.write(C.clear)
  process.exit(0)
})

process.stdout.write('\x1b[?25l')
tick()
setInterval(tick, 5000)
