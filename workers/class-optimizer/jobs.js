/**
 * GRIDHAND Class Optimizer — Bull Queue Job Definitions
 *
 * Queues:
 *   co:class-sync       — Sync class schedule from Mindbody, upsert to co_classes
 *   co:attendance-sync  — Sync attendance records for recent class sessions
 *   co:analysis         — Analyze attendance patterns, generate AI recommendations
 *   co:auto-cancel      — Auto-cancel underperforming upcoming classes
 *
 * Job dispatchers exported:
 *   runClassSync(clientSlug)
 *   runAttendanceSync(clientSlug)
 *   runAnalysis(clientSlug)
 *   runAutoCancellation(clientSlug)
 *   runForAllClients(jobFn)
 *   getQueueStats()
 */

'use strict';

const Bull   = require('bull');
const dayjs  = require('dayjs');
const db     = require('./db');
const mb     = require('./mindbody');
const cal    = require('./calendar');

// ─── Queue Config ─────────────────────────────────────────────────────────────

function buildRedisOpts() {
    const host     = process.env.REDIS_HOST     || '127.0.0.1';
    const port     = parseInt(process.env.REDIS_PORT || '6379', 10);
    const password = process.env.REDIS_PASSWORD || undefined;
    const tls      = process.env.REDIS_TLS === 'true' ? {} : undefined;
    return { host, port, password, tls };
}

const QUEUE_OPTS = {
    redis: buildRedisOpts(),
    defaultJobOptions: {
        attempts:         3,
        backoff:          { type: 'exponential', delay: 5000 },
        removeOnComplete: 50,
        removeOnFail:     100,
    },
};

const classSync       = new Bull('co:class-sync',      QUEUE_OPTS);
const attendanceSync  = new Bull('co:attendance-sync',  QUEUE_OPTS);
const analysis        = new Bull('co:analysis',         QUEUE_OPTS);
const autoCancellation = new Bull('co:auto-cancel',     QUEUE_OPTS);

// ─── Job: Class Sync ──────────────────────────────────────────────────────────
// Fetches the Mindbody class schedule and upserts into co_classes.

classSync.process('sync', 3, async (job) => {
    const { clientSlug } = job.data;
    console.log(`[ClassSync] Starting for ${clientSlug}`);

    const client = await db.getClient(clientSlug);
    if (!client) throw new Error(`No client config found for slug: ${clientSlug}`);

    // Pull recurring class schedules from Mindbody
    const schedules = await mb.getAllClassSchedules(
        client.mindbody_site_id,
        client.mindbody_api_key
    );

    if (!schedules.length) {
        console.log(`[ClassSync] No class schedules returned for ${clientSlug}`);
        return { clientSlug, synced: 0 };
    }

    let synced  = 0;
    let skipped = 0;

    for (const schedule of schedules) {
        try {
            // Each ClassSchedule has one or more associated Classes
            const classDescId = schedule.ClassDescription?.Id;
            const className   = schedule.ClassDescription?.Name || 'Unknown Class';
            const instructor  = schedule.Staff
                ? `${schedule.Staff.FirstName || ''} ${schedule.Staff.LastName || ''}`.trim()
                : null;

            // DaysSunday=true etc. → map to day_of_week 0-6
            const DAYS = ['DaySunday','DayMonday','DayTuesday','DayWednesday','DayThursday','DayFriday','DaySaturday'];
            const activeDays = DAYS
                .map((key, idx) => (schedule[key] ? idx : null))
                .filter(d => d !== null);

            const startTime = schedule.StartTime
                ? schedule.StartTime.slice(0, 5) // "HH:MM"
                : null;

            const durationMs = schedule.Duration || null;
            const durationMin = durationMs ? Math.round(durationMs / 60) : null;
            const maxCapacity = schedule.MaxCapacity || null;

            // Use the ClassSchedule ID as the Mindbody class reference
            const mbClassId = String(schedule.Id || classDescId || `${className}-unknown`);

            // Upsert one record per unique schedule entry
            await db.upsertClass({
                clientId:        client.id,
                mindbodyClassId: mbClassId,
                className,
                instructorName:  instructor,
                dayOfWeek:       activeDays.length === 1 ? activeDays[0] : null,
                startTime,
                durationMinutes: durationMin,
                maxCapacity,
                isActive:        !schedule.IsActive === false,
            });

            synced++;
        } catch (innerErr) {
            console.error(`[ClassSync] Failed to upsert schedule ${schedule.Id}: ${innerErr.message}`);
            skipped++;
        }
    }

    console.log(`[ClassSync] Done for ${clientSlug} — ${synced} synced, ${skipped} skipped`);
    return { clientSlug, synced, skipped };
});

