/**
 * GRIDHAND Route Optimizer — Google Maps Directions API Integration
 *
 * Uses the Google Maps Directions API with waypoint optimization
 * to find the most efficient ordering of stops for a crew.
 *
 * Docs: https://developers.google.com/maps/documentation/directions/get-directions
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');

const MAPS_API_BASE = 'https://maps.googleapis.com/maps/api/directions/json';

// ─── Route Optimizer ──────────────────────────────────────────────────────────

/**
 * Build the optimal route for a crew given a list of jobs.
 *
 * @param {Array}  jobs          - Array of job objects (each has address, clientName, etc.)
 * @param {string} depotAddress  - Starting and ending address (the shop / yard)
 * @param {string} apiKey        - Google Maps API key
 * @returns {{ orderedStops, totalDistanceKm, estimatedDriveMinutes, polyline }}
 */
async function optimizeRoute(jobs, depotAddress, apiKey) {
    if (!apiKey) throw new Error('Google Maps API key is required');
    if (!jobs || jobs.length === 0) {
        return { orderedStops: [], totalDistanceKm: 0, estimatedDriveMinutes: 0, polyline: null };
    }

    const origin      = encodeURIComponent(depotAddress || jobs[0].address);
    const destination = encodeURIComponent(depotAddress || jobs[jobs.length - 1].address);

    // Build waypoints string — pipe-separated, with optimize:true prefix
    const waypointAddresses = jobs.map(j => encodeURIComponent(j.address));
    const waypoints = `optimize:true|${waypointAddresses.join('|')}`;

    // Depart at 6:30am local time today (approximate to seconds since epoch)
    const departureTime = getDepartureTimestamp();

    const response = await axios.get(MAPS_API_BASE, {
        params: {
            origin,
            destination,
            waypoints,
            departure_time: departureTime,
            traffic_model:  'best_guess',
            key:            apiKey,
        },
    });

    const result = response.data;

    if (result.status !== 'OK') {
        throw new Error(`Google Maps API error: ${result.status} — ${result.error_message || 'no details'}`);
    }

    const route = result.routes[0];
    if (!route) throw new Error('No route returned from Google Maps');

    // Google returns optimized waypoint order as array of indices
    const waypointOrder = route.waypoint_order || jobs.map((_, i) => i);

    // Compute cumulative arrival times and map back to original job objects
    let elapsedSeconds  = 0;
    const orderedStops  = waypointOrder.map((originalIndex, seq) => {
        const job      = jobs[originalIndex];
        const leg      = route.legs[seq];            // legs[0] = depot → first stop, etc.
        const driveSec = leg?.duration?.value || 0;
        elapsedSeconds += driveSec;

        const estimatedArrival = dayjs()
            .hour(6).minute(30).second(0)
            .add(elapsedSeconds, 'second')
            .format('HH:mm');

        // Add job duration to elapsed for the next stop
        elapsedSeconds += (job.estimatedDurationMinutes || 60) * 60;

        return {
            sequence:                 seq + 1,
            jobId:                    job.id,
            jobNumber:                job.jobNumber,
            clientName:               job.clientName,
            address:                  job.address,
            estimatedArrival,
            estimatedDurationMinutes: job.estimatedDurationMinutes || 60,
            driveFromPrevMinutes:     Math.round(driveSec / 60),
        };
    });

    // Sum total drive time from all legs (excluding job durations)
    const totalDriveSec = route.legs.reduce((sum, leg) => sum + (leg.duration?.value || 0), 0);
    const totalDistanceM = route.legs.reduce((sum, leg) => sum + (leg.distance?.value || 0), 0);

    return {
        orderedStops,
        totalDistanceKm:       Math.round((totalDistanceM / 1000) * 10) / 10,
        estimatedDriveMinutes: Math.round(totalDriveSec / 60),
        polyline:              route.overview_polyline?.points || null,
    };
}

/**
 * Get a departure timestamp of 6:30am today (for traffic modeling).
 * Returns seconds since epoch.
 */
function getDepartureTimestamp() {
    const d = new Date();
    d.setHours(6, 30, 0, 0);
    // If it's past 6:30am, use now so Google doesn't reject the timestamp
    if (d.getTime() < Date.now()) return 'now';
    return Math.floor(d.getTime() / 1000);
}

module.exports = {
    optimizeRoute,
};
