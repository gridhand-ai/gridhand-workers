/**
 * GRIDHAND Reconciliation Bot — Xero API Integration
 *
 * Handles:
 *  - OAuth 2.0 authorization + token management (stored in rb_clients)
 *  - Auto token refresh (Xero access tokens expire in 30 minutes)
 *  - Bank transactions, accounts, bank statements
 *  - Normalizes Xero data to match rb_transactions schema
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');
const db    = require('./db');

// ─── Constants ────────────────────────────────────────────────────────────────

const XERO_BASE_URL    = 'https://api.xero.com/api.xro/2.0';
const XERO_AUTH_URL    = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL   = 'https://identity.xero.com/connect/token';
const XERO_TENANTS_URL = 'https://api.xero.com/connections';
const SCOPES           = 'openid profile email accounting.transactions accounting.reports.read offline_access';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getClientCredentials() {
    const clientId     = process.env.XERO_CLIENT_ID;
    const clientSecret = process.env.XERO_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('XERO_CLIENT_ID and XERO_CLIENT_SECRET must be set');
    }
    return { clientId, clientSecret };
}

function basicAuthHeader() {
    const { clientId, clientSecret } = getClientCredentials();
    return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

/**
 * Build Xero OAuth2 authorization URL for a client.
 */
function initiateOAuth(clientSlug) {
    const { clientId } = getClientCredentials();
    const redirectUri  = process.env.XERO_REDIRECT_URI;
    const state        = Buffer.from(JSON.stringify({ clientSlug, ts: Date.now() })).toString('base64');

    const params = new URLSearchParams({
        response_type: 'code',
        client_id:     clientId,
        redirect_uri:  redirectUri,
        scope:         SCOPES,
        state,
    });

    return `${XERO_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens. Called in /auth/xero/callback.
 * Also fetches the tenant list to get the xero_tenant_id.
 */
async function handleCallback(code, state) {
    let clientSlug;
    try {
        clientSlug = JSON.parse(Buffer.from(state, 'base64').toString('utf8')).clientSlug;
    } catch {
        throw new Error('Invalid OAuth state parameter');
    }

    const redirectUri = process.env.XERO_REDIRECT_URI;

    const tokenResponse = await axios.post(
        XERO_TOKEN_URL,
        new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
        {
            headers: {
                'Authorization': basicAuthHeader(),
                'Content-Type':  'application/x-www-form-urlencoded',
            },
        }
    );

    const tokens    = tokenResponse.data;
    const expiresAt = dayjs().add(tokens.expires_in, 'second').toISOString();

    // Fetch connected tenants (organizations)
    const tenantsResponse = await axios.get(XERO_TENANTS_URL, {
        headers: { 'Authorization': `Bearer ${tokens.access_token}` },
    });

    const tenants    = tenantsResponse.data || [];
    const tenantId   = tenants[0]?.tenantId || null;

    await db.updateXeroTokens(clientSlug, {
        accessToken:  tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
        tenantId,
    });

    console.log(`[Xero] Connected for ${clientSlug}, tenant: ${tenantId}`);
    return { clientSlug, tenantId, tokens };
}

/**
 * Refresh Xero access token using the stored refresh token.
 */
async function refreshXeroToken(clientSlug) {
    const client = await db.getClient(clientSlug);
    if (!client?.xero_refresh_token) throw new Error(`No Xero refresh token for ${clientSlug}`);

    const response = await axios.post(
        XERO_TOKEN_URL,
        new URLSearchParams({ grant_type: 'refresh_token', refresh_token: client.xero_refresh_token }).toString(),
        {
            headers: {
                'Authorization': basicAuthHeader(),
                'Content-Type':  'application/x-www-form-urlencoded',
            },
        }
    );

    const tokens    = response.data;
    const expiresAt = dayjs().add(tokens.expires_in, 'second').toISOString();

    await db.updateXeroTokens(clientSlug, {
        accessToken:  tokens.access_token,
        refreshToken: tokens.refresh_token || client.xero_refresh_token,
        expiresAt,
        tenantId:     client.xero_tenant_id,
    });

    console.log(`[Xero] Tokens refreshed for ${clientSlug}`);
    return tokens.access_token;
}

/**
 * Get a valid Xero access token, refreshing if within 5 minutes of expiry.
 */
async function getValidXeroToken(clientSlug) {
    const client = await db.getClient(clientSlug);
    if (!client?.xero_access_token) throw new Error(`No Xero connection for ${clientSlug}`);

    const expiresAt = dayjs(client.xero_expires_at);
    if (expiresAt.isBefore(dayjs().add(5, 'minute'))) {
        return refreshXeroToken(clientSlug);
    }

    return client.xero_access_token;
}

// ─── API Request Helper ───────────────────────────────────────────────────────

async function xeroGet(clientSlug, tenantId, path, params = {}) {
    const token = await getValidXeroToken(clientSlug);
    const url   = `${XERO_BASE_URL}/${path}`;

    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization':  `Bearer ${token}`,
                'Xero-tenant-id': tenantId,
                'Accept':         'application/json',
            },
            params,
        });
        return { ok: true, data: response.data };
    } catch (err) {
        const msg = err.response?.data?.Detail || err.response?.data?.Message || err.message;
        return { ok: false, error: msg, status: err.response?.status || 500 };
    }
}

// ─── Data Fetchers ────────────────────────────────────────────────────────────

/**
 * Fetch bank transactions from Xero within date range.
 * Normalizes to match rb_transactions schema (same shape as quickbooks.js output).
 */
async function getTransactions(clientSlug, tenantId, startDate, endDate) {
    const result = await xeroGet(clientSlug, tenantId, 'BankTransactions', {
        where:          `Date >= DateTime(${startDate.replace(/-/g, ',')}) AND Date <= DateTime(${endDate.replace(/-/g, ',')})`,
        order:          'Date DESC',
        page:           1,
        pageSize:       1000,
        unitdp:         4,
    });

    if (!result.ok) {
        console.error(`[Xero] getTransactions failed for ${clientSlug}: ${result.error}`);
        return [];
    }

    const transactions = result.data.BankTransactions || [];
    const normalized   = [];

    for (const txn of transactions) {
        // Xero SPEND = expense (negative), RECEIVE = income (positive)
        const isSpend   = txn.Type === 'SPEND' || txn.Type === 'SPEND-OVERPAYMENT';
        const rawAmount = parseFloat(txn.Total || txn.SubTotal || 0);
        const amount    = isSpend ? -rawAmount : rawAmount;

        const description = txn.Reference ||
            txn.LineItems?.[0]?.Description ||
            txn.Contact?.Name ||
            (isSpend ? 'Expense' : 'Income');

        const { category, confidence } = require('./quickbooks').categorizeTransaction(description, amount);

        normalized.push({
            source:               'xero',
            source_transaction_id: txn.BankTransactionID,
            date:                 dayjs(txn.DateString || txn.Date).format('YYYY-MM-DD'),
            amount,
            description,
            merchant_name:        txn.Contact?.Name || null,
            category,
            category_confidence:  confidence,
            account_id:           txn.BankAccount?.AccountID || null,
            account_name:         txn.BankAccount?.Name || null,
            currency:             txn.CurrencyCode || 'USD',
        });
    }

    return normalized;
}

/**
 * Fetch chart of accounts from Xero.
 */
async function getAccounts(clientSlug, tenantId) {
    const result = await xeroGet(clientSlug, tenantId, 'Accounts', {
        where: 'Status == "ACTIVE"',
    });

    if (!result.ok) return result;

    const accounts = (result.data.Accounts || []).map(a => ({
        id:      a.AccountID,
        code:    a.Code,
        name:    a.Name,
        type:    a.Type,
        status:  a.Status,
    }));

    return { ok: true, data: accounts };
}

/**
 * Fetch bank statement lines for a specific bank account in Xero.
 * Uses GET /BankTransactions filtered by bank account.
 */
async function getBankStatements(clientSlug, tenantId, accountId, startDate, endDate) {
    const result = await xeroGet(clientSlug, tenantId, 'BankTransactions', {
        where:    `BankAccount.AccountID=Guid("${accountId}") AND Date >= DateTime(${startDate.replace(/-/g, ',')}) AND Date <= DateTime(${endDate.replace(/-/g, ',')})`,
        order:    'Date DESC',
        pageSize: 1000,
        unitdp:   4,
    });

    if (!result.ok) return result;

    const statements = (result.data.BankTransactions || []).map(txn => ({
        id:     txn.BankTransactionID,
        date:   dayjs(txn.DateString || txn.Date).format('YYYY-MM-DD'),
        amount: txn.Type?.startsWith('SPEND') ? -parseFloat(txn.Total || 0) : parseFloat(txn.Total || 0),
        ref:    txn.Reference || null,
        status: txn.Status,
    }));

    return { ok: true, data: statements };
}

module.exports = {
    initiateOAuth,
    handleCallback,
    refreshXeroToken,
    getValidXeroToken,
    xeroGet,
    getTransactions,
    getAccounts,
    getBankStatements,
};
