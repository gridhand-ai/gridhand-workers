/**
 * GRIDHAND Weather Watcher — Bull Queue Job Definitions
 *
 * Jobs:
 *  - weather-check         → 6pm + 8am daily: get tomorrow's Jobber jobs, check forecast,
 *                            postpone affected jobs, SMS clients + owner summary
 *  - reschedule-postponed  → 8am daily: find good-weather windows, reschedule in Jobber, SMS clients
 *
 * All jobs are registered here. index.js schedules them via node-cron.
 */

'use strict';

const Bull    = require('bull');
const dayjs   = require('dayjs');
const jobber  = require('./jobber');
const weather = require('./weather');
const db      = require('./db');
const sms     = require('./sms');

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const weatherCheckQueue        = new Bull('weather-watcher:weather-check',        REDIS_URL);
const reschedulePostponedQueue = new Bull('weather-watcher:reschedule-postponed', REDIS_URL);

// ─── Job: Weather Check ───────────────────────────────────────────────────────

weatherCheckQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[WeatherCheck] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No Jobber connection for ${clientSlug}`);

    await jobber.refreshTokenIfNeeded(conn);

    // Get tomorrow's scheduled jobs
    const tomorrowsJobs = await jobber.getTomorrowsJobs(clientSlug, conn);

    if (!tomorrowsJobs.length) {
        console.log(`[WeatherCheck] No jobs scheduled tomorrow for ${clientSlug}`);
        return { clientSlug, postponed: 0, checked: 0 };
    }

    const owApiKey = conn.openweather_api_key || process.env.OPENWEATHERMAP_API_KEY;

    // Collect unique service area coordinates to avoid redundant API calls
    const locationCache = {};
    let   postponedCount = 0;
    const postponedSummary = [];

    for (const j of tomorrowsJobs) {
        // Check if already postponed too many times (max 2 postponements per job)
        const existing = await db.getPostponedJob(clientSlug, j.id);
        if (existing && existing.postpone_count >= 2) {
            console.log(`[WeatherCheck] Job ${j.id} (${j.clientName}) already postponed ${existing.postpone_count}x — skipping`);
            continue;
        }

        const lat = j.lat || conn.service_area_lat;
        const lon = j.lon || conn.service_area_lon;

        if (!lat || !lon) {
            console.log(`[WeatherCheck] No coordinates for job ${j.id} — skipping weather check`);
            continue;
        }

        // Use cached forecast for same coordinates
        const cacheKey = `${lat},${lon}`;
        if (!locationCache[cacheKey]) {
            locationCache[cacheKey] = await weather.getForecast(lat, lon, owApiKey);
        }

        const forecast    = locationCache[cacheKey];
        const tomorrow    = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const evaluation  = await weather.evaluateWeather(forecast, tomorrow);

        if (!evaluation.isPoor) continue;

        // Bad weather found — postpone this job
        const postponeCount = (existing?.postpone_count || 0) + 1;
        const clientPhone   = j.clientPhone || await jobber.getJobClientPhone(conn, j.clientId);

        // Save to DB
        await db.upsertPostponedJob(clientSlug, {
            jobberJobId:    j.id,
            clientName:     j.clientName,
            clientPhone:    clientPhone || null,
            originalDate:   j.scheduledDate,
            postponeReason: evaluation.reasons.join(', '),
            postponeCount,
            status:         'postponed',
        });

        // SMS client if we have their phone
        if (clientPhone) {
            const businessName = conn.business_name || clientSlug;
            const reasonText   = evaluation.reasons.join(' and ');
            const message = `Hi ${j.clientName.split(' ')[0]}, this is ${businessName}. Due to ${reasonText} in the forecast for tomorrow (${tomorrow}), we need to postpone your scheduled service. We'll contact you shortly with a new date. Sorry for the inconvenience!`;

            await sms.send(conn, clientPhone, message, 'postponement_notice');
        }

        postponedCount++;
        postponedSummary.push(`${j.clientName} (${j.scheduledDate}) — ${evaluation.reasons.join(', ')}`);
        console.log(`[WeatherCheck] Postponed job for ${j.clientName} on ${j.scheduledDate}: ${evaluation.reasons.join(', ')}`);
    }

    // SMS owner summary of all postponements
    if (postponedCount > 0) {
        const summaryMsg = [
            `GRIDHAND Weather Alert — ${dayjs().format('MMM D')}:`,
            `${postponedCount} job(s) postponed for tomorrow due to weather:`,
            '',
            postponedSummary.map((s, i) => `${i + 1}. ${s}`).join('\n'),
            '',
            'Clients have been notified. Rescheduling will run at 8am.',
        ].join('\n');

        await sms.sendToOwner(conn, summaryMsg, 'postponement_summary');
    }

    console.log(`[WeatherCheck] Done for ${clientSlug} — ${postponedCount} jobs postponed out of ${tomorrowsJobs.length} checked`);
    return { clientSlug, postponed: postponedCount, checked: tomorrowsJobs.length };
});

