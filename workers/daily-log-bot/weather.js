/**
 * GRIDHAND Daily Log Bot — OpenWeatherMap Integration
 *
 * Fetches current weather for a job site city.
 * Uses the free OpenWeatherMap Current Weather API.
 * Docs: https://openweathermap.org/current
 */

'use strict';

const axios = require('axios');

const OWM_BASE = 'https://api.openweathermap.org/data/2.5';

/**
 * Get current weather for a location.
 * @param {string} city  - e.g. "Milwaukee,US"
 * @returns {{ tempF, description, windMph, precipIn, suitable }}
 */
async function getCurrentWeather(city) {
    const resp = await axios.get(`${OWM_BASE}/weather`, {
        params: {
            q:     city,
            appid: process.env.OPENWEATHER_API_KEY,
            units: 'imperial',
        },
    });

    const d = resp.data;
    const tempF     = Math.round(d.main?.temp || 0);
    const feelsLike = Math.round(d.main?.feels_like || tempF);
    const humidity  = d.main?.humidity || 0;
    const windMph   = Math.round((d.wind?.speed || 0));
    const desc      = d.weather?.[0]?.description || 'unknown';
    const rain1h    = d.rain?.['1h'] || 0;
    const snow1h    = d.snow?.['1h'] || 0;
    const precipMm  = rain1h + snow1h;
    const precipIn  = Math.round(precipMm * 0.0394 * 100) / 100;

    // Determine if site conditions are suitable for work
    const weatherId = d.weather?.[0]?.id || 800;
    const suitable  = isSuitable(weatherId, tempF, windMph, precipIn);

    return {
        tempF,
        feelsLike,
        humidity,
        windMph,
        description: desc,
        precipIn,
        suitable,
        rawId: weatherId,
    };
}

/**
 * Simple rule-based suitability check for outdoor construction.
 * Returns false if conditions are dangerous or work-stopping.
 */
function isSuitable(weatherId, tempF, windMph, precipIn) {
    if (tempF < 20 || tempF > 105) return false;   // extreme temps
    if (windMph > 35) return false;                 // high winds
    if (precipIn > 0.3) return false;               // heavy rain/snow
    if (weatherId >= 200 && weatherId < 300) return false; // thunderstorm
    if (weatherId >= 600 && weatherId < 620) return false; // heavy snow
    if (weatherId === 781) return false;            // tornado
    return true;
}

/**
 * Build weather section text for daily log report.
 */
function buildWeatherText({ tempF, feelsLike, description, windMph, precipIn, suitable }) {
    let text = `${tempF}°F (feels like ${feelsLike}°F), ${description}, wind ${windMph} mph`;
    if (precipIn > 0) text += `, precip ${precipIn}"`;
    if (!suitable) text += ' ⚠️ Conditions may impact site work';
    return text;
}

module.exports = {
    getCurrentWeather,
    buildWeatherText,
};
