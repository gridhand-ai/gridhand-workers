/**
 * GRIDHAND AI — Claims Shepherd
 * AMS Integration Module
 *
 * Supports:
 *   - HawkSoft API v3
 *   - Applied Epic API
 *   - Manual entry fallback
 */

'use strict';

const axios = require('axios');

// ============================================================
// HAWKSOFT API v3
// Docs: https://developer.hawksoft.com/docs/v3
// ============================================================

const HAWKSOFT_BASE = 'https://api.hawksoft.com/v3';

async function hawksoftRequest(method, path, apiKey, data = null) {
    try {
        const response = await axios({
            method,
            url: `${HAWKSOFT_BASE}${path}`,
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-HawkSoft-Agency': process.env.HAWKSOFT_AGENCY_ID || ''
            },
            data: data || undefined,
            timeout: 15000
        });
        return { ok: true, data: response.data };
    } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data?.message || err.message;
        console.error(`[AMS:HawkSoft] ${method} ${path} → ${status} ${msg}`);
        return { ok: false, error: msg, status };
    }
}

const hawksoft = {
    /**
     * Get a policy by policy number
     */
    async getPolicy(apiKey, policyNumber) {
        return hawksoftRequest('GET', `/policies?policyNumber=${encodeURIComponent(policyNumber)}`, apiKey);
    },

    /**
     * Get a policy by AMS policy ID
     */
    async getPolicyById(apiKey, policyId) {
        return hawksoftRequest('GET', `/policies/${policyId}`, apiKey);
    },

    /**
     * Get a claim by AMS claim ID
     */
    async getClaim(apiKey, claimId) {
        return hawksoftRequest('GET', `/claims/${claimId}`, apiKey);
    },

    /**
     * List recent claims — used for sync / auto-detection
     * @param {string} since - ISO datetime string
     */
    async listRecentClaims(apiKey, since) {
        const sinceParam = since ? `&since=${encodeURIComponent(since)}` : '';
        return hawksoftRequest('GET', `/claims?status=new,open${sinceParam}&limit=100`, apiKey);
    },

    /**
     * Create a claim record in HawkSoft after filing FNOL
     */
    async createClaim(apiKey, claimPayload) {
        return hawksoftRequest('POST', '/claims', apiKey, claimPayload);
    },

    /**
     * Update claim status in HawkSoft
     */
    async updateClaim(apiKey, claimId, updates) {
        return hawksoftRequest('PATCH', `/claims/${claimId}`, apiKey, updates);
    },

    /**
     * Get insured contact info
     */
    async getInsured(apiKey, insuredId) {
        return hawksoftRequest('GET', `/contacts/${insuredId}`, apiKey);
    },

    /**
     * Search insured by phone number (for inbound SMS claim detection)
     */
    async findInsuredByPhone(apiKey, phone) {
        const normalized = phone.replace(/\D/g, '');
        return hawksoftRequest('GET', `/contacts?phone=${normalized}`, apiKey);
    },

    /**
     * Get carrier info for a policy
     */
    async getPolicyCarrier(apiKey, policyId) {
        return hawksoftRequest('GET', `/policies/${policyId}/carrier`, apiKey);
    },

    /**
     * Attach a document to a claim record
     */
    async attachDocument(apiKey, claimId, docMeta) {
        return hawksoftRequest('POST', `/claims/${claimId}/documents`, apiKey, docMeta);
    }
};

// ============================================================
// APPLIED EPIC API
// Docs: https://developer.appliedepic.com/
// ============================================================

const EPIC_BASE = 'https://api.appliedsystems.com/epic/v1';

async function epicRequest(method, path, token, agencyId, data = null) {
    try {
        const response = await axios({
            method,
            url: `${EPIC_BASE}${path}`,
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-Applied-Agency-Id': agencyId,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            data: data || undefined,
            timeout: 15000
        });
        return { ok: true, data: response.data };
    } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data?.errorMessage || err.message;
        console.error(`[AMS:Epic] ${method} ${path} → ${status} ${msg}`);
        return { ok: false, error: msg, status };
    }
}

