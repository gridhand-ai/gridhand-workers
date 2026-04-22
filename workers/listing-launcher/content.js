/**
 * GRIDHAND Listing Launcher — AI Content Generation
 *
 * Uses Claude Haiku to generate:
 *  - MLS listing descriptions (250-300 words, professional)
 *  - Facebook posts (hook + features + CTA + hashtags)
 *  - Instagram captions (aspirational + hashtag array)
 *  - Twitter/X posts (max 280 chars)
 *  - Price drop alerts (SMS/social copy)
 *  - Canva social graphics via Canva Connect API
 *  - Weekly performance report summaries
 *
 * All AI calls use claude-haiku-4-5-20251001 for speed and cost efficiency.
 */

'use strict';

const aiClient  = require('../../lib/ai-client');
const axios     = require('axios');

const CANVA_BASE = 'https://api.canva.com/rest/v1';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPrice(price) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(price);
}

function buildListingContext(listing) {
    return [
        `Address: ${listing.address}, ${listing.city}, ${listing.state} ${listing.zip}`,
        `Price: ${formatPrice(listing.price)}`,
        `Bedrooms: ${listing.beds} | Bathrooms: ${listing.baths}`,
        `Square Feet: ${listing.sqft ? listing.sqft.toLocaleString() : 'N/A'}`,
        listing.yearBuilt ? `Year Built: ${listing.yearBuilt}` : '',
        listing.lotSize   ? `Lot Size: ${listing.lotSize} acres` : '',
        listing.features?.length ? `Key Features: ${listing.features.slice(0, 10).join(', ')}` : '',
        listing.description ? `MLS Remarks: ${listing.description}` : '',
    ].filter(Boolean).join('\n');
}

async function callClaude(systemPrompt, userPrompt) {
    return await aiClient.call({
        modelString: 'groq/llama-3.3-70b-versatile',
        systemPrompt,
        messages:    [{ role: 'user', content: userPrompt }],
        maxTokens:   1024,
    }) || '';
}

// ─── MLS Description ──────────────────────────────────────────────────────────

/**
 * Generate a professional MLS listing description (250-300 words).
 * Returns the description string.
 */
async function generateListingDescription(listing) {
    const context = buildListingContext(listing);

    const system = `You are an expert real estate copywriter with 20 years of experience writing high-converting MLS listings.
Your descriptions are professional, accurate, and entice qualified buyers.
You never use clichés like "won't last long" or "honey stop the car".
You highlight specific features that differentiate the property.
Write in present tense. Do not include the price in the description.`;

    const prompt = `Write a compelling MLS listing description for this property.
Aim for 250-300 words. Highlight the top 5 most compelling features.
Start with a strong opening sentence about the property's best attribute.
Do not use bullet points — write in flowing paragraphs.

Property details:
${context}

Return ONLY the description text. No title, no headers.`;

    return callClaude(system, prompt);
}

// ─── Social Media Posts ───────────────────────────────────────────────────────

/**
 * Generate a Facebook post.
 * Format: 1-sentence hook, 2-3 features with emojis, CTA, hashtags. Max 500 chars total.
 */
async function generateFacebookPost(listing) {
    const context = buildListingContext(listing);

    const system = `You are a real estate social media expert who writes Facebook posts that get high engagement.
You write conversational, enthusiastic posts that feel personal — not like a robot wrote them.
Use emojis strategically (2-4 max). Keep it punchy and human.`;

    const prompt = `Write a Facebook post for this listing.

Rules:
- Start with a 1-sentence hook that grabs attention
- Include 2-3 key features with relevant emojis
- End with a clear call to action (DM for showings, link in bio, etc.)
- Add 3-5 relevant hashtags at the end
- Maximum 500 characters total
- Do NOT include the full address (city + state only for privacy until showing)

Property:
${context}

Return ONLY the post text.`;

    return callClaude(system, prompt);
}

/**
 * Generate an Instagram caption.
 * Lifestyle-focused, aspirational tone. 150-200 chars of body + hashtags array returned as JSON.
 */
