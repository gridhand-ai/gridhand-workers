/**
 * GRIDHAND Waste Watcher — Waste Prediction Engine
 *
 * Core intelligence layer. Predicts which items will be wasted,
 * suggests optimal prep quantities, calculates waste cost, and
 * sends targeted SMS alerts to kitchen managers and chefs.
 *
 * Prediction model:
 *   risk_score = current_qty / (usage_rate * days_to_expiry)
 *   - risk_score > 1.5 = HIGH risk (more stock than you can use before expiry)
 *   - risk_score 1.0–1.5 = MEDIUM risk
 *   - risk_score < 1.0  = LOW risk (should be fine)
 */

'use strict';

require('dotenv').config();

const dayjs   = require('dayjs');
const twilio  = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const { calculateUsageRate, getSalesHistory } = require('./pos');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

// ─── Connection Loader ────────────────────────────────────────────────────────

async function _getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('watcher_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error || !data) throw new Error(`No connection found for ${clientSlug}`);
    return data;
}

// ─── Prediction Core ──────────────────────────────────────────────────────────

/**
 * Predict waste for a single inventory item.
 *
 * Logic:
 * 1. Get usage rate (avg daily qty sold over past 14 days)
 * 2. If item has an expiry date, calculate days until expiry
 * 3. Project how much will be used before expiry
 * 4. predicted_waste = current_qty - (usage_rate * days_to_expiry)
 * 5. Clamp to 0 (can't have negative waste)
 *
 * @param {string} clientSlug
 * @param {Object} item - inventory item object (from DB or API)
 * @returns {Object} prediction result
 */
async function predictWaste(clientSlug, item) {
    const usageRate = await calculateUsageRate(clientSlug, item.item_name || item.itemName, 14);

    // If no expiry date, we can still predict based on usage vs on-hand
    const daysToExpiry = item.expiry_date
        ? Math.max(0, dayjs(item.expiry_date).diff(dayjs(), 'day'))
        : null;

    const currentQty = parseFloat(item.current_qty ?? item.currentQty ?? 0);
    const unitCost   = parseFloat(item.unit_cost   ?? item.unitCost   ?? 0);

    let predictedWasteQty = 0;
    let riskScore         = 0;

    if (daysToExpiry !== null) {
        const projectedUsage = usageRate * daysToExpiry;
        predictedWasteQty   = Math.max(0, currentQty - projectedUsage);

        // Risk score: ratio of stock on hand to what we expect to use
        if (daysToExpiry === 0) {
            // Expires today — everything on hand is at risk
            riskScore = currentQty > 0 ? 10 : 0;
        } else if (usageRate > 0) {
            riskScore = currentQty / (usageRate * daysToExpiry);
        } else {
            // We use none of this item but have stock — very high risk
            riskScore = currentQty > 0 ? 9.99 : 0;
        }
    } else {
        // No expiry — risk is based on how fast we're moving through stock
        // If usage rate is very low relative to on-hand, flag it
        if (usageRate > 0) {
            const daysOfStock = currentQty / usageRate;
            riskScore = daysOfStock > 30 ? 2.0 : daysOfStock > 14 ? 1.5 : 0.8;
        } else {
            riskScore = currentQty > 0 ? 1.8 : 0;
        }
        predictedWasteQty = 0; // No expiry, no definitive waste prediction
    }

    const predictedWasteCost = parseFloat((predictedWasteQty * unitCost).toFixed(2));

    return {
        itemName:           item.item_name || item.itemName,
        currentQty,
        unit:               item.unit || 'each',
        unitCost,
        usageRate,
        daysToExpiry,
        predictedWasteQty: parseFloat(predictedWasteQty.toFixed(3)),
        predictedWasteCost,
        riskScore:          parseFloat(riskScore.toFixed(2)),
        riskLevel:          riskScore >= 1.5 ? 'HIGH' : riskScore >= 1.0 ? 'MEDIUM' : 'LOW',
    };
}

