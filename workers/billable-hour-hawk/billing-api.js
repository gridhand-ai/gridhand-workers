/**
 * GRIDHAND Billable Hour Hawk — Billing API Abstraction
 *
 * Handles all communication with:
 *   - Clio (OAuth2): https://app.clio.com/api/v4
 *   - Rocket Matter (API key): https://app.rocketmatter.com/api/v1
 *
 * Public surface:
 *   getAuthUrl(clientSlug)
 *   exchangeCode(code, clientSlug)
 *   refreshToken(clientSlug)
 *   getValidToken(clientSlug)
 *   setRocketMatterKey(clientSlug, apiKey)
 *   getTimeEntries(clientSlug, startDate, endDate)
 *   getUnbilledEntries(clientSlug)
 *   getActivities(clientSlug, matterId)
 *   getMatters(clientSlug)
 *   createInvoiceDraft(clientSlug, matterId, entries)
 *   getInvoices(clientSlug, status)
 *   getRealizationRate(clientSlug)
 */

'use strict';

require('dotenv').config();

const axios   = require('axios');
const dayjs   = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

// ─── Supabase ─────────────────────────────────────────────────────────────────

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Constants ────────────────────────────────────────────────────────────────

const CLIO_BASE_URL = 'https://app.clio.com/api/v4';
const RM_BASE_URL   = 'https://app.rocketmatter.com/api/v1';

const CLIO_CLIENT_ID     = process.env.CLIO_CLIENT_ID;
const CLIO_CLIENT_SECRET = process.env.CLIO_CLIENT_SECRET;
const CLIO_REDIRECT_URI  = process.env.CLIO_REDIRECT_URI;

// ─── Internal: DB helpers ─────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('hawk_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    if (error) throw new Error(`DB error loading connection for ${clientSlug}: ${error.message}`);
    return data;
}

async function saveConnection(clientSlug, updates) {
    const { error } = await supabase
        .from('hawk_connections')
        .update(updates)
        .eq('client_slug', clientSlug);
    if (error) throw new Error(`DB error saving connection for ${clientSlug}: ${error.message}`);
}

// ─── Clio OAuth2 ─────────────────────────────────────────────────────────────

/**
 * Build the Clio OAuth2 authorization URL.
 * state encodes clientSlug so the callback can route correctly.
 */
function getAuthUrl(clientSlug) {
    if (!CLIO_CLIENT_ID || !CLIO_REDIRECT_URI) {
        throw new Error('CLIO_CLIENT_ID and CLIO_REDIRECT_URI env vars required');
    }
    const state  = Buffer.from(JSON.stringify({ clientSlug, ts: Date.now() })).toString('base64');
    const params = new URLSearchParams({
        response_type: 'code',
        client_id:     CLIO_CLIENT_ID,
        redirect_uri:  CLIO_REDIRECT_URI,
        scope:         'openid profile email',
        state,
    });
    return `https://app.clio.com/oauth/authorize?${params.toString()}`;
}

/**
 * Exchange the OAuth2 authorization code for access + refresh tokens.
 * Saves them into hawk_connections for this clientSlug.
 */
