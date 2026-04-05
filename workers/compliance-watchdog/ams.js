/**
 * GRIDHAND Compliance Watchdog — AMS Integration (Applied Epic + HawkSoft)
 *
 * Fetches agent licenses, CE records, and carrier appointments from the AMS.
 *
 * Applied Epic API: https://developer.vertafore.com/apis
 * HawkSoft API:     https://developer.hawksoft.com
 */

'use strict';

const axios = require('axios');

const APPLIED_BASE  = 'https://api.vertafore.com/v1';
const HAWKSOFT_BASE = 'https://api.hawksoft.com/v2';

// ─── Auth Headers ─────────────────────────────────────────────────────────────

function buildHeaders(conn) {
    if (conn.ams_type === 'hawksoft') {
        return {
            'Authorization': `Bearer ${conn.ams_api_key}`,
            'Content-Type':  'application/json',
            'Accept':        'application/json',
        };
    }
    // Applied Epic
    return {
        'Authorization': `Bearer ${conn.ams_api_key}`,
        'Vertafore-App-Name':    'GRIDHAND',
        'Vertafore-App-Version': '1.0.0',
        'Content-Type':          'application/json',
        'Accept':                'application/json',
    };
}

function baseUrl(conn) {
    return conn.ams_type === 'hawksoft'
        ? (conn.ams_base_url || HAWKSOFT_BASE)
        : (conn.ams_base_url || APPLIED_BASE);
}

// ─── Fetch Agent Licenses ─────────────────────────────────────────────────────

async function getAgentLicenses(clientSlug, conn) {
    try {
        if (conn.ams_type === 'hawksoft') {
            return await getHawkSoftLicenses(conn);
        }
        return await getAppliedEpicLicenses(conn);
    } catch (err) {
        console.error(`[AMS] getAgentLicenses error for ${clientSlug}: ${err.message}`);
        throw err;
    }
}

async function getAppliedEpicLicenses(conn) {
    const { data } = await axios.get(`${baseUrl(conn)}/agents/licenses`, {
        headers: buildHeaders(conn),
        params: { limit: 500, status: 'all' },
    });

    return (data.AgentLicenses || data.licenses || []).map(l => ({
        amsAgentId:     String(l.AgentId || l.agent_id),
        agentName:      l.AgentName || l.agent_name,
        agentEmail:     l.Email || l.email || null,
        agentPhone:     l.Phone || l.phone || null,
        licenseNumber:  l.LicenseNumber || l.license_number,
        licenseType:    normalizeLicenseType(l.LicenseType || l.license_type),
        stateCode:      l.StateCode || l.state_code,
        issueDate:      l.IssueDate || l.issue_date || null,
        expirationDate: l.ExpirationDate || l.expiration_date,
        status:         (l.Status || l.status || 'active').toLowerCase(),
    }));
}

async function getHawkSoftLicenses(conn) {
    const { data } = await axios.get(`${baseUrl(conn)}/agents/licenses`, {
        headers: buildHeaders(conn),
        params: { pageSize: 500 },
    });

    return (data.data || data.licenses || []).map(l => ({
        amsAgentId:     String(l.agentId),
        agentName:      l.agentName,
        agentEmail:     l.email || null,
        agentPhone:     l.phone || null,
        licenseNumber:  l.licenseNumber,
        licenseType:    normalizeLicenseType(l.licenseType),
        stateCode:      l.stateCode,
        issueDate:      l.issueDate || null,
        expirationDate: l.expirationDate,
        status:         (l.status || 'active').toLowerCase(),
    }));
}

// ─── Fetch CE Requirements ─────────────────────────────────────────────────────

async function getCERequirements(clientSlug, conn) {
    try {
        if (conn.ams_type === 'hawksoft') {
            return await getHawkSoftCE(conn);
        }
        return await getAppliedEpicCE(conn);
    } catch (err) {
        console.error(`[AMS] getCERequirements error for ${clientSlug}: ${err.message}`);
        throw err;
    }
}