const appliedEpic = {
    /**
     * OAuth2 token exchange — call once and cache token
     */
    async getToken(clientId, clientSecret) {
        try {
            const response = await axios.post(
                'https://api.appliedsystems.com/oauth2/token',
                new URLSearchParams({
                    grant_type: 'client_credentials',
                    client_id: clientId,
                    client_secret: clientSecret,
                    scope: 'claims:read claims:write policies:read contacts:read'
                }),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
            );
            return { ok: true, token: response.data.access_token, expiresIn: response.data.expires_in };
        } catch (err) {
            return { ok: false, error: err.response?.data?.error || err.message };
        }
    },

    async getPolicy(token, agencyId, policyNumber) {
        return epicRequest('GET', `/policies?policyNumber=${encodeURIComponent(policyNumber)}`, token, agencyId);
    },

    async getClaim(token, agencyId, claimId) {
        return epicRequest('GET', `/claims/${claimId}`, token, agencyId);
    },

    async listRecentClaims(token, agencyId, since) {
        const sinceParam = since ? `&modifiedSince=${encodeURIComponent(since)}` : '';
        return epicRequest('GET', `/claims?statusGroup=open${sinceParam}&top=100`, token, agencyId);
    },

    async createClaim(token, agencyId, claimPayload) {
        return epicRequest('POST', '/claims', token, agencyId, claimPayload);
    },

    async updateClaim(token, agencyId, claimId, updates) {
        return epicRequest('PATCH', `/claims/${claimId}`, token, agencyId, updates);
    },

    async findInsuredByPhone(token, agencyId, phone) {
        const normalized = phone.replace(/\D/g, '');
        return epicRequest('GET', `/contacts?phoneNumber=${normalized}`, token, agencyId);
    },

    async attachDocument(token, agencyId, claimId, docMeta) {
        return epicRequest('POST', `/claims/${claimId}/attachments`, token, agencyId, docMeta);
    }
};

// ============================================================
// UNIFIED AMS INTERFACE
// Abstracts HawkSoft vs Applied Epic behind one API
// ============================================================

class AMSClient {
    constructor(clientConfig) {
        this.type = clientConfig.ams_type;           // 'hawksoft' | 'applied_epic' | 'manual'
        this.apiKey = clientConfig.ams_api_key;
        this.agencyId = clientConfig.ams_agency_id;
        this._epicToken = null;
        this._epicTokenExpires = null;
    }

    async _getEpicToken() {
        if (this._epicToken && this._epicTokenExpires > Date.now()) {
            return this._epicToken;
        }
        // apiKey stores clientId:clientSecret for Epic
        const [clientId, clientSecret] = (this.apiKey || '').split(':');
        const result = await appliedEpic.getToken(clientId, clientSecret);
        if (!result.ok) throw new Error(`Epic auth failed: ${result.error}`);
        this._epicToken = result.token;
        this._epicTokenExpires = Date.now() + (result.expiresIn - 60) * 1000;
        return this._epicToken;
    }

    async getPolicy(policyNumber) {
        if (this.type === 'hawksoft') {
            return hawksoft.getPolicy(this.apiKey, policyNumber);
        }
        if (this.type === 'applied_epic') {
            const token = await this._getEpicToken();
            return appliedEpic.getPolicy(token, this.agencyId, policyNumber);
        }
        return { ok: false, error: 'Manual AMS — no API available' };
    }

    async getClaim(claimId) {
        if (this.type === 'hawksoft') {
            return hawksoft.getClaim(this.apiKey, claimId);
        }
        if (this.type === 'applied_epic') {
            const token = await this._getEpicToken();
            return appliedEpic.getClaim(token, this.agencyId, claimId);
        }
        return { ok: false, error: 'Manual AMS — no API available' };
    }

    async listRecentClaims(since) {
        if (this.type === 'hawksoft') {
            return hawksoft.listRecentClaims(this.apiKey, since);
        }
        if (this.type === 'applied_epic') {
            const token = await this._getEpicToken();
            return appliedEpic.listRecentClaims(token, this.agencyId, since);
        }
        return { ok: true, data: [] };
    }

    async createClaim(payload) {
        if (this.type === 'hawksoft') {
            return hawksoft.createClaim(this.apiKey, payload);
        }
        if (this.type === 'applied_epic') {
            const token = await this._getEpicToken();
            return appliedEpic.createClaim(token, this.agencyId, payload);
        }
        return { ok: false, error: 'Manual AMS — no API available' };
    }

