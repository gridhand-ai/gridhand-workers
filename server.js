const express = require('express');
const { loadClient } = require('./clients/loader');
const afterHoursWorker = require('./workers/after-hours');

// Inbound workers (handle incoming SMS)
const faqWorker = require('./workers/faq');
const receptionistWorker = require('./workers/receptionist');
const bookingWorker = require('./workers/booking');
const intakeWorker = require('./workers/intake');
const waitlistWorker = require('./workers/waitlist');

// Workers that handle both inbound replies AND outbound sends
const reviewRequesterWorker = require('./workers/review-requester');
const reminderWorker = require('./workers/reminder');
const reactivationWorker = require('./workers/reactivation');
const leadFollowupWorker = require('./workers/lead-followup');
const invoiceChaserWorker = require('./workers/invoice-chaser');
const quoteWorker = require('./workers/quote');
const referralWorker = require('./workers/referral');
const upsellWorker = require('./workers/upsell');
const onboardingWorker = require('./workers/onboarding');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        status: 'GRIDHAND Workers online',
        workers: [
            'faq', 'receptionist', 'booking', 'intake', 'after-hours', 'waitlist',
            'review-requester', 'reminder', 'reactivation', 'lead-followup',
            'invoice-chaser', 'quote', 'referral', 'upsell', 'onboarding'
        ]
    });
});

// ─── Inbound SMS Webhook ───────────────────────────────────────────────────────
app.post('/sms', async (req, res) => {
    const incomingNumber = req.body.To;
    const customerNumber = req.body.From;
    const message = req.body.Body?.trim();

    console.log(`[SMS] ${customerNumber} → ${incomingNumber}: "${message}"`);

    const client = loadClient(incomingNumber);
    if (!client) {
        console.log(`[SMS] No client found for number ${incomingNumber}`);
        return res.set('Content-Type', 'text/xml').send('<Response></Response>');
    }

    const workers = client.workers || [];
    let reply = '';

    try {
        // After-hours check — overrides all other workers if business is closed
        if (workers.includes('after-hours') && !afterHoursWorker.isBusinessOpen(client.business.hours)) {
            reply = await afterHoursWorker.run({ client, message, customerNumber });
        }
        // Receptionist handles general routing
        else if (workers.includes('receptionist')) {
            reply = await receptionistWorker.run({ client, message, customerNumber });
        }
        // Intake collects new customer info
        else if (workers.includes('intake')) {
            reply = await intakeWorker.run({ client, message, customerNumber });
        }
        // Booking helps schedule appointments
        else if (workers.includes('booking')) {
            reply = await bookingWorker.run({ client, message, customerNumber });
        }
        // Waitlist handles spot management
        else if (workers.includes('waitlist')) {
            reply = await waitlistWorker.run({ client, message, customerNumber });
        }
        // FAQ fallback
        else if (workers.includes('faq')) {
            reply = await faqWorker.run({ client, message, customerNumber });
        }
    } catch (e) {
        console.log(`[SMS] Worker error: ${e.message}`);
        reply = `Thanks for reaching out to ${client.business.name}! We'll get back to you shortly.`;
    }

    const twiml = reply
        ? `<Response><Message>${reply}</Message></Response>`
        : `<Response></Response>`;

    res.set('Content-Type', 'text/xml').send(twiml);
});

// ─── Outbound Trigger Routes ───────────────────────────────────────────────────
// These are called by your CRM/portal to fire outbound messages

app.post('/trigger/review-requester', async (req, res) => {
    const { twilioNumber, customerNumber, customerName, serviceName } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        await reviewRequesterWorker.send({ client, customerNumber, customerName, serviceName });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/trigger/reminder', async (req, res) => {
    const { twilioNumber, customerNumber, customerName, appointmentTime, serviceName, reminderType } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        await reminderWorker.send({ client, customerNumber, customerName, appointmentTime, serviceName, reminderType });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/trigger/reactivation', async (req, res) => {
    const { twilioNumber, customerNumber, customerName, lastServiceName, lastServiceDate } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        await reactivationWorker.send({ client, customerNumber, customerName, lastServiceName, lastServiceDate });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/trigger/lead-followup', async (req, res) => {
    const { twilioNumber, customerNumber, customerName, inquiryAbout, followUpNumber } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        await leadFollowupWorker.send({ client, customerNumber, customerName, inquiryAbout, followUpNumber });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/trigger/invoice-chaser', async (req, res) => {
    const { twilioNumber, customerNumber, customerName, invoiceNumber, amount, dueDate, paymentLink, chaseNumber } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        await invoiceChaserWorker.send({ client, customerNumber, customerName, invoiceNumber, amount, dueDate, paymentLink, chaseNumber });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/trigger/quote', async (req, res) => {
    const { twilioNumber, customerNumber, customerName, serviceName, quoteAmount, validUntil, quoteDetails } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        await quoteWorker.send({ client, customerNumber, customerName, serviceName, quoteAmount, validUntil, quoteDetails });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/trigger/waitlist-notify', async (req, res) => {
    const { twilioNumber, customerNumber, customerName, serviceName, availableTime } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        await waitlistWorker.sendSpotAvailable({ client, customerNumber, customerName, serviceName, availableTime });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/trigger/referral', async (req, res) => {
    const { twilioNumber, customerNumber, customerName, lastServiceName } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        await referralWorker.send({ client, customerNumber, customerName, lastServiceName });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/trigger/upsell', async (req, res) => {
    const { twilioNumber, customerNumber, customerName, completedServiceName, upsellServiceName, upsellReason } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        await upsellWorker.send({ client, customerNumber, customerName, completedServiceName, upsellServiceName, upsellReason });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/trigger/onboarding', async (req, res) => {
    const { twilioNumber, customerNumber, customerName, serviceName } = req.body;
    const client = loadClient(twilioNumber);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    try {
        await onboardingWorker.send({ client, customerNumber, customerName, serviceName });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Start Server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`GRIDHAND Workers running on port ${PORT}`);
});
