/**
 * GRIDHAND Rent Collector — Buildium API Integration
 *
 * Buildium uses OAuth 2.0 client credentials flow.
 * Fetches leases, tenants, and payment transactions.
 * Docs: https://developer.buildium.com/
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');
const db    = require('./db');

const BUILDIUM_BASE      = 'https://api.buildium.com/v1';
const BUILDIUM_TOKEN_URL = 'https://id.buildium.com/connect/token';

// ─── OAuth ────────────────────────────────────────────────────────────────────

async function getAccessToken(clientSlug) {
    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    // Check if existing token is still valid
    if (conn.buildium_access_token && conn.buildium_expires_at) {
        if (Date.now() < new Date(conn.buildium_expires_at).getTime() - 60000) {
            return conn.buildium_access_token;
        }
    }

    // Request new token via client credentials
    const resp = await axios.post(BUILDIUM_TOKEN_URL,
        `grant_type=client_credentials&client_id=${encodeURIComponent(conn.buildium_client_id)}&client_secret=${encodeURIComponent(conn.buildium_client_secret)}&scope=accounting:read leases:read`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, expires_in } = resp.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    await db.updateBuildiumTokens(clientSlug, {
        accessToken:  access_token,
        refreshToken: null,
        expiresAt,
    });

    return access_token;
}

async function buildiumGet(clientSlug, path, params = {}) {
    const token = await getAccessToken(clientSlug);
    const resp = await axios.get(`${BUILDIUM_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        params,
    });
    return resp.data;
}

// ─── Leases ───────────────────────────────────────────────────────────────────

/**
 * Get all active leases with tenant + rent details.
 */
async function getActiveLeases(clientSlug) {
    try {
        const leases = await buildiumGet(clientSlug, '/leases', {
            status: 'Active',
            limit:  500,
        });

        return (leases || []).map(l => ({
            buildiumLeaseId: String(l.Id),
            tenantId:        l.Tenants?.[0]?.Id ? String(l.Tenants[0].Id) : null,
            tenantName:      l.Tenants?.[0]?.DisplayName || 'Unknown Tenant',
            tenantPhone:     l.Tenants?.[0]?.PhoneNumbers?.find(p => p.Type === 'Cell')?.Number
                          || l.Tenants?.[0]?.PhoneNumbers?.[0]?.Number || null,
            tenantEmail:     l.Tenants?.[0]?.Email || null,
            propertyAddress: l.Unit?.Address?.AddressLine1 || null,
            unitNumber:      l.Unit?.UnitNumber || null,
            rentAmount:      parseFloat(l.Rent || l.MonthlyRent || 0),
            dueDay:          l.RentDueDay || 1,
            leaseStart:      l.LeaseFrom ? dayjs(l.LeaseFrom).format('YYYY-MM-DD') : null,
            leaseEnd:        l.LeaseTo   ? dayjs(l.LeaseTo).format('YYYY-MM-DD')   : null,
        })).filter(l => l.rentAmount > 0);
    } catch (err) {
        console.warn(`[Buildium] Leases fetch failed: ${err.message}`);
        return [];
    }
}

/**
 * Get payment transactions for a specific lease in a given month.
 */
async function getLeasePayments(clientSlug, leaseId, month) {
    const startDate = dayjs(month, 'YYYY-MM').startOf('month').format('YYYY-MM-DD');
    const endDate   = dayjs(month, 'YYYY-MM').endOf('month').format('YYYY-MM-DD');

    try {
        const transactions = await buildiumGet(clientSlug, `/leases/${leaseId}/transactions`, {
            transactiondatefrom: startDate,
            transactiondateto:   endDate,
            limit:               100,
        });

        const payments = (transactions || []).filter(t =>
            (t.Type || '').toLowerCase() === 'payment'
        );

        const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.TotalAmount || 0), 0);
        const latestPayment = payments.sort((a, b) => new Date(b.Date) - new Date(a.Date))[0];

        return {
            totalPaid,
            paidAt:  latestPayment?.Date ? new Date(latestPayment.Date).toISOString() : null,
            payments,
        };
    } catch (err) {
        console.warn(`[Buildium] Payments fetch failed for lease ${leaseId}: ${err.message}`);
        return { totalPaid: 0, paidAt: null, payments: [] };
    }
}

module.exports = {
    getActiveLeases,
    getLeasePayments,
};