    async updateClaim(claimId, updates) {
        if (this.type === 'hawksoft') {
            return hawksoft.updateClaim(this.apiKey, claimId, updates);
        }
        if (this.type === 'applied_epic') {
            const token = await this._getEpicToken();
            return appliedEpic.updateClaim(token, this.agencyId, claimId, updates);
        }
        return { ok: false, error: 'Manual AMS — no API available' };
    }

    async findInsuredByPhone(phone) {
        if (this.type === 'hawksoft') {
            return hawksoft.findInsuredByPhone(this.apiKey, phone);
        }
        if (this.type === 'applied_epic') {
            const token = await this._getEpicToken();
            return appliedEpic.findInsuredByPhone(token, this.agencyId, phone);
        }
        return { ok: true, data: [] };
    }

    async attachDocument(claimId, docMeta) {
        if (this.type === 'hawksoft') {
            return hawksoft.attachDocument(this.apiKey, claimId, docMeta);
        }
        if (this.type === 'applied_epic') {
            const token = await this._getEpicToken();
            return appliedEpic.attachDocument(token, this.agencyId, claimId, docMeta);
        }
        return { ok: false, error: 'Manual AMS — no API available' };
    }
}

// ============================================================
// AMS SYNC — Detect new claims from AMS data
// ============================================================

/**
 * Normalize a HawkSoft claim record into our internal format
 */
function normalizeHawksoftClaim(raw) {
    return {
        ams_claim_id: raw.id || raw.claimId,
        policy_number: raw.policyNumber,
        policy_id: raw.policyId,
        carrier_code: slugifyCarrier(raw.carrierName || raw.carrier),
        carrier_name: raw.carrierName || raw.carrier || 'Unknown',
        insured_name: raw.insuredName || `${raw.firstName || ''} ${raw.lastName || ''}`.trim(),
        insured_phone: raw.phone || raw.insuredPhone || '',
        insured_email: raw.email || raw.insuredEmail || '',
        insured_address: raw.address || '',
        loss_type: normalizeLossType(raw.lineOfBusiness || raw.lossType),
        loss_date: raw.lossDate || raw.dateOfLoss,
        loss_description: raw.description || raw.lossDescription || '',
        loss_address: raw.lossAddress || raw.locationOfLoss || '',
        police_report_num: raw.policeReportNumber || '',
        estimated_damage: parseFloat(raw.estimatedLoss || raw.damageAmount || 0) || null,
        status: 'detected',
        source: 'ams_sync',
        raw_source_data: raw
    };
}

/**
 * Normalize an Applied Epic claim record
 */
function normalizeEpicClaim(raw) {
    return {
        ams_claim_id: raw.claimId || raw.id,
        policy_number: raw.policyNumber,
        policy_id: raw.policyId,
        carrier_code: slugifyCarrier(raw.company || raw.carrier),
        carrier_name: raw.company || raw.carrier || 'Unknown',
        insured_name: raw.accountName || raw.insuredName || '',
        insured_phone: raw.phoneNumber || raw.insuredPhone || '',
        insured_email: raw.emailAddress || raw.insuredEmail || '',
        insured_address: raw.address?.full || '',
        loss_type: normalizeLossType(raw.lineOfBusiness || raw.coverageType),
        loss_date: raw.lossDate || raw.dateOfLoss,
        loss_description: raw.description || '',
        loss_address: raw.lossLocation || '',
        police_report_num: raw.policeReport || '',
        estimated_damage: parseFloat(raw.reserveAmount || 0) || null,
        status: 'detected',
        source: 'ams_sync',
        raw_source_data: raw
    };
}

function slugifyCarrier(name) {
    if (!name) return 'unknown';
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function normalizeLossType(raw) {
    if (!raw) return 'property';
    const r = raw.toLowerCase();
    if (r.includes('auto') || r.includes('vehicle') || r.includes('car')) return 'auto';
    if (r.includes('worker') || r.includes('comp')) return 'workers_comp';
    if (r.includes('liab')) return 'liability';
    return 'property';
}

module.exports = {
    AMSClient,
    normalizeHawksoftClaim,
    normalizeEpicClaim,
    slugifyCarrier,
    normalizeLossType
};
