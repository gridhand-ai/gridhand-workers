/**
 * GRIDHAND Plan of Care Tracker — Bull Queue Job Definitions
 *
 * Jobs:
 *  - visit-reminders    → 8am daily: SMS patients with appointments in next 24h
 *  - dropoff-monitor    → 10am daily: flag patients who haven't visited per their plan
 *  - plan-sync          → 6am daily: sync treatment plans + recent visits from EHR
 *  - provider-summary   → 7:30am daily: send daily summary to clinic provider/owner
 *
 * All jobs are registered here. index.js schedules them via node-cron.
 */

'use strict';

const Bull    = require('bull');
const dayjs   = require('dayjs');
const ehr     = require('./webpt');
const reports = require('./reports');
const db      = require('./db');
const sms     = require('./sms');

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const planSyncQueue       = new Bull('poc:plan-sync',       REDIS_URL);
const visitReminderQueue  = new Bull('poc:visit-reminders', REDIS_URL);
const dropoffMonitorQueue = new Bull('poc:dropoff-monitor', REDIS_URL);
const providerSummaryQueue = new Bull('poc:provider-summary', REDIS_URL);

// ─── Job: Plan Sync ───────────────────────────────────────────────────────────

planSyncQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[PlanSync] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    // Sync active treatment plans
    const plans = await ehr.getActiveTreatmentPlans(clientSlug, conn);
    for (const plan of plans) {
        await db.upsertTreatmentPlan(clientSlug, plan);
    }

    // Sync recent visits (last 7 days)
    const visits = await ehr.getRecentVisits(clientSlug, conn, 7);
    for (const visit of visits) {
        await db.upsertVisitRecord(clientSlug, visit);
    }

    console.log(`[PlanSync] Done for ${clientSlug} — ${plans.length} plans, ${visits.length} visits`);
    return { clientSlug, plansSync: plans.length, visitsSync: visits.length };
});

// ─── Job: Visit Reminders ─────────────────────────────────────────────────────

visitReminderQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[VisitReminders] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const hoursAhead    = conn.reminder_hours || 24;
    const upcomingAppts = await ehr.getUpcomingAppointments(clientSlug, conn, Math.ceil(hoursAhead / 24) + 1);

    // Filter to appointments within the reminder window
    const now    = dayjs();
    const cutoff = now.add(hoursAhead, 'hour');

    let remindersSent = 0;

    for (const appt of upcomingAppts) {
        if (!appt.patientPhone) {
            console.log(`[VisitReminders] No phone for patient ${appt.ehrPatientId} — skipping`);
            continue;
        }

        const apptTime = appt.visitTime
            ? dayjs(`${appt.visitDate} ${appt.visitTime}`)
            : dayjs(appt.visitDate);

        if (apptTime.isAfter(now) && apptTime.isBefore(cutoff)) {
            const message = reports.generateVisitReminder({
                patientName:  appt.patientName,
                visitDate:    appt.visitDate,
                visitTime:    appt.visitTime,
                providerName: appt.providerName,
                clinicName:   conn.clinic_name || clientSlug,
                clinicPhone:  conn.owner_phone || '',
            });

            await sms.sendToPatient(conn, appt.patientPhone, message, appt.ehrPatientId, 'visit_reminder');
            remindersSent++;
        }
    }

    console.log(`[VisitReminders] Done for ${clientSlug} — ${remindersSent} reminders sent`);
    return { clientSlug, remindersSent };
});

// ─── Job: Dropoff Monitor ─────────────────────────────────────────────────────

dropoffMonitorQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[DropoffMonitor] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const thresholdDays = conn.dropoff_threshold || 14;
    const candidates    = await db.getDropoffCandidates(clientSlug, thresholdDays);

    if (candidates.length === 0) {
        console.log(`[DropoffMonitor] No dropoff candidates for ${clientSlug}`);
        return { clientSlug, dropoffsFlagged: 0 };
    }

    // Flag them in DB
    for (const patient of candidates) {
        await db.flagDropoff(clientSlug, patient.ehr_patient_id);
    }

    // Alert provider/owner
    const alertMsg = reports.generateDropoffAlert({
        patients:   candidates,
        clinicName: conn.clinic_name || clientSlug,
    });

    if (alertMsg) {
        await sms.sendToProvider(conn, alertMsg, 'dropoff_warning');
    }

    console.log(`[DropoffMonitor] Done for ${clientSlug} — ${candidates.length} dropoffs flagged`);
    return { clientSlug, dropoffsFlagged: candidates.length };
});

// ─── Job: Provider Daily Summary ──────────────────────────────────────────────

providerSummaryQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[ProviderSummary] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const activePlans    = await db.getActivePlans(clientSlug);
    const todayAppts     = await ehr.getUpcomingAppointments(clientSlug, conn, 1);
    const dropoffFlagged = activePlans.filter(p => p.dropoff_flagged).length;

    const summaryMsg = reports.generateProviderSummary({
        activePlans:    activePlans.length,
        dropoffs:       dropoffFlagged,
        upcomingToday:  todayAppts.length,
        clinicName:     conn.clinic_name || clientSlug,
    });

    await sms.sendToProvider(conn, summaryMsg, 'provider_summary');

    console.log(`[ProviderSummary] Done for ${clientSlug}`);
    return { clientSlug, activePlans: activePlans.length, todayAppts: todayAppts.length };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['plan-sync',       planSyncQueue],
    ['visit-reminders', visitReminderQueue],
    ['dropoff-monitor', dropoffMonitorQueue],
    ['provider-summary', providerSummaryQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} job failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} job completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runPlanSync(clientSlug) {
    return planSyncQueue.add({ clientSlug }, { attempts: 3, backoff: 60000 });
}

async function runVisitReminders(clientSlug) {
    return visitReminderQueue.add({ clientSlug }, { attempts: 2, backoff: 30000 });
}

async function runDropoffMonitor(clientSlug) {
    return dropoffMonitorQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runProviderSummary(clientSlug) {
    return providerSummaryQueue.add({ clientSlug }, { attempts: 2, backoff: 30000 });
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
    runPlanSync,
    runVisitReminders,
    runDropoffMonitor,
    runProviderSummary,
    runForAllClients,
    planSyncQueue,
    visitReminderQueue,
    dropoffMonitorQueue,
    providerSummaryQueue,
};
