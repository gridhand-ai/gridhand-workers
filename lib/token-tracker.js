'use strict';
// ── GRIDHAND Token Tracker ─────────────────────────────────────────────────
// Tracks cumulative API token usage across the entire worker hierarchy:
//   Commander → 4 Directors → 16 Specialists → 30 Workers
//
// Per-run counters reset on each commander invocation.
// Warns at configurable thresholds before hard limits are hit.
//
// Groq free tier limits (llama-3.3-70b-versatile):
//   - 6,000 tokens/minute (TPM)
//   - 30 requests/minute (RPM)
//   - 500,000 tokens/day
//
// Anthropic (Commander/Directors use Opus):
//   - Rate limits depend on tier — warns at 80% of configured limit

// ─── Provider limits (configurable via env vars) ──────────────────────────
const LIMITS = {
    groq: {
        tpm:  parseInt(process.env.GROQ_TPM_LIMIT  || '6000',  10),
        rpm:  parseInt(process.env.GROQ_RPM_LIMIT  || '30',    10),
        day:  parseInt(process.env.GROQ_DAY_LIMIT  || '500000',10),
    },
    anthropic: {
        // Claude Max or Tier-based. Set ANTHROPIC_TPM_LIMIT to your actual tier.
        tpm:  parseInt(process.env.ANTHROPIC_TPM_LIMIT || '100000', 10),
        day:  parseInt(process.env.ANTHROPIC_DAY_LIMIT || '1000000', 10),
    },
    ollama: {
        tpm: Infinity, day: Infinity, rpm: Infinity, // local/free
    },
};

const WARN_PCT = 0.80; // warn at 80% of limit

// ─── In-memory state ───────────────────────────────────────────────────────
// Minute window: rolling 60s bucket for TPM/RPM tracking
const _minute = {
    windowStart: Date.now(),
    tokens: { groq: 0, anthropic: 0, ollama: 0 },
    requests: { groq: 0, anthropic: 0, ollama: 0 },
};

// Run totals: reset per commander invocation via resetRun()
let _run = {
    id: null,
    startedAt: Date.now(),
    tokens:        { groq: 0, anthropic: 0, ollama: 0, moonshot: 0, perplexity: 0, openai: 0, total: 0 },
    input_tokens:  { groq: 0, anthropic: 0, ollama: 0, moonshot: 0, perplexity: 0, openai: 0 },
    output_tokens: { groq: 0, anthropic: 0, ollama: 0, moonshot: 0, perplexity: 0, openai: 0 },
    requests:      { groq: 0, anthropic: 0, ollama: 0, moonshot: 0, perplexity: 0, openai: 0, total: 0 },
    cost_usd:      { groq: 0, anthropic: 0, moonshot: 0, perplexity: 0, openai: 0 },
    warnings: [],
};

// Day totals: persist across runs (in-process only — resets on server restart)
const _day = {
    date: new Date().toISOString().slice(0, 10),
    tokens: { groq: 0, anthropic: 0, ollama: 0, total: 0 },
};

// ─── Price per 1k tokens (USD) ────────────────────────────────────────────
const PRICE_PER_1K = {
    groq:      0.00059, // llama-3.3-70b-versatile (blended in+out)
    anthropic: 0.015,   // Claude Opus 4.7 blended estimate
    ollama:    0,       // free / local
};

// ─── Helpers ──────────────────────────────────────────────────────────────
function _tickWindow() {
    const now = Date.now();
    if (now - _minute.windowStart > 60_000) {
        _minute.windowStart = now;
        _minute.tokens   = { groq: 0, anthropic: 0, ollama: 0 };
        _minute.requests = { groq: 0, anthropic: 0, ollama: 0 };
    }
}

function _resetDayIfNeeded() {
    const today = new Date().toISOString().slice(0, 10);
    if (_day.date !== today) {
        _day.date = today;
        _day.tokens = { groq: 0, anthropic: 0, ollama: 0, total: 0 };
    }
}

function _warn(provider, dimension, used, limit, tag) {
    const msg = `[token-tracker] ⚠️  ${provider} ${dimension} at ${Math.round(used/limit*100)}% (${used}/${limit}) [${tag}]`;
    if (!_run.warnings.includes(msg)) {
        _run.warnings.push(msg);
        console.warn(msg);
    }
}