async function generateInstagramCaption(listing) {
    const context = buildListingContext(listing);

    const system = `You are a luxury real estate Instagram content creator.
Your captions evoke lifestyle and aspiration — you sell the dream of living in the home.
You write concise, punchy captions that pair with beautiful photos.
Your hashtag selection is strategic: mix high-volume real estate tags with local community tags.`;

    const prompt = `Write an Instagram caption for this listing.

Rules:
- Caption body: 150-200 characters (punchy, lifestyle-focused, aspirational)
- Tone: aspirational, warm, not salesy
- End the body with a 🔑 emoji and "link in bio"
- Include 20 relevant hashtags as a SEPARATE array
- Use local city hashtags, property type hashtags, and lifestyle hashtags

Property:
${context}

Return your response as JSON in this exact format (no markdown code blocks):
{
  "caption": "your caption body here",
  "hashtags": ["hashtag1", "hashtag2", ...]
}`;

    const raw = await callClaude(system, prompt);

    try {
        const parsed = JSON.parse(raw);
        return {
            caption:   parsed.caption || raw,
            hashtags:  parsed.hashtags || [],
            formatted: `${parsed.caption}\n\n${(parsed.hashtags || []).map(h => `#${h.replace(/^#/, '')}`).join(' ')}`,
        };
    } catch {
        // Fallback if JSON parsing fails
        return { caption: raw, hashtags: [], formatted: raw };
    }
}

/**
 * Generate a Twitter/X post. Max 280 characters.
 * Include price, beds/baths, location, one unique feature.
 */
async function generateTwitterPost(listing) {
    const context = buildListingContext(listing);

    const system = `You are a real estate Twitter specialist. You write punchy, informative tweets that get saves and shares.
Every word earns its place. You never exceed 280 characters.`;

    const prompt = `Write a Twitter post for this listing.

Rules:
- Absolute maximum 280 characters (count carefully)
- Must include: price, beds/baths, city, and one standout feature
- Use 1-2 relevant hashtags
- Make it feel exciting but not spammy
- Include a call to action if space allows

Property:
${context}

Return ONLY the tweet text. Nothing else.`;

    const result = await callClaude(system, prompt);
    // Enforce 280-char limit as safety net
    return result.length > 280 ? result.substring(0, 277) + '...' : result;
}

/**
 * Generate a price drop alert for SMS and social re-distribution.
 * "Just reduced!" energy — creates FOMO urgency.
 */
async function generatePriceDropAlert(listing, oldPrice, newPrice) {
    const drop     = oldPrice - newPrice;
    const dropPct  = ((drop / oldPrice) * 100).toFixed(1);

    const system = `You are a real estate urgency copywriter.
Price drops are exciting events that should create FOMO.
Write short, punchy copy that motivates fence-sitters to act immediately.`;

    const prompt = `Write a price drop alert for this listing.

Price reduced from ${formatPrice(oldPrice)} to ${formatPrice(newPrice)} — a ${formatPrice(drop)} (${dropPct}%) reduction.

Property: ${listing.beds}bd/${listing.baths}ba at ${listing.address}, ${listing.city}, ${listing.state}

Generate THREE versions:
1. SMS (max 160 chars): urgent, factual, include price and address
2. Facebook (max 300 chars): excited tone, emojis, CTA
3. Instagram caption (max 200 chars): aspirational but urgent

Return as JSON (no markdown code blocks):
{
  "sms": "...",
  "facebook": "...",
  "instagram": "..."
}`;

    const raw = await callClaude(system, prompt);

    try {
        return JSON.parse(raw);
    } catch {
        return { sms: raw, facebook: raw, instagram: raw };
    }
}

// ─── Canva Design ─────────────────────────────────────────────────────────────

/**
 * Create a social graphic via Canva Connect API.
 * Uses a pre-configured listing template, fills in address, price, beds/baths, first photo.
 * Returns { ok, designUrl, exportUrl }.
 */
