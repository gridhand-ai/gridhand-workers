/**
 * GRIDHAND Listing Launcher — MLS API Layer
 *
 * Wraps MLS Grid API (https://api.mlsgrid.com/v2) — the modern RESO Web API standard.
 * All calls return { ok, data, error } format.
 *
 * Env per client is stored in ll_clients table:
 *   mls_token       — Bearer token (MLS Grid access token)
 *   mls_agent_id    — MemberKey for filtering by agent's listings
 *   mls_originating_system — Originating system name (e.g. 'MiRealSource', 'MRED')
 */

'use strict';

const axios = require('axios');
const db    = require('./db');

const MLS_BASE = 'https://api.mlsgrid.com/v2';

// ─── Core Request ─────────────────────────────────────────────────────────────

/**
 * Make an authenticated request to MLS Grid API.
 * Returns { ok, data, error }.
 */
async function mlsRequest(clientSlug, method, path, params = {}) {
    const client = await db.getClient(clientSlug);
    if (!client || !client.mls_token) {
        return { ok: false, data: null, error: `No MLS token configured for ${clientSlug}` };
    }

    try {
        const response = await axios({
            method,
            url: `${MLS_BASE}${path}`,
            headers: {
                Authorization: `Bearer ${client.mls_token}`,
                Accept:        'application/json',
            },
            params: method.toUpperCase() === 'GET' ? params : undefined,
            data:   method.toUpperCase() !== 'GET' ? params : undefined,
            timeout: 15000,
        });

        return { ok: true, data: response.data, error: null };
    } catch (err) {
        const status  = err.response?.status;
        const message = err.response?.data?.['@iot.message'] || err.response?.data?.message || err.message;
        console.error(`[MLS] ${method.toUpperCase()} ${path} failed (${status}): ${message}`);
        return { ok: false, data: null, error: message };
    }
}

// ─── Listings ─────────────────────────────────────────────────────────────────

/**
 * Get a single listing by its MLS ListingKey.
 */
async function getListing(clientSlug, listingKey) {
    const result = await mlsRequest(
        clientSlug,
        'GET',
        '/Property',
        {
            '$filter':  `ListingKey eq '${listingKey}'`,
            '$expand':  'Media',
            '$top':     1,
        }
    );

    if (!result.ok) return result;

    const raw = result.data?.value?.[0] || null;
    if (!raw) return { ok: false, data: null, error: 'Listing not found' };

    return { ok: true, data: parseListing(raw), error: null };
}

/**
 * Search listings with flexible filters.
 * params: { minPrice, maxPrice, minBeds, minBaths, zip, status, limit }
 */
async function searchListings(clientSlug, params = {}) {
    const filters = [];

    if (params.status)   filters.push(`StandardStatus eq '${params.status}'`);
    if (params.minPrice) filters.push(`ListPrice ge ${params.minPrice}`);
    if (params.maxPrice) filters.push(`ListPrice le ${params.maxPrice}`);
    if (params.minBeds)  filters.push(`BedroomsTotal ge ${params.minBeds}`);
    if (params.minBaths) filters.push(`BathroomsTotalInteger ge ${params.minBaths}`);
    if (params.zip)      filters.push(`PostalCode eq '${params.zip}'`);

    const filterStr = filters.length > 0 ? filters.join(' and ') : "StandardStatus eq 'Active'";

    const result = await mlsRequest(
        clientSlug,
        'GET',
        '/Property',
        {
            '$filter':  filterStr,
            '$expand':  'Media',
            '$top':     params.limit || 50,
            '$orderby': 'ModificationTimestamp desc',
        }
    );

    if (!result.ok) return result;

    const listings = (result.data?.value || []).map(parseListing);
    return { ok: true, data: listings, error: null };
}

/**
 * Get all active listings for the agent configured on this client.
 */
async function getAgentListings(clientSlug) {
    const client = await db.getClient(clientSlug);
    if (!client) return { ok: false, data: null, error: `Client not found: ${clientSlug}` };
    if (!client.mls_agent_id) return { ok: false, data: null, error: `No mls_agent_id configured for ${clientSlug}` };

    const result = await mlsRequest(
        clientSlug,
        'GET',
        '/Property',
        {
            '$filter':  `ListAgentMemberKey eq '${client.mls_agent_id}' and StandardStatus eq 'Active'`,
            '$expand':  'Media',
            '$top':     100,
            '$orderby': 'ListingContractDate desc',
        }
    );

    if (!result.ok) return result;

    const listings = (result.data?.value || []).map(parseListing);
    return { ok: true, data: listings, error: null };
}

/**
 * Get all media (photos) for a listing.
 * Returns array of { order, url, description } sorted by Order.
 */
async function getListingMedia(clientSlug, listingKey) {
    const result = await mlsRequest(
        clientSlug,
        'GET',
        '/Media',
        {
            '$filter':  `ResourceRecordKey eq '${listingKey}' and ResourceName eq 'Property'`,
            '$orderby': 'Order asc',
            '$top':     50,
        }
    );

    if (!result.ok) return result;

    const media = (result.data?.value || []).map(m => ({
        order:       m.Order || 0,
        url:         m.MediaURL || m.MediaPath || '',
        description: m.ShortDescription || '',
        mediaType:   m.MediaType || 'image/jpeg',
    }));

    return { ok: true, data: media, error: null };
}

