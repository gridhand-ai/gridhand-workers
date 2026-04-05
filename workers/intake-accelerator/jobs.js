/**
 * GRIDHAND Intake Accelerator — Bull Queue Job Definitions
 *
 * Jobs:
 *  - process-inquiry        → triggered immediately when a new lead arrives
 *  - send-follow-up         → every 2 hours: nudge stalled in-progress intakes
 *  - schedule-consultation  → triggered when attorney books a slot for a completed intake
 *  - daily-report           → 9am daily: morning intake summary SMS to attorneys
 *  - weekly-report          → Friday 4pm: week-in-review intake report
 *
 * All queues connect to REDIS_URL. index.js runs node-cron to dispatch
 * time-based jobs; webhook handlers dispatch process-inquiry immediately.
 */

'use strict';

require('dotenv').config();

const Bull   = require('bull');
const dayjs  = require('dayjs');
const intake = require('./intake');
const clio   = require('./clio');
const { createClient } = require('@supabase/supabase-js');

// ─── Supabase ─────────────────────────────────────────────────────────────────

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const processInquiryQueue      = new Bull('intake-accelerator:process-inquiry',      REDIS_URL);
const sendFollowUpQueue        = new Bull('intake-accelerator:send-follow-up',        REDIS_URL);
const scheduleConsultationQueue = new Bull('intake-accelerator:schedule-consultation', REDIS_URL);
const dailyReportQueue         = new Bull('intake-accelerator:daily-report',          REDIS_URL);
const weeklyReportQueue        = new Bull('intake-accelerator:weekly-report',         REDIS_URL);

// ─── Job: Process Inquiry ──────────────────────────────────────────────────────

processInquiryQueue.process(async (job) => {
    const { clientSlug, inquiryData } = job.data;
    console.log(`[ProcessInquiry] Running for ${clientSlug} — phone: ${inquiryData?.contactPhone}`);

    const inquiry = await intake.processNewInquiry(clientSlug, inquiryData);

    console.log(`[ProcessInquiry] Done — inquiry ${inquiry.id} created for ${clientSlug}`);
    return { clientSlug, inquiryId: inquiry.id };
});

// ─── Job: Send Follow-Up ──────────────────────────────────────────────────────

sendFollowUpQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[SendFollowUp] Checking stalled intakes for ${clientSlug}`);

    const stalled = await intake.getStalledInquiries(clientSlug, 4);

    let followUpsSent = 0;

    for (const inq of stalled) {
        const questions = intake.buildQuestionnaire(inq.practice_area);
        const currentStep = inq.questionnaire_step;

        if (currentStep >= questions.length) continue; // Already at the end — shouldn't happen

        const followUpMsg = `Hi — we're still here and ready to help! To continue your consultation request, please reply with your answer to:\n\n${questions[currentStep]}`;

        await intake.sendSms(inq.contact_phone, followUpMsg, clientSlug, 'questionnaire_step');
        followUpsSent++;

        console.log(`[SendFollowUp] Follow-up sent to ${inq.contact_phone} (inquiry ${inq.id})`);
    }

    console.log(`[SendFollowUp] Done for ${clientSlug} — ${followUpsSent} follow-ups sent`);
    return { clientSlug, followUpsSent, stalledCount: stalled.length };
});

// ─── Job: Schedule Consultation ───────────────────────────────────────────────

scheduleConsultationQueue.process(async (job) => {
    const { clientSlug, inquiryId, preferredTime } = job.data;
    console.log(`[ScheduleConsultation] Booking for inquiry ${inquiryId} at ${preferredTime}`);

    const entry = await intake.scheduleConsultation(clientSlug, inquiryId, preferredTime);

    console.log(`[ScheduleConsultation] Done — Clio entry ${entry.id}`);
    return { clientSlug, inquiryId, clioEntryId: entry.id };
});

// ─── Job: Daily Report ────────────────────────────────────────────────────────

dailyReportQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[DailyReport] Running for ${clientSlug}`);

    const conn = await clio.getConnection(clientSlug);
    if (!conn) throw new Error(`No Clio connection for ${clientSlug}`);

    const alertTarget = conn.attorney_phone || conn.owner_phone;
    if (!alertTarget) {
        console.log(`[DailyReport] No phone configured for ${clientSlug} — skipping`);
        return { clientSlug, skipped: true };
    }

    const summary = await intake.buildDailySummary(clientSlug);
    await intake.sendSms(alertTarget, summary, clientSlug, 'daily_report');

    console.log(`[DailyReport] Done for ${clientSlug}`);
    return { clientSlug, sent: true };
});

// ─── Job: Weekly Report ───────────────────────────────────────────────────────

weeklyReportQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[WeeklyReport] Running for ${clientSlug}`);

    const conn = await clio.getConnection(clientSlug);
    if (!conn) throw new Error(`No Clio connection for ${clientSlug}`);

    const alertTarget = conn.attorney_phone || conn.owner_phone;
    if (!alertTarget) {
        console.log(`[WeeklyReport] No phone configured for ${clientSlug} — skipping`);
        return { clientSlug, skipped: true };
    }

    // Pull weekly totals
    const weekStart = dayjs().startOf('week').toISOString();

    const { data: rows, error } = await supabase
        .from('inquiries')
        .select('status, practice_area, inquiry_source')
        .eq('client_slug', clientSlug)
        .gte('created_at', weekStart);

    if (error) throw error;

    const total     = rows.length;
    const completed = rows.filter(r => r.status === 'completed').length;
    const scheduled = rows.filter(r => r.status === 'scheduled').length;
    const declined  = rows.filter(r => r.status === 'declined').length;
    const pending   = rows.filter(r => r.status === 'in_progress' || r.status === 'new').length;

    // Top practice area this week
    const areaCounts = rows.reduce((acc, r) => {
        const a = r.practice_area || 'unknown';
        acc[a] = (acc[a] || 0) + 1;
        return acc;
    }, {});
    const topArea = Object.entries(areaCounts).sort((a, b) => b[1] - a[1])[0];

    const weekLabel = dayjs().startOf('week').format('MMM D') + ' – ' + dayjs().format('MMM D');

    const report = [
        `Weekly Intake Report — ${weekLabel}`,
        `Total inquiries: ${total}`,
        `Completed intakes: ${completed}`,
        `Consultations scheduled: ${scheduled}`,
        `Declined / opted out: ${declined}`,
        `Still pending: ${pending}`,
        topArea ? `Top practice area: ${topArea[0].replace(/_/g, ' ')} (${topArea[1]})` : null,
        `Conversion rate: ${total > 0 ? Math.round((scheduled / total) * 100) : 0}%`,
    ].filter(Boolean).join('\n');

    await intake.sendSms(alertTarget, report, clientSlug, 'weekly_report');

    console.log(`[WeeklyReport] Done for ${clientSlug} — ${total} inquiries this week`);
    return { clientSlug, total, completed, scheduled };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

const queueMap = [
    ['process-inquiry',      processInquiryQueue],
    ['send-follow-up',       sendFollowUpQueue],
    ['schedule-consultation', scheduleConsultationQueue],
    ['daily-report',         dailyReportQueue],
    ['weekly-report',        weeklyReportQueue],
];

for (const [name, queue] of queueMap) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runProcessInquiry(clientSlug, inquiryData) {
    return processInquiryQueue.add({ clientSlug, inquiryData }, { attempts: 3, backoff: 15000 });
}

async function runSendFollowUp(clientSlug) {
    return sendFollowUpQueue.add({ clientSlug }, { attempts: 2, backoff: 30000 });
}

async function runScheduleConsultation(clientSlug, inquiryId, preferredTime) {
    return scheduleConsultationQueue.add({ clientSlug, inquiryId, preferredTime }, { attempts: 3, backoff: 10000 });
}

async function runDailyReport(clientSlug) {
    return dailyReportQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runWeeklyReport(clientSlug) {
    return weeklyReportQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

/**
 * Dispatch a job for every connected client.
 * jobFn must be one of the dispatcher functions above (except runProcessInquiry).
 */
async function runForAllClients(jobFn) {
    const clients = await clio.getAllConnectedClients();
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
    runProcessInquiry,
    runSendFollowUp,
    runScheduleConsultation,
    runDailyReport,
    runWeeklyReport,
    runForAllClients,
    processInquiryQueue,
    sendFollowUpQueue,
    scheduleConsultationQueue,
    dailyReportQueue,
    weeklyReportQueue,
};
