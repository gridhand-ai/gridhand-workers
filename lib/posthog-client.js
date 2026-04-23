'use strict'
// PostHog — event tracking for agent actions and client engagement signals

let PostHog
try {
  PostHog = require('posthog-node').PostHog
} catch (e) {
  PostHog = null
}

let _client = null

function getClient() {
  if (!PostHog) { console.warn('[posthog] posthog-node not installed'); return null }
  if (!_client) {
    const key = process.env.POSTHOG_API_KEY
    if (!key) { console.warn('[posthog] POSTHOG_API_KEY not set'); return null }
    _client = new PostHog(key, { host: 'https://app.posthog.com' })
  }
  return _client
}

// Track an agent action against a client
function track(clientId, event, properties = {}) {
  const ph = getClient()
  if (!ph) return
  ph.capture({
    distinctId: clientId,
    event,
    properties: { source: 'gridhand-workers', ...properties },
  })
}

// Identify a client with traits
function identify(clientId, traits = {}) {
  const ph = getClient()
  if (!ph) return
  ph.identify({ distinctId: clientId, properties: traits })
}

async function shutdown() {
  if (_client) await _client.shutdown()
}

module.exports = { track, identify, shutdown }
