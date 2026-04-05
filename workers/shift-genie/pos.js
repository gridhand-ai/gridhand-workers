/**
 * GRIDHAND Shift Genie — POS Integrations
 *
 * Supports:
 *   - Toast POS (OAuth2 + restaurant GUID)
 *   - Square POS (access token + location ID)
 *
 * Provides projected and historical sales data used for labor optimization.
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

// ─── Supabase Helpers ─────────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('genie_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error) throw new Error(`[pos] No connection for ${clientSlug}: ${error.message}`);
    return data;
}

async function saveConnection(clientSlug, updates) {
    const { error } = await supabase
        .from('genie_connections')
        .update(updates)
        .eq('client_slug', clientSlug);

    if (error) throw new Error(`[pos] Save failed: ${error.message}`);
}

// ─── Toast POS ────────────────────────────────────────────────────────────────

const TOAST_AUTH_BASE = 'https://ws-api.toasttab.com/authentication/v1';
const TOAST_API_BASE  = 'https://ws-api.toasttab.com';

/**
 * Get (or refresh) a Toast access token. Token TTL is 24 hours.
 */
async function getToastAccessToken(clientSlug) {
    const conn = await getConnection(clientSlug);

    if (!conn.toast_client_id || !conn.toast_client_secret) {
        throw new Error('Toast credentials not configured for ' + clientSlug);
    }

    // Use cached token if still valid (with 5-minute buffer)
    if (conn.toast_access_token && conn.toast_token_expires_at) {
        const expiresAt = dayjs(conn.toast_token_expires_at);
        if (dayjs().isBefore(expiresAt.subtract(5, 'minute'))) {
            return conn.toast_access_token;
        }
    }

    // Fetch a new token
    const resp = await axios.post(`${TOAST_AUTH_BASE}/authentication/login`, {
        clientId:     conn.toast_client_id,
        clientSecret: conn.toast_client_secret,
        userAccessType: 'TOAST_MACHINE_CLIENT',
    });

    const { token: { accessToken, expiresIn } } = resp.data;
    const expiresAt = dayjs().add(expiresIn || 86400, 'second').toISOString();

    await saveConnection(clientSlug, {
        toast_access_token:    accessToken,
        toast_token_expires_at: expiresAt,
    });

    return accessToken;
}

function toastHeaders(token, restaurantGuid) {
    return {
        Authorization:          `Bearer ${token}`,
        'Toast-Restaurant-External-ID': restaurantGuid,
        'Content-Type': 'application/json',
    };
}

/**
 * Get projected sales for a date using Toast's historical order data.
 * Looks back 4 same-day-of-week data points, averages them.
 *
 * @returns {number} projected total revenue for the day
 */
async function getProjectedSales(clientSlug, date) {
    const conn  = await getConnection(clientSlug);
    const token = await getToastAccessToken(clientSlug);

    const targetDay  = dayjs(date);
    const sampleDays = [-7, -14, -21, -28].map(offset =>
        targetDay.add(offset, 'day').format('YYYY-MM-DD')
    );

    const totals = [];

    for (const sampleDate of sampleDays) {
        try {
            const startDt = `${sampleDate}T00:00:00.000+0000`;
            const endDt   = `${sampleDate}T23:59:59.000+0000`;

            const resp = await axios.get(`${TOAST_API_BASE}/orders/v2/orders`, {
                headers: toastHeaders(token, conn.toast_restaurant_guid),
                params:  { startDate: startDt, endDate: endDt, pageSize: 500 },
            });

            const orders    = resp.data || [];
            const dayRevenue = orders.reduce((sum, order) => {
                if (order.voidDate) return sum; // skip voided orders
                return sum + parseFloat(order.totalAmount || 0);
            }, 0);

            if (dayRevenue > 0) totals.push(dayRevenue);
        } catch (err) {
            console.warn(`[pos] Toast sample date ${sampleDate} failed: ${err.message}`);
        }
    }

    if (totals.length === 0) return 0;
    const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
    return parseFloat(avg.toFixed(2));
}

