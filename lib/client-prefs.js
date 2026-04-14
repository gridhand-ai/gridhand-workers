// ─── Client Preferences — inject personalized preferences into worker prompts ─
//
// Reads the client's `worker_preferences` JSONB from Supabase (populated by
// Commander preference extraction) and returns a formatted context string.
//
// Caches per-clientId for CACHE_TTL_MS. Silent on all errors.

const https = require('https');
const http  = require('http');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const cache = new Map(); // clientId → { text, expires }

async function fetchPrefs(clientId) {
    if (!SUPABASE_URL || !SERVICE_KEY || !clientId) return null;

    const path = `/rest/v1/clients?id=eq.${clientId}&select=worker_preferences,tone&limit=1`;

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
                try {
                    const rows = JSON.parse(body);
                    resolve(Array.isArray(rows) && rows.length > 0 ? rows[0] : null);
                } catch {
                    resolve(null);
                }
            });
        });

        req.on('error', () => resolve(null));
        req.setTimeout(4000, () => { req.destroy(); resolve(null); });
        req.end();
    });
}

/**
 * Build a preference context string from a worker_preferences object.
 */
function buildContextString(prefs, baseTone) {
    if (!prefs || typeof prefs !== 'object') return '';

    const lines = [];

    const tone = prefs.tone || baseTone;
    if (tone) lines.push(`Tone: ${tone}`);
    if (prefs.brand_voice) lines.push(`Brand voice: ${prefs.brand_voice}`);
    if (prefs.style_notes)  lines.push(`Style: ${prefs.style_notes}`);

    if (Array.isArray(prefs.prefer) && prefs.prefer.length > 0) {
        lines.push(`Preferred approach: ${prefs.prefer.join('; ')}`);
    }
    if (Array.isArray(prefs.avoid) && prefs.avoid.length > 0) {
        lines.push(`Avoid: ${prefs.avoid.join('; ')}`);
    }

    return lines.length > 0
        ? `\n\nCLIENT COMMUNICATION PREFERENCES:\n${lines.map(l => `- ${l}`).join('\n')}`
        : '';
}

/**
 * Get preference context string for a client.
 *
 * @param {string} clientId   Supabase UUID from client.clientId
 * @param {string} [baseTone] Fallback tone from client.settings.global.tone
 * @returns {Promise<string>}
 */
async function get(clientId, baseTone = '') {
    if (!clientId) return '';

    const now = Date.now();
    const cached = cache.get(clientId);
    if (cached && cached.expires > now) return cached.text;

    try {
        const row = await fetchPrefs(clientId);
        const text = buildContextString(row?.worker_preferences, row?.tone || baseTone);
        cache.set(clientId, { text, expires: now + CACHE_TTL_MS });
        return text;
    } catch {
        return '';
    }
}

/**
 * Enrich a system prompt with client preferences.
 * Safe to call unconditionally — returns original prompt if no prefs found.
 *
 * @param {string} systemPrompt
 * @param {string} clientId     from client.clientId
 * @param {string} [baseTone]   from client.settings.global.tone
 * @returns {Promise<string>}
 */
async function enrich(systemPrompt, clientId, baseTone) {
    const prefs = await get(clientId, baseTone);
    return systemPrompt + prefs;
}

module.exports = { get, enrich };
