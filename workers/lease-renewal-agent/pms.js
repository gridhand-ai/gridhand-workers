/**
 * GRIDHAND Lease Renewal Agent — PMS Integration (AppFolio + Buildium)
 *
 * Fetches leases expiring within a given window from either AppFolio or Buildium.
 * Normalizes output to a single format regardless of PMS.
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');
const db    = require('./db');

// ─── AppFolio ─────────────────────────────────────────────────────────────────

function appfolioHeaders(username, password) {
    const creds = Buffer.from(`${username}:${password}`).toString('base64');
    return { Authorization: `Basic ${creds}`, Accept: 'application/json' };
}

async function getAppFolioExpiringLeases(conn, withinDays = 60) {
    const base    = `https://${conn.appfolio_database_name}.appfolio.com/api/v1`;
    const endDate = dayjs().add(withinDays, 'day').format('YYYY-MM-DD');

    try {
        const resp = await axios.get(`${base}/leases`, {
            headers: appfolioHeaders(conn.appfolio_api_username, conn.appfolio_api_password),
            params: { status: 'Active', lease_to_before: endDate, per_page: 200 },
        });

        return (resp.data?.results || resp.data || []).map(l => ({
            pmsLeaseId:      String(l.id),
            tenantName:      l.tenant?.name || 'Unknown Tenant',
            tenantEmail:     l.tenant?.email || null,
            tenantPhone:     l.tenant?.phone || null,
            propertyAddress: l.property?.address || null,
            unitNumber:      l.unit?.number || null,
            currentRent:     parseFloat(l.rent || l.monthly_rent || 0),
            leaseEndDate:    l.lease_to ? dayjs(l.lease_to).format('YYYY-MM-DD') : null,
        })).filter(l => l.leaseEndDate && l.currentRent > 0);
    } catch (err) {
        console.warn(`[AppFolio] Expiring leases fetch failed: ${err.message}`);
        return [];
    }
}

// ─── Buildium ─────────────────────────────────────────────────────────────────

async function getBuildiumToken(clientSlug, conn) {
    if (conn.buildium_access_token && conn.buildium_expires_at) {
        if (Date.now() < new Date(conn.buildium_expires_at).getTime() - 60000) {
            return conn.buildium_access_token;
        }
    }

    const resp = await axios.post('https://id.buildium.com/connect/token',
        `grant_type=client_credentials&client_id=${encodeURIComponent(conn.buildium_client_id)}&client_secret=${encodeURIComponent(conn.buildium_client_secret)}&scope=leases:read`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, expires_in } = resp.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
    await db.updateBuildiumTokens(clientSlug, { accessToken: access_token, expiresAt });
    return access_token;
}

async function getBuildiumExpiringLeases(clientSlug, conn, withinDays = 60) {
    const endDate = dayjs().add(withinDays, 'day').format('YYYY-MM-DD');

    try {
        const token = await getBuildiumToken(clientSlug, conn);
        const resp  = await axios.get('https://api.buildium.com/v1/leases', {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            params:  { status: 'Active', leasedateend: endDate, limit: 500 },
        });

        return (resp.data || []).map(l => ({
            pmsLeaseId:      String(l.Id),
            tenantName:      l.Tenants?.[0]?.DisplayName || 'Unknown',
            tenantEmail:     l.Tenants?.[0]?.Email || null,
            tenantPhone:     l.Tenants?.[0]?.PhoneNumbers?.find(p => p.Type === 'Cell')?.Number || null,
            propertyAddress: l.Unit?.Address?.AddressLine1 || null,
            unitNumber:      l.Unit?.UnitNumber || null,
            currentRent:     parseFloat(l.Rent || l.MonthlyRent || 0),
            leaseEndDate:    l.LeaseTo ? dayjs(l.LeaseTo).format('YYYY-MM-DD') : null,
        })).filter(l => l.leaseEndDate && l.currentRent > 0);
    } catch (err) {
        console.warn(`[Buildium] Expiring leases fetch failed: ${err.message}`);
        return [];
    }
}

// ─── Unified Fetcher ──────────────────────────────────────────────────────────

async function getExpiringLeases(clientSlug, conn, withinDays = 60) {
    if ((conn.pms_type || 'appfolio') === 'buildium') {
        return getBuildiumExpiringLeases(clientSlug, conn, withinDays);
    }
    return getAppFolioExpiringLeases(conn, withinDays);
}

module.exports = { getExpiringLeases };
