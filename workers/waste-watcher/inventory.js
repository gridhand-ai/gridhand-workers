/**
 * GRIDHAND Waste Watcher — Inventory Integration
 *
 * Handles MarketMan and BlueCart inventory API integrations.
 * Provides a unified interface for reading inventory state,
 * detecting low stock, expiring items, and persisting snapshots.
 *
 * MarketMan API base: https://app.marketman.com/api/v3/
 * BlueCart API base:  https://api.bluecart.com/v1/
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

// ─── In-memory credential cache ───────────────────────────────────────────────
// Avoids repeated DB lookups per request within the same process.

const _mmCredentials  = new Map(); // clientSlug → { apiKey, apiGuid }
const _bcCredentials  = new Map(); // clientSlug → { apiKey }

// ─── Credential Setters ───────────────────────────────────────────────────────

function setMarketManCredentials(clientSlug, apiKey, apiGuid) {
    if (!apiKey || !apiGuid) throw new Error(`MarketMan credentials incomplete for ${clientSlug}`);
    _mmCredentials.set(clientSlug, { apiKey, apiGuid });
}

function setBlueCartKey(clientSlug, apiKey) {
    if (!apiKey) throw new Error(`BlueCart API key missing for ${clientSlug}`);
    _bcCredentials.set(clientSlug, { apiKey });
}

// ─── Credential Loaders ───────────────────────────────────────────────────────
// Load from DB if not cached, then cache.

async function _loadMMCredentials(clientSlug) {
    if (_mmCredentials.has(clientSlug)) return _mmCredentials.get(clientSlug);

    const { data, error } = await supabase
        .from('watcher_connections')
        .select('marketman_api_key, marketman_guid')
        .eq('client_slug', clientSlug)
        .single();

    if (error || !data) throw new Error(`No MarketMan credentials found for ${clientSlug}`);
    if (!data.marketman_api_key || !data.marketman_guid) {
        throw new Error(`MarketMan credentials incomplete for ${clientSlug}`);
    }

    const creds = { apiKey: data.marketman_api_key, apiGuid: data.marketman_guid };
    _mmCredentials.set(clientSlug, creds);
    return creds;
}

async function _loadBCCredentials(clientSlug) {
    if (_bcCredentials.has(clientSlug)) return _bcCredentials.get(clientSlug);

    const { data, error } = await supabase
        .from('watcher_connections')
        .select('bluecart_api_key')
        .eq('client_slug', clientSlug)
        .single();

    if (error || !data) throw new Error(`No BlueCart credentials found for ${clientSlug}`);
    if (!data.bluecart_api_key) throw new Error(`BlueCart API key missing for ${clientSlug}`);

    const creds = { apiKey: data.bluecart_api_key };
    _bcCredentials.set(clientSlug, creds);
    return creds;
}

async function _getActiveInventorySystem(clientSlug) {
    const { data, error } = await supabase
        .from('watcher_connections')
        .select('active_inventory_system')
        .eq('client_slug', clientSlug)
        .single();

    if (error || !data) throw new Error(`No connection found for ${clientSlug}`);
    return data.active_inventory_system || 'marketman';
}

// ─── MarketMan API Helpers ────────────────────────────────────────────────────

function _mmHeaders(creds) {
    return {
        'Content-Type': 'application/json',
        'api_key':      creds.apiKey,
        'guid':         creds.apiGuid,
    };
}

const MM_BASE = 'https://app.marketman.com/api/v3';

/**
 * Fetch all inventory items from MarketMan with current qty, unit, par level.
 * Returns a normalized array of inventory item objects.
 */
async function getInventoryItems(clientSlug) {
    const creds = await _loadMMCredentials(clientSlug);

    let response;
    try {
        response = await axios.get(`${MM_BASE}/items`, {
            headers: _mmHeaders(creds),
            timeout: 15000,
        });
    } catch (err) {
        const status = err.response?.status;
        throw new Error(`MarketMan getInventoryItems failed for ${clientSlug}: ${status} ${err.message}`);
    }

    const raw = response.data?.Items || response.data?.items || [];

    return raw.map(item => ({
        externalItemId:  String(item.ItemID || item.id || ''),
        itemName:        item.Name || item.name || 'Unknown Item',
        category:        item.Category || item.category || null,
        currentQty:      parseFloat(item.Quantity ?? item.quantity ?? 0),
        unit:            item.Unit || item.unit || 'each',
        parLevel:        parseFloat(item.PAR ?? item.par_level ?? 0) || null,
        unitCost:        parseFloat(item.UnitCost ?? item.unit_cost ?? 0),
        expiryDate:      item.ExpiryDate || item.expiry_date || null,
        storageLocation: item.StorageLocation || item.storage_location || null,
    }));
}

