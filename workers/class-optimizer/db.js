/**
 * GRIDHAND Class Optimizer — Supabase Database Layer
 *
 * Thin wrapper around Supabase client for all DB operations.
 * All raw queries go here — jobs.js and other modules stay clean.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Clients ──────────────────────────────────────────────────────────────────

async function getAllClients() {
    const { data, error } = await supabase
        .from('co_clients')
        .select('*')
        .order('business_name', { ascending: true });

    if (error) throw error;
    return data || [];
}

async function getClient(clientSlug) {
    const { data, error } = await supabase
        .from('co_clients')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function upsertClient({
    clientSlug,
    businessName,
    mindbodySiteId,
    mindbodyApiKey,
    googleCalendarId,
    googleServiceAccountJson,
    minAttendanceThreshold,
    cancellationNoticeHours,
    ownerPhone,
}) {
    const { data, error } = await supabase
        .from('co_clients')
        .upsert({
            client_slug:                clientSlug,
            business_name:              businessName,
            mindbody_site_id:           mindbodySiteId,
            mindbody_api_key:           mindbodyApiKey,
            google_calendar_id:         googleCalendarId         || null,
            google_service_account_json: googleServiceAccountJson || null,
            min_attendance_threshold:   minAttendanceThreshold   ?? 3,
            cancellation_notice_hours:  cancellationNoticeHours  ?? 2,
            owner_phone:                ownerPhone                || null,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'client_slug' })
        .select()
        .single();

    if (error) throw error;
    return data;
}

// ─── Classes ──────────────────────────────────────────────────────────────────

async function getClassesByClient(clientId, activeOnly = false) {
    let query = supabase
        .from('co_classes')
        .select('*')
        .eq('client_id', clientId)
        .order('day_of_week', { ascending: true });

    if (activeOnly) query = query.eq('is_active', true);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

async function getClassById(classId) {
    const { data, error } = await supabase
        .from('co_classes')
        .select('*')
        .eq('id', classId)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function upsertClass({
    clientId,
    mindbodyClassId,
    className,
    instructorName,
    dayOfWeek,
    startTime,
    durationMinutes,
    maxCapacity,
    googleEventId,
    isActive,
}) {
    const { data, error } = await supabase
        .from('co_classes')
        .upsert({
            client_id:         clientId,
            mindbody_class_id: String(mindbodyClassId),
            class_name:        className,
            instructor_name:   instructorName    || null,
            day_of_week:       dayOfWeek         ?? null,
            start_time:        startTime         || null,
            duration_minutes:  durationMinutes   || null,
            max_capacity:      maxCapacity       || null,
            google_event_id:   googleEventId     || null,
            is_active:         isActive !== undefined ? isActive : true,
            updated_at:        new Date().toISOString(),
        }, { onConflict: 'client_id,mindbody_class_id' })
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function deactivateClass(classId) {
    const { error } = await supabase
        .from('co_classes')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', classId);

    if (error) throw error;
}

async function updateClassGoogleEventId(classId, googleEventId) {
    const { error } = await supabase
        .from('co_classes')
        .update({ google_event_id: googleEventId, updated_at: new Date().toISOString() })
        .eq('id', classId);

    if (error) throw error;
}

// ─── Attendance Records ───────────────────────────────────────────────────────

async function upsertAttendanceRecord({
    clientId,
    classId,
    classDate,
    enrolledCount,
    attendedCount,
    capacity,
}) {
    const fillRate = capacity > 0
        ? parseFloat(((attendedCount / capacity) * 100).toFixed(2))
        : 0;

    const { data, error } = await supabase
        .from('co_attendance_records')
        .upsert({
            client_id:      clientId,
            class_id:       classId,
            class_date:     classDate,
            enrolled_count: enrolledCount,
            attended_count: attendedCount,
            capacity:       capacity,
            fill_rate:      fillRate,
        }, { onConflict: 'class_id,class_date' })
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function getAttendanceByClient(clientId, days = 30) {
    const since = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);

    const { data, error } = await supabase
        .from('co_attendance_records')
        .select('*, co_classes(class_name, instructor_name, day_of_week, start_time)')
        .eq('client_id', clientId)
        .gte('class_date', since)
        .order('class_date', { ascending: false });

    if (error) throw error;
    return data || [];
}

async function getAttendanceByClass(classId, days = 90) {
    const since = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);

    const { data, error } = await supabase
        .from('co_attendance_records')
        .select('*')
        .eq('class_id', classId)
        .gte('class_date', since)
        .order('class_date', { ascending: false });

    if (error) throw error;
    return data || [];
}

/**
 * Returns per-class aggregate stats: avg_attended, avg_fill_rate, sessions_count.
 * Used by the analysis job to identify underperformers.
 */
