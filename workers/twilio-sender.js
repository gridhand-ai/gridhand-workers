const twilio = require('twilio');
const memoryModule = require('./memory');

function getClient() {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN required');
    return twilio(sid, token);
}

async function sendSMS({ from, to, body, clientSlug }) {
    const client = getClient();
    const msg = await client.messages.create({ from, to, body });
    if (clientSlug) {
        memoryModule.saveMessage(clientSlug, to, 'assistant', body);
    }
    console.log(`[TwilioSender] Sent to ${to}: "${body}" (SID: ${msg.sid})`);
    return msg;
}

module.exports = { sendSMS };
