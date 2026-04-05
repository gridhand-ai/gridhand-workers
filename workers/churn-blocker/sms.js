/**
 * GRIDHAND Churn Blocker — SMS Sender
 *
 * Twilio wrapper for re-engagement messages.
 * Per-client credentials take priority over env-level defaults.
 * Logs every sent message to cb_churn_alerts via db.logAlert.
 */

'use strict';

const twilio = require('twilio');
const db     = require('./db');

// ─── Twilio Client Factory ─────────────────────────────────────────────────────

/**
 * Build a Twilio client from the client config row.
 * Falls back to global env vars if per-client creds are not set.
 * @param {object} conn - cb_clients row
 */
function getClient(conn) {
    const sid   = conn?.twilio_sid   || process.env.TWILIO_ACCOUNT_SID;
    const token = conn?.twilio_token || process.env.TWILIO_AUTH_TOKEN;

    if (!sid || !token) {
        throw new Error(
            `Twilio credentials missing for client ${conn?.client_slug || '(unknown)'}. ` +
            'Set twilio_sid/twilio_token on the client row or TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN env vars.'
        );
    }

    return twilio(sid, token);
}

/**
 * Resolve the "from" number for a client.
 */
function getFromNumber(conn) {
    const from = conn?.twilio_number || process.env.TWILIO_FROM_NUMBER;
    if (!from) throw new Error('No Twilio from-number configured');
    return from;
}

// ─── Message Composer ─────────────────────────────────────────────────────────

/**
 * Build a personalized re-engagement message based on inactivity tier.
 *
 * Tiers:
 *   7–14 days  → warm/friendly
 *   15–21 days → more concerned / motivational
 *   22+ days   → special offer mention + urgency
 */
function composeMessage(conn, member, daysSinceVisit) {
    const firstName    = member.first_name || member.firstName || 'there';
    const businessName = conn.business_name;

    if (daysSinceVisit <= 14) {
        return (
            `Hey ${firstName}! We miss you at ${businessName}. ` +
            `It's been ${daysSinceVisit} days since your last visit — life gets busy, we get it. ` +
            `Come back this week and get back on track. We're here for you! ` +
            `Reply STOP to opt out.`
        );
    }

    if (daysSinceVisit <= 21) {
        return (
            `${firstName}, your goals are still waiting for you! 💪 ` +
            `It's been ${daysSinceVisit} days since we've seen you at ${businessName}. ` +
            `Don't let momentum slip away — your body will thank you for coming back. ` +
            `See you soon! Reply STOP to opt out.`
        );
    }

    // 22+ days — special offer hook
    return (
        `${firstName}, we haven't seen you at ${businessName} in ${daysSinceVisit} days. ` +
        `We'd love to welcome you back! Reply COMEBACK and we'll set you up with a special returning-member offer. ` +
        `Your fitness journey isn't over — it's just on pause. ` +
        `Reply STOP to opt out.`
    );
}

// ─── Send Functions ───────────────────────────────────────────────────────────

/**
 * Send a single re-engagement SMS to a member.
 * Logs the alert to cb_churn_alerts.
 *
 * @param {object} conn          - cb_clients row
 * @param {object} member        - cb_members row (must have .id, .phone, .first_name, etc.)
 * @param {number} daysSinceVisit
 * @returns {{ ok: boolean, twilioSid?: string, error?: string }}
 */
async function sendReengagement(conn, member, daysSinceVisit) {
    const phone = member.phone;
    if (!phone) {
        console.warn(`[SMS] No phone for member ${member.id} — skipping`);
        return { ok: false, error: 'no_phone' };
    }

    const messageBody = composeMessage(conn, member, daysSinceVisit);
    const from        = getFromNumber(conn);

    console.log(
        `[SMS] → ${phone} (${member.first_name} ${member.last_name}) ` +
        `[${daysSinceVisit}d inactive]: ${messageBody.slice(0, 60)}...`
    );

    let twilioSid = null;

    try {
        const msg = await getClient(conn).messages.create({
            from,
            to:   phone,
            body: messageBody,
        });
        twilioSid = msg.sid;
    } catch (err) {
        console.error(`[SMS] Twilio error for ${phone}: ${err.message}`);
        return { ok: false, error: err.message };
    }

    // Log to db
    try {
        await db.logAlert(conn.id, member.id, {
            daysSinceVisit,
            messageBody,
            twilioSid,
            status: 'sent',
        });
    } catch (dbErr) {
        // Non-fatal — message was sent, just log the db error
        console.error(`[SMS] Failed to log alert to db: ${dbErr.message}`);
    }

    return { ok: true, twilioSid, messageBody };
}

/**
 * Send re-engagement SMS to a batch of inactive members.
 * Filters out members who have been alerted recently (spam protection is done
 * upstream in jobs.js, but this layer also guards against empty phone numbers).
 *
 * @param {object} conn            - cb_clients row
 * @param {Array}  inactiveMembers - array of cb_members rows with daysSinceVisit attached
 * @returns {{ sent: number, failed: number, total: number }}
 */
async function sendBulkReengagement(conn, inactiveMembers) {
    let sent   = 0;
    let failed = 0;

    for (const member of inactiveMembers) {
        const result = await sendReengagement(conn, member, member.days_since_visit || member.daysSinceVisit);

        if (result.ok) {
            sent++;
        } else {
            failed++;
        }

        // Small throttle to respect Twilio rate limits (1 msg/sec per number by default)
        await new Promise(r => setTimeout(r, 150));
    }

    console.log(`[SMS] Bulk reengagement done for ${conn.client_slug}: sent=${sent} failed=${failed} total=${inactiveMembers.length}`);
    return { sent, failed, total: inactiveMembers.length };
}

module.exports = {
    getClient,
    composeMessage,
    sendReengagement,
    sendBulkReengagement,
};
