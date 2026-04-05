'use strict';

/**
 * AMS Integration — HawkSoft v3 + Applied Epic
 *
 * Pulls client book of business data: clients, policies, coverage details.
 * Both providers return normalized output so the analyzer never needs to
 * know which AMS is in use.
 */

const axios = require('axios');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildHeaders(token, extra = {}) {
    return {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...extra,
    };
}

async function paginate(fetchPage, maxPages = 100) {
    const results = [];
    let page = 1;

    while (page <= maxPages) {
        const { items, hasMore } = await fetchPage(page);
        results.push(...items);
        if (!hasMore) break;
        page++;
    }

    return results;
}

// ---------------------------------------------------------------------------
// Policy line normalizer
// Maps AMS-specific codes → our canonical line-of-business strings
// ---------------------------------------------------------------------------

const HAWKSOFT_LOB_MAP = {
    'AUTO':         'auto',
    'HO':           'home',
    'HO3':          'home',
    'HO6':          'condo',
    'RENT':         'renters',
    'UMBRELLA':     'umbrella',
    'FLOOD':        'flood',
    'LIFE':         'life',
    'TERM':         'life',
    'WL':           'life',
    'DISABILITY':   'disability',
    'HEALTH':       'health',
    'MEDICARE':     'medicare_supplement',
    'COMMERCIAL':   'commercial',
    'BOP':          'commercial',
    'GL':           'commercial',
    'WORK_COMP':    'workers_comp',
    'CYBER':        'cyber',
    'BOAT':         'boat',
    'MOTORCYCLE':   'motorcycle',
    'RV':           'rv',
    'ANNUITY':      'annuity',
};

const APPLIED_LOB_MAP = {
    'PersonalAuto':         'auto',
    'Homeowners':           'home',
    'Condo':                'condo',
    'Renters':              'renters',
    'PersonalUmbrella':     'umbrella',
    'Flood':                'flood',
    'Life':                 'life',
    'TermLife':             'life',
    'WholeLife':            'life',
    'Disability':           'disability',
    'Health':               'health',
    'MedicareSupp':         'medicare_supplement',
    'CommercialAuto':       'commercial_auto',
    'BusinessOwners':       'commercial',
    'GeneralLiability':     'commercial',
    'WorkersComp':          'workers_comp',
    'Cyber':                'cyber',
    'Boat':                 'boat',
    'Motorcycle':           'motorcycle',
    'Annuity':              'annuity',
};

function normalizeLob(raw, amsType) {
    const map = amsType === 'hawksoft' ? HAWKSOFT_LOB_MAP : APPLIED_LOB_MAP;
    return map[raw] || raw?.toLowerCase().replace(/\s+/g, '_') || 'unknown';
}

// ---------------------------------------------------------------------------
// HawkSoft v3 API
// Docs: https://api.hawksoft.com/v3/docs
// ---------------------------------------------------------------------------

class HawkSoftClient {
    constructor({ agencyId, clientId, clientSecret, baseUrl }) {
        this.agencyId     = agencyId;
        this.clientId     = clientId;
        this.clientSecret = clientSecret;
        this.baseUrl      = baseUrl || 'https://api.hawksoft.com/v3';
        this._token       = null;
        this._tokenExpiry = 0;
    }

    async authenticate() {
        if (this._token && Date.now() < this._tokenExpiry) return this._token;

        const res = await axios.post(`${this.baseUrl}/auth/token`, {
            grant_type:    'client_credentials',
            client_id:     this.clientId,
            client_secret: this.clientSecret,
            agency_id:     this.agencyId,
        }, {
            headers: { 'Content-Type': 'application/json' },
        });

        this._token       = res.data.access_token;
        this._tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
        return this._token;
    }

    async get(path, params = {}) {
        const token = await this.authenticate();
        const res   = await axios.get(`${this.baseUrl}${path}`, {
            headers: buildHeaders(token, { 'X-Agency-ID': this.agencyId }),
            params,
        });
        return res.data;
    }

    // Fetch all clients in the agency's book
    async getClients() {
        return paginate(async (page) => {
            const data = await this.get('/clients', { page, per_page: 100, status: 'active' });
            return {
                items:   data.clients || [],
                hasMore: data.pagination?.has_next_page || false,
            };
        });
    }