// ─── Job: Attendance Sync ─────────────────────────────────────────────────────
// Syncs attendance records for class sessions in the last N days.

attendanceSync.process('sync', 5, async (job) => {
    const { clientSlug, days = 14 } = job.data;
    console.log(`[AttendanceSync] Starting for ${clientSlug} (last ${days} days)`);

    const client = await db.getClient(clientSlug);
    if (!client) throw new Error(`No client config found for slug: ${clientSlug}`);

    // Pull all class instances in the lookback window
    const startDate = dayjs().subtract(days, 'day').format('YYYY-MM-DDT00:00:00');
    const endDate   = dayjs().format('YYYY-MM-DDT23:59:59');

    let offset      = 0;
    const limit     = 200;
    let totalSynced = 0;

    while (true) {
        const result = await mb.getClasses(
            client.mindbody_site_id,
            client.mindbody_api_key,
            startDate,
            endDate,
            { Offset: offset, Limit: limit }
        );

        if (!result.ok) {
            console.error(`[AttendanceSync] Mindbody fetch failed at offset ${offset}: ${result.error}`);
            break;
        }

        const classes  = result.data.Classes || [];
        const total    = result.data.PaginationResponse?.TotalResults || 0;

        for (const cls of classes) {
            try {
                // Only process classes that have already occurred (StartDateTime in the past)
                const startDt = dayjs(cls.StartDateTime);
                if (startDt.isAfter(dayjs())) continue;

                const mbClassId  = String(cls.ClassScheduleId || cls.Id);
                const classDate  = startDt.format('YYYY-MM-DD');
                const capacity   = cls.MaxCapacity || 0;

                // Fetch attendance roster
                const attResult = await mb.getClassAttendance(
                    client.mindbody_site_id,
                    client.mindbody_api_key,
                    cls.Id
                );

                let enrolledCount = 0;
                let attendedCount = 0;

                if (attResult.ok) {
                    const visits = attResult.data.Clients || attResult.data.ClassAttendances || [];
                    enrolledCount = visits.length;
                    attendedCount = visits.filter(v =>
                        v.SignedIn === true || v.VisitRefNo || v.AttendanceStatus === 'Enrolled'
                    ).length;
                } else {
                    // Fallback: use Mindbody's TotalBooked field if available
                    enrolledCount = cls.TotalBooked || 0;
                    attendedCount = cls.TotalAttendees || cls.TotalBooked || 0;
                }

                // Find matching co_classes row
                // Try by mindbody_class_id matching the schedule ID
                const classRows = await db.getClassesByClient(client.id);
                const matchedClass = classRows.find(r =>
                    r.mindbody_class_id === mbClassId ||
                    r.mindbody_class_id === String(cls.Id)
                );

                if (!matchedClass) {
                    // Class not yet synced — skip
                    continue;
                }

                await db.upsertAttendanceRecord({
                    clientId:      client.id,
                    classId:       matchedClass.id,
                    classDate,
                    enrolledCount,
                    attendedCount,
                    capacity,
                });

                totalSynced++;
            } catch (innerErr) {
                console.error(`[AttendanceSync] Failed for class ${cls.Id}: ${innerErr.message}`);
            }
        }

        offset += limit;
        if (offset >= total || classes.length === 0) break;
    }

    console.log(`[AttendanceSync] Done for ${clientSlug} — ${totalSynced} records synced`);
    return { clientSlug, totalSynced };
});

