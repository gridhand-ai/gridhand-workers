// Customer Profiler — builds and maintains a full profile per customer per business
//
// PERSISTENCE: Supabase `customer_profiles` table (JSONB profile column).
// Replaces filesystem store, which did not survive Railway container restarts.
//
// API: All functions are async (`await getProfile(...)`, `await updateProfile(...)`).
// A short-lived in-memory cache (LRU, 60s TTL) absorbs hot-path reads inside a single
// inbound message handler so we don't hit Supabase 4x for the same customer.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
);

const TABLE = 'customer_profiles';
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;
const cache = new Map(); // key -> { profile, expiresAt }

function normalizePhone(phone) {
    return String(phone || '').replace(/[^0-9]/g, '');
}

function cacheKey(clientSlug, customerPhone) {
    return `${clientSlug}|${customerPhone}`;
}

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
        cache.delete(key);
        return null;
    }
    return hit.profile;
}

function cacheSet(key, profile) {
    if (cache.size >= CACHE_MAX) {
        // Evict oldest entry — Map preserves insertion order
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(key, { profile, expiresAt: Date.now() + CACHE_TTL_MS });
}

function cacheInvalidate(key) {
    cache.delete(key);
}

function defaultProfile(clientSlug, customerNumber) {
    return {
        customerNumber,
        clientSlug,
        name: null,
        firstContact: new Date().toISOString(),
        lastContact: null,
        totalInteractions: 0,
        services: [],
        lastWorker: null,
        lastSentiment: null,
        lastEmotion: null,
        communicationStyle: null, // casual, formal, brief, detailed
        responseSpeed: null,      // fast (<5min), medium (<1hr), slow
        isVIP: false,
        vipReason: null,
        totalSpend: 0,
        invoicesPaid: 0,
        invoicesOverdue: 0,
        appointmentsKept: 0,
        appointmentsCancelled: 0,
        appointmentsNoShow: 0,
        referralCount: 0,
        reviewLeft: false,
        optedOut: false,
        optedOutAt: null,
        tags: [],
        notes: [],
        leadScore: null,
        leadTier: null,
    };
}

async function getProfile(clientSlug, customerNumber) {
    const phone = normalizePhone(customerNumber);
    if (!clientSlug || !phone) return defaultProfile(clientSlug, customerNumber);

    const key = cacheKey(clientSlug, phone);
    const cached = cacheGet(key);
    if (cached) return cached;

    try {
        const { data, error } = await supabase
            .from(TABLE)
            .select('profile')
            .eq('client_slug', clientSlug)
            .eq('customer_phone', phone)
            .maybeSingle();

        if (error) {
            console.log(`[CustomerProfiler] read error: ${error.message}`);
            return defaultProfile(clientSlug, customerNumber);
        }

        const profile = data?.profile
            ? { ...defaultProfile(clientSlug, customerNumber), ...data.profile }
            : defaultProfile(clientSlug, customerNumber);

        cacheSet(key, profile);
        return profile;
    } catch (e) {
        console.log(`[CustomerProfiler] read exception: ${e.message}`);
        return defaultProfile(clientSlug, customerNumber);
    }
}

async function updateProfile(clientSlug, customerNumber, updates) {
    const phone = normalizePhone(customerNumber);
    if (!clientSlug || !phone) return defaultProfile(clientSlug, customerNumber);

    const existing = await getProfile(clientSlug, customerNumber);
    const updated = {
        ...existing,
        ...updates,
        lastContact: new Date().toISOString(),
        totalInteractions: (existing.totalInteractions || 0) + (updates._countInteraction ? 1 : 0),
    };
    delete updated._countInteraction;

    try {
        const { error } = await supabase
            .from(TABLE)
            .upsert({
                client_slug: clientSlug,
                customer_phone: phone,
                profile: updated,
            }, { onConflict: 'client_slug,customer_phone' });

        if (error) {
            console.log(`[CustomerProfiler] write error: ${error.message}`);
            return existing;
        }

        cacheSet(cacheKey(clientSlug, phone), updated);
        return updated;
    } catch (e) {
        console.log(`[CustomerProfiler] write exception: ${e.message}`);
        return existing;
    }
}

async function recordInteraction(clientSlug, customerNumber, { workerName, sentiment, emotion, extractedName } = {}) {
    const updates = {
        _countInteraction: true,
        lastWorker: workerName || null,
        lastSentiment: sentiment || null,
        lastEmotion: emotion || null,
    };
    if (extractedName) updates.name = extractedName;
    return updateProfile(clientSlug, customerNumber, updates);
}

async function recordService(clientSlug, customerNumber, serviceName) {
    const profile = await getProfile(clientSlug, customerNumber);
    const services = profile.services || [];
    if (!services.includes(serviceName)) services.push(serviceName);
    return updateProfile(clientSlug, customerNumber, { services });
}

async function addTag(clientSlug, customerNumber, tag) {
    const profile = await getProfile(clientSlug, customerNumber);
    const tags = profile.tags || [];
    if (!tags.includes(tag)) tags.push(tag);
    return updateProfile(clientSlug, customerNumber, { tags });
}

async function addNote(clientSlug, customerNumber, note) {
    const profile = await getProfile(clientSlug, customerNumber);
    const notes = profile.notes || [];
    notes.push({ note, ts: new Date().toISOString() });
    return updateProfile(clientSlug, customerNumber, { notes: notes.slice(-50) });
}

async function markOptedOut(clientSlug, customerNumber) {
    return updateProfile(clientSlug, customerNumber, {
        optedOut: true,
        optedOutAt: new Date().toISOString(),
    });
}

// Returns ALL customers for a client, keyed by phone (digits-only),
// with the lightweight summary fields the old `_index.json` used to hold.
async function getAllCustomers(clientSlug) {
    if (!clientSlug) return {};
    try {
        const { data, error } = await supabase
            .from(TABLE)
            .select('customer_phone, profile, updated_at')
            .eq('client_slug', clientSlug);

        if (error) {
            console.log(`[CustomerProfiler] getAllCustomers error: ${error.message}`);
            return {};
        }

        const out = {};
        for (const row of data || []) {
            const p = row.profile || {};
            // Use the original (non-normalized) customerNumber stored on the profile when available,
            // so admin UIs continue to display formatted numbers consistent with prior behavior.
            const displayKey = p.customerNumber || row.customer_phone;
            out[displayKey] = {
                lastContact: p.lastContact || row.updated_at,
                totalInteractions: p.totalInteractions || 0,
                lastSentiment: p.lastSentiment || null,
                isVIP: !!p.isVIP,
                optedOut: !!p.optedOut,
                name: p.name || null,
            };
        }
        return out;
    } catch (e) {
        console.log(`[CustomerProfiler] getAllCustomers exception: ${e.message}`);
        return {};
    }
}

// Test/debug helper — clear in-memory cache (DB untouched)
function _clearCache() { cache.clear(); }

module.exports = {
    getProfile,
    updateProfile,
    recordInteraction,
    recordService,
    addTag,
    addNote,
    markOptedOut,
    getAllCustomers,
    _clearCache,
};
