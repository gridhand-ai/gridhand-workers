// ─── Task Counter — Session-based billing tracker ─────────────────────────────
// A "task" = one meaningful business outcome delivered.
//
// Inbound workers: 1 task = 1 customer session (24-hour window per customer)
// Outbound workers: 1 task = 1 successful send
// Specialist workers: 1 task each, exempt from quota if client has à la carte add-on
//
// Storage: file-based per client per billing month (fast, Railway-local)
// Sync: pushes counts to Supabase so portal dashboard can display them
//
// Tier limits:
//   free:    100 tasks/month
//   starter: 1,000 tasks/month
//   growth:  5,000 tasks/month
//   command: unlimited

const fs   = require('fs');
const path = require('path');

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MEMORY_DIR = path.join(__dirname, '../memory');

const TIER_LIMITS = {
    free:    100,
    starter: 1000,
    growth:  5000,
    command: Infinity,
};

// Workers that count as outbound tasks (1 task = 1 successful send, no session needed)
const OUTBOUND_WORKERS = new Set([
    'review-requester', 'reminder', 'reactivation', 'lead-followup',
    'invoice-chaser', 'referral', 'upsell', 'weekly-report',
]);

// Specialist workers — exempt from quota if client has specialistAddOn: true
const SPECIALIST_WORKERS = new Set([
    'recall-commander', 'no-show-nurse', 'treatment-presenter',
    'prior-auth-bot', 'vaccine-reminder', 'rebook-reminder',
]);

// ─── Billing month key ────────────────────────────────────────────────────────
function getBillingMonth() {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ─── File path for client's monthly task count ────────────────────────────────
function getCounterPath(clientSlug) {
    const dir = path.join(MEMORY_DIR, clientSlug);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `tasks_${getBillingMonth()}.json`);
}

// ─── Load counter state for client ───────────────────────────────────────────
function loadCounter(clientSlug) {
    try {
        const fp = getCounterPath(clientSlug);
        if (!fs.existsSync(fp)) return { count: 0, sessions: {}, month: getBillingMonth() };
        return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {
        return { count: 0, sessions: {}, month: getBillingMonth() };
    }
}

// ─── Save counter state ───────────────────────────────────────────────────────
function saveCounter(clientSlug, state) {
    try {
        fs.writeFileSync(getCounterPath(clientSlug), JSON.stringify(state, null, 2));
    } catch (e) {
        console.error('[TaskCounter] Failed to save counter:', e.message);
    }
}

// ─── Sync count to Supabase (non-blocking, for portal dashboard) ──────────────
async function syncToSupabase(clientSlug, count, limit, tier) {
    try {
        await supabase
            .from('clients')
            .update({
                tasks_this_month: count,
                task_limit: limit === Infinity ? null : limit,
                billing_tier: tier,
            })
            .eq('slug', clientSlug);
    } catch {
        // Non-fatal
    }
}

// ─── Get tier limit for a client ─────────────────────────────────────────────
function getTierLimit(client) {
    const tier = client?.billing?.tier || 'free';
    return { tier, limit: TIER_LIMITS[tier] ?? TIER_LIMITS.free };
}

// ─── Session key: clientSlug + customerNumber + billing month ─────────────────
// Ensures same customer in same month within 24h = same task
function getSessionKey(customerNumber) {
    const safe = customerNumber.replace(/[^a-zA-Z0-9]/g, '');
    const dayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return `${safe}_${dayKey}`;
}

// ─── Check if customer already has an open session today ─────────────────────
function hasActiveSession(state, customerNumber) {
    const key = getSessionKey(customerNumber);
    const session = state.sessions[key];
    if (!session) return false;
    // Session expires after 24 hours
    return (Date.now() - session.startedAt) < 24 * 60 * 60 * 1000;
}

// ─── Open a new session for a customer ───────────────────────────────────────
function openSession(state, customerNumber) {
    const key = getSessionKey(customerNumber);
    state.sessions[key] = { startedAt: Date.now() };
    // Prune old sessions (keep last 200 to prevent file bloat)
    const keys = Object.keys(state.sessions);
    if (keys.length > 200) {
        const oldest = keys.sort((a, b) => state.sessions[a].startedAt - state.sessions[b].startedAt);
        oldest.slice(0, keys.length - 200).forEach(k => delete state.sessions[k]);
    }
}

// ─── Main: check if a task is allowed and increment counter if so ─────────────
// Returns: { allowed: bool, count: number, limit: number, tier: string, isNewTask: bool }
async function checkAndCount({ client, workerName, customerNumber = null }) {
    const clientSlug = client.slug;
    const { tier, limit } = getTierLimit(client);

    // Command tier = unlimited, always allowed
    if (limit === Infinity) {
        return { allowed: true, count: 0, limit: Infinity, tier, isNewTask: true };
    }

    // Specialists: exempt if client has specialistAddOn
    if (SPECIALIST_WORKERS.has(workerName) && client?.billing?.specialistAddOn) {
        return { allowed: true, count: 0, limit, tier, isNewTask: true };
    }

    const state = loadCounter(clientSlug);

    // Inbound workers: session-based dedup
    if (!OUTBOUND_WORKERS.has(workerName) && customerNumber) {
        if (hasActiveSession(state, customerNumber)) {
            // Continuing an existing session — not a new task, always allowed
            return { allowed: true, count: state.count, limit, tier, isNewTask: false };
        }
    }

    // At or over limit?
    if (state.count >= limit) {
        return { allowed: false, count: state.count, limit, tier, isNewTask: true };
    }

    // Increment count + open session
    state.count += 1;
    if (!OUTBOUND_WORKERS.has(workerName) && customerNumber) {
        openSession(state, customerNumber);
    }
    saveCounter(clientSlug, state);

    // Sync to Supabase async (don't block the worker)
    syncToSupabase(clientSlug, state.count, limit, tier).catch(() => {});

    return { allowed: true, count: state.count, limit, tier, isNewTask: true };
}

// ─── Get current count (for dashboard reads) ──────────────────────────────────
function getCount(clientSlug) {
    const state = loadCounter(clientSlug);
    return state.count;
}

module.exports = { checkAndCount, getCount, getTierLimit, TIER_LIMITS, getBillingMonth };