// ─── Job: Analysis ────────────────────────────────────────────────────────────
// Analyzes attendance patterns and generates recommendations.
// Uses Anthropic if ANTHROPIC_API_KEY is set; falls back to rule-based logic.

analysis.process('analyze', 2, async (job) => {
    const { clientSlug } = job.data;
    console.log(`[Analysis] Starting for ${clientSlug}`);

    const client = await db.getClient(clientSlug);
    if (!client) throw new Error(`No client config found for slug: ${clientSlug}`);

    const threshold = client.min_attendance_threshold || 3;

    // Pull 30-day attendance stats per class
    const stats   = await db.getClassAttendanceStats(client.id, 30);
    const classes = await db.getClassesByClient(client.id, true);

    if (!stats.length) {
        console.log(`[Analysis] No attendance data yet for ${clientSlug}`);
        return { clientSlug, recommendations: 0 };
    }

    // Build a lookup map: classId → class row
    const classMap = {};
    for (const cls of classes) classMap[cls.id] = cls;

    let recommendationsCreated = 0;

    // ── Rule-based analysis ────────────────────────────────────────────────────

    const underperformers = [];
    const highDemand      = [];

    for (const stat of stats) {
        const cls = classMap[stat.classId];
        if (!cls) continue;

        if (stat.avgAttended < threshold && stat.sessionsCount >= 3) {
            underperformers.push({ stat, cls });
        }

        if (cls.max_capacity && stat.avgFillRate >= 85 && stat.sessionsCount >= 3) {
            highDemand.push({ stat, cls });
        }
    }

    // Create cancel recommendations for underperformers
    for (const { stat, cls } of underperformers) {
        const reason = `${cls.class_name} averaged only ${stat.avgAttended} attendees `
            + `over ${stat.sessionsCount} sessions (threshold: ${threshold}). `
            + `Avg fill rate: ${stat.avgFillRate}%.`;

        await db.insertRecommendation({
            clientId:            client.id,
            classId:             cls.id,
            recommendationType:  'cancel_class',
            reason,
            data: {
                avgAttended:    stat.avgAttended,
                avgFillRate:    stat.avgFillRate,
                sessionsCount:  stat.sessionsCount,
                threshold,
            },
        });

        recommendationsCreated++;
        console.log(`[Analysis] Created cancel_class recommendation for "${cls.class_name}"`);
    }

    // Create add_capacity recommendations for high-demand classes
    for (const { stat, cls } of highDemand) {
        const reason = `${cls.class_name} has been running at ${stat.avgFillRate}% capacity `
            + `over ${stat.sessionsCount} sessions. Consider increasing class size.`;

        await db.insertRecommendation({
            clientId:            client.id,
            classId:             cls.id,
            recommendationType:  'add_capacity',
            reason,
            data: {
                avgFillRate:   stat.avgFillRate,
                sessionsCount: stat.sessionsCount,
                currentMax:    cls.max_capacity,
            },
        });

        recommendationsCreated++;
    }

    // ── AI-enhanced analysis (if Anthropic SDK available) ─────────────────────

    if (process.env.ANTHROPIC_API_KEY && (underperformers.length > 0 || highDemand.length > 0)) {
        try {
            const Anthropic = require('@anthropic-ai/sdk');
            const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

            const statsContext = stats.slice(0, 20).map(s => {
                const cls = classMap[s.classId];
                return cls
                    ? `${cls.class_name} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][cls.day_of_week] || '?'} ${cls.start_time || ''}): avg ${s.avgAttended} attended, ${s.avgFillRate}% fill over ${s.sessionsCount} sessions`
                    : null;
            }).filter(Boolean).join('\n');

            const prompt = [
                `You are a fitness studio optimization expert. Analyze this attendance data for ${client.business_name}:`,
                '',
                statsContext,
                '',
                `Minimum attendance threshold: ${threshold} per class.`,
                `Underperforming classes: ${underperformers.map(u => u.cls.class_name).join(', ') || 'none'}.`,
                `High-demand classes: ${highDemand.map(h => h.cls.class_name).join(', ') || 'none'}.`,
                '',
                'Provide 1-3 additional strategic recommendations not already identified. For each, specify: recommendation_type (cancel_class/reschedule/add_capacity/reduce_capacity/add_class), reason (1-2 sentences), and any relevant data points. Format as JSON array.',
            ].join('\n');

            const message = await anthropic.messages.create({
                model:      'claude-opus-4-5',
                max_tokens: 1024,
                messages: [{ role: 'user', content: prompt }],
            });

            const text = message.content[0]?.text || '';

            // Extract JSON from the response
            const jsonMatch = text.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                const aiRecs = JSON.parse(jsonMatch[0]);

                for (const rec of aiRecs) {
                    if (!rec.recommendation_type || !rec.reason) continue;

                    // Find matching class by name if mentioned
                    let matchedClassId = null;
                    if (rec.class_name) {
                        const found = classes.find(c =>
                            c.class_name.toLowerCase().includes(rec.class_name.toLowerCase())
                        );
                        if (found) matchedClassId = found.id;
                    }

                    await db.insertRecommendation({
                        clientId:           client.id,
                        classId:            matchedClassId,
                        recommendationType: rec.recommendation_type,
                        reason:             `[AI] ${rec.reason}`,
                        data:               rec.data || {},
                    });

                    recommendationsCreated++;
                }
            }
        } catch (aiErr) {
            // AI failure is non-fatal — rule-based recs are already saved
            console.warn(`[Analysis] AI enhancement skipped: ${aiErr.message}`);
        }
    }

    console.log(`[Analysis] Done for ${clientSlug} — ${recommendationsCreated} recommendations created`);
    return { clientSlug, recommendationsCreated, underperformers: underperformers.length, highDemand: highDemand.length };
});

