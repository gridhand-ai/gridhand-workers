/**
 * GRIDHAND Maintenance Dispatcher — AppFolio API Integration
 *
 * AppFolio uses HTTP Basic Auth with client_id + API credentials.
 * Fetches maintenance requests and updates work order status.
 * Docs: https://developer.appfolio.com/
 */

'use strict';

const axios = require('axios');

/**
 * Build the AppFolio base URL for a given database name.
 * e.g. databaseName = "mycompany" → https://mycompany.appfolio.com/api/v1
 */
function getBaseUrl(databaseName) {
    return `https://${databaseName}.appfolio.com/api/v1`;
}

function getAuthHeaders(username, password) {
    const creds = Buffer.from(`${username}:${password}`).toString('base64');
    return {
        Authorization: `Basic ${creds}`,
        Accept:        'application/json',
        'Content-Type': 'application/json',
    };
}

// ─── Maintenance Requests ─────────────────────────────────────────────────────

/**
 * Pull open maintenance requests from AppFolio.
 */
async function getMaintenanceRequests(conn, status = 'Open') {
    try {
        const resp = await axios.get(
            `${getBaseUrl(conn.appfolio_database_name)}/maintenance_requests`,
            {
                headers: getAuthHeaders(conn.appfolio_api_username, conn.appfolio_api_password),
                params: { status, per_page: 100 },
            }
        );

        const items = resp.data?.results || resp.data || [];
        return items.map(r => ({
            appfolioRequestId: String(r.id),
            propertyAddress:   r.property?.address || null,
            unitNumber:        r.unit?.number || null,
            tenantName:        r.tenant?.name || null,
            tenantPhone:       r.tenant?.phone || null,
            category:          mapCategory(r.category || r.type || 'general'),
            priority:          mapPriority(r.priority || r.urgency || 'routine'),
            description:       r.description || r.notes || 'No description provided',
        }));
    } catch (err) {
        console.warn(`[AppFolio] Maintenance requests fetch failed: ${err.message}`);
        return [];
    }
}

/**
 * Update the status of a work order back in AppFolio.
 */
async function updateWorkOrderStatus(conn, appfolioRequestId, status, notes = '') {
    try {
        await axios.patch(
            `${getBaseUrl(conn.appfolio_database_name)}/maintenance_requests/${appfolioRequestId}`,
            { status, notes },
            { headers: getAuthHeaders(conn.appfolio_api_username, conn.appfolio_api_password) }
        );
        return true;
    } catch (err) {
        console.warn(`[AppFolio] Work order status update failed for ${appfolioRequestId}: ${err.message}`);
        return false;
    }
}

// ─── Category / Priority Mapping ──────────────────────────────────────────────

function mapCategory(raw) {
    const r = (raw || '').toLowerCase();
    if (r.includes('plumb') || r.includes('leak') || r.includes('drain')) return 'plumbing';
    if (r.includes('elec') || r.includes('power') || r.includes('outlet')) return 'electrical';
    if (r.includes('hvac') || r.includes('heat') || r.includes('cool') || r.includes('ac')) return 'hvac';
    if (r.includes('appliance') || r.includes('fridge') || r.includes('stove')) return 'appliance';
    if (r.includes('roof') || r.includes('leak') || r.includes('gutter')) return 'roofing';
    if (r.includes('pest') || r.includes('bug') || r.includes('rodent')) return 'pest';
    return 'general';
}

function mapPriority(raw) {
    const r = (raw || '').toLowerCase();
    if (r.includes('emergency') || r.includes('urgent') && r.includes('high')) return 'emergency';
    if (r.includes('urgent') || r.includes('high') || r.includes('asap')) return 'urgent';
    return 'routine';
}

module.exports = {
    getMaintenanceRequests,
    updateWorkOrderStatus,
    mapCategory,
    mapPriority,
};
