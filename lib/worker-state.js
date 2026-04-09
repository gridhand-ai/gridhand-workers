// ─── Worker State Machine ─────────────────────────────────────────────────────
// Gives every worker an explicit lifecycle — no more guessing what's running.
//
// States:
//   idle       → worker is registered but not processing anything
//   running    → actively handling a customer message
//   retrying   → failed once, attempting retry
//   escalated  → failed all retries, MJ notified
//   paused     → client hit task limit, worker is suspended
//   degraded   → running on fallback provider (Anthropic down)
//
// State is kept in memory (per-process) — lightweight, no DB needed.
// Dashboard can query via GET /api/worker-states (added to server.js).

const { EventEmitter } = require('events');

const STATES = {
    IDLE:      'idle',
    RUNNING:   'running',
    RETRYING:  'retrying',
    ESCALATED: 'escalated',
    PAUSED:    'paused',
    DEGRADED:  'degraded',
};

class WorkerStateMachine extends EventEmitter {
    constructor() {
        super();
        // Map of `${clientSlug}:${workerName}` → state object
        this._states = new Map();
    }

    // ── Get or create state entry ───────────────────────────────────────────
    _key(workerName, clientSlug) {
        return `${clientSlug}:${workerName}`;
    }

    _get(workerName, clientSlug) {
        const key = this._key(workerName, clientSlug);
        if (!this._states.has(key)) {
            this._states.set(key, {
                workerName,
                clientSlug,
                state: STATES.IDLE,
                since: Date.now(),
                lastCustomer: null,
                retryCount: 0,
                totalRuns: 0,
                totalFailures: 0,
                provider: 'anthropic',
            });
        }
        return this._states.get(key);
    }

    // ── Transition ────────────────────────────────────────────────────────
    _transition(workerName, clientSlug, newState, meta = {}) {
        const entry = this._get(workerName, clientSlug);
        const prev  = entry.state;
        entry.state = newState;
        entry.since = Date.now();
        Object.assign(entry, meta);
        this.emit('transition', { workerName, clientSlug, from: prev, to: newState, ...meta });
        return entry;
    }

    // ── Public API ────────────────────────────────────────────────────────
    start(workerName, clientSlug, customerNumber) {
        const entry = this._get(workerName, clientSlug);
        entry.totalRuns += 1;
        return this._transition(workerName, clientSlug, STATES.RUNNING, {
            lastCustomer: customerNumber,
            retryCount: 0,
        });
    }

    complete(workerName, clientSlug) {
        return this._transition(workerName, clientSlug, STATES.IDLE);
    }

    retry(workerName, clientSlug, retryCount) {
        return this._transition(workerName, clientSlug, STATES.RETRYING, { retryCount });
    }

    escalate(workerName, clientSlug) {
        const entry = this._get(workerName, clientSlug);
        entry.totalFailures += 1;
        return this._transition(workerName, clientSlug, STATES.ESCALATED);
    }

    pause(workerName, clientSlug) {
        return this._transition(workerName, clientSlug, STATES.PAUSED);
    }

    degrade(workerName, clientSlug, fallbackProvider) {
        return this._transition(workerName, clientSlug, STATES.DEGRADED, { provider: fallbackProvider });
    }

    restore(workerName, clientSlug) {
        return this._transition(workerName, clientSlug, STATES.IDLE, { provider: 'anthropic' });
    }

    // ── Query ─────────────────────────────────────────────────────────────
    getState(workerName, clientSlug) {
        return this._get(workerName, clientSlug);
    }

    // Get all states for a client
    getClientStates(clientSlug) {
        const result = [];
        for (const [key, entry] of this._states) {
            if (key.startsWith(`${clientSlug}:`)) result.push(entry);
        }
        return result;
    }

    // Get all non-idle states (what's actually happening right now)
    getActive() {
        const result = [];
        for (const entry of this._states.values()) {
            if (entry.state !== STATES.IDLE) result.push(entry);
        }
        return result;
    }

    // Snapshot for dashboard API
    snapshot() {
        const all = [];
        for (const entry of this._states.values()) {
            all.push({
                key:          `${entry.clientSlug}:${entry.workerName}`,
                workerName:   entry.workerName,
                clientSlug:   entry.clientSlug,
                state:        entry.state,
                sinceMs:      Date.now() - entry.since,
                lastCustomer: entry.lastCustomer,
                retryCount:   entry.retryCount,
                totalRuns:    entry.totalRuns,
                totalFailures:entry.totalFailures,
                provider:     entry.provider,
            });
        }
        return all;
    }
}

// ─── Singleton — shared across all workers in the process ────────────────────
const stateMachine = new WorkerStateMachine();

module.exports = { stateMachine, STATES };
