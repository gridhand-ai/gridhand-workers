/**
 * GRIDHAND No-Show Nurse — Bull Queue Job Definitions
 *
 * Queues:
 *   nsn:detect       — scan EHR for no-shows
 *   nsn:reminder     — send pre-appointment reminder batch
 *   nsn:fill-slot    — attempt to fill one open slot from waitlist
 *   nsn:followup     — follow up with today's no-shows
 *   nsn:digest       — weekly Monday stats digest
 *
 * Dispatchers (called by index.js cron or manual /trigger endpoints):
 *   runDetectNoShows(clientSlug)
 *   runSendReminders(clientSlug, hoursOut)
 *   runFillSlot(clientSlug, slotId)
 *   runNoShowFollowUp(clientSlug)
 *   runWeeklyDigest(clientSlug)
 *   runForAllClients(jobFn)
 */

'use strict';

const Bull       = require('bull');
const dayjs      = require('dayjs');
const scheduling = require('./scheduling');
const waitlist   = require('./waitlist');
const outreach   = require('./outreach');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const detectQueue   = new Bull('nsn:detect',    REDIS_URL);
const reminderQueue = new Bull('nsn:reminder',  REDIS_URL);
const fillSlotQueue = new Bull('nsn:fill-slot', REDIS_URL);
const followupQueue = new Bull('nsn:followup',  REDIS_URL);
const digestQueue   = new Bull('nsn:digest',    REDIS_URL);

// ─── Job: Detect No-Shows ─────────────────────────────────────────────────────

detectQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[Jobs:detect] Running for ${clientSlug}`);

    const conn    = await scheduling.getConnection(clientSlug);
    const noShows = await scheduling.detectNoShows(clientSlug);

    let newCount = 0;

    for (const appt of noShows) {
        // Check if already recorded
        const { data: existing } = await supabase
            .from('nsn_no_shows')
            .select('id')
            .eq('client_slug', clientSlug)
            .eq('appointment_id', appt.id)
            .single();

        if (existing) continue;

        // Fetch patient details
        let patient = { id: appt.patientId, name: 'Patient', phone: null };
        if (appt.patientId) {
            try {
                patient = await scheduling.getPatient(clientSlug, appt.patientId);
            } catch (e) {
                console.warn(`[Jobs:detect] Could not fetch patient ${appt.patientId}: ${e.message}`);
            }
        }

        // Record no-show in DB
        await supabase.from('nsn_no_shows').insert({
            client_slug:      clientSlug,
            appointment_id:   appt.id,
            patient_id:       appt.patientId,
            patient_name:     patient.name,
            patient_phone:    patient.phone,
            scheduled_at:     appt.start,
            appointment_type: appt.appointmentType,
            provider_name:    appt.providerName,
            status:           'detected',
        });

        // Attempt to mark in EHR
        try {
            await scheduling.markNoShow(clientSlug, appt.id);
        } catch (e) {
            console.warn(`[Jobs:detect] markNoShow EHR failed for ${appt.id}: ${e.message}`);
        }

        // Alert front desk
        await outreach.sendNoShowAlert(conn, appt, patient);

        // Send patient follow-up immediately
        if (patient.phone) {
            await outreach.sendNoShowFollowUp(conn, patient, appt);
        }

        // Try to fill the slot from waitlist
        await fillSlotQueue.add(
            { clientSlug, slotId: appt.slotId, appointmentType: appt.appointmentType, slotStart: appt.start },
            { attempts: 2, backoff: 30000, delay: 5000 }
        );

        // Bump daily stats
        await bumpNoShowStats(clientSlug);

        newCount++;
    }

    console.log(`[Jobs:detect] Done for ${clientSlug} — ${newCount} new no-shows recorded`);
    return { clientSlug, newNoShows: newCount, totalScanned: noShows.length };
});

// ─── Job: Send Reminders ──────────────────────────────────────────────────────

reminderQueue.process(async (job) => {
    const { clientSlug, hoursOut = 24 } = job.data;
    console.log(`[Jobs:reminder] Running ${hoursOut}hr reminders for ${clientSlug}`);

    const conn = await scheduling.getConnection(clientSlug);

    // Check if this reminder type is enabled
    if (hoursOut >= 24 && !conn.reminder_24hr_enabled) {
        console.log(`[Jobs:reminder] 24hr reminders disabled for ${clientSlug}`);
        return { clientSlug, skipped: true };
    }
    if (hoursOut < 24 && !conn.reminder_2hr_enabled) {
        console.log(`[Jobs:reminder] 2hr reminders disabled for ${clientSlug}`);
        return { clientSlug, skipped: true };
    }

    // Get appointments in the target window
    const targetDate = hoursOut >= 24
        ? dayjs().add(1, 'day').format('YYYY-MM-DD')
        : dayjs().format('YYYY-MM-DD');

    const appointments = await scheduling.getAppointmentsByDate(clientSlug, targetDate);

    // For 2hr: filter to appointments starting in 1.5–2.5hr window
    let targets = appointments;
    if (hoursOut < 24) {
        targets = appointments.filter(appt => {
            const minsOut = dayjs(appt.start).diff(dayjs(), 'minute');
            return minsOut >= 90 && minsOut <= 150;
        });
    }

    // Only remind booked (not confirmed/cancelled/noshow)
    targets = targets.filter(a => a.status === 'booked');

    let sent = 0;
    for (const appt of targets) {
        if (!appt.patientId) continue;

        let patient = { id: appt.patientId, name: 'Patient', phone: null };
        try {
            patient = await scheduling.getPatient(clientSlug, appt.patientId);
        } catch (e) {
            console.warn(`[Jobs:reminder] Could not fetch patient ${appt.patientId}: ${e.message}`);
            continue;
        }

        if (!patient.phone) continue;

        try {
            await outreach.sendPreAppointmentReminder(conn, patient, appt, hoursOut);
            sent++;
        } catch (e) {
            console.error(`[Jobs:reminder] Failed to send reminder for appt ${appt.id}: ${e.message}`);
        }
    }

    console.log(`[Jobs:reminder] Done for ${clientSlug} — ${sent} reminders sent (${hoursOut}hr)`);
    return { clientSlug, sent, hoursOut, appointmentsChecked: targets.length };
});

// ─── Job: Fill Slot ───────────────────────────────────────────────────────────

fillSlotQueue.process(async (job) => {
    const { clientSlug, slotId, appointmentType, slotStart } = job.data;
    console.log(`[Jobs:fill-slot] Filling slot ${slotId} for ${clientSlug}`);

    const fakeSlot = {
        id:              slotId,
        start:           slotStart || null,
        appointmentType: appointmentType || null,
    };

    // Expire any stale offers first
    await waitlist.expireOldOffers(clientSlug);

    // Find top matching waitlist patient
    const matches = await waitlist.findMatchingWaitlistPatients(clientSlug, fakeSlot);
    if (!matches.length) {
        console.log(`[Jobs:fill-slot] No waitlist matches for slot ${slotId} in ${clientSlug}`);
        return { clientSlug, slotId, offered: false };
    }

    await waitlist.offerSlotToPatient(clientSlug, matches[0], fakeSlot);

    console.log(`[Jobs:fill-slot] Offered slot ${slotId} to ${matches[0].patient_name} for ${clientSlug}`);
    return { clientSlug, slotId, offered: true, patientName: matches[0].patient_name };
});

// ─── Job: No-Show Follow-Up ───────────────────────────────────────────────────

followupQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[Jobs:followup] Running for ${clientSlug}`);

    const conn = await scheduling.getConnection(clientSlug);
    const today = dayjs().format('YYYY-MM-DD');

    // Get no-shows from today that haven't been followed up yet
    const { data: noShows, error } = await supabase
        .from('nsn_no_shows')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'detected')
        .gte('scheduled_at', `${today}T00:00:00Z`)
        .lte('scheduled_at', `${today}T23:59:59Z`);

    if (error) throw error;
    if (!noShows?.length) {
        console.log(`[Jobs:followup] No pending follow-ups for ${clientSlug}`);
        return { clientSlug, sent: 0 };
    }

    let sent = 0;
    for (const ns of noShows) {
        if (!ns.patient_phone) continue;

        try {
            await outreach.sendNoShowFollowUp(
                conn,
                { id: ns.patient_id, name: ns.patient_name, phone: ns.patient_phone },
                { id: ns.appointment_id, start: ns.scheduled_at, appointmentType: ns.appointment_type }
            );
            sent++;
        } catch (e) {
            console.error(`[Jobs:followup] Follow-up failed for ${ns.appointment_id}: ${e.message}`);
        }
    }

    console.log(`[Jobs:followup] Done for ${clientSlug} — ${sent} follow-ups sent`);
    return { clientSlug, sent };
});

