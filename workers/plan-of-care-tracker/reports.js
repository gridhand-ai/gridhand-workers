/**
 * GRIDHAND Plan of Care Tracker — Message Formatters
 *
 * Pure formatting functions — no DB or API calls here.
 */

'use strict';

const dayjs = require('dayjs');

// ─── Patient Visit Reminder ───────────────────────────────────────────────────

function generateVisitReminder({ patientName, visitDate, visitTime, providerName, clinicName, clinicPhone }) {
    const dateStr = dayjs(visitDate).format('ddd, MMM D');
    const timeStr = visitTime ? ` at ${visitTime}` : '';
    const provider = providerName ? ` with ${providerName}` : '';

    return `Hi ${patientName.split(' ')[0]}! Reminder: you have a PT appointment${provider} tomorrow${timeStr} (${dateStr}) at ${clinicName}. Reply CONFIRM to confirm or call ${clinicPhone} to reschedule.`;
}

// ─── Dropoff Warning (to provider/owner) ─────────────────────────────────────

function generateDropoffAlert({ patients, clinicName }) {
    if (patients.length === 0) return null;

    const lines = patients.map(p => {
        const days   = p.last_visit_date
            ? dayjs().diff(dayjs(p.last_visit_date), 'day')
            : '?';
        const visits = p.visits_completed && p.total_visits
            ? `${p.visits_completed}/${p.total_visits} visits`
            : p.visits_completed
                ? `${p.visits_completed} visits done`
                : 'no visits logged';
        return `• ${p.patient_name} — ${days}d since last visit, ${visits}`;
    });

    return [
        `⚠️ ${clinicName} — ${patients.length} patient${patients.length > 1 ? 's' : ''} may be dropping off their plan:`,
        ...lines,
        'Reply with a patient name for their contact info.',
    ].join('\n');
}

// ─── Plan Completion Alert (to provider/owner) ────────────────────────────────

function generatePlanCompleteAlert({ patientName, visitsCompleted, totalVisits, clinicName }) {
    return `✅ ${clinicName}: ${patientName} has completed their plan of care (${visitsCompleted}/${totalVisits} visits). Consider scheduling a discharge assessment or new care plan.`;
}

// ─── Daily Provider Summary ───────────────────────────────────────────────────

function generateProviderSummary({ activePlans, dropoffs, upcomingToday, clinicName }) {
    const lines = [
        `📋 ${clinicName} — Daily POC Summary`,
        `Active plans: ${activePlans} | Today's visits: ${upcomingToday} | New dropoff flags: ${dropoffs}`,
    ];
    if (dropoffs > 0) {
        lines.push(`⚠️ ${dropoffs} patient${dropoffs > 1 ? 's' : ''} flagged for dropoff — check your POC dashboard.`);
    }
    return lines.join('\n');
}

module.exports = {
    generateVisitReminder,
    generateDropoffAlert,
    generatePlanCompleteAlert,
    generateProviderSummary,
};