// ─── Main: record a completed API call ────────────────────────────────────
// provider: 'groq' | 'anthropic' | 'ollama'
// tokens:   { input: N, output: N } — from API response usage object
// tag:      caller label e.g. 'acquisition-director/lead-qualifier'
function record(provider, tokens = {}, tag = 'unknown') {
    _tickWindow();
    _resetDayIfNeeded();

    const total = (tokens.input || 0) + (tokens.output || 0);
    const p = provider in LIMITS ? provider : 'ollama';

    // ── Minute window ──────────────────────────────────────────────────────
    _minute.tokens[p]   = (_minute.tokens[p]   || 0) + total;
    _minute.requests[p] = (_minute.requests[p] || 0) + 1;

    // ── Run totals (track actual input/output split per provider) ─────────────
    _run.tokens[p]        = (_run.tokens[p]        || 0) + total;
    _run.tokens.total     = (_run.tokens.total      || 0) + total;
    _run.input_tokens[p]  = (_run.input_tokens[p]  || 0) + (tokens.input  || 0);
    _run.output_tokens[p] = (_run.output_tokens[p] || 0) + (tokens.output || 0);
    _run.requests[p]      = (_run.requests[p]      || 0) + 1;
    _run.requests.total   = (_run.requests.total   || 0) + 1;
    _run.cost_usd[p]      = (_run.cost_usd[p]      || 0) + (total / 1000 * (PRICE_PER_1K[p] || 0));

    // ── Day totals ─────────────────────────────────────────────────────────
    _day.tokens[p]     = (_day.tokens[p]     || 0) + total;
    _day.tokens.total  = (_day.tokens.total  || 0) + total;

    // ── Threshold checks ───────────────────────────────────────────────────
    const L = LIMITS[p];
    if (L) {
        if (L.tpm && _minute.tokens[p] > L.tpm * WARN_PCT)
            _warn(p, 'TPM', _minute.tokens[p], L.tpm, tag);
        if (L.rpm && _minute.requests[p] > L.rpm * WARN_PCT)
            _warn(p, 'RPM', _minute.requests[p], L.rpm, tag);
        if (L.day && _day.tokens[p] > L.day * WARN_PCT)
            _warn(p, 'DAY', _day.tokens[p], L.day, tag);
    }

    return { provider: p, total, input: tokens.input || 0, output: tokens.output || 0 };
}

// ─── Reset run counters (call at start of each commander run) ─────────────
function resetRun(runId = null) {
    _run = {
        id: runId,
        startedAt: Date.now(),
        tokens:        { groq: 0, anthropic: 0, ollama: 0, moonshot: 0, perplexity: 0, openai: 0, total: 0 },
        input_tokens:  { groq: 0, anthropic: 0, ollama: 0, moonshot: 0, perplexity: 0, openai: 0 },
        output_tokens: { groq: 0, anthropic: 0, ollama: 0, moonshot: 0, perplexity: 0, openai: 0 },
        requests:      { groq: 0, anthropic: 0, ollama: 0, moonshot: 0, perplexity: 0, openai: 0, total: 0 },
        cost_usd:      { groq: 0, anthropic: 0, moonshot: 0, perplexity: 0, openai: 0 },
        warnings: [],
    };
}

// ─── Get current run summary ───────────────────────────────────────────────
function runSummary() {
    const elapsed = Math.round((Date.now() - _run.startedAt) / 1000);
    return {
        runId:    _run.id,
        elapsed_s: elapsed,
        tokens:   { ..._run.tokens },
        requests: { ..._run.requests },
        cost_usd: {
            groq:      +_run.cost_usd.groq.toFixed(4),
            anthropic: +_run.cost_usd.anthropic.toFixed(4),
            total:     +(_run.cost_usd.groq + _run.cost_usd.anthropic).toFixed(4),
        },
        minute_window: {
            tokens:   { ..._minute.tokens },
            requests: { ..._minute.requests },
        },
        day_tokens: { ..._day.tokens },
        warnings:  [ ..._run.warnings ],
    };
}

// ─── Quick log helper used by ai-client ───────────────────────────────────
function logUsage(provider, tag, inputTokens, outputTokens) {
    const result = record(provider, { input: inputTokens, output: outputTokens }, tag);
    // Only surface token burn to logs when it's a Claude model (costs real money).
    // Groq and Ollama are free — no noise.
    if (provider === 'anthropic') {
        const summary = runSummary();
        console.log(
            `[token-tracker] ${tag} | claude ${result.input}in+${result.output}out=${result.total}tok` +
            ` | run: ${summary.tokens.anthropic}tok ($${summary.cost_usd.anthropic}) | day: ${summary.day_tokens.anthropic}tok`
        );
    }
}

// ─── Persist run totals to Supabase usage_log ─────────────────────────────
// Called at end of each commander run. Inserts one row per active provider.
async function persistRun(supabase, runId) {
    const summary = runSummary();
    const providers = ['groq', 'anthropic', 'ollama', 'moonshot', 'perplexity', 'openai'];
    const rows = providers
        .filter(p => (summary.tokens[p] || 0) > 0)
        .map(p => ({
            run_id:        runId,
            provider:      p,
            input_tokens:  _run.input_tokens[p]  || 0,
            output_tokens: _run.output_tokens[p] || 0,
            cost_usd:      summary.cost_usd[p]   || 0,
        }));
    if (!rows.length) return;
    const { error } = await supabase.from('usage_log').insert(rows);
    if (error) console.warn(`[token-tracker] persistRun failed: ${error.message}`);
    else console.log(`[token-tracker] Persisted ${rows.length} provider rows for run ${runId}`);
}

module.exports = { record, resetRun, runSummary, logUsage, persistRun, LIMITS };
