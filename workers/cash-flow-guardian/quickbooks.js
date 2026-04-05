/**
 * GRIDHAND Cash Flow Guardian — QuickBooks Online API v3 Integration
 *
 * Handles:
 *  - OAuth 2.0 authorization + token management
 *  - Token refresh (QB access tokens expire in 1 hour)
 *  - Cash flow data: P&L, AR, AP, cash balance
 *  - Invoice list + customer contact lookup
 */

'use strict';

const axios   = require('axios');
const dayjs   = require('dayjs');
const db      = require('./db');

// ─── QB API Constants ──────────────────────────────────────────────────────────

const QB_BASE_URL    = 'https://quickbooks.api.intuit.com/v3/company';
const QB_AUTH_URL    = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL   = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QB_REVOKE_URL  = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const QB_SANDBOX_URL = 'https://sandbox-quickbooks.api.intuit.com/v3/company';

const SCOPES = 'com.intuit.quickbooks.accounting';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getBaseUrl() {
    return process.env.QB_SANDBOX === 'true' ? QB_SANDBOX_URL : QB_BASE_URL;
}

function getClientCredentials() {
    const clientId     = process.env.QB_CLIENT_ID;
    const clientSecret = process.env.QB_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('QB_CLIENT_ID and QB_CLIENT_SECRET must be set in environment');
    }
    return { clientId, clientSecret };
}

function basicAuthHeader() {
    const { clientId, clientSecret } = getClientCredentials();
    return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

// ─── OAuth 2.0 ────────────────────────────────────────────────────────────────

/**
 * Build the QuickBooks authorization URL for a client.
 * Redirect user to this URL to begin OAuth flow.
 */
function getAuthorizationUrl(clientSlug) {
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
 * Exchange authorization code for access + refresh tokens.
 * Call this in the OAuth callback handler.
 */
async function exchangeCode({ code, realmId, clientSlug, ownerPhone }) {
    const redirectUri = process.env.QB_REDIRECT_URI;

    const response = await axios.post(QB_TOKEN_URL,
        new URLSearchParams({
            grant_type:   'authorization_code',
            code,
            redirect_uri: redirectUri,
        }).toString(),
        {
            headers: {
                'Authorization': basicAuthHeader(),
                'Content-Type':  'application/x-www-form-urlencoded',
                'Accept':        'application/json',
            },
        }
    );

    const tokens = response.data;
    const expiresAt = dayjs().add(tokens.expires_in, 'second').toISOString();

    await db.upsertQBConnection({
        clientSlug,
        realmId,
        ownerPhone,
        accessToken:  tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenType:    tokens.token_type,
        expiresAt,
        scope:        tokens.x_refresh_token_expires_in ? SCOPES : null,
    });

    console.log(`[QB] Tokens saved for ${clientSlug} (realm: ${realmId})`);
    return { realmId, clientSlug };
}

/**
 * Refresh an expired access token using the stored refresh token.
 * Called automatically before any API request if token is stale.
 */
async function refreshAccessToken(clientSlug) {
    const conn = await db.getQBConnection(clientSlug);
    if (!conn) throw new Error(`No QuickBooks connection found for ${clientSlug}`);

    const response = await axios.post(QB_TOKEN_URL,
        new URLSearchParams({
            grant_type:    'refresh_token',
            refresh_token: conn.refresh_token,
        }).toString(),
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

    await db.updateQBTokens(clientSlug, {
        accessToken:  tokens.access_token,
        refreshToken: tokens.refresh_token || conn.refresh_token,
        expiresAt,
    });

    console.log(`[QB] Tokens refreshed for ${clientSlug}`);
    return tokens.access_token;
}

/**
 * Get a valid access token for a client, refreshing if needed.
 */
async function getValidToken(clientSlug) {
    const conn = await db.getQBConnection(clientSlug);
    if (!conn) throw new Error(`No QuickBooks connection for client: ${clientSlug}`);

    const expiresAt = dayjs(conn.expires_at);
    const nowPlus5  = dayjs().add(5, 'minute');

    if (expiresAt.isBefore(nowPlus5)) {
        return refreshAccessToken(clientSlug);
    }

    return conn.access_token;
}

// ─── API Request Helper ────────────────────────────────────────────────────────

async function qbGet(clientSlug, realmId, path, params = {}) {
    const token = await getValidToken(clientSlug);
    const url   = `${getBaseUrl()}/${realmId}/${path}`;

    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept':        'application/json',
            },
            params: {
                minorversion: 65,
                ...params,
            },
        });
        return response.data;
    } catch (err) {
        const msg = err.response?.data?.Fault?.Error?.[0]?.Message || err.message;
        throw new Error(`QB API error [${path}]: ${msg}`);
    }
}