/**
 * Rank items by waste risk score, highest first.
 * @param {Array} items - inventory items
 * @param {string} clientSlug - used to compute usage rates
 * @returns {Array} items sorted by risk score descending, with risk metadata
 */
async function rankWasteRisk(clientSlug, items) {
    const predictions = await Promise.all(
        items.map(item => predictWaste(clientSlug, item).catch(err => {
            console.error(`[Predictions] rankWasteRisk failed for ${item.item_name}: ${err.message}`);
            return null;
        }))
    );

    return predictions
        .filter(Boolean)
        .sort((a, b) => b.riskScore - a.riskScore);
}

// ─── Prep Quantity Suggestion ─────────────────────────────────────────────────

/**
 * Suggest optimal prep quantity for an item on a given day of week.
 *
 * Strategy:
 * 1. Look at historical sales for this item on this same day of week (last 8 occurrences)
 * 2. Average the qty sold
 * 3. Add a 15% buffer for safety
 * 4. Subtract what's already on hand
 * 5. Return max(0, result) as the prep recommendation
 *
 * @param {string} clientSlug
 * @param {Object} item - inventory item
 * @param {number} dayOfWeek - 0=Sunday, 1=Monday ... 6=Saturday
 * @returns {Object} { suggestedPrepQty, unit, avgHistoricalSales, onHand }
 */
async function suggestPrepQuantity(clientSlug, item, dayOfWeek) {
    const itemName   = item.item_name || item.itemName;
    const currentQty = parseFloat(item.current_qty ?? item.currentQty ?? 0);
    const unit       = item.unit || 'each';

    // Look back 8 weeks to get enough data points for this day of week
    const startDate = dayjs().subtract(56, 'day').format('YYYY-MM-DD');

    const { data, error } = await supabase
        .from('daily_sales')
        .select('sale_date, quantity_sold')
        .eq('client_slug', clientSlug)
        .eq('item_name', itemName)
        .gte('sale_date', startDate)
        .order('sale_date', { ascending: false });

    if (error) throw new Error(`suggestPrepQuantity query failed: ${error.message}`);

    // Filter to the matching day of week
    const matchingDays = (data || []).filter(row => {
        return dayjs(row.sale_date).day() === dayOfWeek;
    });

    let avgSales = 0;
    if (matchingDays.length > 0) {
        const total = matchingDays.reduce((sum, row) => sum + parseFloat(row.quantity_sold || 0), 0);
        avgSales = total / matchingDays.length;
    } else {
        // No day-specific data — fall back to overall average
        avgSales = await calculateUsageRate(clientSlug, itemName, 14);
    }

    // 15% prep buffer
    const targetQty        = avgSales * 1.15;
    const suggestedPrepQty = Math.max(0, parseFloat((targetQty - currentQty).toFixed(3)));

    return {
        itemName,
        suggestedPrepQty,
        unit,
        avgHistoricalSales: parseFloat(avgSales.toFixed(3)),
        onHand:             currentQty,
        dataPoints:         matchingDays.length,
    };
}

// ─── Waste Cost Calculation ───────────────────────────────────────────────────

/**
 * Calculate total dollar value of waste for a period.
 * Reads from waste_predictions table.
 *
 * @param {string} clientSlug
 * @param {string} period - 'today' | 'week' | 'month'
 * @returns {Object} { totalWasteCost, itemCount, predictions }
 */
async function calculateWasteCost(clientSlug, period = 'week') {
    let startDate;
    const today = dayjs().format('YYYY-MM-DD');

    switch (period) {
        case 'today':
            startDate = today;
            break;
        case 'month':
            startDate = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
            break;
        case 'week':
        default:
            startDate = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
            break;
    }

    const { data, error } = await supabase
        .from('waste_predictions')
        .select('*')
        .eq('client_slug', clientSlug)
        .gte('prediction_date', startDate)
        .lte('prediction_date', today)
        .gt('predicted_waste_cost', 0)
        .order('predicted_waste_cost', { ascending: false });

    if (error) throw new Error(`calculateWasteCost query failed: ${error.message}`);

    const predictions    = data || [];
    const totalWasteCost = predictions.reduce(
        (sum, row) => sum + parseFloat(row.predicted_waste_cost || 0), 0
    );

    return {
        period,
        startDate,
        endDate:        today,
        totalWasteCost: parseFloat(totalWasteCost.toFixed(2)),
        itemCount:      predictions.length,
        predictions,
    };
}