/**
 * Get actual sales for a date from Toast (for labor cost calculation).
 */
async function getToastActualSales(clientSlug, date) {
    const conn  = await getConnection(clientSlug);
    const token = await getToastAccessToken(clientSlug);

    const startDt = `${dayjs(date).format('YYYY-MM-DD')}T00:00:00.000+0000`;
    const endDt   = `${dayjs(date).format('YYYY-MM-DD')}T23:59:59.000+0000`;

    const resp = await axios.get(`${TOAST_API_BASE}/orders/v2/orders`, {
        headers: toastHeaders(token, conn.toast_restaurant_guid),
        params:  { startDate: startDt, endDate: endDt, pageSize: 500 },
    });

    const orders = resp.data || [];
    let totalRevenue = 0;
    const byHour = {};

    for (const order of orders) {
        if (order.voidDate) continue;
        const amount = parseFloat(order.totalAmount || 0);
        totalRevenue += amount;

        const openedAt = order.openedDate || order.createdDate;
        if (openedAt) {
            const hour = dayjs(openedAt).hour();
            byHour[hour] = (byHour[hour] || 0) + amount;
        }
    }

    return { totalRevenue: parseFloat(totalRevenue.toFixed(2)), byHour };
}

// ─── Square POS ───────────────────────────────────────────────────────────────

const SQUARE_BASE = 'https://connect.squareup.com/v2';

function squareClient(clientSlug, conn) {
    return axios.create({
        baseURL: SQUARE_BASE,
        headers: {
            Authorization:  `Bearer ${conn.square_access_token}`,
            'Content-Type': 'application/json',
            'Square-Version': '2024-01-17',
        },
    });
}

/**
 * Get historical sales for Square — average by day of week + hour.
 * Looks back 4 weeks to build the pattern.
 *
 * @param {string} clientSlug
 * @param {number} dayOfWeek — 0=Sunday, 6=Saturday
 * @param {number} hour — 0–23
 * @returns {number} average revenue for that hour on that day of week
 */
async function getHistoricalSales(clientSlug, dayOfWeek, hour) {
    const conn   = await getConnection(clientSlug);
    const client = squareClient(clientSlug, conn);

    // Get last 4 matching weekdays
    const targetDates = [];
    let cursor = dayjs();
    while (targetDates.length < 4) {
        cursor = cursor.subtract(1, 'day');
        if (cursor.day() === dayOfWeek) {
            targetDates.push(cursor.format('YYYY-MM-DD'));
        }
    }

    const hourlyTotals = [];

    for (const date of targetDates) {
        const startAt = `${date}T${String(hour).padStart(2, '0')}:00:00.000Z`;
        const endAt   = `${date}T${String(hour).padStart(2, '0')}:59:59.000Z`;

        try {
            const resp = await client.post('/orders/search', {
                location_ids: [conn.square_location_id],
                query: {
                    filter: {
                        date_time_filter: {
                            created_at: { start_at: startAt, end_at: endAt },
                        },
                        state_filter: { states: ['COMPLETED'] },
                    },
                },
            });

            const orders = resp.data.orders || [];
            const total  = orders.reduce((sum, o) => {
                return sum + (o.total_money?.amount || 0) / 100; // Square amounts are in cents
            }, 0);

            if (orders.length > 0 || total > 0) {
                hourlyTotals.push(total);
            }
        } catch (err) {
            console.warn(`[pos] Square historical lookup failed for ${date} hour ${hour}: ${err.message}`);
        }
    }

    if (hourlyTotals.length === 0) return 0;
    const avg = hourlyTotals.reduce((a, b) => a + b, 0) / hourlyTotals.length;
    return parseFloat(avg.toFixed(2));
}

/**
 * Get actual sales for a date from Square (for labor cost calculation).
 */
