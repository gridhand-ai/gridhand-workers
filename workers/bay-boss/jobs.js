// Bay Boss Bull Queue Jobs
// Uses Bull (Redis-backed) for reliable scheduled and triggered jobs
//
// JOBS:
//   morning-briefing  — 7:00am daily — SMS to shop owner with day overview
//   eod-summary       — 6:00pm daily — SMS with utilization stats
//   schedule-check    — Every 30min  — Detect overruns, idle techs, bay issues
//   alert-owner       — On-demand    — Triggered by schedule-check when alert threshold hit

const Bull   = require('bull');
const twilio = require('twilio');
const tekmetric = require('./tekmetric');
const scheduler = require('./scheduler');
const calendar  = require('./calendar');

// ─── Redis connection ─────────────────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// ─── Queue factory ────────────────────────────────────────────────────────────
function createQueue(name) {
    return new Bull(name, REDIS_URL, {
        defaultJobOptions: {
            removeOnComplete: 50,
            removeOnFail:     20,
            attempts:         3,
            backoff: { type: 'exponential', delay: 5000 },
        },
    });
}

// ─── Queues ───────────────────────────────────────────────────────────────────
const morningBriefingQueue = createQueue('bay-boss:morning-briefing');
const eodSummaryQueue      = createQueue('bay-boss:eod-summary');
const scheduleCheckQueue   = createQueue('bay-boss:schedule-check');
const alertOwnerQueue      = createQueue('bay-boss:alert-owner');

// ─── SMS Sender ───────────────────────────────────────────────────────────────
function getTwilioClient(config) {
    const sid   = config.twilioAccountSid   || process.env.TWILIO_ACCOUNT_SID;
    const token = config.twilioAuthToken    || process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error('Twilio credentials missing for Bay Boss');
    return twilio(sid, token);
}

async function sendSMS(config, to, body) {
    const client = getTwilioClient(config);
    const from   = config.twilioFrom || process.env.TWILIO_FROM_NUMBER;

    try {
        const msg = await client.messages.create({ from, to, body });
        console.log(`[BayBoss] SMS sent to ${to}: "${body.slice(0, 60)}..." (SID: ${msg.sid})`);
        return msg;
    } catch (e) {
        console.error(`[BayBoss] SMS send failed to ${to}: ${e.message}`);
        throw e;
    }
}

// ─── Job: Morning Briefing ────────────────────────────────────────────────────
morningBriefingQueue.process(async (job) => {
    const { config } = job.data;
    const {
        tekmetricApiKey,
        shopId,
        totalBays     = 6,
        ownerPhone,
        calendarConfig,
        techCalendarMap,
    } = config;

    console.log(`[BayBoss] Running morning briefing for shop ${shopId}`);

    const snapshot    = await tekmetric.getDailySnapshot(tekmetricApiKey, shopId, totalBays);
    const bayStatus   = scheduler.analyzeBayUtilization(snapshot.bayStatus);

    // Pull tech calendar schedules if configured
    let techSchedules = {};
    if (calendarConfig && techCalendarMap) {
        try {
            techSchedules = await calendar.getAllTechSchedules(calendarConfig, techCalendarMap);
        } catch (e) {
            console.warn(`[BayBoss] Calendar fetch failed, continuing without: ${e.message}`);
        }
    }

    const techAnalysis = scheduler.analyzeTechWorkloads(snapshot.techWorkload, techSchedules);
    const brief        = await scheduler.generateScheduleBrief(snapshot, techAnalysis, bayStatus, 'morning');

    if (ownerPhone) {
        await sendSMS(config, ownerPhone, brief);
    }

    return { brief, snapshot: { date: snapshot.date, appts: snapshot.appointments.length } };
});

// ─── Job: EOD Summary ─────────────────────────────────────────────────────────
eodSummaryQueue.process(async (job) => {
    const { config } = job.data;
    const { tekmetricApiKey, shopId, totalBays = 6, ownerPhone } = config;

    console.log(`[BayBoss] Running EOD summary for shop ${shopId}`);

    const snapshot   = await tekmetric.getDailySnapshot(tekmetricApiKey, shopId, totalBays);
    const bayStatus  = scheduler.analyzeBayUtilization(snapshot.bayStatus);
    const techAnalysis = scheduler.analyzeTechWorkloads(snapshot.techWorkload);

    const summary = await scheduler.generateScheduleBrief(snapshot, techAnalysis, bayStatus, 'eod');

    // Build utilization stats line
    const completed    = snapshot.allOrders.filter(o => o.status === 'COMPLETE').length;
    const utilLine     = `\n\nStats: ${completed}/${snapshot.allOrders.length} jobs done | ${bayStatus.utilizationPct}% bay util`;

    const fullSummary = summary + utilLine;

    if (ownerPhone) {
        await sendSMS(config, ownerPhone, fullSummary);
    }

    return { summary: fullSummary, completed, total: snapshot.allOrders.length };
});

