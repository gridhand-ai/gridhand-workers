'use strict'
/**
 * notify-owner.js
 *
 * Sends a proactive owner notification to the portal's /api/notify/owner endpoint.
 * The portal handles routing to SMS or voice call based on each client's
 * contact_preference. This is fired by directors when a critical event escalates
 * (hot lead, urgent customer issue, revenue at risk, etc.).
 *
 * Fire-and-forget — never throws. Failures are logged but never bubble up
 * into the director's run() return path.
 */

const PORTAL_URL  = process.env.PORTAL_URL || 'https://gridhand.ai'
const CRON_SECRET = process.env.CRON_SECRET

/**
 * @param {object} opts
 * @param {string} opts.businessId  — Supabase clients.id (UUID)
 * @param {string} opts.eventType   — short slug: 'hot_lead' | 'booking_cancelled' | 'urgent_escalation' | 'revenue_at_risk' | etc.
 * @param {string} opts.message     — human-readable message ("New hot lead: Jane from Google — wants HVAC quote")
 * @returns {Promise<void>}
 */
async function notifyOwner({ businessId, eventType, message } = {}) {
  if (!businessId || !eventType || !message) {
    console.warn('[notify-owner] Missing required field — skipping notification')
    return
  }
  if (!CRON_SECRET) {
    console.warn('[notify-owner] CRON_SECRET not set — skipping owner notification')
    return
  }
  if (!PORTAL_URL) {
    console.warn('[notify-owner] PORTAL_URL not set — skipping owner notification')
    return
  }

  try {
    const res = await fetch(`${PORTAL_URL}/api/notify/owner`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${CRON_SECRET}`,
      },
      body: JSON.stringify({
        business_id: businessId,
        event_type:  eventType,
        message,
      }),
    })

    if (!res.ok) {
      console.error(`[notify-owner] Portal returned ${res.status} for businessId=${businessId} event=${eventType}`)
      return
    }
    console.log(`[notify-owner] Sent ${eventType} for businessId=${businessId}`)
  } catch (err) {
    console.error('[notify-owner] Failed:', err.message)
    // Fire-and-forget — never throw
  }
}

module.exports = { notifyOwner }