async function qbQuery(clientSlug, realmId, sql) {
    return qbGet(clientSlug, realmId, 'query', { query: sql });
}

async function qbReport(clientSlug, realmId, reportName, params = {}) {
    const token = await getValidToken(clientSlug);
    const url   = `${getBaseUrl()}/${realmId}/reports/${reportName}`;

    const response = await axios.get(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept':        'application/json',
        },
        params: {
            minorversion: 65,
            ...params,
        },
    });
    return response.data;
}

// ─── Cash Flow Data Fetchers ───────────────────────────────────────────────────

/**
 * Pull today's Profit & Loss summary from QuickBooks.
 * Returns { totalIncome, totalExpenses, netIncome }
 */
async function getProfitAndLoss(clientSlug, realmId, startDate, endDate) {
    const data = await qbReport(clientSlug, realmId, 'ProfitAndLoss', {
        start_date: startDate || dayjs().startOf('month').format('YYYY-MM-DD'),
        end_date:   endDate   || dayjs().format('YYYY-MM-DD'),
        summarize_column_by: 'Total',
    });

    let totalIncome   = 0;
    let totalExpenses = 0;

    for (const row of data.Rows?.Row || []) {
        if (row.group === 'Income')   totalIncome   = parseFloat(row.Summary?.ColData?.[1]?.value || 0);
        if (row.group === 'Expenses') totalExpenses = parseFloat(row.Summary?.ColData?.[1]?.value || 0);
    }

    return {
        totalIncome,
        totalExpenses,
        netIncome: totalIncome - totalExpenses,
    };
}

/**
 * Get current cash balance from the Balance Sheet.
 * Returns the total checking/savings balance.
 */
async function getCashBalance(clientSlug, realmId) {
    const data = await qbReport(clientSlug, realmId, 'BalanceSheet', {
        as_of_date: dayjs().format('YYYY-MM-DD'),
    });

    let cashBalance = 0;

    for (const row of data.Rows?.Row || []) {
        if (row.group === 'CurrentAssets') {
            for (const sub of row.Rows?.Row || []) {
                if (sub.Header?.ColData?.[0]?.value?.toLowerCase().includes('cash') ||
                    sub.Header?.ColData?.[0]?.value?.toLowerCase().includes('checking') ||
                    sub.Header?.ColData?.[0]?.value?.toLowerCase().includes('savings')) {
                    cashBalance += parseFloat(sub.Summary?.ColData?.[1]?.value || 0);
                }
            }
        }
    }

    return cashBalance;
}

/**
 * Get total accounts receivable — what customers owe.
 */
async function getAccountsReceivable(clientSlug, realmId) {
    const data = await qbReport(clientSlug, realmId, 'AgedReceivablesSummary', {
        report_date: dayjs().format('YYYY-MM-DD'),
    });

    let totalAR    = 0;
    let overdueAR  = 0;
    let overdueCount = 0;

    for (const row of data.Rows?.Row || []) {
        if (row.type === 'Section') continue;
        const cols     = row.ColData || [];
        const rowTotal = parseFloat(cols[cols.length - 1]?.value || 0);
        totalAR += rowTotal;

        // Columns after the first are aging buckets: 1-30, 31-60, 61-90, 91+
        // Anything past col[1] (current) is overdue
        const overdueAmt = cols.slice(2).reduce((sum, c) => sum + parseFloat(c?.value || 0), 0);
        if (overdueAmt > 0) {
            overdueAR += overdueAmt;
            overdueCount++;
        }
    }

    return { totalAR, overdueAR, overdueCount };
}

/**
 * Get total accounts payable — what the business owes.
 */
async function getAccountsPayable(clientSlug, realmId) {
    const data = await qbReport(clientSlug, realmId, 'AgedPayablesSummary', {
        report_date: dayjs().format('YYYY-MM-DD'),
    });

    let totalAP = 0;

    for (const row of data.Rows?.Row || []) {
        if (row.type === 'Section') continue;
        const cols = row.ColData || [];
        totalAP += parseFloat(cols[cols.length - 1]?.value || 0);
    }

    return totalAP;
}

/**
 * Get list of open/overdue invoices with customer contact info.
 * Returns array of invoice objects ready for reminder logic.
 */
