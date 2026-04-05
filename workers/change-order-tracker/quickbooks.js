/**
 * GRIDHAND Change Order Tracker — QuickBooks API Integration
 *
 * Creates QB invoices for approved change orders.
 */

'use strict';

const axios = require('axios');
const db    = require('./db');

const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function getBaseUrl() {
    return process.env.QB_SANDBOX === 'true'
        ? 'https://sandbox-quickbooks.api.intuit.com'
        : 'https://quickbooks.api.intuit.com';
}

async function refreshQBToken(clientSlug) {
    const conn = await db.getConnection(clientSlug);
    const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');

    const resp = await axios.post(QB_TOKEN_URL,
        `grant_type=refresh_token&refresh_token=${encodeURIComponent(conn.qb_refresh_token)}`,
        { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = resp.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
    await db.updateQBTokens(clientSlug, { accessToken: access_token, refreshToken: refresh_token, expiresAt });
    return access_token;
}

async function getValidQBToken(clientSlug) {
    const conn = await db.getConnection(clientSlug);
    if (!conn?.qb_access_token) throw new Error(`No QB connection for ${clientSlug}`);
    if (Date.now() < new Date(conn.qb_expires_at).getTime() - 60000) return conn.qb_access_token;
    return refreshQBToken(clientSlug);
}

async function qbPost(clientSlug, realmId, path, body) {
    const token = await getValidQBToken(clientSlug);
    const resp = await axios.post(
        `${getBaseUrl()}/v3/company/${realmId}${path}`,
        body,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' } }
    );
    return resp.data;
}

/**
 * Create a QuickBooks invoice for an approved change order.
 */
async function createInvoiceForCO(clientSlug, realmId, { coNumber, title, amount, customerName, projectName }) {
    const lineItem = {
        Amount:          amount,
        DetailType:      'SalesItemLineDetail',
        Description:     `Change Order #${coNumber}: ${title} — Project: ${projectName}`,
        SalesItemLineDetail: {
            Qty:        1,
            UnitPrice:  amount,
        },
    };

    const invoice = {
        Line:           [lineItem],
        CustomerRef:    { name: customerName },
        DocNumber:      `CO-${coNumber}`,
        PrivateNote:    `Auto-created by GRIDHAND Change Order Tracker for project: ${projectName}`,
    };

    try {
        const result = await qbPost(clientSlug, realmId, '/invoice', invoice);
        return result?.Invoice?.Id ? String(result.Invoice.Id) : null;
    } catch (err) {
        console.error(`[QB] Invoice creation failed for CO #${coNumber}: ${err.message}`);
        return null;
    }
}

module.exports = {
    createInvoiceForCO,
};
