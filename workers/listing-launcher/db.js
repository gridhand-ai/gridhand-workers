/**
 * GRIDHAND Listing Launcher — Supabase Database Layer
 *
 * Thin wrapper around Supabase client for all DB operations.
 * No business logic lives here — jobs.js, content.js, and distribution.js stay clean.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Clients ──────────────────────────────────────────────────────────────────

async function getClient(clientSlug) {
    const { data, error } = await supabase
        .from('ll_clients')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllActiveClients() {
    const { data, error } = await supabase
        .from('ll_clients')
        .select('client_slug, agent_phone, mls_agent_id, mls_token, enabled_platforms')
        .eq('active', true);

    if (error) throw error;
    return data || [];
}

// ─── Listings ─────────────────────────────────────────────────────────────────

async function upsertListing(clientSlug, listing) {
    const { data, error } = await supabase
        .from('ll_listings')
        .upsert({
            client_id:       listing.clientId,
            mls_key:         listing.mlsKey,
            mls_number:      listing.mlsNumber,
            address:         listing.address,
            city:            listing.city,
            state:           listing.state,
            zip:             listing.zip,
            price:           listing.price,
            beds:            listing.beds,
            baths:           listing.baths,
            sqft:            listing.sqft,
            year_built:      listing.yearBuilt || null,
            status:          listing.status,
            list_date:       listing.listDate || null,
            days_on_market:  listing.daysOnMarket || 0,
            description:     listing.description || null,
            features:        listing.features || [],
            photos:          listing.photos || [],
            raw_data:        listing.rawData || {},
            updated_at:      new Date().toISOString(),
        }, { onConflict: 'client_id,mls_key' })
        .select('id')
        .single();

    if (error) throw error;
    return data;
}

async function getListing(listingId) {
    const { data, error } = await supabase
        .from('ll_listings')
        .select('*')
        .eq('id', listingId)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getListingByMlsKey(clientId, mlsKey) {
    const { data, error } = await supabase
        .from('ll_listings')
        .select('*')
        .eq('client_id', clientId)
        .eq('mls_key', mlsKey)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getListingsByClient(clientSlug, { status = null, limit = 20, offset = 0 } = {}) {
    let query = supabase
        .from('ll_listings')
        .select(`
            *,
            ll_clients!inner(client_slug)
        `)
        .eq('ll_clients.client_slug', clientSlug)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

async function updateListingPrice(listingId, newPrice) {
    const { error } = await supabase
        .from('ll_listings')
        .update({ price: newPrice, updated_at: new Date().toISOString() })
        .eq('id', listingId);

    if (error) throw error;
}

// ─── Content ──────────────────────────────────────────────────────────────────

async function upsertContent(listingId, clientId, content) {
    const { data, error } = await supabase
        .from('ll_content')
        .upsert({
            listing_id:          listingId,
            client_id:           clientId,
            mls_description:     content.mlsDescription || null,
            facebook_post:       content.facebookPost || null,
            instagram_caption:   content.instagramCaption || null,
            twitter_post:        content.twitterPost || null,
            canva_design_url:    content.canvaDesignUrl || null,
            generated_at:        new Date().toISOString(),
            updated_at:          new Date().toISOString(),
        }, { onConflict: 'listing_id' })
        .select('id')
        .single();

    if (error) throw error;
    return data;
}

async function getContent(listingId) {
    const { data, error } = await supabase
        .from('ll_content')
        .select('*')
        .eq('listing_id', listingId)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

// ─── Distribution Log ─────────────────────────────────────────────────────────

async function logDistribution(listingId, clientId, { platform, postId, content, imageUrl }) {
    const { data, error } = await supabase
        .from('ll_distribution_log')
        .insert({
            listing_id:  listingId,
            client_id:   clientId,
            platform,
            post_id:     postId || null,
            content:     content || null,
            image_url:   imageUrl || null,
            posted_at:   new Date().toISOString(),
        })
        .select('id')
        .single();

    if (error) throw error;
    return data;
}

async function getDistributionLog(listingId) {
    const { data, error } = await supabase
        .from('ll_distribution_log')
        .select('*')
        .eq('listing_id', listingId)
        .order('posted_at', { ascending: false });

    if (error) throw error;
    return data || [];
}

async function getDistributionRecord(distributionId) {
    const { data, error } = await supabase
        .from('ll_distribution_log')
        .select('*')
        .eq('id', distributionId)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getDistributionsPendingTracking(hoursOld = 24) {
    const cutoff = new Date(Date.now() - hoursOld * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
        .from('ll_distribution_log')
        .select('*')
        .lte('posted_at', cutoff)
        .not('post_id', 'is', null);

    if (error) throw error;
    return data || [];
}

// ─── Performance Metrics ──────────────────────────────────────────────────────

async function upsertPerformanceMetrics(listingId, distributionId, { platform, views, likes, comments, shares, linkClicks, rawMetrics }) {
    const { error } = await supabase
        .from('ll_performance_metrics')
        .upsert({
            listing_id:      listingId,
            distribution_id: distributionId,
            platform,
            views:           views || 0,
            likes:           likes || 0,
            comments:        comments || 0,
            shares:          shares || 0,
            link_clicks:     linkClicks || 0,
            checked_at:      new Date().toISOString(),
            raw_metrics:     rawMetrics || {},
            updated_at:      new Date().toISOString(),
        }, { onConflict: 'distribution_id' });

    if (error) throw error;
}

async function getPerformanceByListing(listingId) {
    const { data, error } = await supabase
        .from('ll_performance_metrics')
        .select('*')
        .eq('listing_id', listingId)
        .order('checked_at', { ascending: false });

    if (error) throw error;
    return data || [];
}

async function getPerformanceByClient(clientSlug) {
    const { data, error } = await supabase
        .from('ll_performance_metrics')
        .select(`
            *,
            ll_listings!inner(address, city, price, ll_clients!inner(client_slug))
        `)
        .eq('ll_listings.ll_clients.client_slug', clientSlug)
        .order('checked_at', { ascending: false })
        .limit(200);

    if (error) throw error;
    return data || [];
}

// ─── SMS Log ──────────────────────────────────────────────────────────────────

async function logSms(clientSlug, { toPhone, messageBody, messageType, listingId = null }) {
    const { error } = await supabase
        .from('ll_sms_log')
        .insert({
            client_slug:  clientSlug,
            to_phone:     toPhone,
            message_body: messageBody,
            message_type: messageType,
            listing_id:   listingId || null,
        });

    if (error) throw error;
}

module.exports = {
    getClient,
    getAllActiveClients,
    upsertListing,
    getListing,
    getListingByMlsKey,
    getListingsByClient,
    updateListingPrice,
    upsertContent,
    getContent,
    logDistribution,
    getDistributionLog,
    getDistributionRecord,
    getDistributionsPendingTracking,
    upsertPerformanceMetrics,
    getPerformanceByListing,
    getPerformanceByClient,
    logSms,
};