async function getAppliedEpicCE(conn) {
    const { data } = await axios.get(`${baseUrl(conn)}/agents/ce-requirements`, {
        headers: buildHeaders(conn),
        params: { limit: 500 },
    });

    return (data.CERequirements || data.ce_requirements || []).map(ce => ({
        amsAgentId:           String(ce.AgentId || ce.agent_id),
        agentName:            ce.AgentName || ce.agent_name,
        stateCode:            ce.StateCode || ce.state_code,
        licenseType:          normalizeLicenseType(ce.LicenseType || ce.license_type),
        renewalPeriodEnd:     ce.RenewalPeriodEnd || ce.renewal_period_end,
        hoursRequired:        parseFloat(ce.HoursRequired || ce.hours_required || 0),
        hoursCompleted:       parseFloat(ce.HoursCompleted || ce.hours_completed || 0),
        ethicsHoursRequired:  parseFloat(ce.EthicsHoursRequired || ce.ethics_hours_required || 0),
        ethicsHoursCompleted: parseFloat(ce.EthicsHoursCompleted || ce.ethics_hours_completed || 0),
        status:               (ce.Status || ce.status || 'in_progress').toLowerCase(),
    }));
}

async function getHawkSoftCE(conn) {
    const { data } = await axios.get(`${baseUrl(conn)}/agents/continuing-education`, {
        headers: buildHeaders(conn),
        params: { pageSize: 500 },
    });

    return (data.data || data.ce || []).map(ce => ({
        amsAgentId:           String(ce.agentId),
        agentName:            ce.agentName,
        stateCode:            ce.stateCode,
        licenseType:          normalizeLicenseType(ce.licenseType),
        renewalPeriodEnd:     ce.renewalPeriodEnd,
        hoursRequired:        parseFloat(ce.hoursRequired || 0),
        hoursCompleted:       parseFloat(ce.hoursCompleted || 0),
        ethicsHoursRequired:  parseFloat(ce.ethicsHoursRequired || 0),
        ethicsHoursCompleted: parseFloat(ce.ethicsHoursCompleted || 0),
        status:               (ce.status || 'in_progress').toLowerCase(),
    }));
}

// ─── Fetch Carrier Appointments ───────────────────────────────────────────────

async function getCarrierAppointments(clientSlug, conn) {
    try {
        if (conn.ams_type === 'hawksoft') {
            return await getHawkSoftAppointments(conn);
        }
        return await getAppliedEpicAppointments(conn);
    } catch (err) {
        console.error(`[AMS] getCarrierAppointments error for ${clientSlug}: ${err.message}`);
        throw err;
    }
}

async function getAppliedEpicAppointments(conn) {
    const { data } = await axios.get(`${baseUrl(conn)}/agents/carrier-appointments`, {
        headers: buildHeaders(conn),
        params: { limit: 500, status: 'all' },
    });

    return (data.CarrierAppointments || data.appointments || []).map(a => ({
        amsAgentId:      String(a.AgentId || a.agent_id),
        agentName:       a.AgentName || a.agent_name,
        carrierName:     a.CarrierName || a.carrier_name,
        carrierNaic:     a.CarrierNAIC || a.carrier_naic || null,
        stateCode:       a.StateCode || a.state_code,
        appointmentType: normalizeLicenseType(a.AppointmentType || a.appointment_type || ''),
        effectiveDate:   a.EffectiveDate || a.effective_date || null,
        expirationDate:  a.ExpirationDate || a.expiration_date || null,
        renewalDate:     a.RenewalDate || a.renewal_date || null,
        status:          (a.Status || a.status || 'active').toLowerCase(),
    }));
}

async function getHawkSoftAppointments(conn) {
    const { data } = await axios.get(`${baseUrl(conn)}/agents/appointments`, {
        headers: buildHeaders(conn),
        params: { pageSize: 500 },
    });

    return (data.data || data.appointments || []).map(a => ({
        amsAgentId:      String(a.agentId),
        agentName:       a.agentName,
        carrierName:     a.carrierName,
        carrierNaic:     a.carrierNaic || null,
        stateCode:       a.stateCode,
        appointmentType: normalizeLicenseType(a.appointmentType || ''),
        effectiveDate:   a.effectiveDate || null,
        expirationDate:  a.expirationDate || null,
        renewalDate:     a.renewalDate || null,
        status:          (a.status || 'active').toLowerCase(),
    }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeLicenseType(raw) {
    if (!raw) return 'other';
    const lower = raw.toLowerCase().replace(/[^a-z0-9]/g, '_');
    if (lower.includes('property') || lower.includes('casualty') || lower.includes('p_c')) return 'property_casualty';
    if (lower.includes('life')) return 'life';
    if (lower.includes('health')) return 'health';
    if (lower.includes('surplus')) return 'surplus_lines';
    if (lower.includes('variable')) return 'variable';
    return lower;
}

module.exports = {
    getAgentLicenses,
    getCERequirements,
    getCarrierAppointments,
};
