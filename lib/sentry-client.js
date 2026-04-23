'use strict'
// Sentry — production error capture for all workers

let Sentry
try {
  Sentry = require('@sentry/node')
} catch (e) {
  Sentry = null
}

let _initialized = false

function init() {
  if (_initialized) return
  if (!Sentry) { console.warn('[sentry] @sentry/node not installed — errors will not be captured'); return }
  const dsn = process.env.SENTRY_DSN
  if (!dsn) { console.warn('[sentry] SENTRY_DSN not set — errors will not be captured'); return }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.1,
  })
  _initialized = true
}

// Capture an error with optional context tags
function captureError(err, context = {}) {
  if (!Sentry || !_initialized) return
  Sentry.withScope(scope => {
    Object.entries(context).forEach(([k, v]) => scope.setTag(k, v))
    Sentry.captureException(err)
  })
}

// Capture a message (non-error event)
function captureMessage(msg, level = 'info', context = {}) {
  if (!Sentry || !_initialized) return
  Sentry.withScope(scope => {
    Object.entries(context).forEach(([k, v]) => scope.setTag(k, v))
    Sentry.captureMessage(msg, level)
  })
}

module.exports = { init, captureError, captureMessage }
