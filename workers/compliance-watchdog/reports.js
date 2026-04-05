/**
 * GRIDHAND Compliance Watchdog — SMS Message Formatters
 *
 * Pure formatting functions — no DB or API calls.
 */

'use strict';

const dayjs = require('dayjs');

// ─── License Expiring Alert ───────────────────────────────────────────────────

function generateLicenseExpiringAlert({ licenses, agencyName }) {
    if (licenses.length === 0) return null;

    const lines = licenses.slice(0, 5).map(l => {
        const days = dayjs(l.expiration_date).diff(dayjs(), 'day');
        const type = formatLicenseType(l.license_type);
        return `• ${l.agent_name} — ${l.state_code} ${type} expires in ${days}d (${dayjs(l.expiration_date).format('M/D/YY')})`;
    });

    const more = licenses.length > 5 ? `\n+ ${licenses.length - 5} more` : '';
    const urgency = licenses.some(l => dayjs(l.expiration_date).diff(dayjs(), 'day') <= 14) ? '🚨' : '⚠️';

    return [
        `${urgency} ${agencyName} — License${licenses.length > 1 ? 's' : ''} Expiring:`,
        ...lines,
        more,
        'Renew immediately to avoid E&O exposure.',
    ].filter(Boolean).join('\n');
}

// ─── License Expired Alert ────────────────────────────────────────────────────

function generateLicenseExpiredAlert({ licenses, agencyName }) {
    if (licenses.length === 0) return null;

    const lines = licenses.map(l => {
        const type = formatLicenseType(l.license_type);
        return `• ${l.agent_name} — ${l.state_code} ${type} EXPIRED ${dayjs(l.expiration_date).format('M/D/YY')}`;
    });

    return [
        `🚨 ${agencyName} — EXPIRED Licenses (IMMEDIATE ACTION REQUIRED):`,
        ...lines,
        'Do NOT let these agents bind or sell. Renew immediately!',
    ].join('\n');
}

// ─── CE Behind Schedule Alert ─────────────────────────────────────────────────

function generateCEBehindAlert({ ceRecords, agencyName }) {
    if (ceRecords.length === 0) return null;

    const lines = ceRecords.slice(0, 4).map(ce => {
        const daysLeft  = dayjs(ce.renewal_period_end).diff(dayjs(), 'day');
        const hoursLeft = parseFloat(ce.hours_remaining || 0).toFixed(1);
        return `• ${ce.agent_name} — ${ce.state_code}: ${hoursLeft}h remaining, due in ${daysLeft}d`;
    });

    const more = ceRecords.length > 4 ? `\n+ ${ceRecords.length - 4} more agents` : '';

    return [
        `📚 ${agencyName} — CE Behind Schedule:`,
        ...lines,
        more,
        'Agents must complete CE before license renewal date.',
    ].filter(Boolean).join('\n');
}

// ─── Carrier Appointment Expiring Alert ───────────────────────────────────────

function generateAppointmentExpiringAlert({ appointments, agencyName }) {
    if (appointments.length === 0) return null;

    const lines = appointments.slice(0, 4).map(a => {
        const days = dayjs(a.expiration_date).diff(dayjs(), 'day');
        return `• ${a.agent_name} — ${a.carrier_name} (${a.state_code}) expires in ${days}d`;
    });

    const more = appointments.length > 4 ? `\n+ ${appointments.length - 4} more` : '';

    return [
        `⚠️ ${agencyName} — Carrier Appointments Expiring:`,
        ...lines,
        more,
        'Re-appoint before expiry or agents lose ability to write these carriers.',
    ].filter(Boolean).join('\n');
}

// ─── Weekly Compliance Digest ─────────────────────────────────────────────────

function generateWeeklyDigest({ expiringLicenses, expiredLicenses, ceBehind, expiringAppts, agencyName }) {
    const issues = [];

    if (expiredLicenses.length > 0)   issues.push(`🚨 ${expiredLicenses.length} EXPIRED license${expiredLicenses.length > 1 ? 's' : ''}`);
    if (expiringLicenses.length > 0)  issues.push(`⚠️ ${expiringLicenses.length} license${expiringLicenses.length > 1 ? 's' : ''} expiring soon`);
    if (ceBehind.length > 0)          issues.push(`📚 ${ceBehind.length} agent${ceBehind.length > 1 ? 's' : ''} behind on CE`);
    if (expiringAppts.length > 0)     issues.push(`📋 ${expiringAppts.length} carrier appointment${expiringAppts.length > 1 ? 's' : ''} expiring`);

    if (issues.length === 0) {
        return `✅ ${agencyName} — Weekly Compliance Check: All licenses, CE requirements, and carrier appointments are current. Great work!`;
    }

    return [
        `📋 ${agencyName} — Weekly Compliance Summary:`,
        ...issues,
        'Check your compliance dashboard for details.',
    ].join('\n');
}

function formatLicenseType(type) {
    const map = {
        property_casualty: 'P&C',
        life:              'Life',
        health:            'Health',
        surplus_lines:     'Surplus Lines',
        variable:          'Variable',
    };
    return map[type] || type;
}

module.exports = {
    generateLicenseExpiringAlert,
    generateLicenseExpiredAlert,
    generateCEBehindAlert,
    generateAppointmentExpiringAlert,
    generateWeeklyDigest,
};
