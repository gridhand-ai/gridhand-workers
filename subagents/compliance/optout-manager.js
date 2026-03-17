// Opt-Out Manager — CRITICAL: handles STOP/UNSUBSCRIBE and blocks future messages
// This runs on EVERY inbound and outbound message — no exceptions
const store = require('../store');
const customerProfiler = require('../customer/customer-profiler');

const OPT_OUT_KEYWORDS = /^(stop|stopall|unsubscribe|cancel|quit|end|optout|opt out|remove me|take me off|no more texts|no more messages)$/i;
const OPT_IN_KEYWORDS  = /^(start|yes|unstop|subscribe|optin|opt in|re-subscribe)$/i;

function getListKey(clientSlug) { return clientSlug; }

function getOptOutList(clientSlug) {
    return store.readJson('opt-outs', getListKey(clientSlug)) || {};
}

function saveOptOutList(clientSlug, list) {
    store.writeJson('opt-outs', getListKey(clientSlug), list);
}

function isOptedOut(clientSlug, customerNumber) {
    const list = getOptOutList(clientSlug);
    return !!list[customerNumber];
}

function optOut(clientSlug, customerNumber, reason = 'STOP') {
    const list = getOptOutList(clientSlug);
    list[customerNumber] = {
        optedOutAt: new Date().toISOString(),
        reason,
    };
    saveOptOutList(clientSlug, list);
    customerProfiler.markOptedOut(clientSlug, customerNumber);
    console.log(`[OptOutManager] ${customerNumber} opted out of ${clientSlug} (reason: ${reason})`);
    return true;
}

function optIn(clientSlug, customerNumber) {
    const list = getOptOutList(clientSlug);
    if (list[customerNumber]) {
        delete list[customerNumber];
        saveOptOutList(clientSlug, list);
        customerProfiler.updateProfile(clientSlug, customerNumber, { optedOut: false, optedOutAt: null });
        console.log(`[OptOutManager] ${customerNumber} re-opted-in to ${clientSlug}`);
        return true;
    }
    return false;
}

// Check if a message is an opt-out request. Returns action needed.
function checkMessage(message) {
    const trimmed = message.trim();
    if (OPT_OUT_KEYWORDS.test(trimmed)) return { action: 'opt-out', confirmed: true };
    if (OPT_IN_KEYWORDS.test(trimmed)) return { action: 'opt-in', confirmed: true };
    return { action: null, confirmed: false };
}

// Process inbound message — call this BEFORE routing to workers
// Returns: { blocked, action, reply }
function process(clientSlug, customerNumber, message) {
    // Check if already opted out
    if (isOptedOut(clientSlug, customerNumber)) {
        const check = checkMessage(message);
        if (check.action === 'opt-in') {
            optIn(clientSlug, customerNumber);
            return {
                blocked: false,
                action: 'opted-in',
                reply: 'You have been re-subscribed. Reply STOP at any time to unsubscribe.'
            };
        }
        // They're opted out, block the message
        return { blocked: true, action: 'already-opted-out', reply: null };
    }

    // Check if this message is an opt-out request
    const check = checkMessage(message);
    if (check.action === 'opt-out') {
        optOut(clientSlug, customerNumber, message.toUpperCase());
        return {
            blocked: true,
            action: 'opted-out',
            reply: 'You have been unsubscribed and will receive no further messages. Reply START to re-subscribe.'
        };
    }

    return { blocked: false, action: null, reply: null };
}

// Guard for outbound sends — throw if customer is opted out
function guardOutbound(clientSlug, customerNumber) {
    if (isOptedOut(clientSlug, customerNumber)) {
        throw new Error(`BLOCKED: ${customerNumber} has opted out of ${clientSlug}`);
    }
}

module.exports = { process, guardOutbound, isOptedOut, optOut, optIn, getOptOutList };
