/**
 * GRIDHAND Lead Incubator — Follow Up Boss + Zillow Integration
 *
 * All API interactions with Follow Up Boss CRM and Zillow property data.
 * Returns { ok, data, error } from all public functions.
 *
 * FUB API base: https://api.followupboss.com/v1
 * Auth: HTTP Basic with API key as username, empty password
 *
 * Zillow API base: https://www.zillow.com/webservice/GetSearchResults.aspx
 * Auth: ZWSID query parameter
 */

'use strict';

const axios  = require('axios');
const crypto = require('crypto');
const db     = require('./db');

const FUB_BASE = 'https://api.followupboss.com/v1';

// ─── HTTP Helper ──────────────────────────────────────────────────────────────

/**
 * Make an authenticated request to the Follow Up Boss API.
 * The client's FUB API key is fetched from the database.
 *
 * @param {string} clientSlug
 * @param {string} method  GET | POST | PUT | PATCH | DELETE
 * @param {string} path    e.g. '/people/123'
 * @param {object} [data]  request body for POST/PUT/PATCH
 * @returns {{ ok: boolean, data: any, error: string|null }}
 */
async function fubRequest(clientSlug, method, path, data = null) {
    let apiKey;
    try {
        const client = await db.getClientBySlug(clientSlug);
        if (!client) {
            return { ok: false, data: null, error: `No client found: ${clientSlug}` };
        }
        apiKey = client.fub_api_key;
        if (!apiKey) {
            return { ok: false, data: null, error: `No FUB API key for client: ${clientSlug}` };
        }
    } catch (err) {
        return { ok: false, data: null, error: `DB error loading client: ${err.message}` };
    }

    const config = {
        method:  method.toLowerCase(),
        url:     `${FUB_BASE}${path}`,
        headers: {
            'Content-Type': 'application/json',
            'Accept':       'application/json',
        },
        // FUB uses HTTP Basic: API key as username, password empty
        auth: {
            username: apiKey,
            password: '',
        },
        timeout: 15000,
    };

    if (data) config.data = data;

    try {
        const response = await axios(config);
        return { ok: true, data: response.data, error: null };
    } catch (err) {
        const status  = err.response?.status;
        const message = err.response?.data?.message || err.message;
        console.error(`[FUB] ${method} ${path} failed (${status}): ${message}`);
        return { ok: false, data: null, error: `FUB API error ${status}: ${message}` };
    }
}

// ─── People / Lead Operations ─────────────────────────────────────────────────

/**
 * Get a person/lead from Follow Up Boss by their FUB person ID.
 * @returns {{ ok, data: FUBPerson|null, error }}
 */
async function getPerson(clientSlug, personId) {
    return fubRequest(clientSlug, 'GET', `/people/${personId}`);
}

/**
 * Create a note on a FUB person record.
 * @param {string} note  Plain text note content
 * @returns {{ ok, data, error }}
 */
async function createNote(clientSlug, personId, note) {
    return fubRequest(clientSlug, 'POST', '/notes', {
        personId: parseInt(personId, 10),
        body:     note,
        isHtml:   false,
    });
}

/**
 * Update fields on a FUB person record.
 * @param {object} updates  Key/value pairs to update (FUB field names)
 * @returns {{ ok, data, error }}
 */
async function updatePerson(clientSlug, personId, updates) {
    return fubRequest(clientSlug, 'PUT', `/people/${personId}`, updates);
}

/**
 * Create a follow-up task on a FUB person record.
 * @param {object} task  { description, dueDate (ISO), assignedTo? }
 * @returns {{ ok, data, error }}
 */
async function createTask(clientSlug, personId, task) {
    return fubRequest(clientSlug, 'POST', '/tasks', {
        personId:    parseInt(personId, 10),
        description: task.description,
        dueDate:     task.dueDate || null,
        assignedTo:  task.assignedTo || null,
        isCompleted: false,
    });
}

/**
 * Get leads created after a given timestamp.
 * @param {string} since  ISO 8601 timestamp, e.g. '2024-01-15T00:00:00Z'
 * @returns {{ ok, data: FUBPerson[], error }}
 */
async function getNewLeads(clientSlug, since) {
    const params = new URLSearchParams({
        sort:  '-created',
        limit: '100',
    });
    if (since) params.set('createdAfter', since);

    const result = await fubRequest(clientSlug, 'GET', `/people?${params.toString()}`);
    if (!result.ok) return result;

    const people = result.data?.people || [];
    return { ok: true, data: people, error: null };
}

/**
 * Search for a person in FUB by phone number.
 * @returns {{ ok, data: FUBPerson|null, error }}
 */
async function findPersonByPhone(clientSlug, phone) {
    const normalized = phone.replace(/\D/g, '');
    const result = await fubRequest(clientSlug, 'GET', `/people?phone=${encodeURIComponent(normalized)}&limit=1`);
    if (!result.ok) return result;

    const people = result.data?.people || [];
    return { ok: true, data: people[0] || null, error: null };
}