/**
 * Fetch items expiring within N days from MarketMan.
 */
async function getExpiringItems(clientSlug, days = 3) {
    const items = await getInventoryItems(clientSlug);
    const cutoff = dayjs().add(days, 'day').format('YYYY-MM-DD');

    return items.filter(item => {
        if (!item.expiryDate) return false;
        return dayjs(item.expiryDate).isBefore(cutoff) || dayjs(item.expiryDate).isSame(cutoff, 'day');
    });
}

/**
 * Update the inventory count for a single item in MarketMan.
 */
async function updateInventoryCount(clientSlug, itemId, qty) {
    const creds = await _loadMMCredentials(clientSlug);

    try {
        await axios.post(`${MM_BASE}/items/update`, {
            ItemID:   itemId,
            Quantity: qty,
        }, {
            headers: _mmHeaders(creds),
            timeout: 10000,
        });
    } catch (err) {
        throw new Error(`MarketMan updateInventoryCount failed for ${clientSlug} item ${itemId}: ${err.message}`);
    }
}

/**
 * Fetch recent order history from MarketMan for cost baseline.
 * Returns array of order objects with date, items, and total cost.
 */
async function getOrderHistory(clientSlug, days = 30) {
    const creds = await _loadMMCredentials(clientSlug);
    const startDate = dayjs().subtract(days, 'day').format('YYYY-MM-DD');

    let response;
    try {
        response = await axios.get(`${MM_BASE}/orders`, {
            headers: _mmHeaders(creds),
            params: { from_date: startDate },
            timeout: 15000,
        });
    } catch (err) {
        throw new Error(`MarketMan getOrderHistory failed for ${clientSlug}: ${err.message}`);
    }

    const raw = response.data?.Orders || response.data?.orders || [];

    return raw.map(order => ({
        orderId:    String(order.OrderID || order.id || ''),
        orderDate:  order.OrderDate || order.date || null,
        supplier:   order.SupplierName || order.supplier_name || null,
        totalCost:  parseFloat(order.TotalCost ?? order.total_cost ?? 0),
        status:     order.Status || order.status || 'unknown',
        items: (order.Items || order.items || []).map(i => ({
            itemName: i.Name || i.name || '',
            qty:      parseFloat(i.Quantity ?? i.quantity ?? 0),
            unitCost: parseFloat(i.UnitCost ?? i.unit_cost ?? 0),
        })),
    }));
}

// ─── BlueCart API Helpers ─────────────────────────────────────────────────────

const BC_BASE = 'https://api.bluecart.com/v1';

