const base = require('./base');
const sender = require('./twilio-sender');

// Outbound: send invoice reminder
async function send({ client, customerNumber, customerName, invoiceNumber, amount, dueDate, paymentLink, chaseNumber = 1 }) {
    const biz = client.business;
    const nameGreet = customerName ? `Hi ${customerName}` : 'Hi there';
    const invoiceRef = invoiceNumber ? ` #${invoiceNumber}` : '';
    const amountRef = amount ? ` for $${amount}` : '';
    const dueDateRef = dueDate ? ` due ${dueDate}` : '';
    const payLink = paymentLink ? ` Pay securely here: ${paymentLink}` : ` Please call us at ${biz.phone} to arrange payment.`;

    let body;
    if (chaseNumber === 1) {
        body = `${nameGreet}, friendly reminder from ${biz.name} — invoice${invoiceRef}${amountRef} is${dueDateRef}.${payLink} Questions? Just reply. — ${biz.name}`;
    } else if (chaseNumber === 2) {
        body = `${nameGreet}, following up from ${biz.name} about invoice${invoiceRef}${amountRef}. This is still outstanding — please take a moment to settle it.${payLink} — ${biz.name}`;
    } else {
        body = `${nameGreet}, this is a final notice from ${biz.name} regarding invoice${invoiceRef}${amountRef}. Please contact us at ${biz.phone} immediately to resolve this. — ${biz.name}`;
    }

    await sender.sendSMS({
        from: client.twilioNumber,
        to: customerNumber,
        body,
        clientSlug: client.slug
    });
}

// Inbound: handle replies to invoice messages
async function run({ client, message, customerNumber }) {
    const biz = client.business;
    const tone = base.getTone(client);

    const systemPrompt = `You are a billing assistant for ${biz.name}, a ${biz.industry} business.
You sent this customer an invoice reminder and they're replying.
${tone}
- Keep replies SHORT — 1-2 sentences max.
- If they say they've paid: thank them and say you'll update their account.
- If they need an extension or payment plan: be understanding, direct them to call ${biz.phone}.
- If they dispute the invoice: do NOT argue — say "I'd like to make sure this is resolved, please call us at ${biz.phone}."
- If they have questions about the invoice: answer what you can, otherwise direct to ${biz.phone}.
- Never threaten or use aggressive language.
- Sign off as ${biz.name}.`;

    return base.run({ client, message, customerNumber, workerName: 'InvoiceChaser', systemPrompt });
}

module.exports = { send, run };