// ─── Job: Auto Cancellation ───────────────────────────────────────────────────
// Finds classes starting within X hours with enrollment below threshold,
// cancels them in Mindbody, deletes the Google Calendar event, and logs it.

autoCancellation.process('cancel', 3, async (job) => {
    const { clientSlug } = job.data;
    console.log(`[AutoCancel] Starting for ${clientSlug}`);

    const client = await db.getClient(clientSlug);
    if (!client) throw new Error(`No client config found for slug: ${clientSlug}`);

    const noticeHours = client.cancellation_notice_hours || 2;
    const threshold   = client.min_attendance_threshold  || 3;

    // Fetch upcoming classes within the cancellation notice window
    const windowEnd   = dayjs().add(noticeHours, 'hour');
    const startDate   = dayjs().format('YYYY-MM-DDT00:00:00');
    const endDate     = windowEnd.format('YYYY-MM-DDTHH:mm:ss');

    const upcomingResult = await mb.getClasses(
        client.mindbody_site_id,
        client.mindbody_api_key,
        startDate,
        endDate,
        { Limit: 50 }
    );

    if (!upcomingResult.ok) {
        throw new Error(`Mindbody class fetch failed: ${upcomingResult.error}`);
    }

    const upcoming = (upcomingResult.data.Classes || []).filter(cls => {
        const start = dayjs(cls.StartDateTime);
        return start.isAfter(dayjs()) && start.isBefore(windowEnd);
    });

    let cancelled = 0;

    for (const cls of upcoming) {
        const enrolled = cls.TotalBooked || 0;

        if (enrolled >= threshold) {
            continue; // Enrollment is sufficient — skip
        }

        const classDate = dayjs(cls.StartDateTime).format('YYYY-MM-DD');

        try {
            // 1. Cancel in Mindbody
            const cancelResult = await mb.cancelClass(
                client.mindbody_site_id,
                client.mindbody_api_key,
                cls.Id
            );

            if (!cancelResult.ok) {
                console.error(`[AutoCancel] Mindbody cancel failed for class ${cls.Id}: ${cancelResult.error}`);
                continue;
            }

            // 2. Delete from Google Calendar if configured
            let googleEventDeleted = false;
            const mbClassId = String(cls.ClassScheduleId || cls.Id);

            if (client.google_calendar_id && client.google_service_account_json) {
                const classRows = await db.getClassesByClient(client.id);
                const matchedClass = classRows.find(r =>
                    r.mindbody_class_id === mbClassId ||
                    r.mindbody_class_id === String(cls.Id)
                );

                if (matchedClass?.google_event_id) {
                    const deleteResult = await cal.deleteEvent(
                        client.google_calendar_id,
                        client.google_service_account_json,
                        matchedClass.google_event_id
                    );
                    googleEventDeleted = deleteResult.ok;
                }
            }

            // 3. Log the cancellation
            const reason = `Auto-cancelled: only ${enrolled} enrolled (threshold: ${threshold}, notice: ${noticeHours}h)`;

            const classRows = await db.getClassesByClient(client.id);
            const matchedClass = classRows.find(r =>
                r.mindbody_class_id === mbClassId ||
                r.mindbody_class_id === String(cls.Id)
            );

            await db.logCancellation({
                clientId:           client.id,
                classId:            matchedClass?.id || null,
                classDate,
                cancellationReason: reason,
                notifiedCount:      enrolled,
                googleEventDeleted,
            });

            cancelled++;
            console.log(`[AutoCancel] Cancelled "${cls.ClassDescription?.Name || cls.Id}" on ${classDate} for ${clientSlug} (enrolled: ${enrolled})`);

        } catch (innerErr) {
            console.error(`[AutoCancel] Error cancelling class ${cls.Id}: ${innerErr.message}`);
        }
    }

    console.log(`[AutoCancel] Done for ${clientSlug} — ${cancelled} classes cancelled out of ${upcoming.length} checked`);
    return { clientSlug, cancelled, checked: upcoming.length };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['class-sync',      classSync],
    ['attendance-sync', attendanceSync],
    ['analysis',        analysis],
    ['auto-cancel',     autoCancellation],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} job failed (id=${job.id}, slug=${job.data?.clientSlug}): ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} job completed (id=${job.id}, slug=${job.data?.clientSlug})`);
    });
    queue.on('error', (err) => {
        console.error(`[Jobs] Queue ${name} error: ${err.message}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runClassSync(clientSlug) {
    return classSync.add('sync', { clientSlug });
}

