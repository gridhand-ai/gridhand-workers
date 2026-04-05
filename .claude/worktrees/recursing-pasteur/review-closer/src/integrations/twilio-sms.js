'use strict';

const twilio = require('twilio');
const { config } = require('../config');

let _client = null;

function getClient() {
  if (!_client) {
    _client = twilio(config.twilio.accountSid, config.twilio.authToken);
  }
  return _client;
}

/**
 * Send an SMS message.
 *
 * @param {object} params
 * @param {string} params.to   Recipient phone in E.164 format (+1XXXXXXXXXX)
 * @param {string} params.body SMS message body
 * @param {string} [params.from]  Override sender number (defaults to TWILIO_FROM_NUMBER)
 * @returns {Promise<object>}  Twilio message object
 */
async function sendSms({ to, body, from }) {
  const fromNumber = from || config.twilio.fromNumber;

  if (!to || !body) {
    throw new Error('sendSms: "to" and "body" are required');
  }

  try {
    const message = await getClient().messages.create({
      to,
      from: fromNumber,
      body,
    });

    console.log(`[Twilio] SMS sent to ${to} — SID: ${message.sid}`);
    return { sid: message.sid, status: message.status };
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
