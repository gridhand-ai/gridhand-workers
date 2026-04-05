/**
 * GRIDHAND Change Order Tracker — Procore API Integration
 *
 * Handles OAuth, change order fetch, and project contract data.
 */

'use strict';

const axios = require('axios');
const db    = require('./db');

const PROCORE_BASE  = 'https://api.procore.com';
const PROCORE_AUTH  = 'https://login.procore.com/oauth/authorize';
const PROCORE_TOKEN = 'https://login.procore.com/oauth/token';

function getAuthorizationUrl(state) {
    const params = new URLSearchParams({
        client_id:     process.env.PROCORE_CLIENT_ID,
        redirect_uri:  process.env.PROCORE_REDIRECT_URI,
        response_type: 'code',
        state,
    });
    return `${PROCORE_AUTH}?${params.toString()}`;
}

async function exchangeCode({ code, clientSlug, ownerPhone, companyId, realmId }) {
    const resp = await axios.post(PROCORE_TOKEN, {
        grant_type:    'authorization_code',
        client_id:     process.env.PROCORE_CLIENT_ID,
        client_secret: process.env.PROCORE_CLIENT_SECRET,
        redirect_uri:  process.env.PROCORE_REDIRECT_URI,
        code,
    });
    const { access_token, refresh_token, expires_in } = resp.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    await db.upsertConnection({
        client_slug:              clientSlug,
        procore_company_id:       companyId,
        procore_access_token:     access_token,
        procore_refresh_token:    refresh_token,
        procore_expires_at:       expiresAt,
        qb_realm_id:              realmId || null,
        owner_phone:              ownerPhone,
    });
    return { accessToken: access_token };
}

async function refreshProcoreToken(clientSlug) {
    const conn = await db.getConnection(clientSlug);
    const resp = await axios.post(PROCORE_TOKEN, {
        grant_type:    'refresh_token',
        client_id:     process.env.PROCORE_CLIENT_ID,
        client_secret: process.env.PROCORE_CLIENT_SECRET,
        refresh_token: conn.procore_refresh_token,
    });
    const { access_token, refresh_token, expires_in } = resp.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
    await db.updateProcoreTokens(clientSlug, { accessToken: access_token, refreshToken: refresh_token, expiresAt });
    return access_token;
}

async function getValidToken(clientSlug) {
    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);
    if (Date.now() < new Date(conn.procore_expires_at).getTime() - 60000) {
        return conn.procore_access_token;
    }
    return refreshProcoreToken(clientSlug);
}

async function procoreGet(clientSlug, companyId, path, params = {}) {
    const token = await getValidToken(clientSlug);
    const resp = await axios.get(`${PROCORE_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        params:  { company_id: companyId, ...params },
    });
    return resp.data;
}

// ─── Change Orders ────────────────────────────────────────────────────────────

async function getChangeOrders(clientSlug, companyId, projectId) {
    // Procore: Prime Contract Change Orders
    try {
        const cos = await procoreGet(
            clientSlug, companyId,
            `/rest/v1.0/projects/${projectId}/prime_contract_change_orders`
        );
        return (cos || []).map(co => ({
            procoreCoId:     String(co.id),
            coNumber:        co.number || String(co.id),
            title:           co.title || '',
            description:     co.description || '',
            status:          (co.status || 'pending').toLowerCase(),
            originalAmount:  parseFloat(co.grand_total || 0),
            approvedAmount:  co.status === 'approved' ? parseFloat(co.grand_total || 0) : 0,
            procoreCreatedAt: co.created_at,
            procoreUpdatedAt: co.updated_at,
        }));
    } catch (err) {
        console.warn(`[Procore] Change orders fetch failed for ${projectId}: ${err.message}`);
        return [];
    }
}

async function getActiveProjects(clientSlug, companyId) {
    const projects = await procoreGet(clientSlug, companyId, '/rest/v1.0/projects', { status: 'Active' });
    return (projects || []).map(p => ({
        id:              String(p.id),
        name:            p.name,
        originalContract: parseFloat(p.estimated_value || 0),
    }));
}

module.exports = {
    getAuthorizationUrl,
    exchangeCode,
    getValidToken,
    getActiveProjects,
    getChangeOrders,
};