// ─── Waste Report Generation ──────────────────────────────────────────────────

/**
 * Generate a full waste report for the given period.
 * Returns a structured report object used by jobs.js for SMS and logging.
 *
 * @param {string} clientSlug
 * @param {string} period - 'week' | 'month'
 * @returns {Object} full waste report
 */
async function generateWasteReport(clientSlug, period = 'week') {
    const conn       = await _getConnection(clientSlug);
    const wasteCosts = await calculateWasteCost(clientSlug, period);

    // Top 5 wasted items
    const topWasted = wasteCosts.predictions.slice(0, 5).map(row => ({
        itemName:    row.item_name,
        wasteCost:   parseFloat(row.predicted_waste_cost || 0),
        wasteQty:    parseFloat(row.predicted_waste_qty  || 0),
        riskScore:   parseFloat(row.risk_score           || 0),
    }));

    // Trend: compare to prior period
    const priorPeriodStart = period === 'month'
        ? dayjs().subtract(60, 'day').format('YYYY-MM-DD')
        : dayjs().subtract(14, 'day').format('YYYY-MM-DD');
    const priorPeriodEnd = period === 'month'
        ? dayjs().subtract(31, 'day').format('YYYY-MM-DD')
        : dayjs().subtract(8, 'day').format('YYYY-MM-DD');

    const { data: priorData } = await supabase
        .from('waste_predictions')
        .select('predicted_waste_cost')
        .eq('client_slug', clientSlug)
        .gte('prediction_date', priorPeriodStart)
        .lte('prediction_date', priorPeriodEnd)
        .gt('predicted_waste_cost', 0);

    const priorCost = (priorData || []).reduce(
        (sum, row) => sum + parseFloat(row.predicted_waste_cost || 0), 0
    );

    const trendDelta   = wasteCosts.totalWasteCost - priorCost;
    const trendPercent = priorCost > 0
        ? parseFloat(((trendDelta / priorCost) * 100).toFixed(1))
        : null;

    return {
        clientSlug,
        restaurantName: conn.restaurant_name || clientSlug,
        period,
        startDate:      wasteCosts.startDate,
        endDate:        wasteCosts.endDate,
        totalWasteCost: wasteCosts.totalWasteCost,
        itemCount:      wasteCosts.itemCount,
        topWasted,
        priorPeriodCost: parseFloat(priorCost.toFixed(2)),
        trendDelta:      parseFloat(trendDelta.toFixed(2)),
        trendPercent,
        savingsOpportunity: parseFloat((wasteCosts.totalWasteCost * 0.6).toFixed(2)), // typical 60% reducible
    };
}

// ─── Prediction Persistence ───────────────────────────────────────────────────

/**
 * Save or update a waste prediction to the DB.
 */
async function savePrediction(clientSlug, prediction) {
    const row = {
        client_slug:          clientSlug,
        item_name:            prediction.itemName,
        prediction_date:      dayjs().format('YYYY-MM-DD'),
        predicted_waste_qty:  prediction.predictedWasteQty,
        predicted_waste_cost: prediction.predictedWasteCost,
        risk_score:           prediction.riskScore,
        alerted:              false,
    };

    const { error } = await supabase
        .from('waste_predictions')
        .insert(row);

    if (error) {
        // Non-fatal — don't crash the job on duplicate
        console.warn(`[Predictions] savePrediction warning for ${prediction.itemName}: ${error.message}`);
    }
}

