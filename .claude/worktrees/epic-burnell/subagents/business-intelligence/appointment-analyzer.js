// Appointment Pattern Analyzer — tracks no-shows, cancellations, and best booking times
const store = require('../store');

function getDataKey(clientSlug) { return clientSlug; }

function getData(clientSlug) {
    return store.readJson('appointment-analytics', getDataKey(clientSlug)) || {
        appointments: [],
        patterns: {},
        updatedAt: null,
    };
}

function recordAppointment(clientSlug, { customerNumber, serviceName, scheduledAt, status, reminderSent = false }) {
    const data = getData(clientSlug);
    const appt = {
        customerNumber,
        serviceName,
        scheduledAt, // ISO string
        status,      // 'kept' | 'cancelled' | 'no-show' | 'rescheduled'
        reminderSent,
        recordedAt: new Date().toISOString(),
        dayOfWeek: new Date(scheduledAt).getDay(),
        hour: new Date(scheduledAt).getHours(),
    };

    data.appointments.push(appt);
    data.appointments = data.appointments.slice(-500); // keep last 500
    data.updatedAt = new Date().toISOString();

    // Recompute patterns
    data.patterns = computePatterns(data.appointments);
    store.writeJson('appointment-analytics', getDataKey(clientSlug), data);

    console.log(`[AppointmentAnalyzer] Recorded ${status} appointment for ${customerNumber}`);
    return appt;
}

function computePatterns(appointments) {
    if (appointments.length < 5) return {};

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'fri', 'Sat'];
    const byDay = {};
    const byHour = {};
    let noShows = 0, cancellations = 0, kept = 0;

    for (const appt of appointments) {
        const day = dayNames[appt.dayOfWeek] || appt.dayOfWeek;
        const hour = appt.hour;

        if (!byDay[day]) byDay[day] = { kept: 0, noShow: 0, cancelled: 0 };
        if (!byHour[hour]) byHour[hour] = { kept: 0, noShow: 0, cancelled: 0 };

        if (appt.status === 'kept') { byDay[day].kept++; byHour[hour].kept++; kept++; }
        if (appt.status === 'no-show') { byDay[day].noShow++; byHour[hour].noShow++; noShows++; }
        if (appt.status === 'cancelled') { byDay[day].cancelled++; byHour[hour].cancelled++; cancellations++; }
    }

    // Find worst no-show day
    const worstDay = Object.entries(byDay)
        .sort((a, b) => b[1].noShow - a[1].noShow)[0];

    // Find best booking hour
    const bestHour = Object.entries(byHour)
        .filter(([, v]) => v.kept > 0)
        .sort((a, b) => (b[1].kept / (b[1].kept + b[1].noShow + 1)) - (a[1].kept / (a[1].kept + a[1].noShow + 1)))[0];

    return {
        total: appointments.length,
        kept,
        noShows,
        cancellations,
        keepRate: `${((kept / appointments.length) * 100).toFixed(1)}%`,
        worstNoShowDay: worstDay ? worstDay[0] : null,
        bestBookingHour: bestHour ? `${bestHour[0]}:00` : null,
        byDay,
        byHour,
    };
}

function getPatterns(clientSlug) {
    return getData(clientSlug).patterns || {};
}

// Get reminder recommendation based on patterns
function getReminderRecommendation(clientSlug, scheduledAt) {
    const patterns = getPatterns(clientSlug);
    const dayOfWeek = new Date(scheduledAt).getDay();
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'fri', 'Sat'];
    const dayName = dayNames[dayOfWeek];

    const dayData = patterns.byDay?.[dayName];
    const highNoShowDay = dayData && dayData.noShow > dayData.kept;

    return {
        send24hr: true,
        send1hr: highNoShowDay, // Send extra 1hr reminder on high no-show days
        urgency: highNoShowDay ? 'high' : 'normal',
        reason: highNoShowDay ? `${dayName} has historically high no-shows` : 'Standard reminder',
    };
}

module.exports = { recordAppointment, getPatterns, getReminderRecommendation };
