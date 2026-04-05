/**
 * GRIDHAND Waste Watcher — POS Integration
 *
 * Handles Toast POS and Square POS integrations.
 * Provides a unified interface for reading sales data and item-level
 * quantities sold — used to calculate usage rates and predict waste.
 *
 * Toast API base:  https://ws-api.toasttab.com/
 * Square API base: https://connect.squareup.com/v2/
 */

'use strict';

require('dotenv').config();

const axios   = require('axios');
const dayjs   = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── In-memory credential & token cache ───────────────────────────────────────

const _toastCredentials = new Map(); // clientSlug → { clientId, clientSecret, restaurantGuid }
const _toastTokens      = new Map(); // clientSlug → { accessToken, expiresAt }
const _squareTokens     = new Map(); // clientSlug → { accessToken, locationId }

// ─── Toast: Credential Setters ────────────────────────────────────────────────

/**
 * Register Toast credentials for a client in memory.
 * Also persists to DB.
 */
async function setToastCredentials(clientSlug, clientId, clientSecret, restaurantGuid) {
    if (!clientId || !clientSecret || !restaurantGuid) {
        throw new Error(`Toast credentials incomplete for ${clientSlug}`);
    }

    _toastCredentials.set(clientSlug, { clientId, clientSecret, restaurantGuid });

    // Persist to DB so we can reload after restart
    const { error } = await supabase
        .from('watcher_connections')
        .upsert({
            client_slug:           clientSlug,
            toast_client_id:       clientId,
            toast_client_secret:   clientSecret,
            toast_restaurant_guid: restaurantGuid,
            active_pos_system:     'toast',
            updated_at:            new Date().toISOString(),
        }, { onConflict: 'client_slug' });

    if (error) throw new Error(`setToastCredentials DB save failed: ${error.message}`);
}

async function _loadToastCredentials(clientSlug) {
    if (_toastCredentials.has(clientSlug)) return _toastCredentials.get(clientSlug);

    const { data, error } = await supabase
        .from('watcher_connections')
        .select('toast_client_id, toast_client_secret, toast_restaurant_guid')
        .eq('client_slug', clientSlug)
        .single();

    if (error || !data) throw new Error(`No Toast credentials found for ${clientSlug}`);
    if (!data.toast_client_id || !data.toast_client_secret || !data.toast_restaurant_guid) {
        throw new Error(`Toast credentials incomplete in DB for ${clientSlug}`);
    }

    const creds = {
        clientId:       data.toast_client_id,
        clientSecret:   data.toast_client_secret,
        restaurantGuid: data.toast_restaurant_guid,
    };

    _toastCredentials.set(clientSlug, creds);
    return creds;
}

// ─── Toast: OAuth ─────────────────────────────────────────────────────────────

const TOAST_BASE = 'https://ws-api.toasttab.com';

/**
 * Obtain a Toast OAuth access token using client credentials grant.
 * Caches the token in memory and in DB until it expires.
 */
async function getOAuthToken(clientSlug) {
    // Check in-memory cache first
    const cached = _toastTokens.get(clientSlug);
    if (cached && dayjs().isBefore(dayjs(cached.expiresAt).subtract(5, 'minute'))) {
        return cached.accessToken;
    }

    // Check DB cache
    const { data: dbConn } = await supabase
        .from('watcher_connections')
        .select('toast_access_token, toast_token_expires_at')
        .eq('client_slug', clientSlug)
        .single();

    if (dbConn?.toast_access_token && dbConn?.toast_token_expires_at) {
        if (dayjs().isBefore(dayjs(dbConn.toast_token_expires_at).subtract(5, 'minute'))) {
            _toastTokens.set(clientSlug, {
                accessToken: dbConn.toast_access_token,
                expiresAt:   dbConn.toast_token_expires_at,
            });
            return dbConn.toast_access_token;
        }
    }

    // Fetch new token
    const creds = await _loadToastCredentials(clientSlug);

    let response;
    try {
        response = await axios.post(`${TOAST_BASE}/usermgmt/v1/authentications`, {
            clientId:     creds.clientId,
            clientSecret: creds.clientSecret,
            userAccessType: 'TOAST_MACHINE_CLIENT',
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
        });
    } catch (err) {
        throw new Error(`Toast OAuth token request failed for ${clientSlug}: ${err.message}`);
    }

    const token     = response.data?.token?.accessToken;
    const expiresIn = response.data?.token?.expiresIn || 86400; // default 24h
    const expiresAt = dayjs().add(expiresIn, 'second').toISOString();

    if (!token) throw new Error(`Toast OAuth returned no access token for ${clientSlug}`);

    // Cache in memory
    _toastTokens.set(clientSlug, { accessToken: token, expiresAt });

    // Persist to DB
    await supabase
        .from('watcher_connections')
        .update({ toast_access_token: token, toast_token_expires_at: expiresAt })
        .eq('client_slug', clientSlug);

    console.log(`[Toast] Obtained new access token for ${clientSlug}, expires ${expiresAt}`);
    return token;
}

