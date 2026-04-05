/**
 * GRIDHAND Route Optimizer — Bull Queue Job Definitions
 *
 * Jobs:
 *  - optimize-routes    → 6am Mon-Sat: pull Jobber jobs, call Google Maps, build optimal routes, save to DB
 *  - morning-briefing   → 6:30am Mon-Sat: fetch saved routes, SMS each crew lead their stop list
 *
 * All jobs are registered here. index.js schedules them via node-cron.
 */

'use strict';

const Bull   = require('bull');
const dayjs  = require('dayjs');
const jobber = require('./jobber');
const maps   = require('./maps');
const db     = require('./db');
const sms    = require('./sms');

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const optimizeRoutesQueue  = new Bull('route-optimizer:optimize-routes',  REDIS_URL);
const morningBriefingQueue = new Bull('route-optimizer:morning-briefing', REDIS_URL);

// ─── Job: Optimize Routes ─────────────────────────────────────────────────────

optimizeRoutesQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[OptimizeRoutes] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No Jobber connection for ${clientSlug}`);

    // Refresh tokens if needed, then pull today's scheduled jobs from Jobber
    await jobber.refreshTokenIfNeeded(conn);
    const scheduledJobs = await jobber.getScheduledJobs(clientSlug, conn);

    if (!scheduledJobs.length) {
        console.log(`[OptimizeRoutes] No jobs scheduled today for ${clientSlug}`);
        return { clientSlug, crewCount: 0, totalJobs: 0, estimatedDriveSaved: 0 };
    }

    // Group jobs by crew
    const crewMap = {};
    for (const j of scheduledJobs) {
        const key = j.crewId || 'unassigned';
        if (!crewMap[key]) {
            crewMap[key] = {
                crewId:        j.crewId || 'unassigned',
                crewName:      j.crewName || 'Unassigned Crew',
                crewLeadPhone: j.crewLeadPhone || null,
                jobs:          [],
            };
        }
        crewMap[key].jobs.push(j);
    }

    const today     = dayjs().format('YYYY-MM-DD');
    let   savedRoutes = 0;

    // Optimize route for each crew via Google Maps Waypoint Optimization
    for (const [crewId, crew] of Object.entries(crewMap)) {
        try {
            const googleApiKey = conn.google_maps_api_key || process.env.GOOGLE_MAPS_API_KEY;
            const optimized    = await maps.optimizeRoute(crew.jobs, conn.depot_address, googleApiKey);

            await db.saveRoute(clientSlug, {
                routeDate:             today,
                crewId,
                crewName:              crew.crewName,
                crewLeadPhone:         crew.crewLeadPhone,
                stops:                 optimized.orderedStops,
                totalDistanceKm:       optimized.totalDistanceKm,
                estimatedDriveMinutes: optimized.estimatedDriveMinutes,
            });

            savedRoutes++;
            console.log(`[OptimizeRoutes] Crew ${crew.crewName}: ${crew.jobs.length} stops, ${optimized.estimatedDriveMinutes} min drive`);
        } catch (err) {
            console.error(`[OptimizeRoutes] Failed to optimize route for crew ${crewId}: ${err.message}`);
        }
    }

    const crewCount   = Object.keys(crewMap).length;
    const totalJobs   = scheduledJobs.length;

    // Rough estimate: unoptimized drive is ~20% longer on average
    const totalSavedMinutes = savedRoutes * 12;

    console.log(`[OptimizeRoutes] Done for ${clientSlug} — ${crewCount} crews, ${totalJobs} jobs`);
    return { clientSlug, crewCount, totalJobs, estimatedDriveSaved: totalSavedMinutes };
});

// ─── Job: Morning Briefing ────────────────────────────────────────────────────

morningBriefingQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[MorningBriefing] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No Jobber connection for ${clientSlug}`);

    const today  = dayjs().format('YYYY-MM-DD');
    const routes = await db.getRoutesForDate(clientSlug, today);

    if (!routes.length) {
        console.log(`[MorningBriefing] No routes found for ${clientSlug} on ${today}`);
        return { clientSlug, briefingsSent: 0 };
    }

    let briefingsSent = 0;

    for (const route of routes) {
        if (!route.crew_lead_phone) {
            console.log(`[MorningBriefing] No crew lead phone for crew ${route.crew_name} — skipping`);
            continue;
        }

        const stops = route.stops || [];
        const lines = stops.map((stop, i) => {
            const duration = stop.estimatedDurationMinutes
                ? ` (~${stop.estimatedDurationMinutes} min)`
                : '';
            return `${i + 1}. ${stop.clientName} — ${stop.address}${duration}`;
        });

        const driveNote = route.estimated_drive_minutes
            ? `\nTotal drive: ~${route.estimated_drive_minutes} min (${(route.total_distance_km || 0).toFixed(1)} km)`
            : '';

        const message = [
            `GRIDHAND — Good morning, ${route.crew_name}! Here's today's route (${today}):`,
            '',
            lines.join('\n'),
            driveNote,
            '',
            'Routes are optimized to save drive time. Have a great day!',
        ].join('\n').trim();

        await sms.send(conn, route.crew_lead_phone, message, 'morning_briefing');
        briefingsSent++;

        console.log(`[MorningBriefing] Sent briefing to ${route.crew_name} (${route.crew_lead_phone}) — ${stops.length} stops`);
    }

    console.log(`[MorningBriefing] Done for ${clientSlug} — ${briefingsSent} briefings sent`);
    return { clientSlug, briefingsSent, routeCount: routes.length };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['optimize-routes',  optimizeRoutesQueue],
    ['morning-briefing', morningBriefingQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} job failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} job completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────
// These are called by index.js cron or by manual /trigger endpoints.

async function runOptimizeRoutes(clientSlug) {
    return optimizeRoutesQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runMorningBriefing(clientSlug) {
    return morningBriefingQueue.add({ clientSlug }, { attempts: 2, backoff: 30000 });
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
    runOptimizeRoutes,
    runMorningBriefing,
    runForAllClients,
    optimizeRoutesQueue,
    morningBriefingQueue,
};
