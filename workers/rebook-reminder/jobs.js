/**
 * GRIDHAND Rebook Reminder — Bull Queue Job Definitions
 *
 * Jobs:
 *  - rebook-scan   → 10am Tue/Thu: identify overdue clients, send personalized SMS reminders
 *  - sync-clients  → 3am Sunday: pull 90 days of appointment history, recalculate rebook intervals
 *
 * All jobs are registered here. index.js schedules them via node-cron.
 */

'use strict';

const Bull    = require('bull');
const dayjs   = require('dayjs');
const booking = require('./booking');
const db      = require('./db');
const sms     = require('./sms');

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const rebookScanQueue   = new Bull('rebook-reminder:rebook-scan',  REDIS_URL);
const syncClientsQueue  = new Bull('rebook-reminder:sync-clients', REDIS_URL);

// ─── Job: Rebook Scan ─────────────────────────────────────────────────────────

rebookScanQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[RebookScan] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    // Get all clients who have a known rebook interval
    const clients = await db.getClientsWithRebookInterval(clientSlug);

    let remindersSent   = 0;
    let overdueCount    = 0;
    const skippedNoPhone = [];

    for (const client of clients) {
        if (client.opted_out) continue;
        if (!client.last_visit_date) continue;

        const daysSinceLastVisit = dayjs().diff(dayjs(client.last_visit_date), 'day');
        const overdueDays        = daysSinceLastVisit - client.avg_rebook_days;

        if (overdueDays <= 0) continue;

        overdueCount++;

        // Throttle: don't send if we already reminded them in the last 7 days
        if (client.last_reminder_sent) {
            const daysSinceReminder = dayjs().diff(dayjs(client.last_reminder_sent), 'day');
            if (daysSinceReminder < 7) {
                console.log(`[RebookScan] Skipping ${client.name} — reminded ${daysSinceReminder}d ago`);
                continue;
            }
        }

        if (!client.phone) {
            skippedNoPhone.push(client.name);
            continue;
        }

        try {
            await sms.sendRebookReminder(conn, {
                clientPhone:     client.phone,
                clientName:      client.name,
                lastServiceType: client.last_service_type || 'your last service',
                overdueDays,
                salonName:       conn.salon_name,
                bookingUrl:      conn.booking_url,
            });

            await db.updateClientReminderSent(clientSlug, client.id);
            await db.logAlert(clientSlug, {
                alertType:   'rebook_reminder',
                recipient:   client.phone,
                messageBody: `Rebook reminder sent to ${client.name} (${overdueDays}d overdue)`,
            });

            remindersSent++;
            console.log(`[RebookScan] Sent reminder to ${client.name} — ${overdueDays}d overdue`);
        } catch (err) {
            console.error(`[RebookScan] Failed to SMS ${client.name}: ${err.message}`);
        }
    }

    if (skippedNoPhone.length > 0) {
        console.log(`[RebookScan] Skipped (no phone): ${skippedNoPhone.join(', ')}`);
    }

    console.log(`[RebookScan] Done for ${clientSlug} — ${remindersSent} reminders sent, ${overdueCount} overdue`);
    return { clientSlug, remindersSent, overdueCount, skippedNoPhone: skippedNoPhone.length };
});

// ─── Job: Sync Clients ────────────────────────────────────────────────────────

syncClientsQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[SyncClients] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    // Pull last 90 days of appointments from booking system
    const appointments = await booking.getRecentAppointments(conn, 90);

    if (!appointments || appointments.length === 0) {
        console.log(`[SyncClients] No appointments found for ${clientSlug}`);
        return { clientSlug, synced: 0 };
    }

    // Group appointments by clientId to calculate average rebook interval
    const clientMap = new Map();

    for (const appt of appointments) {
        if (!clientMap.has(appt.clientId)) {
            clientMap.set(appt.clientId, {
                clientId:    appt.clientId,
                name:        appt.clientName,
                phone:       appt.clientPhone || null,
                serviceType: appt.serviceType,
                visits:      [],
            });
        }
        const entry = clientMap.get(appt.clientId);
        entry.visits.push(dayjs(appt.completedAt));
        // Keep most recent service type
        if (dayjs(appt.completedAt).isAfter(entry.visits[entry.visits.length - 2] || dayjs(0))) {
            entry.serviceType = appt.serviceType;
        }
    }

    let synced = 0;

    for (const [, clientData] of clientMap) {
        // Sort visits oldest → newest
        clientData.visits.sort((a, b) => a.diff(b));

        const lastVisit   = clientData.visits[clientData.visits.length - 1];
        const visitCount  = clientData.visits.length;

        // Calculate average days between visits (need at least 2 visits)
        let avgRebookDays = 0;
        if (visitCount >= 2) {
            let totalGap = 0;
            for (let i = 1; i < clientData.visits.length; i++) {
                totalGap += clientData.visits[i].diff(clientData.visits[i - 1], 'day');
            }
            avgRebookDays = Math.round(totalGap / (visitCount - 1));
        }

        // Calculate current overdue days
        const daysSinceLast = dayjs().diff(lastVisit, 'day');
        const overdueDays   = avgRebookDays > 0 ? Math.max(0, daysSinceLast - avgRebookDays) : 0;

        await db.upsertClient(clientSlug, {
            externalClientId: clientData.clientId,
            name:             clientData.name,
            phone:            clientData.phone,
            lastVisitDate:    lastVisit.format('YYYY-MM-DD'),
            lastServiceType:  clientData.serviceType,
            visitCount,
            avgRebookDays,
            overdueDays,
        });

        synced++;
    }

    await db.logAlert(clientSlug, {
        alertType:   'sync_complete',
        recipient:   conn.owner_phone || 'system',
        messageBody: `Client sync complete: ${synced} clients updated from ${appointments.length} appointments`,
    });

    console.log(`[SyncClients] Done for ${clientSlug} — ${synced} clients synced from ${appointments.length} appointments`);
    return { clientSlug, synced, appointmentCount: appointments.length };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['rebook-scan',  rebookScanQueue],
    ['sync-clients', syncClientsQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} job failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} job completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runRebookScan(clientSlug) {
    return rebookScanQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runSyncClients(clientSlug) {
    return syncClientsQueue.add({ clientSlug }, { attempts: 3, backoff: 30000 });
}

/**
 * Run a job for all connected clients.
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
    runRebookScan,
    runSyncClients,
    runForAllClients,
    rebookScanQueue,
    syncClientsQueue,
};