function _bcHeaders(creds) {
    return {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${creds.apiKey}`,
    };
}

/**
 * Fetch inventory from BlueCart.
 */
async function getInventory(clientSlug) {
    const creds = await _loadBCCredentials(clientSlug);

    let response;
    try {
        response = await axios.get(`${BC_BASE}/inventory`, {
            headers: _bcHeaders(creds),
            timeout: 15000,
        });
    } catch (err) {
        throw new Error(`BlueCart getInventory failed for ${clientSlug}: ${err.message}`);
    }

    const raw = response.data?.inventory || response.data?.items || [];

    return raw.map(item => ({
        externalItemId:  String(item.id || ''),
        itemName:        item.name || item.product_name || 'Unknown Item',
        category:        item.category || null,
        currentQty:      parseFloat(item.quantity ?? item.qty ?? 0),
        unit:            item.unit || 'each',
        parLevel:        parseFloat(item.par_level ?? 0) || null,
        unitCost:        parseFloat(item.unit_cost ?? item.price ?? 0),
        expiryDate:      item.expiry_date || item.expiration_date || null,
        storageLocation: item.location || item.storage_location || null,
    }));
}

/**
 * Fetch orders from BlueCart within a date range.
 */
async function getOrders(clientSlug, startDate, endDate) {
    const creds = await _loadBCCredentials(clientSlug);

    const start = startDate || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
    const end   = endDate   || dayjs().format('YYYY-MM-DD');

    let response;
    try {
        response = await axios.get(`${BC_BASE}/orders`, {
            headers: _bcHeaders(creds),
            params:  { start_date: start, end_date: end },
            timeout: 15000,
        });
    } catch (err) {
        throw new Error(`BlueCart getOrders failed for ${clientSlug}: ${err.message}`);
    }

    return response.data?.orders || [];
}

// ─── Unified Inventory Read ────────────────────────────────────────────────────

/**
 * Get inventory for a client, routing to the correct system.
 * Returns normalized item array.
 */
async function getInventoryForClient(clientSlug) {
    const system = await _getActiveInventorySystem(clientSlug);
    if (system === 'bluecart') return getInventory(clientSlug);
    return getInventoryItems(clientSlug);
}

// ─── Database Operations ──────────────────────────────────────────────────────

/**
 * Upsert all inventory items to the DB for a client.
 * Preserves par levels if not included in the API response.
 */
async function saveInventorySnapshot(clientSlug, items) {
    if (!items || items.length === 0) return;

    // Upsert each item
    const rows = items.map(item => ({
        client_slug:      clientSlug,
        external_item_id: item.externalItemId,
        item_name:        item.itemName,
        category:         item.category || null,
        current_qty:      item.currentQty,
        unit:             item.unit,
        par_level:        item.parLevel   || null,
        unit_cost:        item.unitCost   || 0,
        expiry_date:      item.expiryDate || null,
        storage_location: item.storageLocation || null,
        updated_at:       new Date().toISOString(),
    }));

    const { error } = await supabase
        .from('inventory_items')
        .upsert(rows, { onConflict: 'client_slug,external_item_id' });

    if (error) throw new Error(`saveInventorySnapshot failed: ${error.message}`);

    // Calculate snapshot summary
    const lowStockItems   = detectLowStock(items, items.map(i => ({ id: i.externalItemId, par: i.parLevel })));
    const expiringItems   = detectExpiringItems(items);
    const totalValue      = items.reduce((sum, i) => sum + (i.currentQty * i.unitCost), 0);

    const snapshot = {
        client_slug:           clientSlug,
        snapshot_date:         dayjs().format('YYYY-MM-DD'),
        total_items:           items.length,
        low_stock_count:       lowStockItems.length,
        expiring_count:        expiringItems.length,
        total_inventory_value: parseFloat(totalValue.toFixed(2)),
    };

    const { error: snapError } = await supabase
        .from('inventory_snapshots')
        .upsert(snapshot, { onConflict: 'client_slug,snapshot_date' });

    if (snapError) throw new Error(`saveInventorySnapshot (summary) failed: ${snapError.message}`);

    console.log(`[Inventory] Saved snapshot for ${clientSlug}: ${items.length} items, $${totalValue.toFixed(2)} total value`);
    return snapshot;
}

/**
 * Get current inventory items from DB for a client.
 */
async function getStoredInventory(clientSlug) {
    const { data, error } = await supabase
        .from('inventory_items')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('item_name', { ascending: true });

    if (error) throw new Error(`getStoredInventory failed: ${error.message}`);
    return data || [];
}

/**
 * Get the N most recent inventory snapshots for a client.
 */
async function getRecentSnapshots(clientSlug, limit = 14) {
    const { data, error } = await supabase
        .from('inventory_snapshots')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('snapshot_date', { ascending: false })
        .limit(limit);

    if (error) throw new Error(`getRecentSnapshots failed: ${error.message}`);
    return data || [];
}

// ─── Analysis Functions ───────────────────────────────────────────────────────

/**
 * Returns items whose current quantity is below their par level.
 * @param {Array} items - normalized inventory items
 * @returns {Array} items with par level defined that are below it
 */
function detectLowStock(items) {
    return items.filter(item => {
        if (item.parLevel === null || item.parLevel === undefined) return false;
        return item.currentQty < item.parLevel;
    }).map(item => ({
        ...item,
        deficit: parseFloat((item.parLevel - item.currentQty).toFixed(3)),
    }));
}

/**
 * Returns items expiring within 3 days (inclusive of today and the cutoff day).
 * @param {Array} items - normalized inventory items
 * @returns {Array} items expiring soon, sorted by expiry date ascending
 */
function detectExpiringItems(items) {
    const cutoff = dayjs().add(3, 'day');

    return items
        .filter(item => {
            if (!item.expiryDate) return false;
            const expiry = dayjs(item.expiryDate);
            return expiry.isBefore(cutoff) || expiry.isSame(cutoff, 'day');
        })
        .map(item => {
            const daysUntilExpiry = dayjs(item.expiryDate).diff(dayjs(), 'day');
            return { ...item, daysUntilExpiry };
        })
        .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    // MarketMan
    setMarketManCredentials,
    getInventoryItems,
    getExpiringItems,
    updateInventoryCount,
    getOrderHistory,

    // BlueCart
    setBlueCartKey,
    getInventory,
    getOrders,

    // Unified
    getInventoryForClient,

    // Database
    saveInventorySnapshot,
    getStoredInventory,
    getRecentSnapshots,

    // Analysis
    detectLowStock,
    detectExpiringItems,
};
