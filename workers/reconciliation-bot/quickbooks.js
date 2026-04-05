/**
 * GRIDHAND Reconciliation Bot — QuickBooks Online API v3 Integration
 *
 * Handles:
 *  - OAuth 2.0 authorization + token management (stored in rb_clients)
 *  - Auto token refresh (access tokens expire in 1 hour)
 *  - Transaction sync: Purchase, JournalEntry, Transfer
 *  - Chart of accounts
 *  - Rule-based transaction categorization
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');
const db    = require('./db');

// ─── Constants ────────────────────────────────────────────────────────────────

const QB_BASE_URL    = 'https://quickbooks.api.intuit.com/v3/company';
const QB_SANDBOX_URL = 'https://sandbox-quickbooks.api.intuit.com/v3/company';
const QB_AUTH_URL    = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL   = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const SCOPES         = 'com.intuit.quickbooks.accounting';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getBaseUrl() {
    return process.env.QB_SANDBOX === 'true' ? QB_SANDBOX_URL : QB_BASE_URL;
}

function getClientCredentials() {
    const clientId     = process.env.QB_CLIENT_ID;
    const clientSecret = process.env.QB_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('QB_CLIENT_ID and QB_CLIENT_SECRET must be set');
    }
    return { clientId, clientSecret };
}

function basicAuthHeader() {
    const { clientId, clientSecret } = getClientCredentials();
    return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

/**
 * Build the QBO authorization URL for a client.
 * Index.js redirects user to this URL to start OAuth.
 */
