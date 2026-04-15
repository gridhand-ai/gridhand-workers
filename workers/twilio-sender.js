// Thin wrapper — delegates to lib/twilio-client which handles per-client credentials
const twilioClient = require('../lib/twilio-client');

async function sendSMS({ from, to, body, clientSlug, clientApiKeys, clientTimezone }) {
    return twilioClient.sendSMS({ from, to, body, clientSlug, clientApiKeys, clientTimezone });
}

module.exports = { sendSMS };
