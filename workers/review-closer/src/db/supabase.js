'use strict';

const { createClient } = require('@supabase/supabase-js');
const { config } = require('../config');

let _client = null;

function getClient() {
  if (!_client) {
    _client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return _client;
}

// ── shops ─────────────────────────────────────────────────────────────────────

async function getShopByTekmetricId(tekmetricShopId) {
  const { data, error } = await getClient()
    .from('shops')
    .select('*')
    .eq('tekmetric_shop_id', String(tekmetricShopId))
    .eq('active', true)
    .single();

  if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows
  return data || null;
}

async function getAllActiveShops() {
  const { data, error } = await getClient()
    .from('shops')
    .select('*')
    .eq('active', true);

  if (error) throw error;
  return data || [];
}

// ── review_requests ───────────────────────────────────────────────────────────

async function createReviewRequest({ shopId, roId, customerName, customerPhone, vehicle, serviceSummary, jobId }) {
  const { data, error } = await getClient()
    .from('review_requests')
    .insert({
      shop_id: shopId,
      ro_id: String(roId),
      customer_name: customerName,
      customer_phone: customerPhone,
      vehicle: vehicle || null,
      service_summary: serviceSummary || null,
      job_id: jobId || null,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function markReviewRequestSent(id) {
  const { error } = await getClient()
    .from('review_requests')
    .update({ sent_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw error;
}

async function markReviewRequestFailed(id, errorMessage) {
  const { error } = await getClient()
    .from('review_requests')
    .update({ error: errorMessage })
    .eq('id', id);

  if (error) throw error;
}

async function getReviewRequestByRoId(shopId, roId) {
  const { data, error } = await getClient()
    .from('review_requests')
    .select('*')
    .eq('shop_id', shopId)
    .eq('ro_id', String(roId))
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

async function linkReviewToRequest(shopId, customerPhone, reviewId, rating) {
  // Find the most recent sent (but unmatched) request for this phone number
  const { data, error } = await getClient()
    .from('review_requests')
    .select('id')
    .eq('shop_id', shopId)
    .eq('customer_phone', customerPhone)
    .eq('review_received', false)
    .not('sent_at', 'is', null)
    .order('sent_at', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  if (!data) return;

  await getClient()
    .from('review_requests')
    .update({ review_received: true, review_rating: rating, review_id: reviewId })
    .eq('id', data.id);
}

async function countTodayRequests(shopId) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { count, error } = await getClient()
    .from('review_requests')
    .select('id', { count: 'exact', head: true })
    .eq('shop_id', shopId)
    .gte('created_at', todayStart.toISOString());

  if (error) throw error;
  return count || 0;
}

// ── review_monitoring ─────────────────────────────────────────────────────────

async function reviewExists(shopId, reviewId) {
  const { data, error } = await getClient()
    .from('review_monitoring')
    .select('id')
    .eq('shop_id', shopId)
    .eq('review_id', reviewId)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return !!data;
}

async function createReviewRecord({ shopId, reviewId, reviewerName, rating, reviewText, reviewUrl, publishedAt }) {
  const { data, error } = await getClient()
    .from('review_monitoring')
    .insert({
      shop_id: shopId,
      review_id: reviewId,
      reviewer_name: reviewerName || null,
      rating,
      review_text: reviewText || null,
      review_url: reviewUrl || null,
      published_at: publishedAt || null,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function markReviewResponded(id, responseText) {
  const { error } = await getClient()
    .from('review_monitoring')
    .update({ responded: true, response_text: responseText, responded_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw error;
}

async function markOwnerAlerted(id) {
  const { error } = await getClient()
    .from('review_monitoring')
    .update({ alerted_owner: true, alerted_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw error;
}

module.exports = {
  getClient,
  // shops
  getShopByTekmetricId,
  getAllActiveShops,
  // review_requests
  createReviewRequest,
  markReviewRequestSent,
  markReviewRequestFailed,
  getReviewRequestByRoId,
  linkReviewToRequest,
  countTodayRequests,
  // review_monitoring
  reviewExists,
  createReviewRecord,
  markReviewResponded,
  markOwnerAlerted,
};