async function getSquareActualSales(clientSlug, date) {
    const conn   = await getConnection(clientSlug);
    const client = squareClient(clientSlug, conn);

    const startAt = `${dayjs(date).format('YYYY-MM-DD')}T00:00:00.000Z`;
    const endAt   = `${dayjs(date).format('YYYY-MM-DD')}T23:59:59.000Z`;

    const resp = await client.post('/orders/search', {
        location_ids: [conn.square_location_id],
        query: {
            filter: {
                date_time_filter: {
                    created_at: { start_at: startAt, end_at: endAt },
                },
                state_filter: { states: ['COMPLETED'] },
            },
        },
    });

    const orders     = resp.data.orders || [];
    let totalRevenue = 0;
    const byHour     = {};

    for (const order of orders) {
        const amount = (order.total_money?.amount || 0) / 100;
        totalRevenue += amount;

        const createdAt = order.created_at;
        if (createdAt) {
            const hour = dayjs(createdAt).hour();
            byHour[hour] = (byHour[hour] || 0) + amount;
        }
    }

    return { totalRevenue: parseFloat(totalRevenue.toFixed(2)), byHour };
}

// ─── Unified Public Interface ─────────────────────────────────────────────────

/**
 * Get projected hourly sales pattern for a date.
 * Used by the optimizer to recommend staffing levels per hour.
 *
 * @returns {Object} { hourlyPattern: {0: revenue, 1: revenue, ...}, totalProjected }
 */
async function getHourlySalesPattern(clientSlug, date) {
    const conn      = await getConnection(clientSlug);
    const dayOfWeek = dayjs(date).day();

    const hourlyPattern = {};
    let totalProjected  = 0;

    if (conn.active_pos_system === 'square') {
        for (let hour = 6; hour <= 23; hour++) {
            const avg = await getHistoricalSales(clientSlug, dayOfWeek, hour);
            hourlyPattern[hour] = avg;
            totalProjected += avg;
        }
    } else {
        // Toast: use single-day projection, then distribute by typical pattern
        const dayTotal = await getProjectedSales(clientSlug, date);
        totalProjected = dayTotal;

        // Typical restaurant revenue distribution across hours
        const distribution = {
            6: 0.01, 7: 0.03, 8: 0.05, 9: 0.04, 10: 0.03,
            11: 0.08, 12: 0.10, 13: 0.09, 14: 0.05, 15: 0.03,
            16: 0.03, 17: 0.06, 18: 0.10, 19: 0.12, 20: 0.10,
            21: 0.05, 22: 0.03, 23: 0.01,
        };
        for (const [hour, pct] of Object.entries(distribution)) {
            hourlyPattern[parseInt(hour)] = parseFloat((dayTotal * pct).toFixed(2));
        }
    }

    return {
        hourlyPattern,
        totalProjected: parseFloat(totalProjected.toFixed(2)),
    };
}

/**
 * Get actual labor cost percentage for a date.
 * Requires both labor data (from scheduling.js) and actual POS revenue.
 *
 * @param {string} clientSlug
 * @param {string} date — YYYY-MM-DD
 * @param {number} actualLaborCost — total dollars spent on labor
 * @returns {number} labor cost as a decimal percentage (e.g. 0.28 for 28%)
 */
async function getLaborCostPercentage(clientSlug, date, actualLaborCost) {
    const conn = await getConnection(clientSlug);

    let totalRevenue = 0;

    try {
        if (conn.active_pos_system === 'square') {
            const result = await getSquareActualSales(clientSlug, date);
            totalRevenue = result.totalRevenue;
        } else {
            const result = await getToastActualSales(clientSlug, date);
            totalRevenue = result.totalRevenue;
        }
    } catch (err) {
        console.warn(`[pos] getLaborCostPercentage revenue lookup failed: ${err.message}`);
        return 0;
    }

    if (totalRevenue === 0) return 0;
    return parseFloat((actualLaborCost / totalRevenue).toFixed(4));
}

module.exports = {
    // Toast
    getProjectedSales,
    getToastActualSales,

    // Square
    getHistoricalSales,
    getSquareActualSales,

    // Unified
    getHourlySalesPattern,
    getLaborCostPercentage,
};
