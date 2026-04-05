/**
 * GRIDHAND Compliance Watchdog — Supabase Database Layer
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
        .from('compliance_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('compliance_connections')
        .select('client_slug');
    if (error) throw error;
    return data || [];
}

async function upsertConnection(conn) {
    const { error } = await supabase
        .from('compliance_connections')
        .upsert({ ...conn, updated_at: new Date().toISOString() }, { onConflict: 'client_slug' });
    if (error) throw error;
}

// ─── Agent Licenses ───────────────────────────────────────────────────────────

async function upsertLicense(clientSlug, license) {
    const { error } = await supabase
        .from('agent_licenses')
        .upsert({
            client_slug:      clientSlug,
            ams_agent_id:     license.amsAgentId,
            agent_name:       license.agentName,
            agent_email:      license.agentEmail || null,
            agent_phone:      license.agentPhone || null,
            license_number:   license.licenseNumber,
            license_type:     license.licenseType,
            state_code:       license.stateCode,
            issue_date:       license.issueDate || null,
            expiration_date:  license.expirationDate,
            status:           license.status || 'active',
            last_checked_at:  new Date().toISOString(),
            doi_verified:     license.doiVerified || false,
            updated_at:       new Date().toISOString(),
        }, { onConflict: 'client_slug,ams_agent_id,license_number,state_code' });
    if (error) throw error;
}

async function getExpiringLicenses(clientSlug, daysAhead) {
    const cutoff = dayjs().add(daysAhead, 'day').format('YYYY-MM-DD');
    const today  = dayjs().format('YYYY-MM-DD');

    const { data, error } = await supabase
        .from('agent_licenses')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'active')
        .lte('expiration_date', cutoff)
        .gte('expiration_date', today)
        .order('expiration_date', { ascending: true });

    if (error) throw error;
    return data || [];
}

async function getExpiredLicenses(clientSlug) {
    const today = dayjs().format('YYYY-MM-DD');

    const { data, error } = await supabase
        .from('agent_licenses')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'active')
        .lt('expiration_date', today);

    if (error) throw error;
    return data || [];
}

// ─── CE Requirements ──────────────────────────────────────────────────────────

async function upsertCERequirement(clientSlug, ce) {
    const { error } = await supabase
        .from('ce_requirements')
        .upsert({
            client_slug:           clientSlug,
            ams_agent_id:          ce.amsAgentId,
            agent_name:            ce.agentName,
            state_code:            ce.stateCode,
            license_type:          ce.licenseType,
            renewal_period_end:    ce.renewalPeriodEnd,
            hours_required:        ce.hoursRequired,
            hours_completed:       ce.hoursCompleted || 0,
            ethics_hours_required: ce.ethicsHoursRequired || 0,
            ethics_hours_completed: ce.ethicsHoursCompleted || 0,
            status:                ce.status || 'in_progress',
            last_synced_at:        new Date().toISOString(),
            updated_at:            new Date().toISOString(),
        }, { onConflict: 'client_slug,ams_agent_id,state_code,renewal_period_end' });
    if (error) throw error;
}

async function getCEsBehindSchedule(clientSlug) {
    const today = dayjs().format('YYYY-MM-DD');

    const { data, error } = await supabase
        .from('ce_requirements')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'in_progress')
        .lte('renewal_period_end', dayjs().add(90, 'day').format('YYYY-MM-DD'))
        .gt('hours_remaining', 0);

    if (error) throw error;
    return data || [];
}

// ─── Carrier Appointments ─────────────────────────────────────────────────────

async function upsertAppointment(clientSlug, appt) {
    const { error } = await supabase
        .from('carrier_appointments')
        .upsert({
            client_slug:      clientSlug,
            ams_agent_id:     appt.amsAgentId,
            agent_name:       appt.agentName,
            carrier_name:     appt.carrierName,
            carrier_naic:     appt.carrierNaic || null,
            state_code:       appt.stateCode,
            appointment_type: appt.appointmentType || null,
            effective_date:   appt.effectiveDate || null,
            expiration_date:  appt.expirationDate || null,
            renewal_date:     appt.renewalDate || null,
            status:           appt.status || 'active',
            updated_at:       new Date().toISOString(),
        }, { onConflict: 'client_slug,ams_agent_id,carrier_name,state_code,appointment_type' });
    if (error) throw error;
}

async function getExpiringAppointments(clientSlug, daysAhead) {
    const cutoff = dayjs().add(daysAhead, 'day').format('YYYY-MM-DD');
    const today  = dayjs().format('YYYY-MM-DD');

    const { data, error } = await supabase
        .from('carrier_appointments')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'active')
        .not('expiration_date', 'is', null)
        .lte('expiration_date', cutoff)
        .gte('expiration_date', today)
        .order('expiration_date', { ascending: true });

    if (error) throw error;
    return data || [];
}

// ─── Alert Log ────────────────────────────────────────────────────────────────

async function logAlert(clientSlug, { alertType, amsAgentId, daysUntilExpiry, itemId, itemDescription, recipient, messageBody }) {
    // Deduplicate: don't send the same alert twice in one day
    const { data: existing } = await supabase
        .from('compliance_alerts')
        .select('id')
        .eq('client_slug', clientSlug)
        .eq('alert_type', alertType)
        .eq('ams_agent_id', amsAgentId || '')
        .eq('item_id', itemId || '')
        .gte('sent_at', dayjs().startOf('day').toISOString());

    if (existing && existing.length > 0) return; // Already sent today

    const { error } = await supabase
        .from('compliance_alerts')
        .insert({
            client_slug:      clientSlug,
            ams_agent_id:     amsAgentId || null,
            alert_type:       alertType,
            days_until_expiry: daysUntilExpiry || null,
            item_id:          itemId || null,
            item_description: itemDescription || null,
            recipient,
            message_body:     messageBody,
        });

    if (error && !error.message.includes('unique')) throw error;
}

async function getAlertHistory(clientSlug, alertType = null, limit = 50) {
    let query = supabase
        .from('compliance_alerts')
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
    upsertLicense,
    getExpiringLicenses,
    getExpiredLicenses,
    upsertCERequirement,
    getCEsBehindSchedule,
    upsertAppointment,
    getExpiringAppointments,
    logAlert,
    getAlertHistory,
};