async function runAttendanceSync(clientSlug, days = 14) {
    return attendanceSync.add('sync', { clientSlug, days });
}

async function runAnalysis(clientSlug) {
    return analysis.add('analyze', { clientSlug });
}

async function runAutoCancellation(clientSlug) {
    return autoCancellation.add('cancel', { clientSlug });
}

/**
 * Run a job function for every client in co_clients.
 * jobFn must accept (clientSlug) and return a Bull Job promise.
 */
async function runForAllClients(jobFn) {
    const clients = await db.getAllClients();
    const results = [];

    for (const client of clients) {
        try {
            const job = await jobFn(client.client_slug);
            results.push({ clientSlug: client.client_slug, jobId: job.id });
        } catch (err) {
            console.error(`[Jobs] Failed to queue job for ${client.client_slug}: ${err.message}`);
            results.push({ clientSlug: client.client_slug, error: err.message });
        }
    }

    return results;
}

// ─── Queue Stats Helper ───────────────────────────────────────────────────────

async function getQueueStats() {
    const [syncCounts, attCounts, analysisCounts, cancelCounts] = await Promise.all([
        classSync.getJobCounts(),
        attendanceSync.getJobCounts(),
        analysis.getJobCounts(),
        autoCancellation.getJobCounts(),
    ]);

    return {
        classSync:       syncCounts,
        attendanceSync:  attCounts,
        analysis:        analysisCounts,
        autoCancellation: cancelCounts,
    };
}

module.exports = {
    classSync,
    attendanceSync,
    analysis,
    autoCancellation,
    runClassSync,
    runAttendanceSync,
    runAnalysis,
    runAutoCancellation,
    runForAllClients,
    getQueueStats,
};
