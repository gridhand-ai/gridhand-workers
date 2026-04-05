/**
 * GRIDHAND Class Optimizer — Mindbody API v6 Integration
 *
 * Handles all communication with the Mindbody public API.
 * Auth: Api-Key header + SiteId header per request.
 *
 * All public functions return { ok: true, data } or { ok: false, error, status }.
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');

const BASE_URL = 'https://api.mindbodyonline.com/public/v6';

// ─── Core HTTP Wrappers ────────────────────────────────────────────────────────

/**
 * Perform a GET request against the Mindbody API.
 * @param {string} siteId - Mindbody site ID
 * @param {string} apiKey - Mindbody API key
 * @param {string} path   - API path e.g. "/class/classes"
 * @param {object} params - Query parameters
 */
async function mindbodyGet(siteId, apiKey, path, params = {}) {
    try {
        const response = await axios.get(`${BASE_URL}${path}`, {
            headers: {
                'Api-Key':      apiKey,
                'SiteId':       String(siteId),
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

/**
 * Perform a POST request against the Mindbody API.
 * @param {string} siteId - Mindbody site ID
 * @param {string} apiKey - Mindbody API key
 * @param {string} path   - API path
 * @param {object} body   - Request body
 */
async function mindbodyPost(siteId, apiKey, path, body = {}) {
    try {
        const response = await axios.post(`${BASE_URL}${path}`, body, {
            headers: {
                'Api-Key':      apiKey,
                'SiteId':       String(siteId),
                'Content-Type': 'application/json',
            },
            timeout: 15000,
        });
        return { ok: true, data: response.data };
    } catch (err) {
        const status  = err.response?.status;
        const message = err.response?.data?.Error?.Message || err.message;
        console.error(`[Mindbody] POST ${path} failed — ${status}: ${message}`);
        return { ok: false, error: message, status: status || 500 };
    }
}

// ─── Class Endpoints ──────────────────────────────────────────────────────────

/**
 * Fetch scheduled class instances within a date range.
 * Returns paginated results; pass params.Offset to paginate.
 *
 * @param {string} siteId
 * @param {string} apiKey
 * @param {string} startDate - ISO date or datetime e.g. "2025-01-01"
 * @param {string} endDate   - ISO date or datetime e.g. "2025-01-31"
 * @param {object} params    - Additional query params (Offset, Limit, etc.)
 */
async function getClasses(siteId, apiKey, startDate, endDate, params = {}) {
    return mindbodyGet(siteId, apiKey, '/class/classes', {
        StartDateTime: startDate,
        EndDateTime:   endDate,
        Limit:         200,
        ...params,
    });
}

/**
 * Fetch the recurring class schedule (class schedule templates, not instances).
 * Useful for understanding what days/times classes are configured to run.
 *
 * @param {string} siteId
 * @param {string} apiKey
 */
async function getClassSchedule(siteId, apiKey) {
    return mindbodyGet(siteId, apiKey, '/class/classschedules', {
        Limit: 200,
    });
}

/**
 * Fetch full attendance roster for one or more class instances.
 * classIds is a single Mindbody class instance ID (integer).
 *
 * @param {string}         siteId
 * @param {string}         apiKey
 * @param {number|string}  classId - Mindbody class instance ID
 */
async function getClassAttendance(siteId, apiKey, classId) {
    return mindbodyGet(siteId, apiKey, '/class/classattendance', {
        ClassIds: classId,
    });
}

/**
 * Fetch the class description for a given ClassDescriptionId.
 * Descriptions contain the name, category, and program details.
 *
 * @param {string}        siteId
 * @param {string}        apiKey
 * @param {number|string} classDescriptionId
 */
async function getClassDescription(siteId, apiKey, classDescriptionId) {
    return mindbodyGet(siteId, apiKey, '/class/classdescriptions', {
        ClassDescriptionIds: classDescriptionId,
    });
}

/**
 * Cancel a scheduled class instance in Mindbody.
 * Uses the POST endpoint with the cancel action body.
 *
 * @param {string}        siteId
 * @param {string}        apiKey
 * @param {number|string} classId - Mindbody class instance ID to cancel
 */
async function cancelClass(siteId, apiKey, classId) {
    // Mindbody v6 cancels a class by substituting it with "cancelled" status.
    // The standard approach is to call the class cancel endpoint.
    return mindbodyPost(siteId, apiKey, '/class/cancelclass', {
        ClassId: classId,
        SendClientEmails: true,
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch all class instances for the next N days with full pagination.
 * Returns a flat array of Mindbody class objects.
 *
 * @param {string} siteId
 * @param {string} apiKey
 * @param {number} days - How many days ahead to fetch (default: 14)
 */
async function getUpcomingClasses(siteId, apiKey, days = 14) {
    const start = dayjs().format('YYYY-MM-DDT00:00:00');
    const end   = dayjs().add(days, 'day').format('YYYY-MM-DDT23:59:59');

    let offset   = 0;
    const limit  = 200;
    let allItems = [];

    while (true) {
        const result = await getClasses(siteId, apiKey, start, end, {
            Offset: offset,
            Limit:  limit,
        });

        if (!result.ok) {
            console.error(`[Mindbody] getUpcomingClasses failed at offset ${offset}: ${result.error}`);
            break;
        }

        const items = result.data.Classes || [];
        allItems = allItems.concat(items);

        const total = result.data.PaginationResponse?.TotalResults || 0;
        offset += limit;
        if (offset >= total || items.length === 0) break;
    }

    return allItems;
}

/**
 * Fetch all class schedule entries (recurring templates) with pagination.
 *
 * @param {string} siteId
 * @param {string} apiKey
 */
async function getAllClassSchedules(siteId, apiKey) {
    const result = await getClassSchedule(siteId, apiKey);
    if (!result.ok) return [];
    return result.data.ClassSchedules || [];
}

module.exports = {
    mindbodyGet,
    mindbodyPost,
    getClasses,
    getClassSchedule,
    getClassAttendance,
    getClassDescription,
    cancelClass,
    getUpcomingClasses,
    getAllClassSchedules,
};
