// Payment Link Generator — generates secure payment links on demand
// Supports: Stripe, Square, PayPal (invoices)
// Config: client.settings.integrations.payments.provider + credentials

async function generateLink(clientSlug, clientSettings, { amount, description, customerEmail = null, customerName = null, invoiceNumber = null, dueDate = null }) {
    const integration = clientSettings?.integrations?.payments;
    if (!integration?.provider) {
        return { error: 'No payment provider configured. Add provider to client settings.' };
    }

    try {
        let result;
        switch (integration.provider) {
            case 'stripe':  result = await generateStripeLink(integration.credentials, { amount, description, customerEmail, customerName }); break;
            case 'square':  result = await generateSquareLink(integration.credentials, { amount, description, customerEmail, invoiceNumber }); break;
            case 'paypal':  result = await generatePayPalLink(integration.credentials, { amount, description, customerEmail, invoiceNumber }); break;
            default: return { error: `Unsupported payment provider: ${integration.provider}` };
        }
        console.log(`[PaymentLinkGenerator] Generated ${integration.provider} link for $${amount} (${clientSlug})`);
        return result;
    } catch (e) {
        console.log(`[PaymentLinkGenerator] Error: ${e.message}`);
        return { error: e.message };
    }
}

async function generateStripeLink(credentials, { amount, description, customerEmail, customerName }) {
    const { secretKey } = credentials;
    // Create a Stripe Payment Link via API
    const body = new URLSearchParams({
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': Math.round(amount * 100),
        'line_items[0][price_data][product_data][name]': description,
        'line_items[0][quantity]': '1',
        ...(customerEmail ? { 'customer_email': customerEmail } : {}),
    });

    const res = await fetch('https://api.stripe.com/v1/payment_links', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
    });

    if (!res.ok) throw new Error(`Stripe API: ${res.status}`);
    const data = await res.json();
    return { url: data.url, provider: 'stripe', amount, description };
}

async function generateSquareLink(credentials, { amount, description, customerEmail, invoiceNumber }) {
    const { accessToken, locationId } = credentials;
    const res = await fetch('https://connect.squareup.com/v2/invoices', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Square-Version': '2024-01-18',
        },
        body: JSON.stringify({
            invoice: {
                location_id: locationId,
                order_id: invoiceNumber,
                payment_requests: [{
                    request_type: 'BALANCE',
                    due_date: new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
                    tipping_enabled: false,
                }],
                title: description,
                primary_recipient: customerEmail ? { email_address: customerEmail } : undefined,
            },
            idempotency_key: `inv_${Date.now()}`,
        }),
    });

    if (!res.ok) throw new Error(`Square API: ${res.status}`);
    const data = await res.json();
    return { url: data.invoice?.public_url, provider: 'square', amount, description };
}

async function generatePayPalLink(credentials, { amount, description, customerEmail, invoiceNumber }) {
    const { clientId, clientSecret } = credentials;

    // Get access token
    const tokenRes = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
        method: 'POST',
        headers: {
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
    });

    if (!tokenRes.ok) throw new Error('PayPal auth failed');
    const { access_token } = await tokenRes.json();

    // Create invoice
    const invoiceRes = await fetch('https://api-m.paypal.com/v2/invoicing/invoices', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${access_token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            detail: { currency_code: 'USD', note: description, invoice_number: invoiceNumber },
            items: [{ name: description, quantity: '1', unit_amount: { currency_code: 'USD', value: amount.toFixed(2) } }],
            primary_recipients: customerEmail ? [{ billing_info: { email_address: customerEmail } }] : [],
        }),
    });

    if (!invoiceRes.ok) throw new Error(`PayPal API: ${invoiceRes.status}`);
    const invoiceData = await invoiceRes.json();
    return { url: invoiceData.href, provider: 'paypal', amount, description };
}

module.exports = { generateLink };