/**
 * Get price history for a listing via PropertyHistory endpoint.
 */
async function getPriceHistory(clientSlug, listingKey) {
    const result = await mlsRequest(
        clientSlug,
        'GET',
        '/PropertyHistory',
        {
            '$filter':  `ListingKey eq '${listingKey}' and HistoryTransactionType eq 'PriceChange'`,
            '$orderby': 'TransactionDate desc',
            '$top':     20,
        }
    );

    if (!result.ok) return result;

    const history = (result.data?.value || []).map(h => ({
        date:     h.TransactionDate || h.ModificationTimestamp,
        oldPrice: h.PreviousListPrice || null,
        newPrice: h.ListPrice || null,
        type:     h.HistoryTransactionType || 'PriceChange',
    }));

    return { ok: true, data: history, error: null };
}

/**
 * Fetch new or updated listings since a given timestamp.
 * Used by the periodic MLS sync cron job.
 */
async function getRecentlyUpdated(clientSlug, sinceTimestamp) {
    const client = await db.getClient(clientSlug);
    if (!client) return { ok: false, data: null, error: `Client not found: ${clientSlug}` };

    const isoTs = sinceTimestamp instanceof Date
        ? sinceTimestamp.toISOString()
        : sinceTimestamp;

    const agentFilter = client.mls_agent_id
        ? ` and ListAgentMemberKey eq '${client.mls_agent_id}'`
        : '';

    const result = await mlsRequest(
        clientSlug,
        'GET',
        '/Property',
        {
            '$filter':  `ModificationTimestamp gt ${isoTs}${agentFilter}`,
            '$expand':  'Media',
            '$top':     200,
            '$orderby': 'ModificationTimestamp desc',
        }
    );

    if (!result.ok) return result;

    const listings = (result.data?.value || []).map(parseListing);
    return { ok: true, data: listings, error: null };
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Normalize raw MLS Grid /Property record to internal format.
 * All field names follow MLS Grid's RESO standard field names.
 */
function parseListing(raw) {
    // Extract photos from expanded Media or MediaURL fields
    const photos = [];

    if (raw.Media && Array.isArray(raw.Media)) {
        for (const m of raw.Media) {
            const url = m.MediaURL || m.MediaPath || '';
            if (url) photos.push(url);
        }
    } else if (raw.MediaURL) {
        photos.push(raw.MediaURL);
    }

    // Build features list from standard boolean/text fields
    const features = [];
    if (raw.GarageSpaces > 0)         features.push(`${raw.GarageSpaces}-car garage`);
    if (raw.PoolPrivateYN)             features.push('Private pool');
    if (raw.FireplacesTotal > 0)       features.push(`${raw.FireplacesTotal} fireplace${raw.FireplacesTotal > 1 ? 's' : ''}`);
    if (raw.WaterfrontYN)              features.push('Waterfront');
    if (raw.NewConstructionYN)         features.push('New construction');
    if (raw.BasementYN)                features.push('Basement');
    if (raw.CentralAir)                features.push('Central A/C');
    if (raw.HeatingYN && raw.Heating)  features.push(Array.isArray(raw.Heating) ? raw.Heating.join(', ') : raw.Heating);
    if (raw.LaundryFeatures?.length)   features.push('In-unit laundry');

    // Append any free-text interior/exterior features
    if (Array.isArray(raw.InteriorFeatures)) features.push(...raw.InteriorFeatures.slice(0, 5));
    if (Array.isArray(raw.ExteriorFeatures)) features.push(...raw.ExteriorFeatures.slice(0, 3));

    const daysOnMarket = raw.DaysOnMarket
        || raw.CumulativeDaysOnMarket
        || (raw.ListingContractDate
            ? Math.floor((Date.now() - new Date(raw.ListingContractDate).getTime()) / 86400000)
            : 0);

    return {
        mlsKey:           raw.ListingKey         || raw.ListingId || '',
        mlsNumber:        raw.ListingId          || raw.MLSNumber || '',
        address:          raw.UnparsedAddress    || `${raw.StreetNumber || ''} ${raw.StreetName || ''}`.trim(),
        city:             raw.City               || '',
        state:            raw.StateOrProvince    || '',
        zip:              raw.PostalCode         || '',
        price:            raw.ListPrice          || raw.ClosePrice || 0,
        beds:             raw.BedroomsTotal      || 0,
        baths:            raw.BathroomsTotalInteger || raw.BathroomsFull || 0,
        sqft:             raw.LivingArea         || raw.BuildingAreaTotal || 0,
        lotSize:          raw.LotSizeAcres       || raw.LotSizeSquareFeet || 0,
        yearBuilt:        raw.YearBuilt          || null,
        description:      raw.PublicRemarks      || '',
        features:         features.filter(Boolean),
        photos,
        status:           raw.StandardStatus     || raw.MlsStatus || 'Active',
        listDate:         raw.ListingContractDate || null,
        daysOnMarket:     daysOnMarket,
        agentName:        raw.ListAgentFullName  || '',
        agentMlsId:       raw.ListAgentMemberKey || '',
        propertyType:     raw.PropertyType       || raw.PropertySubType || '',
        rawData:          raw,
    };
}

module.exports = {
    mlsRequest,
    getListing,
    searchListings,
    getAgentListings,
    getListingMedia,
    getPriceHistory,
    getRecentlyUpdated,
    parseListing,
};
