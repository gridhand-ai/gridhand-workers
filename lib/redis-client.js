'use strict';

// ─── Upstash Redis Client (persistent SMS dedup + future rate limiting) ────────
//
// Falls back gracefully when UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
// are not set — in-memory Map dedup in server.js takes over automatically.
//
// Usage:
//   const { getRedis } = require('./redis-client');
//   const redis = getRedis();          // null when not configured
//   if (redis) {
//     const set = await redis.set(key, '1', { ex: 30, nx: true });
//     // set === null  → key already existed (duplicate)
//     // set === 'OK'  → key was new (proceed)
//   }

const { Redis } = require('@upstash/redis');

let _redis = null;
let _initialized = false;

function getRedis() {
    if (_initialized) return _redis;
    _initialized = true;

    const url   = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
        console.log('[Redis] UPSTASH_REDIS_REST_URL/TOKEN not set — falling back to in-memory dedup');
        return null;
    }

    try {
        _redis = new Redis({ url, token });
        console.log('[Redis] Upstash Redis client initialized — persistent dedup active');
    } catch (e) {
        console.error('[Redis] Failed to initialize Upstash Redis client:', e.message);
        _redis = null;
    }

    return _redis;
}

module.exports = { getRedis };
