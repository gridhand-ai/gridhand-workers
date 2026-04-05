/**
 * GRIDHAND Intake Accelerator — Clio Manage API Integration
 *
 * Handles:
 *  - OAuth 2.0 flow: getAuthUrl, exchangeCode, refreshToken
 *  - Token lifecycle: getValidToken (auto-refreshes 5 min before expiry)
 *  - Clio API helpers: clioGet, clioPost
 *  - Entity operations: contacts, matters, calendar entries
 *
 * Base URL: https://app.clio.com/api/v4
 * Docs: https://app.clio.com/api/v4/documentation
 */

'use strict';

require('dotenv').config();

const axios  = require('axios');
const dayjs  = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

// ─── Supabase ─────────────────────────────────────────────────────────────────

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Clio Constants ───────────────────────────────────────────────────────────

const CLIO_BASE_URL   = 'https://app.clio.com/api/v4';
const CLIO_AUTH_URL   = 'https://app.clio.com/oauth/authorize';
const CLIO_TOKEN_URL  = 'https://app.clio.com/oauth/token';

// ─── DB Helpers ───────────────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('clio_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function saveTokens(clientSlug, { accessToken, refreshToken, expiresAt, clioUserId }) {
    const { error } = await supabase
        .from('clio_connections')
        .upsert({
            client_slug:   clientSlug,
            access_token:  accessToken,
            refresh_token: refreshToken,
            expires_at:    expiresAt,
            clio_user_id:  clioUserId || null,
            updated_at:    new Date().toISOString(),
        }, { onConflict: 'client_slug' });

    if (error) throw error;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('clio_connections')
        .select('client_slug')
        .not('access_token', 'is', null);

    if (error) throw error;
    return data || [];
}

// ─── OAuth 2.0 ────────────────────────────────────────────────────────────────

/**
 * Build the Clio authorization URL to redirect the attorney to.
 */