function _toastHeaders(token, restaurantGuid) {
    return {
        'Authorization':       `Bearer ${token}`,
        'Toast-Restaurant-External-ID': restaurantGuid,
        'Content-Type':        'application/json',
    };
}

// ─── Toast: Sales Data ────────────────────────────────────────────────────────

/**
 * Get aggregate sales data for a date range from Toast.
 * Returns total revenue and a list of items sold with quantities.
 */
async function getSalesData(clientSlug, startDate, endDate) {
    const creds = await _loadToastCredentials(clientSlug);
    const token = await getOAuthToken(clientSlug);

    const start = dayjs(startDate).startOf('day').toISOString();
    const end   = dayjs(endDate).endOf('day').toISOString();

    let response;
    try {
        response = await axios.get(`${TOAST_BASE}/orders/v2/ordersBulk`, {
            headers: _toastHeaders(token, creds.restaurantGuid),
            params: {
                startDate: start,
                endDate:   end,
                pageSize:  500,
            },
            timeout: 20000,
        });
    } catch (err) {
        throw new Error(`Toast getSalesData failed for ${clientSlug}: ${err.message}`);
    }

    const orders = response.data || [];
    let totalRevenue = 0;
    const itemMap    = new Map(); // itemName → { quantitySold, revenue }

    for (const order of orders) {
        if (order.voided || order.deleted) continue;
        for (const check of (order.checks || [])) {
            for (const selection of (check.selections || [])) {
                if (selection.voided) continue;
                const name     = selection.displayName || selection.itemGroupGuid || 'Unknown';
                const qty      = selection.quantity || 1;
                const price    = parseFloat(selection.price ?? 0) * qty;
                totalRevenue  += price;

                const existing = itemMap.get(name) || { quantitySold: 0, revenue: 0 };
                itemMap.set(name, {
                    quantitySold: existing.quantitySold + qty,
                    revenue:      parseFloat((existing.revenue + price).toFixed(2)),
                });
            }
        }
    }

    return {
        startDate,
        endDate,
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        orderCount:   orders.length,
        items: Array.from(itemMap.entries()).map(([name, data]) => ({
            itemName:     name,
            quantitySold: data.quantitySold,
            revenue:      data.revenue,
        })),
    };
}

/**
 * Get item-level sales for a single day from Toast.
 */
async function getMenuItemSales(clientSlug, date) {
    const result = await getSalesData(clientSlug, date, date);
    return result.items;
}

// ─── Square: Credential Loading ───────────────────────────────────────────────

async function getSquareToken(clientSlug) {
    if (_squareTokens.has(clientSlug)) return _squareTokens.get(clientSlug);

    const { data, error } = await supabase
        .from('watcher_connections')
        .select('square_access_token, square_location_id')
        .eq('client_slug', clientSlug)
        .single();

    if (error || !data) throw new Error(`No Square credentials found for ${clientSlug}`);
    if (!data.square_access_token) throw new Error(`Square access token missing for ${clientSlug}`);

    const creds = {
        accessToken: data.square_access_token,
        locationId:  data.square_location_id,
    };
    _squareTokens.set(clientSlug, creds);
    return creds;
}

// ─── Square: Sales Data ───────────────────────────────────────────────────────

const SQUARE_BASE = 'https://connect.squareup.com/v2';

function _squareHeaders(accessToken) {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
        'Square-Version': '2024-01-17',
    };
}

/**
 * Get order data from Square for a date range.
 */
async function getOrderData(clientSlug, startDate, endDate) {
    const { accessToken, locationId } = await getSquareToken(clientSlug);

    const body = {
        location_ids: [locationId],
        query: {
            filter: {
                date_time_filter: {
                    created_at: {
                        start_at: dayjs(startDate).startOf('day').toISOString(),
                        end_at:   dayjs(endDate).endOf('day').toISOString(),
                    },
                },
                state_filter: { states: ['COMPLETED'] },
            },
        },
        limit: 500,
    };

    let allOrders = [];
    let cursor    = null;

    do {
        if (cursor) body.cursor = cursor;

        let response;
        try {
            response = await axios.post(`${SQUARE_BASE}/orders/search`, body, {
                headers: _squareHeaders(accessToken),
                timeout: 20000,
            });
        } catch (err) {
            throw new Error(`Square getOrderData failed for ${clientSlug}: ${err.message}`);
        }

        const page = response.data?.orders || [];
        allOrders  = allOrders.concat(page);
        cursor     = response.data?.cursor || null;

    } while (cursor);

    return allOrders;
}

