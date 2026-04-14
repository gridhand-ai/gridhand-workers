// ─── Industry Learnings — inject pooled industry wisdom into worker prompts ───
//
// Fetches the most recent learnings for a given industry from Supabase and
// returns them as a formatted string ready to append to any system prompt.
//
// Caches per-industry for CACHE_TTL_MS to avoid hammering Supabase on every
// message. On any error returns "" silently — never breaks a worker.

const https = require('https');
const http  = require('http');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const cache = new Map(); // industry → { text, expires }

/**
 * Fetch learnings for an industry from Supabase.
 * Returns raw rows or [] on error.
 */
async function fetchFromSupabase(industry) {
    if (!SUPABASE_URL || !SERVICE_KEY) return [];

    const encoded = encodeURIComponent(industry);
    const path = `/rest/v1/industry_learnings?industry=eq.${encoded}&order=created_at.desc&limit=5&select=learning,worker_type,confidence_score`;

    return new Promise((resolve) => {
        const url = new URL(SUPABASE_URL + path);
        const lib = url.protocol === 'https:' ? https : http;

        const req = lib.request({
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'GET',
            headers: {
                'apikey': SERVICE_KEY,
                'Authorization': `Bearer ${SERVICE_KEY}`,
                'Content-Type': 'application/json',
            },
        }, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch { resolve([]); }
            });
        });

        req.on('error', () => resolve([]));
        req.setTimeout(5000, () => { req.destroy(); resolve([]); });
        req.end();
    });
}

/**
 * Get industry learning context string for injection into a system prompt.
 * Returns "" if no learnings exist or on any error.
 *
 * @param {string} industry  e.g. "Dental", "Auto Repair", "Real Estate"
 * @returns {Promise<string>}
 */
async function get(industry) {
    if (!industry) return '';

    const now = Date.now();
    const cached = cache.get(industry);
    if (cached && cached.expires > now) return cached.text;

    try {
        const rows = await fetchFromSupabase(industry);
        if (!rows || rows.length === 0) {
            cache.set(industry, { text: '', expires: now + CACHE_TTL_MS });
            return '';
        }

        const lines = rows
            .filter(r => r.learning && r.learning.trim())
            .map(r => `- ${r.learning.trim()}`);

        if (lines.length === 0) {
            cache.set(industry, { text: '', expires: now + CACHE_TTL_MS });
            return '';
        }

        const text = `\n\nINDUSTRY LEARNINGS (what works for ${industry} businesses):\n${lines.join('\n')}`;
        cache.set(industry, { text, expires: now + CACHE_TTL_MS });
        return text;
    } catch {
        return '';
    }
}

/**
 * Append industry learnings to an existing system prompt string.
 * Safe to call unconditionally — returns original prompt if no learnings found.
 *
 * @param {string}  systemPrompt
 * @param {string}  industry
 * @returns {Promise<string>}
 */
async function enrich(systemPrompt, industry) {
    const learnings = await get(industry);
    return systemPrompt + learnings;
}

module.exports = { get, enrich };
