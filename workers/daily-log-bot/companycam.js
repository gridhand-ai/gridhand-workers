/**
 * GRIDHAND Daily Log Bot — CompanyCam API Integration
 *
 * CompanyCam uses API key auth. Fetches photos taken at job sites today.
 * Docs: https://docs.companycam.com/
 */

'use strict';

const axios = require('axios');

const COMPANYCAM_BASE = 'https://api.companycam.com/v2';

function getHeaders(apiKey) {
    return {
        Authorization: `Bearer ${apiKey}`,
        Accept:        'application/json',
    };
}

// ─── Projects ─────────────────────────────────────────────────────────────────

async function getProjects(apiKey) {
    const resp = await axios.get(`${COMPANYCAM_BASE}/projects`, {
        headers: getHeaders(apiKey),
        params:  { status: 'active', per_page: 100 },
    });
    return (resp.data || []).map(p => ({
        id:      String(p.id),
        name:    p.name,
        address: p.address?.street_address_1 || null,
        lat:     p.address?.lat || null,
        lng:     p.address?.lng || null,
    }));
}

// ─── Photos ───────────────────────────────────────────────────────────────────

/**
 * Get photos for a project taken on a specific date.
 * @param {string} apiKey
 * @param {string} projectId  - CompanyCam project ID
 * @param {string} date       - YYYY-MM-DD
 */
async function getProjectPhotos(apiKey, projectId, date) {
    const startTs = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
    const endTs   = Math.floor(new Date(`${date}T23:59:59Z`).getTime() / 1000);

    try {
        const resp = await axios.get(`${COMPANYCAM_BASE}/projects/${projectId}/photos`, {
            headers: getHeaders(apiKey),
            params:  {
                captured_after:  startTs,
                captured_before: endTs,
                per_page:        200,
            },
        });

        return (resp.data || []).map(p => ({
            id:        String(p.id),
            url:       p.uris?.find(u => u.type === 'original')?.uri || p.uris?.[0]?.uri || null,
            takenAt:   p.captured_at,
            latitude:  p.coordinates?.lat || null,
            longitude: p.coordinates?.lng || null,
            tags:      (p.tags || []).map(t => t.display_value),
            uploader:  p.creator?.name || null,
        }));
    } catch (err) {
        console.warn(`[CompanyCam] Photos fetch error for project ${projectId}: ${err.message}`);
        return [];
    }
}

/**
 * Build a text summary of today's photos for inclusion in the daily log.
 */
function buildPhotoSummary(photos) {
    if (!photos.length) return 'No photos captured today.';

    const uploaders = [...new Set(photos.map(p => p.uploader).filter(Boolean))];
    const tags      = [...new Set(photos.flatMap(p => p.tags))].filter(Boolean);
    const tagText   = tags.length ? ` Captured areas: ${tags.slice(0, 8).join(', ')}.` : '';

    return `${photos.length} photo${photos.length !== 1 ? 's' : ''} uploaded by ${
        uploaders.length ? uploaders.join(', ') : 'crew'
    }.${tagText}`;
}

module.exports = {
    getProjects,
    getProjectPhotos,
    buildPhotoSummary,
};