// ─── Job: Weekly Digest ───────────────────────────────────────────────────────

digestQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[Jobs:digest] Running for ${clientSlug}`);

    const conn = await scheduling.getConnection(clientSlug);
    const result = await outreach.sendWeeklyDigest(conn);

    console.log(`[Jobs:digest] Done for ${clientSlug}`);
    return { clientSlug, ...result };
});

// ─── Internal stat helpers ────────────────────────────────────────────────────

async function bumpNoShowStats(clientSlug) {
    const today = dayjs().format('YYYY-MM-DD');
    const { data: existing } = await supabase
        .from('nsn_daily_stats')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('stat_date', today)
        .single();

    if (!existing) {
        await supabase.from('nsn_daily_stats').insert({
            client_slug:   clientSlug,
            stat_date:     today,
            no_show_count: 1,
        });
    } else {
        await supabase
            .from('nsn_daily_stats')
            .update({ no_show_count: (existing.no_show_count || 0) + 1 })
            .eq('client_slug', clientSlug)
            .eq('stat_date', today);
    }
}

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['nsn:detect',    detectQueue],
    ['nsn:reminder',  reminderQueue],
    ['nsn:fill-slot', fillSlotQueue],
    ['nsn:followup',  followupQueue],
    ['nsn:digest',    digestQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} completed for ${job.data.clientSlug}`);
    });
}

// ─── Dispatchers ──────────────────────────────────────────────────────────────

async function runDetectNoShows(clientSlug) {
    return detectQueue.add({ clientSlug }, { attempts: 3, backoff: 30000 });
}

async function runSendReminders(clientSlug, hoursOut = 24) {
    return reminderQueue.add({ clientSlug, hoursOut }, { attempts: 2, backoff: 60000 });
}

async function runFillSlot(clientSlug, slotId, opts = {}) {
    return fillSlotQueue.add(
        { clientSlug, slotId, ...opts },
        { attempts: 2, backoff: 30000 }
    );
}

async function runNoShowFollowUp(clientSlug) {
    return followupQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runWeeklyDigest(clientSlug) {
    return digestQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

/**
 * Run a job function for all connected clients.
 * @param {Function} jobFn — one of the run* functions above
 */
async function runForAllClients(jobFn) {
    const { data: clients, error } = await supabase
        .from('nsn_connections')
        .select('client_slug');

    if (error) throw error;
    if (!clients?.length) return [];

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

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    runDetectNoShows,
    runSendReminders,
    runFillSlot,
    runNoShowFollowUp,
    runWeeklyDigest,
    runForAllClients,
    detectQueue,
    reminderQueue,
    fillSlotQueue,
    followupQueue,
    digestQueue,
};