function initiateOAuth(clientSlug) {
    const { clientId } = getClientCredentials();
    const redirectUri  = process.env.QB_REDIRECT_URI;
    const state        = Buffer.from(JSON.stringify({ clientSlug, ts: Date.now() })).toString('base64');

    const params = new URLSearchParams({
        client_id:     clientId,
        scope:         SCOPES,
        redirect_uri:  redirectUri,
        response_type: 'code',
        access_type:   'offline',
        state,
    });

    return `${QB_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens. Called in /auth/qbo/callback.
 */
async function handleCallback(code, state) {
    let clientSlug;
    try {
        clientSlug = JSON.parse(Buffer.from(state, 'base64').toString('utf8')).clientSlug;
    } catch {
        throw new Error('Invalid OAuth state parameter');
    }

    const redirectUri = process.env.QB_REDIRECT_URI;
    const response = await axios.post(
        QB_TOKEN_URL,
        new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
        {
            headers: {
                'Authorization': basicAuthHeader(),
                'Content-Type':  'application/x-www-form-urlencoded',
                'Accept':        'application/json',
            },
        }
    );

    const tokens    = response.data;
    const expiresAt = dayjs().add(tokens.expires_in, 'second').toISOString();

    // NOTE: realmId comes from the callback query param, passed by caller
    return { clientSlug, tokens, expiresAt };
}

/**
 * Refresh an expired QBO access token using the stored refresh token.
 */
async function refreshAccessToken(clientSlug) {
    const client = await db.getClient(clientSlug);
    if (!client) throw new Error(`No client found: ${clientSlug}`);

    const response = await axios.post(
        QB_TOKEN_URL,
        new URLSearchParams({ grant_type: 'refresh_token', refresh_token: client.qbo_refresh_token }).toString(),
        {
            headers: {
                'Authorization': basicAuthHeader(),
                'Content-Type':  'application/x-www-form-urlencoded',
                'Accept':        'application/json',
            },
        }
    );

    const tokens    = response.data;
    const expiresAt = dayjs().add(tokens.expires_in, 'second').toISOString();

    await db.updateQboTokens(clientSlug, {
        accessToken:  tokens.access_token,
        refreshToken: tokens.refresh_token || client.qbo_refresh_token,
        expiresAt,
    });

    console.log(`[QBO] Tokens refreshed for ${clientSlug}`);
    return tokens.access_token;
}

/**
 * Get a valid access token, refreshing if within 5 minutes of expiry.
 */
async function getValidToken(clientSlug) {
    const client = await db.getClient(clientSlug);
    if (!client?.qbo_access_token) throw new Error(`No QBO connection for ${clientSlug}`);

    const expiresAt = dayjs(client.qbo_expires_at);
    if (expiresAt.isBefore(dayjs().add(5, 'minute'))) {
        return refreshAccessToken(clientSlug);
    }

    return client.qbo_access_token;
}

// ─── API Request Helpers ──────────────────────────────────────────────────────

async function qbGet(clientSlug, realmId, path, params = {}) {
    const token = await getValidToken(clientSlug);
    const url   = `${getBaseUrl()}/${realmId}/${path}`;

    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept':        'application/json',
            },
            params: { minorversion: 65, ...params },
        });
        return { ok: true, data: response.data };
    } catch (err) {
        const msg = err.response?.data?.Fault?.Error?.[0]?.Message || err.message;
        return { ok: false, error: msg, status: err.response?.status || 500 };
    }
}

async function qbQuery(clientSlug, realmId, sql) {
    return qbGet(clientSlug, realmId, 'query', { query: sql });
}

// ─── Transaction Categorization ───────────────────────────────────────────────

const CATEGORY_RULES = [
    { category: 'Payroll',       confidence: 0.95, keywords: ['payroll', 'adp', 'gusto', 'paychex', 'wage', 'salary', 'direct deposit'] },
    { category: 'Rent',          confidence: 0.95, keywords: ['rent', 'lease', 'property management', 'landlord'] },
    { category: 'Utilities',     confidence: 0.90, keywords: ['electric', 'gas', 'water', 'utility', 'wec', 'we energies', 'comcast', 'at&t', 'internet', 'phone'] },
    { category: 'Insurance',     confidence: 0.92, keywords: ['insurance', 'insur', 'hartford', 'nationwide', 'progressive', 'allstate', 'travelers'] },
    { category: 'Advertising',   confidence: 0.90, keywords: ['facebook ads', 'google ads', 'meta ads', 'marketing', 'advertising', 'ads manager'] },
    { category: 'Supplies',      confidence: 0.85, keywords: ['office depot', 'staples', 'amazon', 'uline', 'supplies', 'parts'] },
    { category: 'Software',      confidence: 0.90, keywords: ['quickbooks', 'intuit', 'adobe', 'microsoft', 'google workspace', 'slack', 'zoom', 'hubspot', 'subscription'] },
    { category: 'Travel',        confidence: 0.88, keywords: ['airline', 'airbnb', 'hotel', 'marriott', 'hilton', 'uber', 'lyft', 'car rental'] },
    { category: 'Meals',         confidence: 0.85, keywords: ['restaurant', 'grubhub', 'doordash', 'ubereats', 'food', 'lunch', 'dinner', 'catering'] },
    { category: 'Banking',       confidence: 0.95, keywords: ['bank fee', 'service charge', 'overdraft', 'wire fee', 'ach fee', 'monthly fee'] },
    { category: 'Tax',           confidence: 0.95, keywords: ['irs', 'state tax', 'payroll tax', 'sales tax', 'tax payment', 'estimated tax'] },
    { category: 'Professional',  confidence: 0.88, keywords: ['attorney', 'lawyer', 'accountant', 'cpa', 'consultant', 'legal', 'bookkeeping'] },
    { category: 'Inventory',     confidence: 0.85, keywords: ['inventory', 'product', 'wholesale', 'distributor', 'supplier', 'merchandise'] },
    { category: 'Equipment',     confidence: 0.82, keywords: ['equipment', 'machinery', 'tools', 'hardware', 'vehicle', 'computer', 'laptop'] },
    { category: 'Loan Payment',  confidence: 0.92, keywords: ['loan payment', 'mortgage', 'installment', 'financing', 'capital one', 'chase bank'] },
];

/**
 * Categorize a transaction based on description and amount.
 * Returns { category, confidence }.
 */
function categorizeTransaction(description, amount) {
    if (!description) return { category: 'Uncategorized', confidence: 0 };

    const lower = description.toLowerCase();

    for (const rule of CATEGORY_RULES) {
        for (const keyword of rule.keywords) {
            if (lower.includes(keyword)) {
                return { category: rule.category, confidence: rule.confidence };
            }
        }
    }

    // Heuristics by amount range
    if (Math.abs(amount) > 5000)  return { category: 'Large Expense', confidence: 0.5 };
    if (Math.abs(amount) < 10)    return { category: 'Minor Expense', confidence: 0.5 };

    return { category: 'Uncategorized', confidence: 0 };
}

// ─── Data Fetchers ────────────────────────────────────────────────────────────

/**
 * Fetch Purchase, JournalEntry, and Transfer transactions within date range.
 * Returns a normalized array matching the rb_transactions schema.
 */
async function getTransactions(clientSlug, realmId, startDate, endDate) {
    const normalized = [];

    // ── Purchases (expenses) ──
    const purchaseResult = await qbQuery(
        clientSlug, realmId,
        `SELECT * FROM Purchase WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 1000`
    );

    if (purchaseResult.ok) {
        const purchases = purchaseResult.data.QueryResponse?.Purchase || [];
        for (const p of purchases) {
            const { category, confidence } = categorizeTransaction(
                p.PrivateNote || p.AccountRef?.name || '',
                parseFloat(p.TotalAmt || 0)
            );
            normalized.push({
                source:               'qbo',
                source_transaction_id: p.Id,
                date:                 p.TxnDate,
                amount:               -Math.abs(parseFloat(p.TotalAmt || 0)), // expenses are negative
                description:          p.PrivateNote || p.AccountRef?.name || 'Purchase',
                merchant_name:        p.EntityRef?.name || null,
                category,
                category_confidence:  confidence,
                account_id:           p.AccountRef?.value || null,
                account_name:         p.AccountRef?.name || null,
                currency:             p.CurrencyRef?.value || 'USD',
            });
        }
    }

    // ── Journal Entries ──
    const jeResult = await qbQuery(
        clientSlug, realmId,
        `SELECT * FROM JournalEntry WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 500`
    );

    if (jeResult.ok) {
        const entries = jeResult.data.QueryResponse?.JournalEntry || [];
        for (const je of entries) {
            for (const line of je.Line || []) {
                const detail   = line.JournalEntryLineDetail;
                const amount   = parseFloat(line.Amount || 0);
                const isCredit = detail?.PostingType === 'Credit';
                const { category, confidence } = categorizeTransaction(
                    line.Description || je.PrivateNote || 'Journal Entry',
                    amount
                );
                normalized.push({
                    source:               'qbo',
                    source_transaction_id: `${je.Id}-L${line.Id}`,
                    date:                 je.TxnDate,
                    amount:               isCredit ? -amount : amount,
                    description:          line.Description || je.PrivateNote || 'Journal Entry',
                    merchant_name:        null,
                    category,
                    category_confidence:  confidence,
                    account_id:           detail?.AccountRef?.value || null,
                    account_name:         detail?.AccountRef?.name || null,
                    currency:             je.CurrencyRef?.value || 'USD',
                });
            }
        }
    }

    // ── Transfers ──
    const transferResult = await qbQuery(
        clientSlug, realmId,
        `SELECT * FROM Transfer WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 500`
    );

    if (transferResult.ok) {
        const transfers = transferResult.data.QueryResponse?.Transfer || [];
        for (const t of transfers) {
            normalized.push({
                source:               'qbo',
                source_transaction_id: t.Id,
                date:                 t.TxnDate,
                amount:               parseFloat(t.Amount || 0),
                description:          t.PrivateNote || 'Transfer',
                merchant_name:        null,
                category:             'Transfer',
                category_confidence:  1.0,
                account_id:           t.FromAccountRef?.value || null,
                account_name:         t.FromAccountRef?.name || null,
                currency:             t.CurrencyRef?.value || 'USD',
            });
        }
    }

    return normalized;
}

/**
 * Fetch chart of accounts from QuickBooks.
 */
async function getAccounts(clientSlug, realmId) {
    const result = await qbQuery(
        clientSlug, realmId,
        `SELECT * FROM Account WHERE Active = true MAXRESULTS 500`
    );

    if (!result.ok) return { ok: false, error: result.error };

    const accounts = (result.data.QueryResponse?.Account || []).map(a => ({
        id:          a.Id,
        name:        a.Name,
        type:        a.AccountType,
        subType:     a.AccountSubType,
        currentBalance: parseFloat(a.CurrentBalance || 0),
        currency:    a.CurrencyRef?.value || 'USD',
    }));

    return { ok: true, data: accounts };
}

module.exports = {
    initiateOAuth,
    handleCallback,
    refreshAccessToken,
    getValidToken,
    qbGet,
    qbQuery,
    getTransactions,
    getAccounts,
    categorizeTransaction,
};