// ─── Job: Schedule Check ──────────────────────────────────────────────────────
scheduleCheckQueue.process(async (job) => {
    const { config } = job.data;
    const { tekmetricApiKey, shopId, totalBays = 6 } = config;

    console.log(`[BayBoss] Running schedule check for shop ${shopId}`);

    const snapshot = await tekmetric.getDailySnapshot(tekmetricApiKey, shopId, totalBays);
    const result   = await scheduler.runScheduleOptimization(snapshot);

    // If there are high-severity alerts, trigger the alert queue
    const highAlerts = result.alerts.filter(a => a.severity === 'high');
    if (highAlerts.length > 0) {
        await alertOwnerQueue.add(
            { config, alerts: highAlerts, recommendations: result.recommendations },
            { priority: 1 }  // highest priority
        );
        console.log(`[BayBoss] Queued ${highAlerts.length} high-priority alert(s)`);
    }

    return {
        alertsFound: result.alerts.length,
        highAlerts:  highAlerts.length,
        bayStatus:   result.bayUtilization.status,
        overruns:    result.overrunJobs.length,
    };
});

// ─── Job: Alert Owner ─────────────────────────────────────────────────────────
alertOwnerQueue.process(async (job) => {
    const { config, alerts, recommendations } = job.data;
    const { ownerPhone } = config;

    if (!ownerPhone) {
        console.warn('[BayBoss] Alert skipped — no ownerPhone configured');
        return { skipped: true };
    }

    // Build SMS from alerts
    const lines = ['⚠️ Bay Boss Alert:'];

    for (const alert of alerts.slice(0, 3)) {
        lines.push(`• ${alert.message}`);
    }

    if (recommendations) {
        // Trim to fit SMS limit
        const rec = recommendations.split('\n').slice(0, 2).join(' ');
        lines.push(`💡 ${rec}`);
    }

    const body = lines.join('\n').slice(0, 320);

    await sendSMS(config, ownerPhone, body);

    return { alertsSent: alerts.length, to: ownerPhone };
});

// ─── Error handlers ───────────────────────────────────────────────────────────
[morningBriefingQueue, eodSummaryQueue, scheduleCheckQueue, alertOwnerQueue].forEach(q => {
    q.on('failed', (job, err) => {
        console.error(`[BayBoss] Job "${job.name}" in queue "${q.name}" failed: ${err.message}`);
    });
    q.on('completed', (job, result) => {
        console.log(`[BayBoss] Job "${job.name}" completed in queue "${q.name}"`);
    });
});

// ─── Schedule Recurring Jobs ──────────────────────────────────────────────────
// Call this on server startup with the client config
async function scheduleRecurringJobs(config) {
    const {
        morningBriefingTime = '7 0 * * 1-6',  // 7:00am Mon–Sat
        eodSummaryTime      = '0 18 * * 1-6',  // 6:00pm Mon–Sat
        scheduleCheckCron   = '*/30 7-18 * * 1-6', // Every 30min during business hours
    } = config;

    // Clear existing repeated jobs
    await morningBriefingQueue.removeRepeatable({ cron: morningBriefingTime });
    await eodSummaryQueue.removeRepeatable({ cron: eodSummaryTime });
    await scheduleCheckQueue.removeRepeatable({ cron: scheduleCheckCron });

    // Add new ones
    await morningBriefingQueue.add({ config }, { repeat: { cron: morningBriefingTime } });
    await eodSummaryQueue.add({ config },      { repeat: { cron: eodSummaryTime } });
    await scheduleCheckQueue.add({ config },   { repeat: { cron: scheduleCheckCron } });

    console.log('[BayBoss] Recurring jobs scheduled:');
    console.log(`  Morning briefing: ${morningBriefingTime}`);
    console.log(`  EOD summary:      ${eodSummaryTime}`);
    console.log(`  Schedule check:   ${scheduleCheckCron}`);
}

// ─── Manual Triggers ──────────────────────────────────────────────────────────
async function triggerMorningBriefing(config) {
    return morningBriefingQueue.add({ config }, { priority: 1 });
}

async function triggerEodSummary(config) {
    return eodSummaryQueue.add({ config }, { priority: 1 });
}

async function triggerScheduleCheck(config) {
    return scheduleCheckQueue.add({ config }, { priority: 1 });
}

async function triggerAlert(config, message) {
    return alertOwnerQueue.add({
        config,
        alerts: [{ type: 'manual', message, severity: 'high' }],
        recommendations: null,
    }, { priority: 1 });
}

// ─── Queue Status ─────────────────────────────────────────────────────────────
async function getQueueStatus() {
    const queues = { morningBriefing: morningBriefingQueue, eodSummary: eodSummaryQueue, scheduleCheck: scheduleCheckQueue, alertOwner: alertOwnerQueue };
    const status = {};

    for (const [name, queue] of Object.entries(queues)) {
        const [waiting, active, completed, failed] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount(),
        ]);
        status[name] = { waiting, active, completed, failed };
    }

    return status;
}

module.exports = {
    scheduleRecurringJobs,
    triggerMorningBriefing,
    triggerEodSummary,
    triggerScheduleCheck,
    triggerAlert,
    getQueueStatus,
    queues: {
        morningBriefing: morningBriefingQueue,
        eodSummary:      eodSummaryQueue,
        scheduleCheck:   scheduleCheckQueue,
        alertOwner:      alertOwnerQueue,
    },
};