    // Fetch a single client record
    async getClient(clientId) {
        return this.get(`/clients/${clientId}`);
    }

    // Fetch all policies for a client
    async getPoliciesForClient(clientId) {
        const data = await this.get(`/clients/${clientId}/policies`, { status: 'active' });
        return data.policies || [];
    }

    // Fetch all policies across all clients (efficient batch endpoint)
    async getAllPolicies(since) {
        const params = { per_page: 200 };
        if (since) params.updated_since = since;

        return paginate(async (page) => {
            const data = await this.get('/policies', { ...params, page });
            return {
                items:   data.policies || [],
                hasMore: data.pagination?.has_next_page || false,
            };
        });
    }

    // Normalize HawkSoft client → our schema
    normalizeClient(raw) {
        return {
            ams_client_id: String(raw.client_id || raw.id),
            full_name:     `${raw.first_name || ''} ${raw.last_name || ''}`.trim() || raw.name,
            email:         raw.email || null,
            phone:         raw.phone || raw.cell_phone || null,
            date_of_birth: raw.date_of_birth || null,
            client_since:  raw.client_since || null,
            address: {
                street: raw.address?.street1 || null,
                city:   raw.address?.city    || null,
                state:  raw.address?.state   || null,
                zip:    raw.address?.zip     || null,
            },
            ams_raw: raw,
        };
    }

    // Normalize HawkSoft policy → our schema
    normalizePolicy(raw) {
        return {
            ams_policy_id:    String(raw.policy_id || raw.id),
            ams_client_id:    String(raw.client_id),
            line_of_business: normalizeLob(raw.line_of_business || raw.lob, 'hawksoft'),
            carrier:          raw.carrier_name || raw.carrier || null,
            policy_number:    raw.policy_number || null,
            effective_date:   raw.effective_date || null,
            expiration_date:  raw.expiration_date || null,
            annual_premium:   parseFloat(raw.annual_premium || raw.premium || 0),
            coverage_limit:   parseFloat(raw.coverage_limit || 0),
            deductible:       parseFloat(raw.deductible || 0),
            status:           raw.status?.toLowerCase() || 'active',
            coverage_details: raw.coverages || raw.coverage_details || {},
            ams_raw:          raw,
        };
    }
}

// ---------------------------------------------------------------------------
// Applied Epic API
// Docs: REST API with OAuth2 — base URL varies by Epic server install
// ---------------------------------------------------------------------------

class AppliedEpicClient {
    constructor({ serverUrl, clientId, clientSecret, agencyId }) {
        this.serverUrl    = serverUrl || 'https://api.appliedsystems.com/epic/v1';
        this.clientId     = clientId;
        this.clientSecret = clientSecret;
        this.agencyId     = agencyId;
        this._token       = null;
        this._tokenExpiry = 0;
    }

