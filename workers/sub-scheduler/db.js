/**
 * GRIDHAND Sub-Scheduler — Supabase Database Layer
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
        .from('ss_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('ss_connections')
        .select('client_slug');
    if (error) throw error;
    return data || [];
}

async function upsertConnection(conn) {
    const { error } = await supabase
        .from('ss_connections')
        .upsert({ ...conn, updated_at: new Date().toISOString() }, { onConflict: 'client_slug' });
    if (error) throw error;
}

async function updateGoogleTokens(clientSlug, { accessToken, refreshToken, expiresAt }) {
    const { error } = await supabase
        .from('ss_connections')
        .update({ google_access_token: accessToken, google_refresh_token: refreshToken, google_expires_at: expiresAt, updated_at: new Date().toISOString() })
        .eq('client_slug', clientSlug);
    if (error) throw error;
}

// ─── Subcontractors ───────────────────────────────────────────────────────────

async function upsertSubcontractor(clientSlug, sub) {
    const { error } = await supabase
        .from('ss_subcontractors')
        .upsert({
            client_slug: clientSlug,
            name:        sub.name,
            company:     sub.company || null,
            phone:       sub.phone,
            email:       sub.email || null,
            trade:       sub.trade || null,
            bt_sub_id:   sub.btSubId || null,
            updated_at:  new Date().toISOString(),
        }, { onConflict: 'client_slug,phone' });
    if (error) throw error;
}

async function getSubcontractor(clientSlug, phone) {
    const { data, error } = await supabase
        .from('ss_subcontractors')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('phone', phone)
        .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

// ─── Schedules ────────────────────────────────────────────────────────────────

async function upsertSchedule(clientSlug, sched) {
    const { error } = await supabase
        .from('ss_schedules')
        .upsert({
            client_slug:    clientSlug,
            bt_schedule_id: sched.btScheduleId,
            project_id:     sched.projectId || null,
            project_name:   sched.projectName || null,
            title:          sched.title,
            start_date:     sched.startDate,
            start_time:     sched.startTime || null,
            end_date:       sched.endDate || null,
            sub_phone:      sched.subPhone || null,
            sub_name:       sched.subName || null,
            trade:          sched.trade || null,
            google_event_id: sched.googleEventId || null,
            updated_at:     new Date().toISOString(),
        }, { onConflict: 'client_slug,bt_schedule_id' });
    if (error) throw error;
}

async function getUpcomingSchedules(clientSlug, withinHours = 30) {
    const now    = dayjs().toISOString();
    const cutoff = dayjs().add(withinHours, 'hour').format('YYYY-MM-DD');

    const { data, error } = await supabase
        .from('ss_schedules')
        .select('*')
        .eq('client_slug', clientSlug)
        .gte('start_date', dayjs().format('YYYY-MM-DD'))
        .lte('start_date', cutoff)
        .is('reminder_sent_at', null)
        .not('sub_phone', 'is', null);

    if (error) throw error;
    return data || [];
}

async function getTodaySchedules(clientSlug) {
    const today = dayjs().format('YYYY-MM-DD');
    const { data, error } = await supabase
        .from('ss_schedules')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('start_date', today);
    if (error) throw error;
    return data || [];
}

async function markReminderSent(clientSlug, btScheduleId) {
    const { error } = await supabase
        .from('ss_schedules')
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq('client_slug', clientSlug)
        .eq('bt_schedule_id', btScheduleId);
    if (error) throw error;
}

async function markNoShowAlerted(clientSlug, btScheduleId) {
    const { error } = await supabase
        .from('ss_schedules')
        .update({ no_show_alerted: true })
        .eq('client_slug', clientSlug)
        .eq('bt_schedule_id', btScheduleId);
    if (error) throw error;
}

async function getYesterdayUnconfirmedSchedules(clientSlug) {
    const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const { data, error } = await supabase
        .from('ss_schedules')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('start_date', yesterday)
        .eq('confirmed', false)
        .eq('no_show_alerted', false)
        .not('sub_phone', 'is', null);
    if (error) throw error;
    return data || [];
}

// ─── Alert Log ────────────────────────────────────────────────────────────────

async function logAlert(clientSlug, { alertType, recipient, messageBody, scheduleId = null }) {
    const { error } = await supabase
        .from('ss_alerts')
        .insert({ client_slug: clientSlug, alert_type: alertType, recipient, message_body: messageBody, schedule_id: scheduleId });
    if (error) throw error;
}

async function getAlertHistory(clientSlug, alertType = null, limit = 50) {
    let query = supabase
        .from('ss_alerts')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('created_at', { ascending: false })
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
    upsertSubcontractor,
    getSubcontractor,
    upsertSchedule,
    getUpcomingSchedules,
    getTodaySchedules,
    markReminderSent,
    markNoShowAlerted,
    getYesterdayUnconfirmedSchedules,
    logAlert,
    getAlertHistory,
};
