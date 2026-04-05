/**
 * GRIDHAND Deadline Sentinel — Case Management API Layer
 *
 * Handles OAuth2 for Clio and API-key auth for MyCase.
 * Exposes a unified interface regardless of which system the firm uses.
 *
 * Clio API:   https://app.clio.com/api/v4
 * MyCase API: https://app.mycase.com/api/v1
 *
 * Environment vars:
 *   CLIO_CLIENT_ID       — from Clio developer app
 *   CLIO_CLIENT_SECRET   — from Clio developer app
 *   CLIO_REDIRECT_URI    — must match Clio app settings
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
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

const CLIO_BASE    = 'https://app.clio.com/api/v4';
const MYCASE_BASE  = 'https://app.mycase.com/api/v1';
const CLIO_AUTH    = 'https://app.clio.com/oauth/authorize';
const CLIO_TOKEN   = 'https://app.clio.com/oauth/token';

// ─── Clio OAuth2 ─────────────────────────────────────────────────────────────

/**
 * Returns the OAuth2 authorization URL for a firm.
 * Redirect user's browser here to start Clio OAuth.
 *
 * @param {string} clientSlug
 * @returns {string} URL
 */
function getAuthUrl(clientSlug) {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id:     process.env.CLIO_CLIENT_ID,
        redirect_uri:  process.env.CLIO_REDIRECT_URI,
        state:         clientSlug,
    });
    return `${CLIO_AUTH}?${params.toString()}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 * Saves the tokens to DB.
 *
 * @param {string} clientSlug
 * @param {string} code  — from OAuth callback ?code=
 * @returns {object} token record
 */
async function exchangeCode(clientSlug, code) {
    const resp = await axios.post(CLIO_TOKEN, new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        client_id:     process.env.CLIO_CLIENT_ID,
        client_secret: process.env.CLIO_CLIENT_SECRET,
        redirect_uri:  process.env.CLIO_REDIRECT_URI,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const { access_token, refresh_token, expires_in } = resp.data;
    const expiresAt = dayjs().add(expires_in, 'second').toISOString();

    await supabase
        .from('sentinel_connections')
        .upsert({
            client_slug:        clientSlug,
            clio_access_token:  access_token,
            clio_refresh_token: refresh_token,
            clio_expires_at:    expiresAt,
            active_system:      'clio',
        }, { onConflict: 'client_slug' });

    console.log(`[CaseMgmt] Clio tokens saved for ${clientSlug}, expires ${expiresAt}`);
    return { access_token, expires_at: expiresAt };
}

/**
 * Use the stored refresh token to get a new access token.
 *
 * @param {string} clientSlug
 * @param {string} refreshToken
 * @returns {object} { access_token, expires_at }
 */
async function refreshToken(clientSlug, refreshToken) {
    const resp = await axios.post(CLIO_TOKEN, new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
        client_id:     process.env.CLIO_CLIENT_ID,
        client_secret: process.env.CLIO_CLIENT_SECRET,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const { access_token, refresh_token: newRefresh, expires_in } = resp.data;
    const expiresAt = dayjs().add(expires_in, 'second').toISOString();

    await supabase
        .from('sentinel_connections')
        .update({
            clio_access_token:  access_token,
            clio_refresh_token: newRefresh || refreshToken,
            clio_expires_at:    expiresAt,
        })
        .eq('client_slug', clientSlug);

    console.log(`[CaseMgmt] Clio token refreshed for ${clientSlug}`);
    return { access_token, expires_at: expiresAt };
}

/**
 * Returns a valid Clio access token, refreshing automatically if expired.
 *
 * @param {string} clientSlug
 * @returns {string} access_token
 */
async function getValidToken(clientSlug) {
    const { data: conn, error } = await supabase
        .from('sentinel_connections')
        .select('clio_access_token, clio_refresh_token, clio_expires_at')
        .eq('client_slug', clientSlug)
        .single();

    if (error || !conn) throw new Error(`No Clio connection found for ${clientSlug}`);
    if (!conn.clio_access_token) throw new Error(`Clio not authorized for ${clientSlug}`);

    // Refresh if expiring within 5 minutes
    const expiresAt = dayjs(conn.clio_expires_at);
    if (dayjs().isAfter(expiresAt.subtract(5, 'minute'))) {
        const refreshed = await refreshToken(clientSlug, conn.clio_refresh_token);
        return refreshed.access_token;
    }

    return conn.clio_access_token;
}

// ─── MyCase Setup ─────────────────────────────────────────────────────────────

/**
 * Save a MyCase API key for a client.
 *
 * @param {string} clientSlug
 * @param {string} apiKey
 */
async function setMyCaseKey(clientSlug, apiKey) {
    const { error } = await supabase
        .from('sentinel_connections')
        .upsert({
            client_slug:    clientSlug,
            mycase_api_key: apiKey,
            active_system:  'mycase',
        }, { onConflict: 'client_slug' });

    if (error) throw new Error(`Failed to save MyCase key for ${clientSlug}: ${error.message}`);
    console.log(`[CaseMgmt] MyCase API key saved for ${clientSlug}`);
}

// ─── Internal HTTP helpers ────────────────────────────────────────────────────

async function clioGet(clientSlug, path, params = {}) {
    const token = await getValidToken(clientSlug);
    const resp  = await axios.get(`${CLIO_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        params,
    });
    return resp.data;
}