/**
 * Mark a prediction as alerted so we don't SMS about it again today.
 */
async function markAlerted(clientSlug, itemName) {
    await supabase
        .from('waste_predictions')
        .update({ alerted: true })
        .eq('client_slug', clientSlug)
        .eq('item_name', itemName)
        .eq('prediction_date', dayjs().format('YYYY-MM-DD'));
}

// ─── SMS Alerts ───────────────────────────────────────────────────────────────

async function _logAlert(clientSlug, alertType, recipient, messageBody) {
    await supabase.from('waste_alerts').insert({
        client_slug:  clientSlug,
        alert_type:   alertType,
        recipient,
        message_body: messageBody,
    });
}

async function _sendSMS(to, body) {
    return twilioClient.messages.create({
        from: FROM_NUMBER,
        to,
        body,
    });
}

/**
 * Send an SMS alert when an item is predicted to be wasted.
 * Only fires once per item per day (alerted flag guards duplicates).
 *
 * @param {string} clientSlug
 * @param {Object} item - inventory item
 * @param {Object} prediction - result from predictWaste()
 */
async function sendWasteAlert(clientSlug, item, prediction) {
    const conn = await _getConnection(clientSlug);
    if (!conn.manager_phone && !conn.chef_phone) {
        console.warn(`[Predictions] No recipient phone for ${clientSlug} — skipping waste alert`);
        return;
    }

    const expiryStr  = item.expiry_date ? dayjs(item.expiry_date).format('MMM D') : 'unknown';
    const recipient  = conn.manager_phone || conn.chef_phone;
    const restaurant = conn.restaurant_name || clientSlug;

    const body = [
        `🚨 Expiry Alert — ${restaurant}`,
        `Expiring TODAY:`,
        `• ${prediction.itemName}: ${prediction.currentQty} ${prediction.unit} ($${(prediction.currentQty * prediction.unitCost).toFixed(2)})`,
        `Use immediately or 86 from menu`,
    ].join('\n');

    try {
        await _sendSMS(recipient, body);
        await _logAlert(clientSlug, 'expiry_alert', recipient, body);
        await markAlerted(clientSlug, prediction.itemName);
        console.log(`[Predictions] Waste alert sent for ${prediction.itemName} to ${recipient}`);
    } catch (err) {
        console.error(`[Predictions] sendWasteAlert SMS failed for ${clientSlug}: ${err.message}`);
    }
}

/**
 * Send the morning prep briefing to the kitchen manager / chef.
 * Includes: top prep items for today, expiring items, low stock items.
 *
 * @param {string} clientSlug
 * @param {Object} opts
 * @param {Array}  opts.prepItems      - [{ itemName, suggestedPrepQty, unit }]
 * @param {Array}  opts.expiringToday  - inventory items expiring today
 * @param {Array}  opts.lowStockItems  - inventory items below par
 */
async function sendDailyReport(clientSlug, opts = {}) {
    const conn = await _getConnection(clientSlug);
    const { prepItems = [], expiringToday = [], lowStockItems = [] } = opts;

    const recipient  = conn.chef_phone || conn.manager_phone;
    if (!recipient) {
        console.warn(`[Predictions] No recipient phone for ${clientSlug} — skipping daily report`);
        return;
    }

    const restaurant = conn.restaurant_name || clientSlug;
    const dayStr     = dayjs().format('dddd, MMM D');

    const prepLines = prepItems.slice(0, 6).map(
        p => `• ${p.itemName}: prep ${p.suggestedPrepQty} ${p.unit}`
    );

    const expiringStr = expiringToday.length > 0
        ? expiringToday.map(i => i.item_name || i.itemName).slice(0, 4).join(', ')
        : 'None';

    const lowStockStr = lowStockItems.length > 0
        ? lowStockItems.map(i => i.item_name || i.itemName).slice(0, 4).join(', ')
        : 'None';

    const body = [
        `🍳 Prep Briefing — ${restaurant}`,
        `${dayStr}`,
        `─────────────────`,
        `High prep items today:`,
        ...(prepLines.length > 0 ? prepLines : ['• All items well stocked']),
        `─────────────────`,
        `⚠️ Expiring today: ${expiringStr}`,
        `Low stock: ${lowStockStr}`,
        `Reply DETAIL for full list`,
    ].join('\n');

    try {
        await _sendSMS(recipient, body);
        await _logAlert(clientSlug, 'prep_briefing', recipient, body);
        console.log(`[Predictions] Daily prep briefing sent to ${recipient} for ${clientSlug}`);
    } catch (err) {
        console.error(`[Predictions] sendDailyReport SMS failed for ${clientSlug}: ${err.message}`);
    }
}

