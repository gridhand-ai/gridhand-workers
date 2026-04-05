/**
 * GRIDHAND Daily Log Bot — Procore API Integration
 *
 * Handles OAuth 2.0, project list, daily logs, and crew check-ins.
 * Procore OAuth: https://developers.procore.com/documentation/oauth-choose-flow
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');
const db    = require('./db');

const PROCORE_BASE    = 'https://api.procore.com';
const PROCORE_AUTH    = 'https://login.procore.com/oauth/authorize';
const PROCORE_TOKEN   = 'https://login.procore.com/oauth/token';

// ─── OAuth ────────────────────────────────────────────────────────────────────

function getAuthorizationUrl(state) {
    const params = new URLSearchParams({
        client_id:     process.env.PROCORE_CLIENT_ID,
        redirect_uri:  process.env.PROCORE_REDIRECT_URI,
        response_type: 'code',
        state,
    });
    return `${PROCORE_AUTH}?${params.toString()}`;
}

async function exchangeCode({ code, clientSlug, ownerPhone, companyId }) {
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
        owner_phone:              ownerPhone,
    });

    return { accessToken: access_token };
}

async function refreshToken(clientSlug) {
    const conn = await db.getConnection(clientSlug);
    if (!conn?.procore_refresh_token) throw new Error('No refresh token');

    const resp = await axios.post(PROCORE_TOKEN, {
        grant_type:    'refresh_token',
        client_id:     process.env.PROCORE_CLIENT_ID,
        client_secret: process.env.PROCORE_CLIENT_SECRET,
        refresh_token: conn.procore_refresh_token,
    });

    const { access_token, refresh_token, expires_in } = resp.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    await db.updateProcoreTokens(clientSlug, {
        accessToken:  access_token,
        refreshToken: refresh_token,
        expiresAt,
    });

    return access_token;
}

async function getValidToken(clientSlug) {
    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No Procore connection for ${clientSlug}`);

    const expiresAt = new Date(conn.procore_expires_at).getTime();
    if (Date.now() < expiresAt - 60000) return conn.procore_access_token;

    console.log(`[Procore] Refreshing token for ${clientSlug}`);
    return refreshToken(clientSlug);
}

// ─── API Helper ───────────────────────────────────────────────────────────────

async function procoreGet(clientSlug, companyId, path, params = {}) {
    const token = await getValidToken(clientSlug);
    const resp = await axios.get(`${PROCORE_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        params:  { company_id: companyId, ...params },
    });
    return resp.data;
}

async function procorePost(clientSlug, companyId, path, body) {
    const token = await getValidToken(clientSlug);
    const resp = await axios.post(`${PROCORE_BASE}${path}`, body, {
        headers: {
            Authorization:  `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        params: { company_id: companyId },
    });
    return resp.data;
}

// ─── Data Fetchers ────────────────────────────────────────────────────────────

async function getActiveProjects(clientSlug, companyId) {
    const projects = await procoreGet(clientSlug, companyId, '/rest/v1.0/projects', {
        status: 'Active',
    });
    return (projects || []).map(p => ({
        id:   String(p.id),
        name: p.name,
        address: p.address,
    }));
}

async function getManpowerLogs(clientSlug, companyId, projectId, date) {
    // Procore Manpower Log = crew check-ins
    try {
        const logs = await procoreGet(
            clientSlug, companyId,
            `/rest/v1.0/projects/${projectId}/manpower_logs`,
            { 'filters[date]': date }
        );
        return (logs || []).map(l => ({
            name:  l.login?.name || l.sub_contractor?.name || 'Unknown',
            hours: l.hours || 0,
            trade: l.party?.name || null,
        }));
    } catch (err) {
        console.warn(`[Procore] Manpower logs error for project ${projectId}: ${err.message}`);
        return [];
    }
}

async function getDailyLog(clientSlug, companyId, projectId, date) {
    // Procore Daily Log entry for a specific date
    try {
        const logs = await procoreGet(
            clientSlug, companyId,
            `/rest/v1.0/projects/${projectId}/daily_logs`,
            { 'filters[date]': date }
        );
        return logs?.[0] || null;
    } catch {
        return null;
    }
}

async function postDailyLog(clientSlug, companyId, projectId, { date, notes }) {
    // Create or update Procore daily log entry
    try {
        const result = await procorePost(clientSlug, companyId,
            `/rest/v1.0/projects/${projectId}/daily_logs`,
            { daily_log: { date, notes } }
        );
        return result?.id ? String(result.id) : null;
    } catch (err) {
        console.error(`[Procore] Post daily log failed: ${err.message}`);
        return null;
    }
}

module.exports = {
    getAuthorizationUrl,
    exchangeCode,
    getValidToken,
    getActiveProjects,
    getManpowerLogs,
    getDailyLog,
    postDailyLog,
};