async function myCaseGet(clientSlug, path, params = {}) {
    const { data: conn } = await supabase
        .from('sentinel_connections')
        .select('mycase_api_key')
        .eq('client_slug', clientSlug)
        .single();

    if (!conn?.mycase_api_key) throw new Error(`No MyCase key for ${clientSlug}`);

    const resp = await axios.get(`${MYCASE_BASE}${path}`, {
        headers: { Authorization: `Token ${conn.mycase_api_key}` },
        params,
    });
    return resp.data;
}

/**
 * Determine which system a client is using.
 * @param {string} clientSlug
 * @returns {string} 'clio' | 'mycase'
 */
async function getActiveSystem(clientSlug) {
    const { data: conn } = await supabase
        .from('sentinel_connections')
        .select('active_system')
        .eq('client_slug', clientSlug)
        .single();

    return conn?.active_system || 'clio';
}

// ─── Matters ─────────────────────────────────────────────────────────────────

/**
 * Fetch all active matters for a client.
 * Normalizes Clio and MyCase responses to the same shape.
 *
 * @param {string} clientSlug
 * @returns {Array<{ id, name, status, practiceArea, clientName, clientId, assignedAttorney }>}
 */
async function getMatters(clientSlug) {
    const system = await getActiveSystem(clientSlug);

    if (system === 'clio') {
        return getClioMatters(clientSlug);
    } else {
        return getMyCaseMatters(clientSlug);
    }
}

async function getClioMatters(clientSlug) {
    const matters = [];
    let page = 1;

    while (true) {
        const resp = await clioGet(clientSlug, '/matters', {
            status:   'open',
            fields:   'id,display_number,description,status,practice_area,client{id,name},responsible_attorney{name}',
            per_page: 200,
            page,
        });

        const batch = resp.data || [];
        for (const m of batch) {
            matters.push({
                id:               String(m.id),
                name:             m.description || m.display_number,
                status:           m.status,
                practiceArea:     m.practice_area?.name || 'Unknown',
                clientName:       m.client?.name || 'Unknown',
                clientId:         String(m.client?.id || ''),
                assignedAttorney: m.responsible_attorney?.name || 'Unassigned',
            });
        }

        // Clio pagination: check meta
        if (!resp.meta?.paging?.next) break;
        page++;
    }

    console.log(`[CaseMgmt] Fetched ${matters.length} Clio matters for ${clientSlug}`);
    return matters;
}

async function getMyCaseMatters(clientSlug) {
    const resp = await myCaseGet(clientSlug, '/cases', { status: 'open', per_page: 500 });
    const cases = resp.cases || [];

    return cases.map(c => ({
        id:               String(c.id),
        name:             c.name,
        status:           c.status,
        practiceArea:     c.case_type || 'Unknown',
        clientName:       c.client_name || 'Unknown',
        clientId:         String(c.contact_id || ''),
        assignedAttorney: c.user_name || 'Unassigned',
    }));
}

// ─── Deadlines / Tasks ────────────────────────────────────────────────────────

/**
 * Fetch all tasks and calendar entries for a matter.
 * Returns a normalized array of deadline objects.
 *
 * @param {string} clientSlug
 * @param {string} matterId
 * @returns {Array<{ externalId, title, dueDate, completedAt, status, source }>}
 */
