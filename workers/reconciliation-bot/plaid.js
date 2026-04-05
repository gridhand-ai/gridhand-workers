/**
 * GRIDHAND Reconciliation Bot — Plaid Bank Feed Integration
 *
 * Handles:
 *  - Plaid Link token creation (frontend link flow)
 *  - Public token exchange for access token
 *  - Transaction sync with pagination
 *  - Account and balance retrieval
 *
 * Env vars required: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox|production)
 */

'use strict';

const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');
const dayjs = require('dayjs');
const db    = require('./db');
const { categorizeTransaction } = require('./quickbooks');

// ─── Plaid Client Factory ─────────────────────────────────────────────────────

let _plaidClient = null;

function getPlaidClient() {
    if (_plaidClient) return _plaidClient;

    const clientId  = process.env.PLAID_CLIENT_ID;
    const secret    = process.env.PLAID_SECRET;
    const envName   = (process.env.PLAID_ENV || 'sandbox').toLowerCase();

    if (!clientId || !secret) {
        throw new Error('PLAID_CLIENT_ID and PLAID_SECRET must be set');
    }

    const envMap = {
        sandbox:    PlaidEnvironments.sandbox,
        production: PlaidEnvironments.production,
        development: PlaidEnvironments.development,
    };

    const basePath = envMap[envName] || PlaidEnvironments.sandbox;

    const config = new Configuration({
        basePath,
        baseOptions: {
            headers: {
                'PLAID-CLIENT-ID': clientId,
                'PLAID-SECRET':    secret,
            },
        },
    });

    _plaidClient = new PlaidApi(config);
    return _plaidClient;
}

// ─── Link Token ───────────────────────────────────────────────────────────────

/**
 * Create a Plaid Link token for the frontend to initiate bank connection.
 * userId should be the client_slug for consistent user tracking.
 */
async function createLinkToken(clientSlug, userId) {
    try {
        const plaid = getPlaidClient();

        const response = await plaid.linkTokenCreate({
            user:          { client_user_id: userId || clientSlug },
            client_name:   'GRIDHAND Reconciliation Bot',
            products:      [Products.Transactions],
            country_codes: [CountryCode.Us],
            language:      'en',
        });

        return { ok: true, data: { link_token: response.data.link_token, expiration: response.data.expiration } };
    } catch (err) {
        const msg = err.response?.data?.error_message || err.message;
        return { ok: false, error: msg, status: err.response?.status || 500 };
    }
}

// ─── Token Exchange ───────────────────────────────────────────────────────────

/**
 * Exchange a public token (from Plaid Link) for a permanent access token.
 * Stores access_token and item_id in rb_clients.
 */
async function exchangePublicToken(clientSlug, publicToken) {
    try {
        const plaid    = getPlaidClient();
        const response = await plaid.itemPublicTokenExchange({ public_token: publicToken });

        const accessToken = response.data.access_token;
        const itemId      = response.data.item_id;

        await db.updatePlaidTokens(clientSlug, { accessToken, itemId });

        console.log(`[Plaid] Token exchanged and stored for ${clientSlug}, item: ${itemId}`);
        return { ok: true, data: { item_id: itemId } };
    } catch (err) {
        const msg = err.response?.data?.error_message || err.message;
        return { ok: false, error: msg, status: err.response?.status || 500 };
    }
}

// ─── Transactions ─────────────────────────────────────────────────────────────

/**
 * Fetch all transactions for a client from Plaid with pagination.
 * Returns normalized transactions matching rb_transactions schema.
 */
