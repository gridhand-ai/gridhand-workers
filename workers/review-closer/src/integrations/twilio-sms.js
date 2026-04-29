'use strict';

const { sendSMS } = require('../../../../lib/twilio-client');
const { config } = require('../config');

/**
 * Send an SMS message via lib/twilio-client.js (TCPA + opt-out compliant).
 *
 * @param {object} params
 * @param {string} params.to   Recipient phone in E.164 format (+1XXXXXXXXXX)
 * @param {string} params.body SMS message body
 * @param {string} [params.from]  Override sender number (defaults to TWILIO_PHONE_NUMBER)
 * @param {string} [params.clientSlug]  Client slug for opt-out lookup
 * @param {string} [params.clientTimezone]  Client timezone for TCPA quiet-hours check
 * @returns {Promise<object>}  { sid, status }
 */
async function sendSms({ to, body, from, clientSlug, clientTimezone }) {
  const fromNumber = from || config.twilio.fromNumber;

  if (!to || !body) {
    throw new Error('sendSms: "to" and "body" are required');
  }

  const clientApiKeys = (config.twilio?.accountSid && config.twilio?.authToken)
    ? { twilio: { accountSid: config.twilio.accountSid, authToken: config.twilio.authToken } }
    : undefined;

  try {
    const { sid } = await sendSMS({
      from:           fromNumber,
      to,
      body,
      clientApiKeys,
      clientSlug,
      clientTimezone,
    });

    console.log(`[Twilio] SMS sent to ${to} — SID: ${sid}`);
    return { sid, status: 'queued' };
  } catch (err) {
    // Twilio error codes worth logging specifically
    if (err.code === 21610) {
      console.warn(`[Twilio] ${to} is unsubscribed (21610) — skipping`);
      throw Object.assign(err, { unsubscribed: true });
    }
    if (err.code === 21614) {
      console.warn(`[Twilio] ${to} is not a valid mobile number (21614)`);
      throw Object.assign(err, { invalidNumber: true });
    }
    console.error(`[Twilio] Failed to send to ${to}: ${err.message}`);
    throw err;
  }
}

module.exports = { sendSms };