/**
 * Send the expiry alert SMS — for items expiring TODAY.
 *
 * @param {string} clientSlug
 * @param {Array}  expiringItems - items with expiry_date = today
 */
async function sendExpiryAlert(clientSlug, expiringItems) {
    if (!expiringItems || expiringItems.length === 0) return;

    const conn = await _getConnection(clientSlug);
    const recipient  = conn.manager_phone || conn.chef_phone;
    if (!recipient) return;

    const restaurant = conn.restaurant_name || clientSlug;

    const itemLines = expiringItems.slice(0, 6).map(item => {
        const qty  = parseFloat(item.current_qty ?? item.currentQty ?? 0);
        const cost = parseFloat(item.unit_cost   ?? item.unitCost   ?? 0);
        const name = item.item_name || item.itemName;
        const unit = item.unit || 'each';
        return `• ${name}: ${qty} ${unit} ($${(qty * cost).toFixed(2)})`;
    });

    const body = [
        `🚨 Expiry Alert — ${restaurant}`,
        `Expiring TODAY:`,
        ...itemLines,
        `Use immediately or 86 from menu`,
    ].join('\n');

    try {
        await _sendSMS(recipient, body);
        await _logAlert(clientSlug, 'expiry_alert', recipient, body);
        console.log(`[Predictions] Expiry alert sent for ${expiringItems.length} items to ${recipient}`);
    } catch (err) {
        console.error(`[Predictions] sendExpiryAlert SMS failed for ${clientSlug}: ${err.message}`);
    }
}

/**
 * Send the weekly waste cost report SMS.
 *
 * @param {string} clientSlug
 * @param {Object} report - result from generateWasteReport()
 */
async function sendWeeklyWasteReport(clientSlug, report) {
    const conn = await _getConnection(clientSlug);
    const recipient  = conn.manager_phone || conn.chef_phone;
    if (!recipient) return;

    const weekStr    = dayjs(report.startDate).format('MMM D');
    const topLines   = report.topWasted.slice(0, 3).map(
        (item, i) => `${i + 1}. ${item.itemName}: $${item.wasteCost.toFixed(2)}`
    );

    const body = [
        `📊 Weekly Waste Report — ${report.restaurantName}`,
        `Week of ${weekStr}`,
        `Estimated waste cost: $${report.totalWasteCost.toFixed(2)}`,
        `Top wasted items:`,
        ...topLines,
        `Savings opportunity: $${report.savingsOpportunity.toFixed(2)}/wk`,
    ].join('\n');

    try {
        await _sendSMS(recipient, body);
        await _logAlert(clientSlug, 'weekly_report', recipient, body);
        console.log(`[Predictions] Weekly waste report sent for ${clientSlug} to ${recipient}`);
    } catch (err) {
        console.error(`[Predictions] sendWeeklyWasteReport SMS failed for ${clientSlug}: ${err.message}`);
    }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    predictWaste,
    rankWasteRisk,
    suggestPrepQuantity,
    calculateWasteCost,
    generateWasteReport,
    savePrediction,
    markAlerted,
    sendWasteAlert,
    sendDailyReport,
    sendExpiryAlert,
    sendWeeklyWasteReport,
};
