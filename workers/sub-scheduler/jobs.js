/**
 * GRIDHAND Sub-Scheduler — Bull Queue Job Definitions
 *
 * Jobs:
 *  - sync-schedules    → every 2h: pull BT schedules, mirror to Google Cal
 *  - send-reminders    → 7am daily: SMS subs about tomorrow's work
 *  - check-no-shows    → 10am daily: flag subs who didn't confirm yesterday
 *  - daily-brief       → 7:30am daily: owner gets today's crew lineup
 */

'use strict';

const Bull         = require('bull');
const dayjs        = require('dayjs');
const buildertrend = require('./buildertrend');
const calendar     = require('./calendar');
const sms          = require('./sms');
const db           = require('./db');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const syncQueue     = new Bull('sub-scheduler:sync-schedules',  REDIS_URL);
const reminderQueue = new Bull('sub-scheduler:send-reminders',  REDIS_URL);
const noShowQueue   = new Bull('sub-scheduler:check-no-shows',  REDIS_URL);
const briefQueue    = new Bull('sub-scheduler:daily-brief',     REDIS_URL);

// ─── Job: Sync Schedules ──────────────────────────────────────────────────────

syncQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[SyncSchedules] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const startDate = dayjs().format('YYYY-MM-DD');
    const endDate   = dayjs().add(14, 'day').format('YYYY-MM-DD');

    const items = await buildertrend.getScheduleItems(
        conn.buildertrend_api_key, conn.buildertrend_company_id, startDate, endDate
    );

    let synced = 0;
    for (const item of items) {
        // Mirror to Google Calendar if connected
        let googleEventId = null;
        if (conn.google_access_token) {
            try {
                googleEventId = await calendar.upsertCalendarEvent(
                    clientSlug, conn.google_calendar_id || 'primary', item
                );
            } catch (err) {
                console.warn(`[SyncSchedules] Calendar sync failed: ${err.message}`);
            }
        }

        await db.upsertSchedule(clientSlug, { ...item, googleEventId });
        synced++;
    }

    // Also sync subcontractor directory
    const subs = await buildertrend.getSubcontractors(
        conn.buildertrend_api_key, conn.buildertrend_company_id
    );
    for (const sub of subs) {
        await db.upsertSubcontractor(clientSlug, sub);
    }

    console.log(`[SyncSchedules] Done for ${clientSlug} — ${synced} items synced`);
    return { clientSlug, synced };
});

// ─── Job: Send Reminders ──────────────────────────────────────────────────────

reminderQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[SendReminders] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const hoursAhead = conn.reminder_hours_before || 24;
    const upcoming   = await db.getUpcomingSchedules(clientSlug, hoursAhead + 6);
    let sent = 0;

    for (const sched of upcoming) {
        const timeStr = sched.start_time || '7:00 AM';
        const msg = [
            `Hi ${sched.sub_name || 'there'}! This is a reminder from ${conn.business_name || 'your GC'}.`,
            `You're scheduled at ${sched.project_name || 'the job site'} on ${dayjs(sched.start_date).format('dddd, MMM D')} at ${timeStr}.`,
            `Reply YES to confirm. Questions? Call us.`,
        ].join(' ');

        await sms.sendToSub(conn, sched.sub_phone, msg, 'reminder', sched.bt_schedule_id);
        await db.markReminderSent(clientSlug, sched.bt_schedule_id);
        sent++;
    }

    console.log(`[SendReminders] Done for ${clientSlug} — ${sent} reminders sent`);
    return { clientSlug, sent };
});

// ─── Job: Check No-Shows ──────────────────────────────────────────────────────

noShowQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[CheckNoShows] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const unconfirmed = await db.getYesterdayUnconfirmedSchedules(clientSlug);
    let flagged = 0;

    for (const sched of unconfirmed) {
        const msg = `⚠️ Possible no-show: ${sched.sub_name || sched.sub_phone} did not confirm for "${sched.title}" on ${dayjs(sched.start_date).format('MMM D')} at ${sched.project_name || 'job site'}. Follow up recommended.`;
        await sms.sendToOwner(conn, msg, 'no_show', sched.bt_schedule_id);
        await db.markNoShowAlerted(clientSlug, sched.bt_schedule_id);
        flagged++;
    }

    console.log(`[CheckNoShows] Done for ${clientSlug} — ${flagged} no-shows flagged`);
    return { clientSlug, flagged };
});

// ─── Job: Daily Brief ─────────────────────────────────────────────────────────

briefQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[DailyBrief] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const todaySchedules = await db.getTodaySchedules(clientSlug);

    if (!todaySchedules.length) {
        console.log(`[DailyBrief] No schedules today for ${clientSlug}`);
        return { clientSlug, scheduled: 0 };
    }

    const lines = todaySchedules.map(s =>
        `• ${s.start_time || 'All day'}: ${s.sub_name || 'Sub TBD'} @ ${s.project_name || 'job site'} — ${s.title}`
    );

    const msg = [
        `📋 Today's Crew Lineup — ${conn.business_name || clientSlug}`,
        `${dayjs().format('dddd, MMM D')}`,
        ``,
        ...lines,
        ``,
        `Total: ${todaySchedules.length} crew assignment${todaySchedules.length !== 1 ? 's' : ''}`,
    ].join('\n');

    await sms.sendToOwner(conn, msg, 'daily_brief');

    console.log(`[DailyBrief] Done for ${clientSlug} — ${todaySchedules.length} on schedule`);
    return { clientSlug, scheduled: todaySchedules.length };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['sync-schedules', syncQueue],
    ['send-reminders', reminderQueue],
    ['check-no-shows', noShowQueue],
    ['daily-brief',    briefQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runSyncSchedules(clientSlug) {
    return syncQueue.add({ clientSlug }, { attempts: 3, backoff: 30000 });
}

async function runSendReminders(clientSlug) {
    return reminderQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runCheckNoShows(clientSlug) {
    return noShowQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runDailyBrief(clientSlug) {
    return briefQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runForAllClients(jobFn) {
    const clients = await db.getAllConnectedClients();
    const results = [];
    for (const { client_slug } of clients) {
        try {
            const job = await jobFn(client_slug);
            results.push({ clientSlug: client_slug, jobId: job.id });
        } catch (err) {
            console.error(`[Jobs] Failed to queue for ${client_slug}: ${err.message}`);
        }
    }
    return results;
}

module.exports = {
    runSyncSchedules,
    runSendReminders,
    runCheckNoShows,
    runDailyBrief,
    runForAllClients,
    syncQueue,
    reminderQueue,
    noShowQueue,
    briefQueue,
};
