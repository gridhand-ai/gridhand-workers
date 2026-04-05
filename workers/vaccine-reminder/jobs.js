/**
 * GRIDHAND Vaccine Reminder — Bull Queue Job Definitions
 *
 * Jobs:
 *  - vaccine-check         → weekly (+ daily critical): scan patients, find due/overdue vaccines, send tiered SMS
 *  - booking-confirmation  → after owner replies YES: confirm appointment request via SMS
 *
 * All jobs are registered here. index.js schedules them via node-cron.
 */

'use strict';

const Bull  = require('bull');
const dayjs = require('dayjs');
const pms   = require('./pms');
const sms   = require('./sms');
const db    = require('./db');

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const vaccineCheckQueue        = new Bull('vaccine-reminder:vaccine-check',        REDIS_URL);
const bookingConfirmationQueue = new Bull('vaccine-reminder:booking-confirmation',  REDIS_URL);

// ─── Job: Vaccine Check ───────────────────────────────────────────────────────

vaccineCheckQueue.process(async (job) => {
    const { clientSlug, criticalOnly = false } = job.data;
    console.log(`[VaccineCheck] Running for ${clientSlug} (criticalOnly=${criticalOnly})`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No vet connection for ${clientSlug}`);

    // Pull all active patients with vaccine records
    const patients = await pms.getPatients(conn);
    console.log(`[VaccineCheck] ${patients.length} patients loaded for ${clientSlug}`);

    const today          = dayjs();
    let   remindersSent  = 0;
    let   patientsScanned = 0;

    for (const patient of patients) {
        if (!patient.vaccines || patient.vaccines.length === 0) continue;

        patientsScanned++;

        for (const vaccine of patient.vaccines) {
            const dueDate = dayjs(vaccine.dueDate);
            if (!dueDate.isValid()) continue;

            const daysUntilDue = dueDate.diff(today, 'day');
            const daysOverdue  = daysUntilDue < 0 ? Math.abs(daysUntilDue) : 0;

            // Determine tier
            let reminderType = null;
            if (daysUntilDue >= 0 && daysUntilDue <= 30)   reminderType = 'due_soon';
            else if (daysOverdue >= 1  && daysOverdue <= 60)  reminderType = 'overdue_mild';
            else if (daysOverdue >= 61 && daysOverdue <= 90)  reminderType = 'overdue_serious';
            else if (daysOverdue > 90)                         reminderType = 'critical';

            if (!reminderType) continue;

            // If criticalOnly mode (daily cron), skip non-critical
            if (criticalOnly && reminderType !== 'critical') continue;

            const ownerPhone = patient.ownerPhone;
            if (!ownerPhone) {
                console.log(`[VaccineCheck] No phone for patient ${patient.name} — skipping`);
                continue;
            }

            // Check throttle — max 1 reminder per vaccine per patient per 14 days
            const existing = await db.getVaccineReminder(clientSlug, patient.id, vaccine.name);
            const THROTTLE_DAYS = 14;

            if (existing && existing.last_reminder_sent) {
                const daysSinceLast = today.diff(dayjs(existing.last_reminder_sent), 'day');
                if (daysSinceLast < THROTTLE_DAYS) {
                    console.log(`[VaccineCheck] Throttled — ${patient.name}/${vaccine.name} last sent ${daysSinceLast}d ago`);
                    continue;
                }
            }

            // Send tiered reminder SMS
            await sms.sendReminderSMS(conn, {
                ownerPhone,
                petName:      patient.name,
                vaccineName:  vaccine.name,
                dueDate:      dueDate.format('MM/DD/YYYY'),
                reminderType,
                daysOverdue,
                practiceName:  conn.practice_name,
                practicePhone: conn.owner_phone,
            });

            // Upsert reminder record
            await db.upsertVaccineReminder(clientSlug, {
                patientId:       patient.id,
                patientName:     patient.name,
                ownerPhone,
                vaccineName:     vaccine.name,
                dueDate:         dueDate.format('YYYY-MM-DD'),
                daysOverdue,
                reminderType,
                reminderCount:   (existing?.reminder_count || 0) + 1,
                lastReminderSent: today.toISOString(),
                status:          daysOverdue > 0 ? 'overdue' : 'due_soon',
            });

            remindersSent++;
            console.log(`[VaccineCheck] Sent ${reminderType} reminder for ${patient.name}/${vaccine.name} to ${ownerPhone}`);
        }
    }

    console.log(`[VaccineCheck] Done for ${clientSlug} — scanned ${patientsScanned} patients, sent ${remindersSent} reminders`);
    return { clientSlug, patientsScanned, remindersSent };
});

// ─── Job: Booking Confirmation ────────────────────────────────────────────────

bookingConfirmationQueue.process(async (job) => {
    const { clientSlug, ownerPhone, petName, vaccineName, appointmentDate } = job.data;
    console.log(`[BookingConfirmation] Running for ${clientSlug} — ${petName}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No vet connection for ${clientSlug}`);

    await sms.sendConfirmationSMS(conn, {
        ownerPhone,
        petName,
        vaccineName,
        appointmentDate,
    });

    console.log(`[BookingConfirmation] Confirmation sent to ${ownerPhone} for ${petName}`);
    return { clientSlug, ownerPhone, petName };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['vaccine-check',        vaccineCheckQueue],
    ['booking-confirmation', bookingConfirmationQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} job failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} job completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runVaccineCheck(clientSlug) {
    return vaccineCheckQueue.add({ clientSlug, criticalOnly: false }, { attempts: 2, backoff: 60000 });
}

async function runCriticalOverdueCheck(clientSlug) {
    return vaccineCheckQueue.add({ clientSlug, criticalOnly: true }, { attempts: 2, backoff: 60000 });
}

async function runBookingConfirmation({ clientSlug, ownerPhone, petName, vaccineName, appointmentDate }) {
    return bookingConfirmationQueue.add(
        { clientSlug, ownerPhone, petName, vaccineName, appointmentDate },
        { attempts: 3, backoff: 30000 }
    );
}

/**
 * Run a job for every connected client.
 * Called by cron triggers in index.js.
 */
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
    runVaccineCheck,
    runCriticalOverdueCheck,
    runBookingConfirmation,
    runForAllClients,
    vaccineCheckQueue,
    bookingConfirmationQueue,
};
