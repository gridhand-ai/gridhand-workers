/**
 * GRIDHAND Weather Watcher — OpenWeatherMap API Integration
 *
 * Uses the OpenWeatherMap 5-day / 3-hour forecast API.
 * Docs: https://openweathermap.org/forecast5
 *
 * Evaluates whether conditions warrant postponing outdoor landscaping work:
 *  - Rain probability > 40%
 *  - Wind speed > 25 mph (11.2 m/s)
 *  - Temperature < 32°F (0°C)
 *  - Snowfall > 0 mm
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');

const OWM_BASE = 'https://api.openweathermap.org/data/2.5/forecast';

// Thresholds for postponement decision
const THRESHOLDS = {
    precipProbability: 0.40,  // 40% chance of rain is enough to postpone
    windSpeedMph:      25,    // mph — converts from m/s in API response
    tempFreezing:      32,    // °F — converts from Kelvin in API response
};

// ─── Forecast Fetcher ─────────────────────────────────────────────────────────

/**
 * Fetch 5-day / 3-hour forecast from OpenWeatherMap for a given location.
 *
 * @param {number} lat     - Latitude
 * @param {number} lon     - Longitude
 * @param {string} apiKey  - OpenWeatherMap API key
 * @returns {Object} Parsed forecast object with daily summaries keyed by 'YYYY-MM-DD'
 */
async function getForecast(lat, lon, apiKey) {
    if (!apiKey) throw new Error('OPENWEATHERMAP_API_KEY is required');
    if (!lat || !lon) throw new Error('Latitude and longitude are required for weather forecast');

    const response = await axios.get(OWM_BASE, {
        params: {
            lat,
            lon,
            appid:  apiKey,
            units:  'imperial',   // Use imperial so wind is mph and temp is °F
            cnt:    40,           // 40 x 3-hour slots = 5 days
        },
    });

    if (response.data.cod !== '200' && response.data.cod !== 200) {
        throw new Error(`OpenWeatherMap API error: ${response.data.message || response.data.cod}`);
    }

    return parseForecast(response.data);
}

/**
 * Parse raw OWM API response into a per-day summary object.
 * Returns { daily: { 'YYYY-MM-DD': { isPoor, reasons, maxRain, maxWind, minTemp } } }
 */
function parseForecast(rawData) {
    const slots = rawData.list || [];
    const daily = {};

    for (const slot of slots) {
        const date = dayjs.unix(slot.dt).format('YYYY-MM-DD');

        if (!daily[date]) {
            daily[date] = {
                isPoor:   false,
                reasons:  [],
                maxRain:  0,          // mm precipitation
                maxWind:  0,          // mph
                minTemp:  Infinity,   // °F
                hasSnow:  false,
                slots:    [],
            };
        }

        const d = daily[date];

        // Precipitation probability (0–1)
        const pop = slot.pop || 0;

        // Wind speed (already in mph due to imperial units)
        const windMph = slot.wind?.speed || 0;

        // Temperature in °F (imperial)
        const tempF = slot.main?.temp || 999;

        // Rain / snow amounts in mm
        const rainMm = slot.rain?.['3h'] || 0;
        const snowMm = slot.snow?.['3h'] || 0;

        d.maxRain  = Math.max(d.maxRain, pop);
        d.maxWind  = Math.max(d.maxWind, windMph);
        d.minTemp  = Math.min(d.minTemp, tempF);
        if (snowMm > 0) d.hasSnow = true;

        d.slots.push({ dt: slot.dt, pop, windMph, tempF, rainMm, snowMm });
    }

    // Evaluate each day
    for (const [date, d] of Object.entries(daily)) {
        const reasons = [];

        if (d.maxRain > THRESHOLDS.precipProbability) {
            reasons.push(`${Math.round(d.maxRain * 100)}% chance of rain`);
        }
        if (d.maxWind > THRESHOLDS.windSpeedMph) {
            reasons.push(`wind gusts up to ${Math.round(d.maxWind)} mph`);
        }
        if (d.minTemp < THRESHOLDS.tempFreezing) {
            reasons.push(`freezing temperatures (${Math.round(d.minTemp)}°F)`);
        }
        if (d.hasSnow) {
            reasons.push('snowfall expected');
        }

        d.isPoor   = reasons.length > 0;
        d.reasons  = reasons;
    }

    return { daily };
}

// ─── Weather Evaluator ────────────────────────────────────────────────────────

/**
 * Evaluate the forecast for a specific date.
 * Returns { isPoor: bool, reasons: string[], recommendation: string }
 *
 * @param {Object} forecast  - Result from getForecast()
 * @param {string} date      - 'YYYY-MM-DD'
 */
async function evaluateWeather(forecast, date) {
    const dayForecast = forecast.daily?.[date];

    if (!dayForecast) {
        // Date not in the 5-day window — assume OK
        return {
            isPoor:         false,
            reasons:        [],
            recommendation: 'No forecast data available for this date — assuming OK.',
        };
    }

    const recommendation = dayForecast.isPoor
        ? `Postpone outdoor work on ${date}: ${dayForecast.reasons.join(', ')}.`
        : `Weather on ${date} looks acceptable for outdoor work.`;

    return {
        isPoor:         dayForecast.isPoor,
        reasons:        dayForecast.reasons,
        maxRainProb:    dayForecast.maxRain,
        maxWindMph:     dayForecast.maxWind,
        minTempF:       dayForecast.minTemp,
        hasSnow:        dayForecast.hasSnow,
        recommendation,
    };
}

module.exports = {
    getForecast,
    evaluateWeather,
};
