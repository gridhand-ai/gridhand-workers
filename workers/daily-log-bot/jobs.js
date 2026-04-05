/**
 * GRIDHAND Daily Log Bot — Bull Queue Job Definitions
 *
 * Jobs:
 *  - generate-daily-log  → 5pm daily: pull photos + weather + crew, generate report
 *  - morning-weather     → 6am daily: send weather advisory to owner
 */

'use strict';

const Bull       = require('bull');
const dayjs      = require('dayjs');
const procore    = require('./procore');
const companycam = require('./companycam');
const weather    = require('./weather');
const db         = require('./db');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const dailyLogQueue   = new Bull('daily-log-bot:generate-daily-log', REDIS_URL);
const morningWxQueue  = new Bull('daily-log-bot:morning-weather',    REDIS_URL);

// ─── Job: Generate Daily Log ──────────────────────────────────────────────────

dailyLogQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[DailyLog] Generating reports for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const today = dayjs().format('YYYY-MM-DD');

    // Get weather
    let wx = null;
    try {
        wx = await weather.getCurrentWeather(conn.openweather_city || 'Chicago,US');
    } catch (err) {
        console.warn(`[DailyLog] Weather fetch failed: ${err.message}`);
    }

    // Get all active Procore projects
    const projects = await procore.getActiveProjects(clientSlug, conn.procore_company_id);
    let reportsGenerated = 0;

    for (const project of projects) {
        try {
            // Crew check-ins from Procore Manpower Logs
            const crewLogs = await procore.getManpowerLogs(
                clientSlug, conn.procore_company_id, project.id, today
            );

            // Photos from CompanyCam
            let photos = [];
            if (conn.companycam_api_key) {
                // Try to match CompanyCam project by name
                const ccProjects = await companycam.getProjects(conn.companycam_api_key);
                const ccProject  = ccProjects.find(p =>
                    p.name.toLowerCase().includes(project.name.toLowerCase().slice(0, 10))
                );
                if (ccProject) {
                    photos = await companycam.getProjectPhotos(conn.companycam_api_key, ccProject.id, today);
                }
            }

            const photoSummary = companycam.buildPhotoSummary(photos);
            const wxText       = wx ? weather.buildWeatherText(wx) : 'Weather data unavailable';

            // Compose daily log narrative
            const crewNames  = crewLogs.map(c => c.name);
            const totalHours = crewLogs.reduce((sum, c) => sum + (c.hours || 0), 0);

            const reportText = buildDailyLogText({
                projectName:  project.name,
                date:         today,
                weatherText:  wxText,
                crewCount:    crewLogs.length,
                crewNames,
                totalHours,
                photoCount:   photos.length,
                photoSummary,
                businessName: conn.business_name || clientSlug,
            });

            // Post back to Procore daily log
            const procoreLogId = await procore.postDailyLog(
                clientSlug, conn.procore_company_id, project.id,
                { date: today, notes: reportText }
            );

            // Save to DB
            await db.upsertDailyReport(clientSlug, {
                projectId:    project.id,
                projectName:  project.name,
                reportDate:   today,
                weatherTempF: wx?.tempF || null,
                weatherDesc:  wx?.description || null,
                weatherWindMph: wx?.windMph || null,
                weatherPrecipIn: wx?.precipIn || null,
                weatherSuitable: wx?.suitable ?? true,
                crewCount:    crewLogs.length,
                crewNames,
                photoCount:   photos.length,
                photoUrls:    photos.map(p => p.url).filter(Boolean),
                photoSummary,
                reportText,
                procoreLogId,
                status:       procoreLogId ? 'posted' : 'generated',
            });

            reportsGenerated++;
            console.log(`[DailyLog] Report generated for project ${project.name}`);

            // Alert if no crew or no photos
            if (crewLogs.length === 0) {
                await db.logAlert(clientSlug, {
                    alertType:   'no_checkins',
                    recipient:   conn.owner_phone,
                    messageBody: `⚠️ No crew check-ins recorded today for "${project.name}". Verify site activity.`,
                    projectId:   project.id,
                });
            }
            if (photos.length === 0 && crewLogs.length > 0) {
                await db.logAlert(clientSlug, {
                    alertType:   'no_photos',
                    recipient:   conn.owner_phone,
                    messageBody: `📷 Reminder: No photos uploaded today for "${project.name}". Ask crew to capture progress.`,
                    projectId:   project.id,
                });
            }
        } catch (err) {
            console.error(`[DailyLog] Failed for project ${project.id}: ${err.message}`);
        }
    }

    console.log(`[DailyLog] Done for ${clientSlug} — ${reportsGenerated} reports generated`);
    return { clientSlug, reportsGenerated, date: today };
});

// ─── Job: Morning Weather Advisory ───────────────────────────────────────────

morningWxQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[MorningWeather] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const wx = await weather.getCurrentWeather(conn.openweather_city || 'Chicago,US');

    if (!wx.suitable) {
        const msg = `🌩️ Weather Advisory for ${conn.business_name || clientSlug}: ${weather.buildWeatherText(wx)}. Consider adjusting site schedules.`;
        await db.logAlert(clientSlug, {
            alertType:   'weather_warning',
            recipient:   conn.owner_phone,
            messageBody: msg,
        });
        console.log(`[MorningWeather] Weather warning sent for ${clientSlug}`);
    } else {
        console.log(`[MorningWeather] Clear conditions for ${clientSlug}: ${wx.tempF}°F`);
    }

    return { clientSlug, tempF: wx.tempF, suitable: wx.suitable };
});

// ─── Report Composer ──────────────────────────────────────────────────────────

function buildDailyLogText({ projectName, date, weatherText, crewCount, crewNames, totalHours, photoCount, photoSummary, businessName }) {
    const crewList = crewNames.length > 0 ? crewNames.join(', ') : 'None recorded';
    return [
        `DAILY LOG — ${projectName}`,
        `Date: ${date} | Generated by GRIDHAND for ${businessName}`,
        ``,
        `WEATHER: ${weatherText}`,
        ``,
        `CREW (${crewCount} personnel, ${totalHours.toFixed(1)} hrs total):`,
        crewList,
        ``,
        `SITE PHOTOS: ${photoSummary}`,
        `Total captured: ${photoCount} photos`,
    ].join('\n');
}

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['generate-daily-log', dailyLogQueue],
    ['morning-weather',    morningWxQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runDailyLog(clientSlug) {
    return dailyLogQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runMorningWeather(clientSlug) {
    return morningWxQueue.add({ clientSlug }, { attempts: 3, backoff: 30000 });
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
    runDailyLog,
    runMorningWeather,
    runForAllClients,
    dailyLogQueue,
    morningWxQueue,
};
