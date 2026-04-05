/**
 * GRIDHAND Parts Prophet — Tekmetric API Integration
 *
 * Fetches tomorrow's scheduled jobs and their associated parts/labor from Tekmetric.
 *
 * Tekmetric API v1 docs: https://tekmetric.com/api
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');

const TEKMETRIC_BASE = 'https://sandbox.tekmetric.com/api/v1';
// Production: 'https://shop.tekmetric.com/api/v1'

function buildHeaders(conn) {
    return {
        'Authorization': `Bearer ${conn.tekmetric_api_key}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
    };
}

// ─── Get Tomorrow's Appointments + Required Parts ─────────────────────────────

async function getTomorrowsJobsWithParts(clientSlug, conn, targetDate = null) {
    const date = targetDate || dayjs().add(1, 'day').format('YYYY-MM-DD');

    try {
        // Step 1: Fetch repair orders for tomorrow
        const { data: roData } = await axios.get(`${TEKMETRIC_BASE}/repair-orders`, {
            headers: buildHeaders(conn),
            params: {
                shop_id:          conn.tekmetric_shop_id,
                appointment_date: date,
                status:           'scheduled',
                limit:            100,
            },
        });

        const repairOrders = roData.content || roData.repairOrders || [];

        if (repairOrders.length === 0) {
            console.log(`[Tekmetric] No scheduled jobs for ${date} at ${clientSlug}`);
            return [];
        }

        // Step 2: For each RO, get the parts required
        const jobsWithParts = [];

        for (const ro of repairOrders) {
            const parts = await getROParts(conn, ro.id);

            if (parts.length > 0) {
                jobsWithParts.push({
                    tekmetricJobId: String(ro.id),
                    roNumber:       ro.repairOrderNumber || String(ro.id),
                    appointmentDate: date,
                    vehicleYear:    ro.vehicle?.year || null,
                    vehicleMake:    ro.vehicle?.make || null,
                    vehicleModel:   ro.vehicle?.model || null,
                    vehicleEngine:  ro.vehicle?.engine || null,
                    vin:            ro.vehicle?.vin || null,
                    customerName:   `${ro.customer?.firstName || ''} ${ro.customer?.lastName || ''}`.trim(),
                    parts,
                });
            }
        }

        return jobsWithParts;
    } catch (err) {
        console.error(`[Tekmetric] getTomorrowsJobsWithParts error for ${clientSlug}: ${err.message}`);
        throw err;
    }
}

async function getROParts(conn, repairOrderId) {
    try {
        const { data } = await axios.get(`${TEKMETRIC_BASE}/repair-orders/${repairOrderId}/parts`, {
            headers: buildHeaders(conn),
        });

        const parts = data.content || data.parts || [];

        return parts.map(p => ({
            partNumber:      p.partNumber || p.number || '',
            partDescription: p.name || p.description || 'Unknown Part',
            quantityNeeded:  p.quantity || 1,
            unitCost:        p.unitCost || null,
        })).filter(p => p.partNumber); // Only include parts with a real part number
    } catch (err) {
        console.error(`[Tekmetric] getROParts error for RO ${repairOrderId}: ${err.message}`);
        return []; // Don't fail the whole scan for one bad RO
    }
}

module.exports = {
    getTomorrowsJobsWithParts,
};
