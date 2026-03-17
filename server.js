const express = require('express');
const { loadClient } = require('./clients/loader');
const faqWorker = require('./workers/faq');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'GRIDHAND Workers online', workers: ['faq'] });
});

// Twilio SMS webhook — routes to the right worker based on the client's number
app.post('/sms', async (req, res) => {
    const incomingNumber = req.body.To;   // The Twilio number the customer texted
    const customerNumber = req.body.From; // The customer's number
    const message = req.body.Body?.trim();

    console.log(`[SMS] ${customerNumber} → ${incomingNumber}: "${message}"`);

    // Load the client config for this Twilio number
    const client = loadClient(incomingNumber);
    if (!client) {
        console.log(`[SMS] No client found for number ${incomingNumber}`);
        return res.set('Content-Type', 'text/xml').send('<Response></Response>');
    }

    let reply = '';

    // Route to the right worker based on client config
    if (client.workers.includes('faq')) {
        reply = await faqWorker.run({ client, message, customerNumber });
    }

    // Send reply via Twilio TwiML
    const twiml = reply
        ? `<Response><Message>${reply}</Message></Response>`
        : `<Response></Response>`;

    res.set('Content-Type', 'text/xml').send(twiml);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`GRIDHAND Workers running on port ${PORT}`);
});