/**
 * Get item-level sales for a single day from Square.
 */
async function getItemSales(clientSlug, date) {
    const orders  = await getOrderData(clientSlug, date, date);
    const itemMap = new Map();

    for (const order of orders) {
        for (const lineItem of (order.line_items || [])) {
            const name = lineItem.name || 'Unknown';
            const qty  = parseFloat(lineItem.quantity || 1);
            const amt  = parseFloat((lineItem.total_money?.amount || 0)) / 100; // cents → dollars

            const existing = itemMap.get(name) || { quantitySold: 0, revenue: 0 };
            itemMap.set(name, {
                quantitySold: existing.quantitySold + qty,
                revenue:      parseFloat((existing.revenue + amt).toFixed(2)),
            });
        }
    }

    return Array.from(itemMap.entries()).map(([name, data]) => ({
        itemName:     name,
        quantitySold: data.quantitySold,
        revenue:      data.revenue,
    }));
}

// ─── Unified POS Interface ────────────────────────────────────────────────────

async function _getActivePOS(clientSlug) {
    const { data, error } = await supabase
        .from('watcher_connections')
        .select('active_pos_system')
        .eq('client_slug', clientSlug)
        .single();

    if (error || !data) throw new Error(`No connection found for ${clientSlug}`);
    return data.active_pos_system || 'toast';
}

/**
 * Get item-level sales for a given date, routing to the active POS system.
 * Returns a normalized array: [{ itemName, quantitySold, revenue }]
 */
async function getSalesByItem(clientSlug, date) {
    const pos = await _getActivePOS(clientSlug);
    if (pos === 'square') return getItemSales(clientSlug, date);
    return getMenuItemSales(clientSlug, date);
}

/**
 * Calculate the average daily usage rate for a named ingredient/item
 * by looking at sales history over the past N days.
 *
 * We look up how many of each menu item was sold and use the relationship
 * stored in daily_sales to determine per-ingredient usage.
 *
 * If no sales data exists, returns 0.
 *
 * @param {string} clientSlug
 * @param {string} itemName  - inventory item name (e.g. "Chicken Breast")
 * @param {number} days      - number of days to average over
 * @returns {number} average daily quantity used
 */
async function calculateUsageRate(clientSlug, itemName, days = 14) {
    const startDate = dayjs().subtract(days, 'day').format('YYYY-MM-DD');

    const { data, error } = await supabase
        .from('daily_sales')
        .select('sale_date, quantity_sold')
        .eq('client_slug', clientSlug)
        .eq('item_name', itemName)
        .gte('sale_date', startDate)
        .order('sale_date', { ascending: false });

    if (error) throw new Error(`calculateUsageRate query failed: ${error.message}`);

    if (!data || data.length === 0) return 0;

    const totalQty = data.reduce((sum, row) => sum + parseFloat(row.quantity_sold || 0), 0);
    const avgDaily = totalQty / days; // divide by days, not data.length, to account for zero-sales days

    return parseFloat(avgDaily.toFixed(4));
}

/**
 * Persist daily sales data for all items on a given date.
 * Called after fetching from POS each day.
 */
async function saveDailySales(clientSlug, date, items) {
    if (!items || items.length === 0) return;

    const rows = items.map(item => ({
        client_slug:   clientSlug,
        sale_date:     date,
        item_name:     item.itemName,
        quantity_sold: item.quantitySold,
        revenue:       item.revenue,
    }));

    const { error } = await supabase
        .from('daily_sales')
        .upsert(rows, { onConflict: 'client_slug,sale_date,item_name' });

    if (error) throw new Error(`saveDailySales failed: ${error.message}`);
    console.log(`[POS] Saved ${rows.length} item sales for ${clientSlug} on ${date}`);
}

/**
 * Get daily sales history from DB for a client and date range.
 */
async function getSalesHistory(clientSlug, days = 14) {
    const startDate = dayjs().subtract(days, 'day').format('YYYY-MM-DD');

    const { data, error } = await supabase
        .from('daily_sales')
        .select('*')
        .eq('client_slug', clientSlug)
        .gte('sale_date', startDate)
        .order('sale_date', { ascending: false });

    if (error) throw new Error(`getSalesHistory failed: ${error.message}`);
    return data || [];
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    // Toast
    setToastCredentials,
    getOAuthToken,
    getSalesData,
    getMenuItemSales,

    // Square
    getSquareToken,
    getOrderData,
    getItemSales,

    // Unified
    getSalesByItem,
    calculateUsageRate,
    saveDailySales,
    getSalesHistory,
};
