/**
 * GRIDHAND Refill Runner — Vetsource Pharmacy API Integration
 *
 * Handles all communication with Vetsource online pharmacy:
 * submitting refill orders, checking order status, listing available products.
 * conn: row from vet_refill_connections table
 */

'use strict';

const axios = require('axios');

const VETSOURCE_BASE = 'https://api.vetsource.com/v1';

/**
 * Build an authenticated Axios instance for Vetsource.
 */
function makeClient(conn) {
    const apiKey     = conn.vetsource_api_key     || process.env.VETSOURCE_API_KEY;
    const practiceId = conn.vetsource_practice_id || process.env.VETSOURCE_PRACTICE_ID;

    if (!apiKey || !practiceId) {
        throw new Error('Vetsource credentials (vetsource_api_key, vetsource_practice_id) are required');
    }

    return axios.create({
        baseURL: VETSOURCE_BASE,
        headers: {
            'Authorization':    `Bearer ${apiKey}`,
            'X-Practice-ID':    practiceId,
            'Content-Type':     'application/json',
            'Accept':           'application/json',
        },
        timeout: 20000,
    });
}

/**
 * Submit a refill order to Vetsource.
 *
 * { patientId, prescriptionId, quantity }
 *
 * Returns:
 * { orderId, trackingUrl, estimatedDelivery }
 */
async function submitRefillOrder(conn, { patientId, prescriptionId, quantity }) {
    const client     = makeClient(conn);
    const practiceId = conn.vetsource_practice_id || process.env.VETSOURCE_PRACTICE_ID;

    try {
        const response = await client.post('/orders', {
            practice_id:     practiceId,
            patient_id:      patientId,
            prescription_id: prescriptionId,
            quantity:        quantity || 1,
            source:          'gridhand_refill_runner',
            auto_refill:     false, // each refill is explicitly requested
        });

        const order = response.data?.order || response.data;

        return {
            orderId:           String(order.id || order.order_id || ''),
            trackingUrl:       order.tracking_url || order.track_url || null,
            estimatedDelivery: order.estimated_delivery || order.delivery_estimate || null,
            status:            order.status || 'submitted',
        };
    } catch (err) {
        console.error(`[Vetsource] submitRefillOrder(Rx ${prescriptionId}) failed: ${err.message}`);
        // Rethrow so jobs.js can catch and handle with SMS fallback
        throw err;
    }
}

/**
 * Get the current status of a Vetsource order.
 *
 * Returns:
 * { orderId, status, trackingUrl, estimatedDelivery, updatedAt }
 */
async function getOrderStatus(conn, orderId) {
    const client = makeClient(conn);

    try {
        const response = await client.get(`/orders/${orderId}`);
        const order    = response.data?.order || response.data;

        return {
            orderId:           String(order.id || order.order_id || orderId),
            status:            order.status || 'unknown',
            trackingUrl:       order.tracking_url || null,
            estimatedDelivery: order.estimated_delivery || null,
            updatedAt:         order.updated_at || null,
        };
    } catch (err) {
        console.error(`[Vetsource] getOrderStatus(${orderId}) failed: ${err.message}`);
        throw err;
    }
}

/**
 * List available medications/products for this practice on Vetsource.
 *
 * Useful for verifying a medication is available before submitting an order.
 *
 * Returns:
 * [{ id, name, genericName, strength, form, inStock }]
 */
async function getPracticeProducts(conn) {
    const client     = makeClient(conn);
    const practiceId = conn.vetsource_practice_id || process.env.VETSOURCE_PRACTICE_ID;

    try {
        const response = await client.get(`/practices/${practiceId}/products`, {
            params: { limit: 500, status: 'active' },
        });

        const raw = response.data?.products || response.data?.data || [];

        return raw.map((p) => ({
            id:          String(p.id || p.product_id),
            name:        p.name || p.product_name || '',
            genericName: p.generic_name || '',
            strength:    p.strength || p.dosage || '',
            form:        p.form || p.product_form || '',
            inStock:     p.in_stock !== false && p.available !== false,
        }));
    } catch (err) {
        console.error(`[Vetsource] getPracticeProducts failed: ${err.message}`);
        throw err;
    }
}

module.exports = {
    submitRefillOrder,
    getOrderStatus,
    getPracticeProducts,
};
