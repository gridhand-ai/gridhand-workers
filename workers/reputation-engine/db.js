/**
 * GRIDHAND Reputation Engine — Supabase Database Layer
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const dayjs = require('dayjs');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Connections ──────────────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('reputation_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('reputation_connections')
        .select('client_slug');
    if (error) throw error;
    return data || [];
}

async function upsertConnection(conn) {
    const { error } = await supabase
        .from('reputation_connections')
        .upsert({ ...conn, updated_at: new Date().toISOString() }, { onConflict: 'client_slug' });
    if (error) throw error;
}

async function updateGoogleTokens(clientSlug, { accessToken, refreshToken, expiresAt }) {
    const { error } = await supabase
        .from('reputation_connections')
        .update({
            google_access_token:     accessToken,
            google_refresh_token:    refreshToken,
            google_token_expires_at: expiresAt,
            updated_at:              new Date().toISOString(),
        })
        .eq('client_slug', clientSlug);
    if (error) throw error;
}

// ─── Reviews ──────────────────────────────────────────────────────────────────

async function upsertReview(clientSlug, review) {
    const { data, error } = await supabase
        .from('reviews')
        .upsert({
            client_slug:        clientSlug,
            platform:           review.platform,
            platform_review_id: review.platformReviewId,
            reviewer_name:      review.reviewerName || null,
            reviewer_photo_url: review.reviewerPhotoUrl || null,
            star_rating:        review.starRating,
            review_text:        review.reviewText || null,
            review_date:        review.reviewDate || null,
            reply_text:         review.replyText || null,
            replied_at:         review.repliedAt || null,
            reply_status:       review.replyStatus || 'pending',
            alert_sent:         review.alertSent || false,
            updated_at:         new Date().toISOString(),
        }, { onConflict: 'client_slug,platform,platform_review_id' })
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function getUnrespondedReviews(clientSlug) {
    const { data, error } = await supabase
        .from('reviews')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('reply_status', 'pending')
        .order('review_date', { ascending: false });

    if (error) throw error;
    return data || [];
}

async function getNegativeUnalerted(clientSlug, threshold) {
    const { data, error } = await supabase
        .from('reviews')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('alert_sent', false)
        .lte('star_rating', threshold)
        .order('review_date', { ascending: false });

    if (error) throw error;
    return data || [];
}

async function markAlertSent(reviewId) {
    const { error } = await supabase
        .from('reviews')
        .update({ alert_sent: true, alert_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', reviewId);
    if (error) throw error;
}

async function markReplied(reviewId, replyText, replyStatus) {
    const { error } = await supabase
        .from('reviews')
        .update({
            reply_text:   replyText,
            reply_status: replyStatus,
            replied_at:   new Date().toISOString(),
            updated_at:   new Date().toISOString(),
        })
        .eq('id', reviewId);
    if (error) throw error;
}

async function getRecentReviews(clientSlug, platform = null, limit = 50) {
    let query = supabase
        .from('reviews')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('review_date', { ascending: false })
        .limit(limit);

    if (platform) query = query.eq('platform', platform);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

async function getReviewStats(clientSlug, platform = null) {
    const sevenDaysAgo = dayjs().subtract(7, 'day').toISOString();

    let query = supabase
        .from('reviews')
        .select('star_rating, review_date, reply_status')
        .eq('client_slug', clientSlug);

    if (platform) query = query.eq('platform', platform);

    const { data, error } = await query;
    if (error) throw error;

    const all    = data || [];
    const recent = all.filter(r => r.review_date >= sevenDaysAgo);

    return {
        total:         all.length,
        avgRating:     all.length ? (all.reduce((s, r) => s + r.star_rating, 0) / all.length).toFixed(2) : null,
        newLast7d:     recent.length,
        positive7d:    recent.filter(r => r.star_rating >= 4).length,
        negative7d:    recent.filter(r => r.star_rating <= 3).length,
        responseRate7d: recent.length
            ? ((recent.filter(r => r.reply_status !== 'pending').length / recent.length) * 100).toFixed(0)
            : '0',
    };
}

// ─── Review Responses ─────────────────────────────────────────────────────────

async function saveResponse(clientSlug, response) {
    const { error } = await supabase
        .from('review_responses')
        .insert({
            client_slug:         clientSlug,
            review_id:           response.reviewId,
            platform:            response.platform,
            platform_review_id:  response.platformReviewId,
            response_text:       response.responseText,
            response_type:       response.responseType || 'auto',
            posted_successfully: response.postedSuccessfully || false,
            posted_at:           response.postedSuccessfully ? new Date().toISOString() : null,
            error_message:       response.errorMessage || null,
        });
    if (error) throw error;
}

// ─── Alert Log ────────────────────────────────────────────────────────────────

async function logAlert(clientSlug, { reviewId, alertType, platform, starRating, recipient, messageBody }) {
    const { error } = await supabase
        .from('reputation_alerts')
        .insert({
            client_slug:  clientSlug,
            review_id:    reviewId || null,
            alert_type:   alertType,
            platform:     platform || null,
            star_rating:  starRating || null,
            recipient,
            message_body: messageBody,
        });
    if (error) throw error;
}

async function getAlertHistory(clientSlug, alertType = null, limit = 50) {
    let query = supabase
        .from('reputation_alerts')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('sent_at', { ascending: false })
        .limit(limit);

    if (alertType) query = query.eq('alert_type', alertType);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

module.exports = {
    getConnection,
    getAllConnectedClients,
    upsertConnection,
    updateGoogleTokens,
    upsertReview,
    getUnrespondedReviews,
    getNegativeUnalerted,
    markAlertSent,
    markReplied,
    getRecentReviews,
    getReviewStats,
    saveResponse,
    logAlert,
    getAlertHistory,
};