/**
 * Update a person's stage in FUB (e.g., 'Lead', 'Prospect', 'Active Buyer').
 * @returns {{ ok, data, error }}
 */
async function updatePersonStage(clientSlug, personId, stage) {
    return fubRequest(clientSlug, 'PUT', `/people/${personId}`, { stage });
}

/**
 * Log an outbound SMS event to FUB as a text message activity.
 * @returns {{ ok, data, error }}
 */
async function logSmsActivity(clientSlug, personId, messageBody, direction = 'outbound') {
    return fubRequest(clientSlug, 'POST', '/textMessages', {
        personId:  parseInt(personId, 10),
        message:   messageBody,
        isInbound: direction === 'inbound',
    });
}

// ─── Zillow Property Enrichment ───────────────────────────────────────────────

/**
 * Look up a property on Zillow by address to get estimated value and details.
 * Uses the Zillow Web Services (ZWSID) API.
 *
 * @param {string} address   Street address (e.g., '2114 Bigelow Ave')
 * @param {string} [citystatezip]  City, state, zip (e.g., 'Seattle, WA 98102')
 * @param {string} [zwsid]   Override ZWSID key (otherwise uses env var)
 * @returns {{ ok, data: ZillowProperty|null, error }}
 */
async function enrichWithZillow(address, citystatezip = '', zwsid = null) {
    const zwsKey = zwsid || process.env.ZILLOW_WSID;
    if (!zwsKey) {
        return { ok: false, data: null, error: 'ZILLOW_WSID not configured' };
    }

    const params = new URLSearchParams({
        'zws-id': zwsKey,
        address:  address,
        citystatezip: citystatezip,
        rentzestimate: 'false',
    });

    try {
        const response = await axios.get(
            `https://www.zillow.com/webservice/GetSearchResults.aspx?${params.toString()}`,
            { timeout: 10000, headers: { 'Accept': 'application/xml' } }
        );

        const xml = response.data;

        // Parse key fields from the Zillow XML response
        const estimatedValue = extractXmlValue(xml, 'zestimate', 'amount') ||
                               extractXmlValue(xml, 'amount');
        const bedrooms    = extractXmlValue(xml, 'bedrooms');
        const bathrooms   = extractXmlValue(xml, 'bathrooms');
        const sqft        = extractXmlValue(xml, 'finishedSqFt');
        const yearBuilt   = extractXmlValue(xml, 'yearBuilt');
        const zillowId    = extractXmlValue(xml, 'zpid');
        const zillowUrl   = extractXmlValue(xml, 'homeDetailsLink');

        const data = {
            estimatedValue: estimatedValue ? parseInt(estimatedValue, 10) : null,
            bedrooms:       bedrooms       ? parseInt(bedrooms, 10)       : null,
            bathrooms:      bathrooms      ? parseFloat(bathrooms)         : null,
            sqft:           sqft           ? parseInt(sqft, 10)            : null,
            yearBuilt:      yearBuilt      ? parseInt(yearBuilt, 10)       : null,
            zpid:           zillowId       || null,
            zillowUrl:      zillowUrl      || null,
        };

        return { ok: true, data, error: null };
    } catch (err) {
        // Zillow may 404 for unknown addresses — not a fatal error
        const status  = err.response?.status;
        const message = err.message;
        console.warn(`[Zillow] Lookup failed for "${address}" (${status}): ${message}`);
        return { ok: false, data: null, error: `Zillow lookup failed: ${message}` };
    }
}

// ─── Webhook Signature Verification ──────────────────────────────────────────

/**
 * Verify an HMAC-SHA256 signature from Follow Up Boss.
 * FUB sends: X-FUB-Signature: sha256=<hex_digest>
 *
 * @param {Buffer|string} rawBody  Raw request body (Buffer preferred)
 * @param {string} signature       Value of X-FUB-Signature header
 * @param {string} secret          Webhook secret from FUB developer settings
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signature, secret) {
    if (!signature || !secret) return false;

    // FUB signature format: "sha256=<hex>"
    const sigValue = signature.startsWith('sha256=') ? signature.slice(7) : signature;

    const body   = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
    const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');

    // Constant-time comparison to prevent timing attacks
    try {
        return crypto.timingSafeEqual(
            Buffer.from(digest, 'hex'),
            Buffer.from(sigValue.padEnd(digest.length, '0').slice(0, digest.length), 'hex')
        );
    } catch {
        // Buffer length mismatch means signature is definitely wrong
        return false;
    }
}

// ─── XML Utility ─────────────────────────────────────────────────────────────

/**
 * Extract a value from an XML string by tag name (very lightweight).
 * For production with complex XML, use a proper XML parser.
 */
function extractXmlValue(xml, ...tags) {
    for (const tag of tags) {
        const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 'i'));
        if (match) return match[1].trim();
    }
    return null;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    fubRequest,
    getPerson,
    createNote,
    updatePerson,
    createTask,
    getNewLeads,
    findPersonByPhone,
    updatePersonStage,
    logSmsActivity,
    enrichWithZillow,
    verifyWebhookSignature,
};
