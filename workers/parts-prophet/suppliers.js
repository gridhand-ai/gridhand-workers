/**
 * GRIDHAND Parts Prophet — WorldPac + AutoZone Supplier API Integration
 *
 * WorldPac SpeedDial API: https://speeddialonline.com / B2B API
 * AutoZone Pro API: https://www.autozone.com/commercial/api
 *
 * Both APIs return availability, price, and ETA for parts lookup.
 * This module handles price comparison and (optionally) order placement.
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');

const WORLDPAC_BASE = 'https://api.speeddialonline.com/v2';
const AUTOZONE_BASE = 'https://api.autozonepro.com/v1';

// ─── WorldPac ─────────────────────────────────────────────────────────────────

function worldpacHeaders(conn) {
    return {
        'Authorization': `Bearer ${conn.worldpac_api_key}`,
        'X-Account-ID':  conn.worldpac_account_id,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
    };
}

async function getWorldpacPrice(conn, part) {
    if (!conn.worldpac_api_key) return null;

    try {
        const { data } = await axios.get(`${WORLDPAC_BASE}/parts/availability`, {
            headers: worldpacHeaders(conn),
            params: {
                part_number:  part.partNumber,
                year:         part.vehicleYear,
                make:         part.vehicleMake,
                model:        part.vehicleModel,
                engine:       part.vehicleEngine,
                quantity:     part.quantityNeeded || 1,
            },
        });

        const result = data.parts?.[0] || data;
        if (!result || !result.price) return null;

        return {
            price:     parseFloat(result.price),
            available: result.available ?? result.in_stock ?? true,
            eta:       result.eta || result.delivery_date || 'Next day',
            warehouseId: result.warehouse_id || null,
        };
    } catch (err) {
        console.warn(`[WorldPac] Price lookup failed for ${part.partNumber}: ${err.message}`);
        return null;
    }
}

async function placeWorldpacOrder(conn, lineItems) {
    const { data } = await axios.post(`${WORLDPAC_BASE}/orders`, {
        account_id: conn.worldpac_account_id,
        parts: lineItems.map(item => ({
            part_number: item.partNumber,
            quantity:    item.quantity,
        })),
    }, { headers: worldpacHeaders(conn) });

    return {
        orderId:      data.order_id || data.id,
        deliveryDate: data.delivery_date || dayjs().add(1, 'day').format('YYYY-MM-DD'),
        totalCost:    data.total || null,
    };
}

// ─── AutoZone Pro ─────────────────────────────────────────────────────────────

function autozoneHeaders(conn) {
    return {
        'Authorization': `Bearer ${conn.autozone_api_key}`,
        'X-Account-ID':  conn.autozone_account_id,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
    };
}

async function getAutozonePrice(conn, part) {
    if (!conn.autozone_api_key) return null;

    try {
        const { data } = await axios.get(`${AUTOZONE_BASE}/catalog/parts/price`, {
            headers: autozoneHeaders(conn),
            params: {
                partNumber: part.partNumber,
                year:       part.vehicleYear,
                make:       part.vehicleMake,
                model:      part.vehicleModel,
                quantity:   part.quantityNeeded || 1,
            },
        });

        const result = data.part || data;
        if (!result || !result.price) return null;

        return {
            price:     parseFloat(result.price),
            available: result.available ?? result.inStock ?? true,
            eta:       result.eta || 'Same day / Next day',
        };
    } catch (err) {
        console.warn(`[AutoZone] Price lookup failed for ${part.partNumber}: ${err.message}`);
        return null;
    }
}

async function placeAutozoneOrder(conn, lineItems) {
    const { data } = await axios.post(`${AUTOZONE_BASE}/orders`, {
        accountId: conn.autozone_account_id,
        lineItems: lineItems.map(item => ({
            partNumber: item.partNumber,
            quantity:   item.quantity,
        })),
    }, { headers: autozoneHeaders(conn) });

    return {
        orderId:      data.orderId || data.id,
        deliveryDate: data.deliveryDate || dayjs().add(1, 'day').format('YYYY-MM-DD'),
        totalCost:    data.totalCost || null,
    };
}

// ─── Compare Prices Across Both Suppliers ─────────────────────────────────────

async function comparePrices(conn, part) {
    const [worldpac, autozone] = await Promise.all([
        getWorldpacPrice(conn, part),
        getAutozonePrice(conn, part),
    ]);

    // Determine best available supplier
    let bestSupplier = null;
    let savings = 0;

    if (worldpac?.available && autozone?.available) {
        bestSupplier = worldpac.price <= autozone.price ? 'worldpac' : 'autozone';
        savings = Math.abs(worldpac.price - autozone.price) * (part.quantityNeeded || 1);
    } else if (worldpac?.available) {
        bestSupplier = 'worldpac';
    } else if (autozone?.available) {
        bestSupplier = 'autozone';
    }

    // Respect preferred supplier if both are available and close in price (<10% diff)
    if (bestSupplier && worldpac?.available && autozone?.available) {
        const priceDiff = Math.abs(worldpac.price - autozone.price);
        const avgPrice  = (worldpac.price + autozone.price) / 2;
        if (priceDiff / avgPrice < 0.10 && conn.preferred_supplier !== 'cheapest') {
            bestSupplier = conn.preferred_supplier || 'worldpac';
        }
    }

    return {
        partNumber:         part.partNumber,
        partDescription:    part.partDescription,
        vehicleYear:        part.vehicleYear,
        vehicleMake:        part.vehicleMake,
        vehicleModel:       part.vehicleModel,
        worldpacPrice:      worldpac?.price || null,
        worldpacAvailable:  worldpac?.available || false,
        worldpacEta:        worldpac?.eta || null,
        autozonePrice:      autozone?.price || null,
        autozoneAvailable:  autozone?.available || false,
        autozoneEta:        autozone?.eta || null,
        bestSupplier,
        bestPrice: bestSupplier === 'worldpac' ? worldpac?.price : autozone?.price,
        savingsVsWorst: savings || null,
    };
}

// ─── Place Order with Best Supplier ──────────────────────────────────────────

async function placeOrder(conn, supplier, lineItems) {
    if (supplier === 'worldpac') {
        return placeWorldpacOrder(conn, lineItems);
    }
    if (supplier === 'autozone') {
        return placeAutozoneOrder(conn, lineItems);
    }
    throw new Error(`Unknown supplier: ${supplier}`);
}

module.exports = {
    comparePrices,
    placeOrder,
};