function getAuthUrl(clientSlug) {
    const clientId    = process.env.CLIO_CLIENT_ID;
    const redirectUri = process.env.CLIO_REDIRECT_URI;

    if (!clientId || !redirectUri) {
        throw new Error('CLIO_CLIENT_ID and CLIO_REDIRECT_URI must be set');
    }

    const state = Buffer.from(JSON.stringify({ clientSlug, ts: Date.now() })).toString('base64');

    const params = new URLSearchParams({
        response_type: 'code',
        client_id:     clientId,
        redirect_uri:  redirectUri,
        state,
    });

    return `${CLIO_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange the authorization code for access + refresh tokens.
 * Called in the OAuth callback handler.
 */
async function exchangeCode(code, clientSlug) {
    const clientId     = process.env.CLIO_CLIENT_ID;
    const clientSecret = process.env.CLIO_CLIENT_SECRET;
    const redirectUri  = process.env.CLIO_REDIRECT_URI;

    const response = await axios.post(CLIO_TOKEN_URL, {
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
        client_id:     clientId,
        client_secret: clientSecret,
    });

    const tokens    = response.data;
    const expiresAt = dayjs().add(tokens.expires_in, 'second').toISOString();

    // Fetch the Clio user ID so we can tag records
    let clioUserId = null;
    try {
        const me = await axios.get(`${CLIO_BASE_URL}/users/who_am_i.json`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        clioUserId = String(me.data?.data?.id || '');
    } catch {
        // non-fatal
    }

    await saveTokens(clientSlug, {
        accessToken:  tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
        clioUserId,
    });

    console.log(`[Clio] OAuth complete for ${clientSlug} (user: ${clioUserId})`);
    return { clientSlug, clioUserId };
}

/**
 * Refresh the access token using the stored refresh token.
 */
async function refreshToken(clientSlug) {
    const conn = await getConnection(clientSlug);
    if (!conn?.refresh_token) throw new Error(`No Clio refresh token for ${clientSlug}`);

    const clientId     = process.env.CLIO_CLIENT_ID;
    const clientSecret = process.env.CLIO_CLIENT_SECRET;

    const response = await axios.post(CLIO_TOKEN_URL, {
        grant_type:    'refresh_token',
        refresh_token: conn.refresh_token,
        client_id:     clientId,
        client_secret: clientSecret,
    });

    const tokens    = response.data;
    const expiresAt = dayjs().add(tokens.expires_in, 'second').toISOString();

    await saveTokens(clientSlug, {
        accessToken:  tokens.access_token,
        refreshToken: tokens.refresh_token || conn.refresh_token,
        expiresAt,
        clioUserId:   conn.clio_user_id,
    });

    console.log(`[Clio] Token refreshed for ${clientSlug}`);
    return tokens.access_token;
}

/**
 * Get a valid access token — auto-refreshes if expiring within 5 minutes.
 */
async function getValidToken(clientSlug) {
    const conn = await getConnection(clientSlug);
    if (!conn?.access_token) throw new Error(`No Clio connection for ${clientSlug}`);

    const expiresAt = dayjs(conn.expires_at);
    const threshold = dayjs().add(5, 'minute');

    if (expiresAt.isBefore(threshold)) {
        return refreshToken(clientSlug);
    }

    return conn.access_token;
}

// ─── API Request Helpers ──────────────────────────────────────────────────────

/**
 * Authenticated GET to Clio API.
 */
async function clioGet(clientSlug, path, params = {}) {
    const token = await getValidToken(clientSlug);

    try {
        const response = await axios.get(`${CLIO_BASE_URL}${path}`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            params,
        });
        return response.data?.data ?? response.data;
    } catch (err) {
        const detail = err.response?.data?.error_description || err.response?.data?.error || err.message;
        throw new Error(`Clio GET ${path} — ${detail}`);
    }
}

/**
 * Authenticated POST to Clio API.
 */
async function clioPost(clientSlug, path, body) {
    const token = await getValidToken(clientSlug);

    try {
        const response = await axios.post(`${CLIO_BASE_URL}${path}`, { data: body }, {
            headers: {
                Authorization:  `Bearer ${token}`,
                'Content-Type': 'application/json',
                Accept:         'application/json',
            },
        });
        return response.data?.data ?? response.data;
    } catch (err) {
        const detail = err.response?.data?.error_description || err.response?.data?.error || err.message;
        throw new Error(`Clio POST ${path} — ${detail}`);
    }
}

// ─── Entity Operations ────────────────────────────────────────────────────────

/**
 * Get open matters for a firm (used for health checks / dashboards).
 */
async function getMatters(clientSlug) {
    return clioGet(clientSlug, '/matters.json', {
        status:   'open',
        fields:   'id,display_number,description,status,client{id,name},practice_area{id,name}',
        per_page: 50,
    });
}

/**
 * Create a new contact in Clio for an intake prospect.
 *
 * data: { name, phone, email }
 */
async function createContact(clientSlug, data) {
    const body = {
        type:           'Person',
        name:           data.name,
        primary_email_address: data.email
            ? { name: 'Home', address: data.email, default_email: true }
            : undefined,
        primary_phone_number: data.phone
            ? { name: 'Mobile', number: data.phone, default_number: true }
            : undefined,
    };

    // Remove undefined keys so Clio doesn't reject the payload
    Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

    const contact = await clioPost(clientSlug, '/contacts.json', body);
    console.log(`[Clio] Created contact ${contact.id} for ${data.name} (${clientSlug})`);
    return contact;
}

/**
 * Create a new matter in Clio linked to an existing contact.
 *
 * data: { clientId, description, practiceAreaId, status }
 */
async function createMatter(clientSlug, data) {
    const body = {
        description:   data.description,
        status:        data.status || 'Pending',
        client:        { id: data.clientId },
        practice_area: data.practiceAreaId ? { id: data.practiceAreaId } : undefined,
        open_date:     dayjs().format('YYYY-MM-DD'),
    };

    Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

    const matter = await clioPost(clientSlug, '/matters.json', body);
    console.log(`[Clio] Created matter ${matter.id} for contact ${data.clientId} (${clientSlug})`);
    return matter;
}

/**
 * Get upcoming calendar entries for the firm.
 */
async function getCalendarEntries(clientSlug) {
    const from = dayjs().toISOString();
    const to   = dayjs().add(30, 'day').toISOString();

    return clioGet(clientSlug, '/calendar_entries.json', {
        start_time: from,
        end_time:   to,
        fields:     'id,summary,start_at,end_at,location,matter{id,description}',
        per_page:   100,
    });
}

/**
 * Create a calendar entry (consultation) in Clio.
 *
 * data: { summary, startAt, endAt, matterId, location, description }
 */
async function createCalendarEntry(clientSlug, data) {
    const body = {
        summary:     data.summary || 'Initial Consultation',
        start_at:    data.startAt,
        end_at:      data.endAt,
        location:    data.location || null,
        description: data.description || null,
        matter:      data.matterId ? { id: data.matterId } : undefined,
    };

    Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

    const entry = await clioPost(clientSlug, '/calendar_entries.json', body);
    console.log(`[Clio] Calendar entry ${entry.id} created — ${data.startAt} (${clientSlug})`);
    return entry;
}

/**
 * Look up Clio practice area IDs so we can tag matters correctly.
 * Returns array of { id, name }
 */
async function getPracticeAreas(clientSlug) {
    return clioGet(clientSlug, '/practice_areas.json', { fields: 'id,name', per_page: 200 });
}

module.exports = {
    getAuthUrl,
    exchangeCode,
    refreshToken,
    getValidToken,
    getMatters,
    createContact,
    createMatter,
    getCalendarEntries,
    createCalendarEntry,
    getPracticeAreas,
    getConnection,
    getAllConnectedClients,
    clioGet,
    clioPost,
};