// ─── Job: Reschedule Postponed ────────────────────────────────────────────────

reschedulePostponedQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[ReschedulePostponed] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No Jobber connection for ${clientSlug}`);

    await jobber.refreshTokenIfNeeded(conn);

    const postponedJobs = await db.getPostponedJobs(clientSlug, ['postponed']);

    if (!postponedJobs.length) {
        console.log(`[ReschedulePostponed] No postponed jobs for ${clientSlug}`);
        return { clientSlug, rescheduled: 0 };
    }

    const owApiKey = conn.openweather_api_key || process.env.OPENWEATHERMAP_API_KEY;
    const lat      = conn.service_area_lat;
    const lon      = conn.service_area_lon;

    // Fetch the 5-day forecast once for all jobs
    let forecast;
    try {
        forecast = await weather.getForecast(lat, lon, owApiKey);
    } catch (err) {
        console.error(`[ReschedulePostponed] Could not fetch forecast: ${err.message}`);
        return { clientSlug, rescheduled: 0, error: err.message };
    }

    let rescheduledCount = 0;

    for (const postponed of postponedJobs) {
        // Find the first good-weather day in the next 5 days
        const goodDay = findFirstGoodWeatherDay(forecast, postponed.original_date);

        if (!goodDay) {
            console.log(`[ReschedulePostponed] No good weather window found for job ${postponed.jobber_job_id} — will retry next run`);
            continue;
        }

        try {
            // Reschedule in Jobber
            await jobber.rescheduleJob(conn, postponed.jobber_job_id, goodDay);

            // Update DB status
            await db.updatePostponedJob(clientSlug, postponed.jobber_job_id, {
                status:          'rescheduled',
                rescheduledDate: goodDay,
            });

            // SMS client with new date
            if (postponed.client_phone) {
                const businessName = conn.business_name || clientSlug;
                const formattedDate = dayjs(goodDay).format('dddd, MMMM D');
                const message = `Hi ${postponed.client_name.split(' ')[0]}, great news from ${businessName}! Your service has been rescheduled to ${formattedDate}. We look forward to seeing you then. Reply STOP to opt out of SMS.`;

                await sms.send(conn, postponed.client_phone, message, 'reschedule_confirmation');
            }

            rescheduledCount++;
            console.log(`[ReschedulePostponed] Rescheduled job ${postponed.jobber_job_id} for ${postponed.client_name} to ${goodDay}`);
        } catch (err) {
            console.error(`[ReschedulePostponed] Failed to reschedule job ${postponed.jobber_job_id}: ${err.message}`);
        }
    }

    console.log(`[ReschedulePostponed] Done for ${clientSlug} — ${rescheduledCount} jobs rescheduled`);
    return { clientSlug, rescheduled: rescheduledCount, reviewed: postponedJobs.length };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find the first good-weather day in the forecast, skipping the original bad date.
 * Returns a 'YYYY-MM-DD' string or null if no good day found in the window.
 */
function findFirstGoodWeatherDay(forecast, originalDate) {
    const skip = dayjs(originalDate).format('YYYY-MM-DD');

    // forecast.daily is keyed by 'YYYY-MM-DD'
    const days = Object.entries(forecast.daily || {})
        .sort(([a], [b]) => a.localeCompare(b));

    for (const [date, dayData] of days) {
        if (date <= skip) continue; // Must be after the original postponed date
        if (!dayData.isPoor) return date;
    }

    return null;
}

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['weather-check',        weatherCheckQueue],
    ['reschedule-postponed', reschedulePostponedQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} job failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} job completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runWeatherCheck(clientSlug) {
    return weatherCheckQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runReschedulePostponed(clientSlug) {
    return reschedulePostponedQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
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
    runWeatherCheck,
    runReschedulePostponed,
    runForAllClients,
    weatherCheckQueue,
    reschedulePostponedQueue,
};