async function generateCanvaDesign(listing) {
    const token = process.env.CANVA_API_TOKEN;
    if (!token) {
        console.warn('[Content] CANVA_API_TOKEN not configured — skipping design generation');
        return { ok: false, designUrl: null, exportUrl: null, error: 'CANVA_API_TOKEN not configured' };
    }

    const templateId = process.env.CANVA_LISTING_TEMPLATE_ID;
    if (!templateId) {
        console.warn('[Content] CANVA_LISTING_TEMPLATE_ID not configured — skipping design generation');
        return { ok: false, designUrl: null, exportUrl: null, error: 'CANVA_LISTING_TEMPLATE_ID not configured' };
    }

    try {
        // Step 1: Create a design from template
        const createResp = await axios.post(
            `${CANVA_BASE}/designs`,
            {
                design_type: { type: 'preset', name: 'SocialMedia' },
                asset_id:    templateId,
                title:       `Listing — ${listing.address}`,
            },
            {
                headers: {
                    Authorization:  `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                timeout: 20000,
            }
        );

        const designId = createResp.data?.design?.id;
        if (!designId) throw new Error('No design ID returned from Canva');

        // Step 2: Update text elements (autofill)
        const autofillData = {
            brand_template_id: templateId,
            title:             `${listing.address} — ${formatPrice(listing.price)}`,
            data: {
                address_line:  { type: 'text', text: listing.address },
                city_state:    { type: 'text', text: `${listing.city}, ${listing.state}` },
                price_display: { type: 'text', text: formatPrice(listing.price) },
                bed_bath:      { type: 'text', text: `${listing.beds} BD | ${listing.baths} BA | ${(listing.sqft || 0).toLocaleString()} SQFT` },
                photo_main:    listing.photos?.[0] ? { type: 'image', asset_id: listing.photos[0] } : undefined,
            },
        };

        // Remove undefined keys
        Object.keys(autofillData.data).forEach(k => {
            if (!autofillData.data[k]) delete autofillData.data[k];
        });

        // Step 3: Create autofill job
        const autofillResp = await axios.post(
            `${CANVA_BASE}/autofills`,
            autofillData,
            {
                headers: {
                    Authorization:  `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                timeout: 20000,
            }
        );

        const autofillDesignId = autofillResp.data?.design?.id || designId;
        const designUrl        = `https://www.canva.com/design/${autofillDesignId}/edit`;

        // Step 4: Request export (JPG for social)
        const exportResp = await axios.post(
            `${CANVA_BASE}/exports`,
            {
                design_id: autofillDesignId,
                format:    'jpg',
                pages:     [1],
            },
            {
                headers: {
                    Authorization:  `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                timeout: 30000,
            }
        );

        const exportUrl = exportResp.data?.job?.export_url
            || exportResp.data?.urls?.[0]
            || null;

        return { ok: true, designUrl, exportUrl, error: null };
    } catch (err) {
        const message = err.response?.data?.message || err.message;
        console.error(`[Content] Canva design generation failed: ${message}`);
        return { ok: false, designUrl: null, exportUrl: null, error: message };
    }
}

// ─── Weekly Report ────────────────────────────────────────────────────────────

/**
 * Generate agent-facing weekly performance summary text.
 * listings: array of { address, price, platform, views, likes, shares, linkClicks }
 */
async function generateWeeklyReport(listings) {
    if (!listings || listings.length === 0) {
        return 'No active listing performance data this week.';
    }

    const totalViews  = listings.reduce((sum, l) => sum + (l.views || 0), 0);
    const totalLeads  = listings.reduce((sum, l) => sum + (l.linkClicks || 0), 0);
    const totalShares = listings.reduce((sum, l) => sum + (l.shares || 0), 0);

    const listingSummary = listings.map(l =>
        `- ${l.address} (${formatPrice(l.price)}): ${l.views} views, ${l.likes} likes, ${l.shares} shares, ${l.linkClicks} lead clicks on ${l.platform}`
    ).join('\n');

    const system = `You are a real estate performance analyst writing a brief weekly SMS report for a real estate agent.
Be concise, data-driven, and actionable. Use plain text only (no markdown, no emojis in the main body).
Highlight what's working and what needs attention.`;

    const prompt = `Write a weekly listing performance report for a real estate agent.

Summary stats:
- Total views across all platforms: ${totalViews}
- Total lead clicks (link in bio / CTA): ${totalLeads}
- Total shares: ${totalShares}
- Active listings tracked: ${listings.length}

Per-listing breakdown:
${listingSummary}

Write a 3-4 sentence summary that:
1. Opens with total reach this week
2. Names the best-performing listing and why
3. Flags any listing getting low engagement (suggest a price drop alert or new content)
4. Closes with one actionable recommendation

Keep it under 320 characters for SMS delivery. Return ONLY the message text.`;

    return callClaude(system, prompt);
}

module.exports = {
    generateListingDescription,
    generateFacebookPost,
    generateInstagramCaption,
    generateTwitterPost,
    generatePriceDropAlert,
    generateCanvaDesign,
    generateWeeklyReport,
};