async function getDeadlinesForMatter(clientSlug, matterId) {
    const system = await getActiveSystem(clientSlug);
    const results = [];

    if (system === 'clio') {
        // Clio tasks
        const taskResp = await clioGet(clientSlug, '/tasks', {
            matter_id: matterId,
            fields:    'id,name,due_at,completed_at,status,priority',
            per_page:  200,
        });

        for (const t of (taskResp.data || [])) {
            if (!t.due_at) continue;
            results.push({
                externalId:  String(t.id),
                title:       t.name,
                dueDate:     dayjs(t.due_at).format('YYYY-MM-DD'),
                completedAt: t.completed_at ? dayjs(t.completed_at).format('YYYY-MM-DD') : null,
                status:      t.status === 'complete' ? 'completed' : 'upcoming',
                priority:    t.priority || 'normal',
                source:      'clio_task',
            });
        }

        // Clio calendar entries linked to this matter
        const calResp = await clioGet(clientSlug, '/calendar_entries', {
            matter_id: matterId,
            fields:    'id,summary,start_at,all_day,matter{id}',
            per_page:  200,
        });

        for (const e of (calResp.data || [])) {
            results.push({
                externalId:  `cal_${e.id}`,
                title:       e.summary,
                dueDate:     dayjs(e.start_at).format('YYYY-MM-DD'),
                completedAt: null,
                status:      'upcoming',
                priority:    'normal',
                source:      'clio_calendar',
            });
        }

    } else {
        // MyCase tasks
        const taskResp = await myCaseGet(clientSlug, '/tasks', {
            case_id:  matterId,
            per_page: 500,
        });

        for (const t of (taskResp.tasks || [])) {
            if (!t.due_on) continue;
            results.push({
                externalId:  String(t.id),
                title:       t.name,
                dueDate:     dayjs(t.due_on).format('YYYY-MM-DD'),
                completedAt: t.completed_on || null,
                status:      t.status === 'completed' ? 'completed' : 'upcoming',
                priority:    'normal',
                source:      'mycase_task',
            });
        }

        // MyCase events (court dates)
        const evtResp = await myCaseGet(clientSlug, '/events', {
            case_id:  matterId,
            per_page: 200,
        });

        for (const e of (evtResp.events || [])) {
            results.push({
                externalId:  `evt_${e.id}`,
                title:       e.name,
                dueDate:     dayjs(e.start_at || e.date).format('YYYY-MM-DD'),
                completedAt: null,
                status:      'upcoming',
                priority:    'normal',
                source:      'mycase_event',
            });
        }
    }

    return results;
}

// ─── Matter Details ───────────────────────────────────────────────────────────

/**
 * Return enriched details for a single matter.
 *
 * @param {string} clientSlug
 * @param {string} matterId
 * @returns {{ id, name, clientName, practiceArea, assignedAttorney }}
 */
async function getMatterDetails(clientSlug, matterId) {
    const system = await getActiveSystem(clientSlug);

    if (system === 'clio') {
        const resp = await clioGet(clientSlug, `/matters/${matterId}`, {
            fields: 'id,description,display_number,practice_area,client{name},responsible_attorney{name}',
        });
        const m = resp.data;
        return {
            id:               String(m.id),
            name:             m.description || m.display_number,
            clientName:       m.client?.name || 'Unknown',
            practiceArea:     m.practice_area?.name || 'Unknown',
            assignedAttorney: m.responsible_attorney?.name || 'Unassigned',
        };
    } else {
        const resp = await myCaseGet(clientSlug, `/cases/${matterId}`);
        const c = resp.case || resp;
        return {
            id:               String(c.id),
            name:             c.name,
            clientName:       c.client_name || 'Unknown',
            practiceArea:     c.case_type || 'Unknown',
            assignedAttorney: c.user_name || 'Unassigned',
        };
    }
}

// ─── Task Status Update ───────────────────────────────────────────────────────

/**
 * Mark a task as completed in Clio or MyCase.
 *
 * @param {string} clientSlug
 * @param {string} matterId   — required for MyCase
 * @param {string} taskId
 * @param {string} status     — 'completed' | 'pending'
 */
async function updateTaskStatus(clientSlug, matterId, taskId, status) {
    const system = await getActiveSystem(clientSlug);

    if (system === 'clio') {
        const token = await getValidToken(clientSlug);
        await axios.patch(`${CLIO_BASE}/tasks/${taskId}`, {
            data: { status: status === 'completed' ? 'complete' : 'pending' },
        }, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
        console.log(`[CaseMgmt] Clio task ${taskId} marked ${status} for ${clientSlug}`);
    } else {
        const { data: conn } = await supabase
            .from('sentinel_connections')
            .select('mycase_api_key')
            .eq('client_slug', clientSlug)
            .single();

        await axios.patch(`${MYCASE_BASE}/tasks/${taskId}`, {
            task: { status },
        }, {
            headers: {
                Authorization: `Token ${conn.mycase_api_key}`,
                'Content-Type': 'application/json',
            },
        });
        console.log(`[CaseMgmt] MyCase task ${taskId} marked ${status} for ${clientSlug}`);
    }
}

// ─── Connection Helpers ───────────────────────────────────────────────────────

/**
 * Return the full connection record for a client.
 * @param {string} clientSlug
 */
async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('sentinel_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error || !data) return null;
    return data;
}

/**
 * Return all clients that have an active connection.
 */
async function getAllConnectedClients() {
    const { data } = await supabase
        .from('sentinel_connections')
        .select('client_slug, active_system, attorney_phone, partner_phone, firm_name, timezone');
    return data || [];
}

module.exports = {
    // Clio OAuth
    getAuthUrl,
    exchangeCode,
    refreshToken,
    getValidToken,
    // MyCase
    setMyCaseKey,
    // Matters
    getMatters,
    getMatterDetails,
    // Deadlines
    getDeadlinesForMatter,
    // Task mutation
    updateTaskStatus,
    // DB helpers
    getConnection,
    getAllConnectedClients,
};