    async authenticate() {
        if (this._token && Date.now() < this._tokenExpiry) return this._token;

        const params = new URLSearchParams({
            grant_type:    'client_credentials',
            client_id:     this.clientId,
            client_secret: this.clientSecret,
        });

        const res = await axios.post(`${this.serverUrl}/oauth/token`, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        this._token       = res.data.access_token;
        this._tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
        return this._token;
    }

    async get(path, params = {}) {
        const token = await this.authenticate();
        const res   = await axios.get(`${this.serverUrl}${path}`, {
            headers: buildHeaders(token),
            params:  { agencyCode: this.agencyId, ...params },
        });
        return res.data;
    }

    async getClients() {
        return paginate(async (page) => {
            const data = await this.get('/clients', { pageNumber: page, pageSize: 100 });
            return {
                items:   data.data || data.clients || [],
                hasMore: (data.pagination?.currentPage || page) < (data.pagination?.totalPages || 1),
            };
        });
    }

    async getClient(clientCode) {
        return this.get(`/clients/${clientCode}`);
    }

    async getPoliciesForClient(clientCode) {
        const data = await this.get(`/clients/${clientCode}/policies`);
        return data.data || data.policies || [];
    }

    async getAllPolicies(since) {
        const params = { pageSize: 200, status: 'Active' };
        if (since) params.lastModifiedFrom = since;

        return paginate(async (page) => {
            const data = await this.get('/policies', { ...params, pageNumber: page });
            return {
                items:   data.data || [],
                hasMore: page < (data.pagination?.totalPages || 1),
            };
        });
    }

    normalizeClient(raw) {
        const name = raw.clientName || `${raw.firstName || ''} ${raw.lastName || ''}`.trim();
        return {
            ams_client_id: String(raw.clientCode || raw.id),
            full_name:     name,
            email:         raw.emailAddress || raw.email || null,
            phone:         raw.phoneNumber  || raw.phone || null,
            date_of_birth: raw.dateOfBirth  || null,
            client_since:  raw.clientSince  || null,
            address: {
                street: raw.address?.addressLine1 || null,
                city:   raw.address?.city         || null,
                state:  raw.address?.state        || null,
                zip:    raw.address?.postalCode   || null,
            },
            ams_raw: raw,
        };
    }

    normalizePolicy(raw) {
        return {
            ams_policy_id:    String(raw.policyId || raw.id),
            ams_client_id:    String(raw.clientCode || raw.clientId),
            line_of_business: normalizeLob(raw.lineOfBusiness || raw.lob, 'applied_epic'),
            carrier:          raw.carrierName || raw.company || null,
            policy_number:    raw.policyNumber || null,
            effective_date:   raw.effectiveDate   || null,
            expiration_date:  raw.expirationDate  || null,
            annual_premium:   parseFloat(raw.annualPremium || raw.writtenPremium || 0),
            coverage_limit:   parseFloat(raw.coverageLimit || 0),
            deductible:       parseFloat(raw.deductible    || 0),
            status:           (raw.status || 'Active').toLowerCase(),
            coverage_details: raw.coverages || {},
            ams_raw:          raw,
        };
    }
}

// ---------------------------------------------------------------------------
// Public API — createAMSClient + sync helpers
// ---------------------------------------------------------------------------

function createAMSClient(agency) {
    const { ams_type, ams_credentials } = agency;

    if (ams_type === 'hawksoft') {
        return new HawkSoftClient({
            agencyId:     ams_credentials.agency_id,
            clientId:     ams_credentials.client_id,
            clientSecret: ams_credentials.client_secret,
            baseUrl:      ams_credentials.base_url,
        });
    }

    if (ams_type === 'applied_epic') {
        return new AppliedEpicClient({
            serverUrl:    ams_credentials.server_url,
            clientId:     ams_credentials.client_id,
            clientSecret: ams_credentials.client_secret,
            agencyId:     ams_credentials.agency_id,
        });
    }

    throw new Error(`Unsupported AMS type: "${ams_type}". Supported: hawksoft, applied_epic`);
}

/**
 * Pull full book of business from AMS and return normalized arrays.
 *
 * @returns {{ clients: [], policies: [] }}
 */
async function syncBookOfBusiness(agency) {
    const ams = createAMSClient(agency);

    console.log(`[AMS:${agency.ams_type}] Fetching clients for agency: ${agency.slug}`);
    const rawClients = await ams.getClients();

    console.log(`[AMS:${agency.ams_type}] Found ${rawClients.length} clients`);
    const clients = rawClients.map(c => ams.normalizeClient(c));

    console.log(`[AMS:${agency.ams_type}] Fetching all policies`);
    const rawPolicies = await ams.getAllPolicies();

    const policies = rawPolicies.map(p => ams.normalizePolicy(p));
    console.log(`[AMS:${agency.ams_type}] Found ${policies.length} policies`);

    return { clients, policies };
}

/**
 * Pull incremental updates since a given timestamp.
 * Used for daily delta syncs rather than full book pulls.
 */
async function syncDelta(agency, since) {
    const ams = createAMSClient(agency);

    const rawPolicies  = await ams.getAllPolicies(since);
    const policies     = rawPolicies.map(p => ams.normalizePolicy(p));

    // For each unique client touched in the delta, fetch fresh client record
    const clientIds    = [...new Set(policies.map(p => p.ams_client_id))];
    const rawClients   = await Promise.all(clientIds.map(id => ams.getClient(id).catch(() => null)));
    const clients      = rawClients.filter(Boolean).map(c => ams.normalizeClient(c));

    return { clients, policies };
}

module.exports = { createAMSClient, syncBookOfBusiness, syncDelta, normalizeLob };