async function getTransactions(clientSlug, startDate, endDate) {
    try {
        const client = await db.getClient(clientSlug);
        if (!client?.plaid_access_token) {
            return { ok: false, error: `No Plaid access token for ${clientSlug}` };
        }

        const plaid       = getPlaidClient();
        const allTxns     = [];
        let offset        = 0;
        let totalCount    = null;
        const pageSize    = 500;

        do {
            const response = await plaid.transactionsGet({
                access_token: client.plaid_access_token,
                start_date:   startDate,
                end_date:     endDate,
                options: {
                    count:           pageSize,
                    offset,
                    include_personal_finance_category: true,
                },
            });

            const data       = response.data;
            totalCount       = totalCount ?? data.total_transactions;
            allTxns.push(...data.transactions);
            offset += data.transactions.length;

            if (data.transactions.length === 0) break;
        } while (allTxns.length < totalCount);

        // Normalize to rb_transactions shape
        const normalized = allTxns.map(txn => {
            const { category, confidence } = categorizeTransaction(
                txn.name || txn.merchant_name || txn.original_description || '',
                txn.amount
            );

            return {
                source:               'plaid',
                source_transaction_id: txn.transaction_id,
                date:                 txn.date,
                // Plaid: positive = debit (money out), negative = credit (money in)
                amount:               -txn.amount,
                description:          txn.name || txn.original_description || 'Bank Transaction',
                merchant_name:        txn.merchant_name || null,
                category:             txn.personal_finance_category?.primary
                                          ? formatPlaidCategory(txn.personal_finance_category.primary)
                                          : category,
                category_confidence:  txn.personal_finance_category?.confidence_level
                                          ? plaidConfidenceToFloat(txn.personal_finance_category.confidence_level)
                                          : confidence,
                account_id:           txn.account_id || null,
                account_name:         null, // will be enriched if needed
                currency:             txn.iso_currency_code || txn.unofficial_currency_code || 'USD',
                pending:              txn.pending || false,
            };
        });

        return { ok: true, data: normalized };
    } catch (err) {
        const msg = err.response?.data?.error_message || err.message;
        return { ok: false, error: msg, status: err.response?.status || 500 };
    }
}

/**
 * Get connected bank accounts for a client.
 */
async function getAccounts(clientSlug) {
    try {
        const client = await db.getClient(clientSlug);
        if (!client?.plaid_access_token) {
            return { ok: false, error: `No Plaid access token for ${clientSlug}` };
        }

        const plaid    = getPlaidClient();
        const response = await plaid.accountsGet({ access_token: client.plaid_access_token });

        const accounts = response.data.accounts.map(a => ({
            account_id:   a.account_id,
            name:         a.name,
            official_name: a.official_name,
            type:         a.type,
            subtype:      a.subtype,
            mask:         a.mask,
            currency:     a.balances.iso_currency_code || 'USD',
            balance_current:   a.balances.current,
            balance_available: a.balances.available,
        }));

        return { ok: true, data: accounts };
    } catch (err) {
        const msg = err.response?.data?.error_message || err.message;
        return { ok: false, error: msg, status: err.response?.status || 500 };
    }
}

/**
 * Get real-time balances for all connected accounts.
 */
async function getBalance(clientSlug) {
    try {
        const client = await db.getClient(clientSlug);
        if (!client?.plaid_access_token) {
            return { ok: false, error: `No Plaid access token for ${clientSlug}` };
        }

        const plaid    = getPlaidClient();
        const response = await plaid.accountsBalanceGet({ access_token: client.plaid_access_token });

        const totals = response.data.accounts.reduce((acc, a) => {
            acc.current   += a.balances.current   || 0;
            acc.available += a.balances.available  || 0;
            return acc;
        }, { current: 0, available: 0 });

        return {
            ok:   true,
            data: {
                accounts:        response.data.accounts,
                total_current:   totals.current,
                total_available: totals.available,
            },
        };
    } catch (err) {
        const msg = err.response?.data?.error_message || err.message;
        return { ok: false, error: msg, status: err.response?.status || 500 };
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPlaidCategory(primary) {
    if (!primary) return 'Uncategorized';
    return primary
        .split('_')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
}

function plaidConfidenceToFloat(level) {
    const map = { VERY_HIGH: 0.97, HIGH: 0.85, MEDIUM: 0.65, LOW: 0.40, UNKNOWN: 0.20 };
    return map[level] || 0.50;
}

module.exports = {
    getPlaidClient,
    createLinkToken,
    exchangePublicToken,
    getTransactions,
    getAccounts,
    getBalance,
};