async function getOpenInvoices(clientSlug, realmId) {
    const sql  = `SELECT * FROM Invoice WHERE Balance > '0' AND TxnStatus IN ('Open', 'Overdue') MAXRESULTS 200`;
    const data = await qbQuery(clientSlug, realmId, sql);

    const invoices = (data.QueryResponse?.Invoice || []).map(inv => {
        const dueDate = inv.DueDate ? dayjs(inv.DueDate) : null;
        const today   = dayjs();
        const daysOverdue = dueDate && dueDate.isBefore(today, 'day')
            ? today.diff(dueDate, 'day')
            : 0;

        return {
            id:           inv.Id,
            invoiceNumber: inv.DocNumber,
            customerRef:  inv.CustomerRef?.value,
            customerName: inv.CustomerRef?.name,
            amount:       parseFloat(inv.TotalAmt || 0),
            balanceDue:   parseFloat(inv.Balance || 0),
            dueDate:      inv.DueDate || null,
            daysOverdue,
            status:       daysOverdue > 0 ? 'Overdue' : 'Open',
            syncToken:    inv.SyncToken,
            emailAddress: inv.BillEmail?.Address || null,
        };
    });

    return invoices;
}

/**
 * Get a customer's phone number from QuickBooks.
 */
async function getCustomerPhone(clientSlug, realmId, customerId) {
    try {
        const data = await qbGet(clientSlug, realmId, `customer/${customerId}`);
        const customer = data.Customer;
        return (
            customer?.PrimaryPhone?.FreeFormNumber ||
            customer?.Mobile?.FreeFormNumber ||
            null
        );
    } catch {
        return null;
    }
}

/**
 * Get upcoming receivables + payables for the next 30 days (for forecast).
 */
async function getUpcomingCashFlow(clientSlug, realmId, days = 30) {
    const endDate = dayjs().add(days, 'day').format('YYYY-MM-DD');
    const today   = dayjs().format('YYYY-MM-DD');

    // Invoices due in the next N days
    const invSql = `SELECT * FROM Invoice WHERE Balance > '0' AND DueDate >= '${today}' AND DueDate <= '${endDate}' MAXRESULTS 200`;
    const invData = await qbQuery(clientSlug, realmId, invSql);
    const expectedInflow = (invData.QueryResponse?.Invoice || [])
        .reduce((sum, inv) => sum + parseFloat(inv.Balance || 0), 0);

    // Bills due in the next N days
    const billSql = `SELECT * FROM Bill WHERE Balance > '0' AND DueDate >= '${today}' AND DueDate <= '${endDate}' MAXRESULTS 200`;
    const billData = await qbQuery(clientSlug, realmId, billSql);
    const expectedOutflow = (billData.QueryResponse?.Bill || [])
        .reduce((sum, bill) => sum + parseFloat(bill.Balance || 0), 0);

    return { expectedInflow, expectedOutflow, days };
}

/**
 * Full daily cash flow snapshot — combines all data into one object.
 */
async function getDailyCashFlowSnapshot(clientSlug, realmId) {
    const today     = dayjs().format('YYYY-MM-DD');
    const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');

    const [pnl, cashBalance, ar, ap] = await Promise.all([
        getProfitAndLoss(clientSlug, realmId, monthStart, today),
        getCashBalance(clientSlug, realmId),
        getAccountsReceivable(clientSlug, realmId),
        getAccountsPayable(clientSlug, realmId),
    ]);

    return {
        date:          today,
        totalIncome:   pnl.totalIncome,
        totalExpenses: pnl.totalExpenses,
        netCashFlow:   pnl.netIncome,
        cashBalance,
        arBalance:     ar.totalAR,
        apBalance:     ap,
        overdueCount:  ar.overdueCount,
        overdueAmount: ar.overdueAR,
    };
}

// ─── QuickBooks Webhook Verification ──────────────────────────────────────────

/**
 * Verify a QB webhook payload using HMAC-SHA256.
 * QB sends signature in the `intuit-signature` header.
 */
function verifyWebhookSignature(rawBody, signature) {
    const crypto   = require('crypto');
    const verifier = process.env.QB_WEBHOOK_VERIFIER_TOKEN;
    if (!verifier) return true; // Skip verification in dev if not set

    const hash = crypto
        .createHmac('sha256', verifier)
        .update(rawBody)
        .digest('base64');

    return hash === signature;
}

module.exports = {
    getAuthorizationUrl,
    exchangeCode,
    refreshAccessToken,
    getValidToken,
    getDailyCashFlowSnapshot,
    getOpenInvoices,
    getCustomerPhone,
    getUpcomingCashFlow,
    getProfitAndLoss,
    getCashBalance,
    getAccountsReceivable,
    getAccountsPayable,
    verifyWebhookSignature,
};
