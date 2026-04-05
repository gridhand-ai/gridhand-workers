/**
 * GRIDHAND Churn Blocker — Mindbody API v6 Integration
 *
 * Handles all communication with the Mindbody public API.
 * Auth: Api-Key header + SiteId header per request.
 *
 * All functions return { ok: true, data } or { ok: false, error, status }.
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');

const BASE_URL = 'https://api.mindbodyonline.com/public/v6';

// ─── Core HTTP Wrapper ────────────────────────────────────────────────────────

/**
 * Perform a GET request against the Mindbody API.
 * @param {string} siteId   - Mindbody site ID (e.g. "-99" for sandbox)
 * @param {string} apiKey   - Mindbody API key (from developer portal)
 * @param {string} path     - API path e.g. "/client/clients"
 * @param {object} params   - Query parameters
 */
async function mindbodyGet(siteId, apiKey, path, params = {}) {
    try {
        const response = await axios.get(`${BASE_URL}${path}`, {
            headers: {
                'Api-Key': apiKey,
                'SiteId':  String(siteId),
                'Content-Type': 'application/json',
            },
            params,
            timeout: 15000,
        });

        return { ok: true, data: response.data };
    } catch (err) {
        const status  = err.response?.status;
        const message = err.response?.data?.Error?.Message || err.message;
        console.error(`[Mindbody] GET ${path} failed — ${status}: ${message}`);
        return { ok: false, error: message, status: status || 500 };
    }
}

// ─── Client (Member) Endpoints ────────────────────────────────────────────────

/**
 * Fetch clients (members) from Mindbody.
 * Supports pagination via Offset and limit via Limit.
 * @param {object} params - Optional: { Offset, Limit, ActiveOnly, SearchText }
 */
async function getClients(siteId, apiKey, params = {}) {
    const defaults = { Limit: 200, ActiveOnly: true, ...params };
    return mindbodyGet(siteId, apiKey, '/client/clients', defaults);
}

/**
 * Fetch all visit records for a specific member.
 * @param {string} clientId  - Mindbody client ID
 * @param {string} startDate - ISO date string e.g. "2024-01-01"
 * @param {string} endDate   - ISO date string e.g. "2024-12-31"
 */
async function getClientVisits(siteId, apiKey, clientId, startDate, endDate) {
    return mindbodyGet(siteId, apiKey, '/client/clientvisits', {
        ClientId:  clientId,
        StartDate: startDate,
        EndDate:   endDate,
        Limit:     500,
    });
}

// ─── Class Endpoints ──────────────────────────────────────────────────────────

/**
 * Fetch scheduled classes within a date range.
 */
async function getClasses(siteId, apiKey, startDate, endDate) {
    return mindbodyGet(siteId, apiKey, '/class/classes', {
        StartDateTime: startDate,
        EndDateTime:   endDate,
        Limit:         200,
    });
}

/**
 * Fetch attendance roster for a specific class.
 * @param {number|string} classId - Mindbody class ID
 */
async function getClassAttendance(siteId, apiKey, classId) {
    return mindbodyGet(siteId, apiKey, '/class/classattendance', {
        ClassId: classId,
    });
}

// ─── Sales Endpoints ──────────────────────────────────────────────────────────

/**
 * Fetch available services/memberships for sale.
 */
async function getServices(siteId, apiKey) {
    return mindbodyGet(siteId, apiKey, '/sale/services', { Limit: 200 });
}

// ─── High-Level Helper ────────────────────────────────────────────────────────

/**
 * Fetch all active members and determine which are inactive.
 *
 * Strategy:
 *   1. Pull all active clients (paginated)
 *   2. For each client, fetch visits in the last (thresholdDays + 30) day window
 *   3. Find the most recent visit date
 *   4. If daysSinceLastVisit >= thresholdDays → flag as inactive
 *
 * Returns array of:
 *   { clientId, firstName, lastName, phone, email, lastVisitDate, daysSinceVisit }
 *
 * Note: This is intentionally conservative on API calls. For large gyms (1000+
 * members) you may want to index visit dates in your local cb_members table
 * and only call Mindbody for delta updates.
 */
async function getInactiveMembers(siteId, apiKey, thresholdDays = 7) {
    const inactiveMembers = [];
    const today     = dayjs();
    const lookback  = today.subtract(thresholdDays + 60, 'day').format('YYYY-MM-DD');
    const todayStr  = today.format('YYYY-MM-DD');

    // ── Step 1: Paginate through all active clients ──
    let offset = 0;
    const pageSize = 200;
    let allClients = [];

    while (true) {
        const result = await getClients(siteId, apiKey, {
            Offset:     offset,
            Limit:      pageSize,
            ActiveOnly: true,
        });

        if (!result.ok) {
            console.error(`[Mindbody] getInactiveMembers: failed to fetch clients at offset ${offset}`);
            break;
        }

        const page = result.data.Clients || [];
        allClients = allClients.concat(page);

        // Mindbody returns PaginationResponse.TotalResults
        const total = result.data.PaginationResponse?.TotalResults || 0;
        offset += pageSize;
        if (offset >= total || page.length === 0) break;
    }

    console.log(`[Mindbody] Fetched ${allClients.length} active members for site ${siteId}`);

    // ── Step 2: Check each client's last visit ──
    for (const client of allClients) {
        // Skip clients with no phone number — we can't SMS them
        const phone = client.MobilePhone || client.HomePhone || client.WorkPhone;
        if (!phone) continue;

        const visitsResult = await getClientVisits(
            siteId,
            apiKey,
            client.UniqueId || client.Id,
            lookback,
            todayStr
        );

        let lastVisitDate = null;
        let daysSinceVisit = 9999;

        if (visitsResult.ok) {
            const visits = visitsResult.data.Visits || [];

            // Find the most recent visit that was actually attended (not cancelled)
            const attended = visits
                .filter(v => v.SignedIn === true || v.LateCancelled === false)
                .map(v => dayjs(v.StartDateTime || v.ClassDate))
                .filter(d => d.isValid());

            if (attended.length > 0) {
                const latest = attended.reduce((a, b) => (a.isAfter(b) ? a : b));
                lastVisitDate  = latest.format('YYYY-MM-DD');
                daysSinceVisit = today.diff(latest, 'day');
            } else {
                // Member has never visited (within our lookback window)
                // Use account creation date as proxy if visits is empty
                daysSinceVisit = thresholdDays; // treat as exactly at threshold
            }
        } else {
            // API error for this client — skip rather than false-positive
            console.warn(`[Mindbody] Could not fetch visits for client ${client.UniqueId}: ${visitsResult.error}`);
            continue;
        }

        if (daysSinceVisit >= thresholdDays) {
            inactiveMembers.push({
                clientId:      String(client.UniqueId || client.Id),
                firstName:     client.FirstName || '',
                lastName:      client.LastName || '',
                email:         client.Email || null,
                phone:         sanitizePhone(phone),
                lastVisitDate: lastVisitDate,
                daysSinceVisit,
            });
        }
    }

    console.log(`[Mindbody] Found ${inactiveMembers.length} inactive members (threshold: ${thresholdDays} days)`);
    return inactiveMembers;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Strip non-numeric chars and ensure E.164 format for US numbers.
 */
function sanitizePhone(raw) {
    if (!raw) return null;
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return `+${digits}`; // return as-is for international
}

module.exports = {
    mindbodyGet,
    getClients,
    getClientVisits,
    getClasses,
    getClassAttendance,
    getServices,
    getInactiveMembers,
    sanitizePhone,
};