async function exchangeCode(code, clientSlug) {
    if (!CLIO_CLIENT_ID || !CLIO_CLIENT_SECRET || !CLIO_REDIRECT_URI) {
        throw new Error('Clio OAuth2 env vars not configured');
    }

    const response = await axios.post('https://app.clio.com/oauth/token', new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  CLIO_REDIRECT_URI,
        client_id:     CLIO_CLIENT_ID,
        client_secret: CLIO_CLIENT_SECRET,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const { access_token, refresh_token, expires_in } = response.data;
    const expiresAt = dayjs().add(expires_in, 'second').toISOString();

    // Upsert connection record
    const { error } = await supabase
        .from('hawk_connections')
        .upsert({
            client_slug:         clientSlug,
            clio_access_token:   access_token,
            clio_refresh_token:  refresh_token,
            clio_expires_at:     expiresAt,
            active_system:       'clio',
        }, { onConflict: 'client_slug' });

    if (error) throw new Error(`Failed to save Clio tokens: ${error.message}`);

    console.log(`[BillingAPI] Clio tokens saved for ${clientSlug}, expires ${expiresAt}`);
    return { access_token, expires_at: expiresAt };
}

/**
 * Use the refresh token to get a new access token.
 * Automatically updates the DB record.
 */
async function refreshToken(clientSlug) {
    const conn = await getConnection(clientSlug);
    if (!conn?.clio_refresh_token) throw new Error(`No Clio refresh token for ${clientSlug}`);

    const response = await axios.post('https://app.clio.com/oauth/token', new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: conn.clio_refresh_token,
        client_id:     CLIO_CLIENT_ID,
        client_secret: CLIO_CLIENT_SECRET,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const { access_token, refresh_token: newRefresh, expires_in } = response.data;
    const expiresAt = dayjs().add(expires_in, 'second').toISOString();

    await saveConnection(clientSlug, {
        clio_access_token:  access_token,
        clio_refresh_token: newRefresh || conn.clio_refresh_token,
        clio_expires_at:    expiresAt,
    });

    console.log(`[BillingAPI] Clio token refreshed for ${clientSlug}`);
    return access_token;
}

/**
 * Return a valid Clio access token, refreshing if needed.
 */
async function getValidToken(clientSlug) {
    const conn = await getConnection(clientSlug);
    if (!conn) throw new Error(`No connection record for ${clientSlug}`);

    if (conn.active_system === 'rocketmatter') {
        return conn.rocketmatter_api_key; // not OAuth
    }

    if (!conn.clio_access_token) throw new Error(`No Clio token for ${clientSlug}`);

    // Refresh if token expires in less than 5 minutes
    const expiresAt = dayjs(conn.clio_expires_at);
    if (expiresAt.diff(dayjs(), 'minute') < 5) {
        return refreshToken(clientSlug);
    }

    return conn.clio_access_token;
}

// ─── Rocket Matter API key auth ───────────────────────────────────────────────

/**
 * Store a Rocket Matter API key for a client.
 */
async function setRocketMatterKey(clientSlug, apiKey) {
    const { error } = await supabase
        .from('hawk_connections')
        .upsert({
            client_slug:          clientSlug,
            rocketmatter_api_key: apiKey,
            active_system:        'rocketmatter',
        }, { onConflict: 'client_slug' });

    if (error) throw new Error(`Failed to save Rocket Matter key: ${error.message}`);
    console.log(`[BillingAPI] Rocket Matter key saved for ${clientSlug}`);
}

// ─── Internal: HTTP helpers ───────────────────────────────────────────────────

/**
 * Build an authorized axios instance for Clio or Rocket Matter.
 */
async function buildClient(clientSlug) {
    const conn  = await getConnection(clientSlug);
    const token = await getValidToken(clientSlug);

    if (conn.active_system === 'rocketmatter') {
        return {
            system: 'rocketmatter',
            http: axios.create({
                baseURL: RM_BASE_URL,
                headers: {
                    'X-API-Key':     token,
                    'Accept':        'application/json',
                    'Content-Type':  'application/json',
                },
                timeout: 15000,
            }),
        };
    }

    return {
        system: 'clio',
        http: axios.create({
            baseURL: CLIO_BASE_URL,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept':        'application/json',
                'Content-Type':  'application/json',
            },
            timeout: 15000,
        }),
    };
}

/**
 * Paginate through all pages of a Clio list endpoint.
 */
async function clioFetchAll(http, endpoint, params = {}) {
    const results = [];
    let url = endpoint;
    let pageParams = { ...params, limit: 200, page_token: undefined };

    while (true) {
        const { data } = await http.get(url, { params: pageParams });
        const items    = data.data || [];
        results.push(...items);

        const nextToken = data.meta?.paging?.next;
        if (!nextToken) break;

        // Clio uses page_token for cursor pagination
        pageParams = { ...params, limit: 200, page_token: nextToken };
    }

    return results;
}

/**
 * Paginate through all pages of a Rocket Matter list endpoint.
 */
async function rmFetchAll(http, endpoint, params = {}) {
    const results = [];
    let page = 1;

    while (true) {
        const { data } = await http.get(endpoint, { params: { ...params, page, per_page: 100 } });
        const items    = Array.isArray(data) ? data : (data.data || data.results || []);
        if (!items.length) break;
        results.push(...items);
        if (items.length < 100) break;
        page++;
    }

    return results;
}

// ─── Public API: Time Entries ─────────────────────────────────────────────────

/**
 * Fetch all time entries between startDate and endDate (YYYY-MM-DD).
 * Returns a normalized array regardless of which system is active.
 */
async function getTimeEntries(clientSlug, startDate, endDate) {
    const { system, http } = await buildClient(clientSlug);

    if (system === 'clio') {
        const raw = await clioFetchAll(http, '/activities', {
            type:         'TimeEntry',
            'date[start]': startDate,
            'date[end]':   endDate,
            fields:        'id,date,quantity,rate,total,note,matter{id,display_number,description,client{name}},user{name},invoice{id}',
        });

        return raw.map(e => ({
            external_entry_id:    String(e.id),
            attorney_name:        e.user?.name || 'Unknown',
            matter_id:            String(e.matter?.id || ''),
            matter_name:          e.matter?.display_number || e.matter?.description || '',
            client_name:          e.matter?.client?.name || '',
            activity_description: e.note || '',
            hours:                parseFloat(e.quantity) || 0,
            rate:                 parseFloat(e.rate) || 0,
            amount:               parseFloat(e.total) || 0,
            entry_date:           e.date,
            billed:               !!e.invoice?.id,
            invoice_id:           e.invoice?.id ? String(e.invoice.id) : null,
        }));
    }

    // Rocket Matter
    const raw = await rmFetchAll(http, '/time_entries', {
        start_date: startDate,
        end_date:   endDate,
    });

    return raw.map(e => ({
        external_entry_id:    String(e.id),
        attorney_name:        e.user?.full_name || e.attorney_name || 'Unknown',
        matter_id:            String(e.matter_id || ''),
        matter_name:          e.matter_name || '',
        client_name:          e.client_name || '',
        activity_description: e.description || e.activity || '',
        hours:                parseFloat(e.hours || e.duration_hours || 0),
        rate:                 parseFloat(e.rate || 0),
        amount:               parseFloat(e.amount || 0),
        entry_date:           e.date || e.entry_date,
        billed:               e.billed === true || e.invoice_id != null,
        invoice_id:           e.invoice_id ? String(e.invoice_id) : null,
    }));
}

/**
 * Fetch only unbilled time entries (not yet on any invoice).
 */
async function getUnbilledEntries(clientSlug) {
    const { system, http } = await buildClient(clientSlug);

    if (system === 'clio') {
        const raw = await clioFetchAll(http, '/activities', {
            type:   'TimeEntry',
            billed: false,
            fields: 'id,date,quantity,rate,total,note,matter{id,display_number,description,client{name}},user{name},invoice{id}',
        });

        return raw.map(e => ({
            external_entry_id:    String(e.id),
            attorney_name:        e.user?.name || 'Unknown',
            matter_id:            String(e.matter?.id || ''),
            matter_name:          e.matter?.display_number || e.matter?.description || '',
            client_name:          e.matter?.client?.name || '',
            activity_description: e.note || '',
            hours:                parseFloat(e.quantity) || 0,
            rate:                 parseFloat(e.rate) || 0,
            amount:               parseFloat(e.total) || 0,
            entry_date:           e.date,
            billed:               false,
            invoice_id:           null,
        }));
    }

    // Rocket Matter — filter unbilled
    const all = await rmFetchAll(http, '/time_entries', { billed: false });
    return all
        .filter(e => !e.billed && !e.invoice_id)
        .map(e => ({
            external_entry_id:    String(e.id),
            attorney_name:        e.user?.full_name || e.attorney_name || 'Unknown',
            matter_id:            String(e.matter_id || ''),
            matter_name:          e.matter_name || '',
            client_name:          e.client_name || '',
            activity_description: e.description || e.activity || '',
            hours:                parseFloat(e.hours || e.duration_hours || 0),
            rate:                 parseFloat(e.rate || 0),
            amount:               parseFloat(e.amount || 0),
            entry_date:           e.date || e.entry_date,
            billed:               false,
            invoice_id:           null,
        }));
}

/**
 * Get all billable activities for a specific matter.
 */
async function getActivities(clientSlug, matterId) {
    const { system, http } = await buildClient(clientSlug);

    if (system === 'clio') {
        return clioFetchAll(http, '/activities', {
            matter_id: matterId,
            type:      'TimeEntry',
            fields:    'id,date,quantity,rate,total,note,user{name},invoice{id}',
        });
    }

    return rmFetchAll(http, `/matters/${matterId}/time_entries`);
}

// ─── Public API: Matters ──────────────────────────────────────────────────────

/**
 * Get all active matters with retainer info.
 */
async function getMatters(clientSlug) {
    const { system, http } = await buildClient(clientSlug);

    if (system === 'clio') {
        const raw = await clioFetchAll(http, '/matters', {
            status: 'open',
            fields: 'id,display_number,description,client{name},matter_budget,trust_balance,custom_rate',
        });

        return raw.map(m => ({
            id:               String(m.id),
            matter_number:    m.display_number,
            description:      m.description || '',
            client_name:      m.client?.name || '',
            retainer_limit:   parseFloat(m.matter_budget?.limit || 0),
            retainer_balance: parseFloat(m.trust_balance || 0),
        }));
    }

    // Rocket Matter
    const raw = await rmFetchAll(http, '/matters', { status: 'active' });
    return raw.map(m => ({
        id:               String(m.id),
        matter_number:    m.matter_number || String(m.id),
        description:      m.description || m.name || '',
        client_name:      m.client_name || '',
        retainer_limit:   parseFloat(m.retainer || m.budget || 0),
        retainer_balance: parseFloat(m.retainer_balance || 0),
    }));
}

// ─── Public API: Invoices ─────────────────────────────────────────────────────

/**
 * Get invoices by status: 'draft' | 'pending' | 'paid' | 'overdue'
 */
async function getInvoices(clientSlug, status) {
    const { system, http } = await buildClient(clientSlug);

    if (system === 'clio') {
        // Clio statuses: draft, outstanding, paid, void
        const clioStatus = status === 'pending' ? 'outstanding'
                         : status === 'overdue'  ? 'outstanding'
                         : status;

        const raw = await clioFetchAll(http, '/bills', {
            status: clioStatus,
            fields: 'id,number,issued_at,due_at,total,paid,balance,state,matter{id,display_number},client{name}',
        });

        return raw.map(inv => ({
            id:           String(inv.id),
            number:       inv.number,
            matter_id:    String(inv.matter?.id || ''),
            matter_name:  inv.matter?.display_number || '',
            client_name:  inv.client?.name || '',
            issued_at:    inv.issued_at,
            due_at:       inv.due_at,
            total:        parseFloat(inv.total || 0),
            paid:         parseFloat(inv.paid || 0),
            balance:      parseFloat(inv.balance || 0),
            status:       inv.state,
        }));
    }

    // Rocket Matter
    const raw = await rmFetchAll(http, '/invoices', { status });
    return raw.map(inv => ({
        id:          String(inv.id),
        number:      inv.invoice_number || String(inv.id),
        matter_id:   String(inv.matter_id || ''),
        matter_name: inv.matter_name || '',
        client_name: inv.client_name || '',
        issued_at:   inv.invoice_date,
        due_at:      inv.due_date,
        total:       parseFloat(inv.total || 0),
        paid:        parseFloat(inv.amount_paid || 0),
        balance:     parseFloat(inv.balance_due || 0),
        status:      inv.status,
    }));
}

// ─── Public API: Invoice Creation ─────────────────────────────────────────────

/**
 * Create a draft invoice in Clio for a matter, attaching specific time entries.
 * Returns the created invoice object.
 */
async function createInvoiceDraft(clientSlug, matterId, entries) {
    const { system, http } = await buildClient(clientSlug);

    if (system === 'clio') {
        const payload = {
            data: {
                matter:  { id: parseInt(matterId) },
                subject: `Invoice — ${dayjs().format('MMMM YYYY')}`,
                issued_at: dayjs().format('YYYY-MM-DD'),
                due_at:    dayjs().add(30, 'day').format('YYYY-MM-DD'),
                // Attach line items from time entries
                time_entries: entries.map(e => ({ id: parseInt(e.external_entry_id) })),
            },
        };

        const { data } = await http.post('/bills', payload);
        return {
            draft_external_id: String(data.data?.id || ''),
            matter_id:         matterId,
            total_hours:       entries.reduce((s, e) => s + parseFloat(e.hours || 0), 0),
            total_amount:      entries.reduce((s, e) => s + parseFloat(e.amount || 0), 0),
            entry_count:       entries.length,
        };
    }

    // Rocket Matter
    const payload = {
        matter_id:    matterId,
        invoice_date: dayjs().format('YYYY-MM-DD'),
        due_date:     dayjs().add(30, 'day').format('YYYY-MM-DD'),
        time_entry_ids: entries.map(e => e.external_entry_id),
    };

    const { data } = await http.post('/invoices', payload);
    return {
        draft_external_id: String(data.id || ''),
        matter_id:         matterId,
        total_hours:       entries.reduce((s, e) => s + parseFloat(e.hours || 0), 0),
        total_amount:      entries.reduce((s, e) => s + parseFloat(e.amount || 0), 0),
        entry_count:       entries.length,
    };
}

// ─── Public API: Realization Rate ─────────────────────────────────────────────

/**
 * Calculate the realization rate for a client: billed / collected ratio.
 * Returns an object with billed, collected, and realization_rate (0-1).
 */
async function getRealizationRate(clientSlug) {
    const { system, http } = await buildClient(clientSlug);

    if (system === 'clio') {
        const [paidInvoices, outstandingInvoices] = await Promise.all([
            clioFetchAll(http, '/bills', {
                status: 'paid',
                fields: 'id,total,paid',
                'issued_at[start]': dayjs().subtract(12, 'month').format('YYYY-MM-DD'),
            }),
            clioFetchAll(http, '/bills', {
                status: 'outstanding',
                fields: 'id,total,paid',
            }),
        ]);

        const totalBilled    = [...paidInvoices, ...outstandingInvoices]
            .reduce((s, inv) => s + parseFloat(inv.total || 0), 0);
        const totalCollected = paidInvoices
            .reduce((s, inv) => s + parseFloat(inv.paid || 0), 0);

        return {
            billed:            totalBilled,
            collected:         totalCollected,
            realization_rate:  totalBilled > 0 ? totalCollected / totalBilled : 0,
        };
    }

    // Rocket Matter
    const [paid, outstanding] = await Promise.all([
        rmFetchAll(http, '/invoices', { status: 'paid' }),
        rmFetchAll(http, '/invoices', { status: 'outstanding' }),
    ]);

    const totalBilled    = [...paid, ...outstanding]
        .reduce((s, inv) => s + parseFloat(inv.total || 0), 0);
    const totalCollected = paid
        .reduce((s, inv) => s + parseFloat(inv.amount_paid || 0), 0);

    return {
        billed:           totalBilled,
        collected:        totalCollected,
        realization_rate: totalBilled > 0 ? totalCollected / totalBilled : 0,
    };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    getAuthUrl,
    exchangeCode,
    refreshToken,
    getValidToken,
    setRocketMatterKey,
    getTimeEntries,
    getUnbilledEntries,
    getActivities,
    getMatters,
    createInvoiceDraft,
    getInvoices,
    getRealizationRate,
};
