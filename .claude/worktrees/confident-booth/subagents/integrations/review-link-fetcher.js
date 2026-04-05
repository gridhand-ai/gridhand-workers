// Review Link Fetcher — gets/stores the Google review link for each client
// Google review links format: https://search.google.com/local/writereview?placeid=PLACE_ID
const store = require('../store');

function getStoredLink(clientSlug) {
    return store.readJson('review-links', clientSlug);
}

function saveLink(clientSlug, provider, url, placeId = null) {
    const data = { provider, url, placeId, savedAt: new Date().toISOString() };
    store.writeJson('review-links', clientSlug, data);
    return data;
}

// Generate Google review link from Place ID
function generateGoogleReviewLink(placeId) {
    return `https://search.google.com/local/writereview?placeid=${placeId}`;
}

// Look up a business's Place ID using Google Places API
async function findGooglePlaceId(businessName, address, apiKey) {
    const query = encodeURIComponent(`${businessName} ${address}`);
    const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${query}&inputtype=textquery&fields=place_id,name,formatted_address&key=${apiKey}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google Places API: ${res.status}`);
    const data = await res.json();

    if (data.candidates?.[0]?.place_id) {
        return data.candidates[0].place_id;
    }
    throw new Error('No place found — check business name and address');
}

// Main: get or auto-generate the review link for a client
async function getReviewLink(clientSlug, clientSettings) {
    // Return stored link if available
    const stored = getStoredLink(clientSlug);
    if (stored?.url) return stored;

    const integration = clientSettings?.integrations?.googleBusiness;
    const workerSettings = clientSettings?.settings?.['review-requester'];

    // If manually set in worker settings
    if (workerSettings?.reviewLink) {
        return saveLink(clientSlug, 'manual', workerSettings.reviewLink);
    }

    // Auto-generate if we have a Place ID
    if (integration?.placeId) {
        const url = generateGoogleReviewLink(integration.placeId);
        return saveLink(clientSlug, 'google', url, integration.placeId);
    }

    // Try to find the Place ID from business info
    const apiKey = integration?.apiKey || process.env.GOOGLE_PLACES_API_KEY;
    if (apiKey && clientSettings?.business?.name && clientSettings?.business?.address) {
        try {
            const placeId = await findGooglePlaceId(
                clientSettings.business.name,
                clientSettings.business.address,
                apiKey
            );
            const url = generateGoogleReviewLink(placeId);
            console.log(`[ReviewLinkFetcher] Found Place ID for ${clientSettings.business.name}: ${placeId}`);
            return saveLink(clientSlug, 'google', url, placeId);
        } catch (e) {
            console.log(`[ReviewLinkFetcher] Could not auto-find Place ID: ${e.message}`);
        }
    }

    // Fallback to website
    const website = clientSettings?.business?.website;
    if (website) return { provider: 'website', url: website };

    return null;
}

// Generate Yelp review link (just the business page)
function getYelpLink(yelpUrl) {
    return yelpUrl ? `${yelpUrl.replace(/\/$/, '')}/writeareview` : null;
}

module.exports = { getReviewLink, generateGoogleReviewLink, findGooglePlaceId, saveLink, getYelpLink };
