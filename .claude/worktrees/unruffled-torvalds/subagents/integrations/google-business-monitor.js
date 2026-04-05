// Google Business Monitor — watches Google reviews and alerts the business
// Requires: Google My Business API (OAuth) or Places API key
// Config: client.settings.integrations.googleBusiness.placeId + apiKey

const Anthropic = require('@anthropic-ai/sdk');
const store = require('../store');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getKey(clientSlug) { return clientSlug; }

function getStoredReviews(clientSlug) {
    return store.readJson('google-reviews', getKey(clientSlug)) || { reviews: [], lastChecked: null };
}

// Fetch reviews using Google Places API (Details endpoint)
async function fetchReviews(placeId, apiKey) {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=reviews,rating&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google Places API error: ${res.status}`);
    const data = await res.json();
    return {
        rating: data.result?.rating || null,
        reviews: data.result?.reviews || [],
    };
}

// Generate a suggested response to a review using Claude
async function generateResponse(review, businessName, businessTone = 'friendly') {
    const toneInstruction = businessTone === 'professional'
        ? 'Be professional and formal.'
        : 'Be warm, genuine, and friendly.';

    const isPositive = review.rating >= 4;

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 150,
            system: `You write business owner responses to Google reviews for ${businessName}.
${toneInstruction}
- Keep responses to 2-3 sentences max.
- For positive reviews: thank them warmly, mention something specific they said.
- For negative reviews: apologize sincerely, take responsibility, offer to make it right (call us at [phone]).
- Never be defensive. Never argue.
- Do not use generic phrases like "we value your feedback."`,
            messages: [{
                role: 'user',
                content: `${isPositive ? 'Positive' : 'Negative'} review (${review.rating}/5 stars):\n"${review.text}"\nFrom: ${review.author_name || 'a customer'}`
            }]
        });

        return response.content[0]?.text?.trim();
    } catch (e) {
        return isPositive
            ? `Thank you so much for your kind words, ${review.author_name || 'valued customer'}! We truly appreciate your support and look forward to seeing you again. — ${businessName}`
            : `We're truly sorry to hear about your experience. Please reach out to us directly so we can make this right. — ${businessName}`;
    }
}

// Main check — compares new reviews against stored ones, flags new ones
async function checkForNewReviews(clientSlug, clientSettings) {
    const integration = clientSettings?.integrations?.googleBusiness;
    if (!integration?.placeId || !integration?.apiKey) {
        return { error: 'Google Business integration not configured. Add placeId and apiKey to client settings.' };
    }

    const stored = getStoredReviews(clientSlug);

    try {
        const { rating, reviews } = await fetchReviews(integration.placeId, integration.apiKey);
        const storedIds = new Set(stored.reviews.map(r => r.time));
        const newReviews = reviews.filter(r => !storedIds.has(r.time));

        if (newReviews.length > 0) {
            // Generate responses for new reviews
            for (const review of newReviews) {
                review.suggestedResponse = await generateResponse(
                    review,
                    clientSettings.business?.name || 'the business',
                    clientSettings.settings?.global?.tone
                );
                review.isNegative = review.rating <= 3;
            }

            // Save updated reviews
            stored.reviews = [...reviews, ...stored.reviews.filter(r => !reviews.find(nr => nr.time === r.time))].slice(0, 50);
            stored.lastChecked = new Date().toISOString();
            stored.currentRating = rating;
            store.writeJson('google-reviews', getKey(clientSlug), stored);

            console.log(`[GoogleBusinessMonitor] ${newReviews.length} new reviews for ${clientSlug} (rating: ${rating})`);
            return { newReviews, rating, total: reviews.length };
        }

        stored.lastChecked = new Date().toISOString();
        store.writeJson('google-reviews', getKey(clientSlug), stored);
        return { newReviews: [], rating, total: reviews.length };
    } catch (e) {
        console.log(`[GoogleBusinessMonitor] Error: ${e.message}`);
        return { error: e.message };
    }
}

function getReviewSummary(clientSlug) {
    const stored = getStoredReviews(clientSlug);
    const negative = stored.reviews.filter(r => r.rating <= 3);
    return {
        totalReviews: stored.reviews.length,
        currentRating: stored.currentRating,
        lastChecked: stored.lastChecked,
        negativeUnresponded: negative.filter(r => !r.responded).length,
    };
}

module.exports = { checkForNewReviews, generateResponse, getReviewSummary };