async function getClassAttendanceStats(clientId, days = 30) {
    const since = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);

    const { data, error } = await supabase
        .from('co_attendance_records')
        .select('class_id, attended_count, fill_rate, class_date')
        .eq('client_id', clientId)
        .gte('class_date', since);

    if (error) throw error;

    // Aggregate per class_id in JS
    const byClass = {};
    for (const row of data || []) {
        if (!byClass[row.class_id]) {
            byClass[row.class_id] = { sessions: 0, totalAttended: 0, totalFillRate: 0 };
        }
        byClass[row.class_id].sessions++;
        byClass[row.class_id].totalAttended  += row.attended_count;
        byClass[row.class_id].totalFillRate  += parseFloat(row.fill_rate || 0);
    }

    return Object.entries(byClass).map(([classId, agg]) => ({
        classId,
        sessionsCount:  agg.sessions,
        avgAttended:    parseFloat((agg.totalAttended / agg.sessions).toFixed(1)),
        avgFillRate:    parseFloat((agg.totalFillRate / agg.sessions).toFixed(2)),
    }));
}

// ─── Recommendations ──────────────────────────────────────────────────────────

async function insertRecommendation({
    clientId,
    classId,
    recommendationType,
    reason,
    data: payload,
}) {
    const { data, error } = await supabase
        .from('co_recommendations')
        .insert({
            client_id:           clientId,
            class_id:            classId || null,
            recommendation_type: recommendationType,
            reason,
            data:                payload || null,
            status:              'pending',
        })
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function getRecommendationsByClient(clientId, status = null) {
    let query = supabase
        .from('co_recommendations')
        .select('*, co_classes(class_name, instructor_name, day_of_week, start_time)')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

async function updateRecommendationStatus(recommendationId, status) {
    const { data, error } = await supabase
        .from('co_recommendations')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', recommendationId)
        .select()
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

// ─── Cancellations ────────────────────────────────────────────────────────────

async function logCancellation({
    clientId,
    classId,
    classDate,
    cancellationReason,
    notifiedCount,
    googleEventDeleted,
}) {
    const { data, error } = await supabase
        .from('co_cancellations')
        .insert({
            client_id:           clientId,
            class_id:            classId       || null,
            class_date:          classDate,
            cancellation_reason: cancellationReason,
            notified_count:      notifiedCount      || 0,
            google_event_deleted: googleEventDeleted || false,
        })
        .select()
        .single();

    if (error) throw error;
    return data;
}

async function getCancellationsByClient(clientId, days = 30) {
    const since = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);

    const { data, error } = await supabase
        .from('co_cancellations')
        .select('*, co_classes(class_name, instructor_name)')
        .eq('client_id', clientId)
        .gte('class_date', since)
        .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
}

module.exports = {
    getAllClients,
    getClient,
    upsertClient,
    getClassesByClient,
    getClassById,
    upsertClass,
    deactivateClass,
    updateClassGoogleEventId,
    upsertAttendanceRecord,
    getAttendanceByClient,
    getAttendanceByClass,
    getClassAttendanceStats,
    insertRecommendation,
    getRecommendationsByClient,
    updateRecommendationStatus,
    logCancellation,
    getCancellationsByClient,
};
