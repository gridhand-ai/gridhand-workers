/**
 * GRIDHAND Compliance Watchdog — Bull Queue Job Definitions
 *
 * Jobs:
 *  - ams-sync          → 6am daily: pull licenses, CE, appointments from AMS
 *  - license-check     → 7am daily: flag expiring/expired licenses, SMS owner
 *  - ce-check          → 7:30am Mon: check CE progress, alert on agents behind schedule
 *  - appointment-check → 8am Mon: flag expiring carrier appointments
 *  - weekly-digest     → 8am Mon: send weekly compliance summary SMS
 *
 * All jobs are registered here. index.js schedules them via node-cron.
 */

'use strict';

const Bull    = require('bull');
const dayjs   = require('dayjs');
const ams     = require('./ams');
const reports = require('./reports');
const db      = require('./db');
const sms     = require('./sms');

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const amsSyncQueue         = new Bull('compliance:ams-sync',          REDIS_URL);
const licenseCheckQueue    = new Bull('compliance:license-check',      REDIS_URL);
const ceCheckQueue         = new Bull('compliance:ce-check',           REDIS_URL);
const appointmentCheckQueue = new Bull('compliance:appointment-check', REDIS_URL);
const weeklyDigestQueue    = new Bull('compliance:weekly-digest',      REDIS_URL);

// ─── Job: AMS Sync ────────────────────────────────────────────────────────────

amsSyncQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[AMSSync] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const [licenses, ceReqs, appointments] = await Promise.all([
        ams.getAgentLicenses(clientSlug, conn),
        ams.getCERequirements(clientSlug, conn),
        ams.getCarrierAppointments(clientSlug, conn),
    ]);

    for (const license of licenses) {
        await db.upsertLicense(clientSlug, license);
    }

    for (const ce of ceReqs) {
        await db.upsertCERequirement(clientSlug, ce);
    }

    for (const appt of appointments) {
        await db.upsertAppointment(clientSlug, appt);
    }

    console.log(`[AMSSync] Done for ${clientSlug} — ${licenses.length} licenses, ${ceReqs.length} CE records, ${appointments.length} appointments`);
    return { clientSlug, licenses: licenses.length, ceReqs: ceReqs.length, appointments: appointments.length };
});

// ─── Job: License Check ───────────────────────────────────────────────────────

licenseCheckQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[LicenseCheck] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const alertThresholds = conn.alert_days_ahead || [90, 60, 30, 14];

    // Check expired licenses first (most urgent)
    const expired = await db.getExpiredLicenses(clientSlug);
    if (expired.length > 0) {
        const msg = reports.generateLicenseExpiredAlert({
            licenses:   expired,
            agencyName: conn.agency_name || clientSlug,
        });
        if (msg) await sms.sendToOwner(conn, msg, 'license_expired', { itemDescription: 'expired_licenses' });
    }

    // Check each alert threshold
    const maxDays = Math.max(...alertThresholds);
    const expiring = await db.getExpiringLicenses(clientSlug, maxDays);

    // Group by alert threshold bucket
    for (const threshold of alertThresholds.sort((a, b) => a - b)) {
        const inBucket = expiring.filter(l => {
            const days = dayjs(l.expiration_date).diff(dayjs(), 'day');
            return days <= threshold;
        });

        if (inBucket.length > 0) {
            const msg = reports.generateLicenseExpiringAlert({
                licenses:   inBucket,
                agencyName: conn.agency_name || clientSlug,
            });

            if (msg) {
                // Only send if we haven't sent this same alert today
                await sms.sendToOwner(conn, msg, 'license_expiring', {
                    daysUntilExpiry: threshold,
                    itemDescription: `expiring_${threshold}d`,
                });
            }
            break; // Only send one threshold level per run (most urgent)
        }
    }

    const totalFlagged = expired.length + expiring.length;
    console.log(`[LicenseCheck] Done for ${clientSlug} — ${expired.length} expired, ${expiring.length} expiring`);
    return { clientSlug, expired: expired.length, expiring: expiring.length, totalFlagged };
});

// ─── Job: CE Check ────────────────────────────────────────────────────────────

ceCheckQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[CECheck] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const behind = await db.getCEsBehindSchedule(clientSlug);

    if (behind.length === 0) {
        console.log(`[CECheck] All agents on track for ${clientSlug}`);
        return { clientSlug, behindCount: 0 };
    }

    const msg = reports.generateCEBehindAlert({
        ceRecords:  behind,
        agencyName: conn.agency_name || clientSlug,
    });

    if (msg) {
        await sms.sendToOwner(conn, msg, 'ce_behind', { itemDescription: 'ce_behind_schedule' });
    }

    console.log(`[CECheck] Done for ${clientSlug} — ${behind.length} agents behind on CE`);
    return { clientSlug, behindCount: behind.length };
});

// ─── Job: Appointment Check ───────────────────────────────────────────────────

appointmentCheckQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[AppointmentCheck] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const expiring = await db.getExpiringAppointments(clientSlug, 90);

    if (expiring.length === 0) {
        console.log(`[AppointmentCheck] No expiring appointments for ${clientSlug}`);
        return { clientSlug, expiringCount: 0 };
    }

    const msg = reports.generateAppointmentExpiringAlert({
        appointments: expiring,
        agencyName:   conn.agency_name || clientSlug,
    });

    if (msg) {
        await sms.sendToOwner(conn, msg, 'appointment_expiring', { itemDescription: 'carrier_appointments' });
    }

    console.log(`[AppointmentCheck] Done for ${clientSlug} — ${expiring.length} appointments expiring`);
    return { clientSlug, expiringCount: expiring.length };
});

// ─── Job: Weekly Digest ───────────────────────────────────────────────────────

weeklyDigestQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[WeeklyDigest] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const [expiringLicenses, expiredLicenses, ceBehind, expiringAppts] = await Promise.all([
        db.getExpiringLicenses(clientSlug, 90),
        db.getExpiredLicenses(clientSlug),
        db.getCEsBehindSchedule(clientSlug),
        db.getExpiringAppointments(clientSlug, 90),
    ]);

    const digestMsg = reports.generateWeeklyDigest({
        expiringLicenses,
        expiredLicenses,
        ceBehind,
        expiringAppts,
        agencyName: conn.agency_name || clientSlug,
    });

    await sms.sendToOwner(conn, digestMsg, 'weekly_digest', { itemDescription: 'weekly_compliance_summary' });

    console.log(`[WeeklyDigest] Done for ${clientSlug}`);
    return { clientSlug, issues: expiringLicenses.length + expiredLicenses.length + ceBehind.length + expiringAppts.length };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['ams-sync',          amsSyncQueue],
    ['license-check',     licenseCheckQueue],
    ['ce-check',          ceCheckQueue],
    ['appointment-check', appointmentCheckQueue],
    ['weekly-digest',     weeklyDigestQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} job failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} job completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runAMSSync(clientSlug) {
    return amsSyncQueue.add({ clientSlug }, { attempts: 3, backoff: 60000 });
}

async function runLicenseCheck(clientSlug) {
    return licenseCheckQueue.add({ clientSlug }, { attempts: 2, backoff: 30000 });
}

async function runCECheck(clientSlug) {
    return ceCheckQueue.add({ clientSlug }, { attempts: 2, backoff: 30000 });
}

async function runAppointmentCheck(clientSlug) {
    return appointmentCheckQueue.add({ clientSlug }, { attempts: 2, backoff: 30000 });
}

async function runWeeklyDigest(clientSlug) {
    return weeklyDigestQueue.add({ clientSlug }, { attempts: 2, backoff: 30000 });
}

async function runForAllClients(jobFn) {
    const clients = await db.getAllConnectedClients();
    const results = [];
    for (const { client_slug } of clients) {
        try {
            const job = await jobFn(client_slug);
            results.push({ clientSlug: client_slug, jobId: job.id });
        } catch (err) {
            console.error(`[Jobs] Failed to queue job for ${client_slug}: ${err.message}`);
        }
    }
    return results;
}

module.exports = {
    runAMSSync,
    runLicenseCheck,
    runCECheck,
    runAppointmentCheck,
    runWeeklyDigest,
    runForAllClients,
    amsSyncQueue,
    licenseCheckQueue,
    ceCheckQueue,
    appointmentCheckQueue,
    weeklyDigestQueue,
};
