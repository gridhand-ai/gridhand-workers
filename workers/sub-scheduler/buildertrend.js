/**
 * GRIDHAND Sub-Scheduler — Buildertrend API Integration
 *
 * Buildertrend uses API key authentication.
 * Fetches scheduled tasks and subcontractor assignments.
 * Docs: https://developer.buildertrend.net/
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');

const BT_BASE = 'https://api.buildertrend.net/v1';

function getHeaders(apiKey) {
    return {
        Authorization: `Bearer ${apiKey}`,
        Accept:        'application/json',
    };
}

// ─── Schedule Items ───────────────────────────────────────────────────────────

/**
 * Get scheduled items within a date range.
 * @param {string} apiKey
 * @param {string} companyId
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 */
async function getScheduleItems(apiKey, companyId, startDate, endDate) {
    try {
        const resp = await axios.get(`${BT_BASE}/schedule`, {
            headers: getHeaders(apiKey),
            params: {
                companyId,
                startDate,
                endDate,
                includeSubItems: true,
            },
        });

        return (resp.data?.results || resp.data || []).map(item => ({
            btScheduleId: String(item.id),
            projectId:    String(item.jobId || item.projectId || ''),
            projectName:  item.jobName || item.projectName || '',
            title:        item.title || item.description || 'Scheduled Work',
            startDate:    item.startDate ? dayjs(item.startDate).format('YYYY-MM-DD') : startDate,
            startTime:    item.startTime || null,
            endDate:      item.endDate   ? dayjs(item.endDate).format('YYYY-MM-DD')   : null,
            subPhone:     item.subcontractorPhone || item.assignedPhone || null,
            subName:      item.subcontractorName  || item.assignedName  || null,
            trade:        item.trade || item.category || null,
        }));
    } catch (err) {
        console.warn(`[Buildertrend] Schedule fetch failed: ${err.message}`);
        return [];
    }
}

/**
 * Get active projects from Buildertrend.
 */
async function getActiveJobs(apiKey, companyId) {
    try {
        const resp = await axios.get(`${BT_BASE}/jobs`, {
            headers: getHeaders(apiKey),
            params: { companyId, status: 'Active', perPage: 100 },
        });
        return (resp.data?.results || resp.data || []).map(j => ({
            id:   String(j.id),
            name: j.name || j.jobName || '',
        }));
    } catch (err) {
        console.warn(`[Buildertrend] Jobs fetch failed: ${err.message}`);
        return [];
    }
}

/**
 * Get subcontractors (subs) from Buildertrend.
 */
async function getSubcontractors(apiKey, companyId) {
    try {
        const resp = await axios.get(`${BT_BASE}/subcontractors`, {
            headers: getHeaders(apiKey),
            params: { companyId, perPage: 200 },
        });
        return (resp.data?.results || resp.data || []).map(s => ({
            btSubId:  String(s.id),
            name:     s.name || `${s.firstName || ''} ${s.lastName || ''}`.trim(),
            company:  s.companyName || null,
            phone:    s.phone || s.mobilePhone || null,
            email:    s.email || null,
            trade:    s.trade || null,
        })).filter(s => s.phone);
    } catch (err) {
        console.warn(`[Buildertrend] Subcontractors fetch failed: ${err.message}`);
        return [];
    }
}

module.exports = {
    getScheduleItems,
    getActiveJobs,
    getSubcontractors,
};
