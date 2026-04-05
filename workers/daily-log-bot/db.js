/**
 * GRIDHAND Daily Log Bot — Supabase Database Layer
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Connections ──────────────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('dlb_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('dlb_connections')
        .select('client_slug');
    if (error) throw error;
    return data || [];
}

async function upsertConnection(conn) {
    const { error } = await supabase
        .from('dlb_connections')
        .upsert({ ...conn, updated_at: new Date().toISOString() }, { onConflict: 'client_slug' });
    if (error) throw error;
}

async function updateProcoreTokens(clientSlug, { accessToken, refreshToken, expiresAt }) {
    const { error } = await supabase
        .from('dlb_connections')
        .update({
            procore_access_token:  accessToken,
            procore_refresh_token: refreshToken,
            procore_expires_at:    expiresAt,
            updated_at:            new Date().toISOString(),
        })
        .eq('client_slug', clientSlug);
    if (error) throw error;
}

// ─── Daily Reports ────────────────────────────────────────────────────────────

async function upsertDailyReport(clientSlug, report) {
    const { error } = await supabase
        .from('dlb_daily_reports')
        .upsert({
            client_slug:              clientSlug,
            procore_project_id:       report.projectId,
            project_name:             report.projectName,
            report_date:              report.reportDate,
            weather_temp_f:           report.weatherTempF,
            weather_desc:             report.weatherDesc,
            weather_wind_mph:         report.weatherWindMph,
            weather_precip_in:        report.weatherPrecipIn,
            weather_suitable_for_work: report.weatherSuitable,
            crew_checkin_count:       report.crewCount,
            crew_names:               JSON.stringify(report.crewNames || []),
            photo_count:              report.photoCount,
            photo_urls:               JSON.stringify(report.photoUrls || []),
            photo_summary:            report.photoSummary,
            report_text:              report.reportText,
            procore_log_id:           report.procoreLogId || null,
            status:                   report.status || 'generated',
            raw_data:                 report.rawData || null,
        }, { onConflict: 'client_slug,procore_project_id,report_date' });
    if (error) throw error;
}

async function getRecentReports(clientSlug, projectId, days = 7) {
    const { data, error } = await supabase
        .from('dlb_daily_reports')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('procore_project_id', projectId)
        .order('report_date', { ascending: false })
        .limit(days);
    if (error) throw error;
    return data || [];
}

// ─── Alert Log ────────────────────────────────────────────────────────────────

async function logAlert(clientSlug, { alertType, recipient, messageBody, projectId = null }) {
    const { error } = await supabase
        .from('dlb_alerts')
        .insert({
            client_slug:  clientSlug,
            alert_type:   alertType,
            recipient,
            message_body: messageBody,
            project_id:   projectId,
        });
    if (error) throw error;
}

async function getAlertHistory(clientSlug, alertType = null, limit = 50) {
    let query = supabase
        .from('dlb_alerts')
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
    updateProcoreTokens,
    upsertDailyReport,
    getRecentReports,
    logAlert,
    getAlertHistory,
};
