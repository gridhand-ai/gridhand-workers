/**
 * GRIDHAND Waste Watcher — Bull Queue Job Definitions
 *
 * Jobs:
 *  - scan-inventory      → 6am daily: sync inventory from MarketMan/BlueCart,
 *                          predict waste, send prep briefing to kitchen
 *  - predict-waste       → on demand: run waste predictions for all inventory
 *  - daily-report        → 6am daily: alias for scan-inventory (unified trigger)
 *  - expiry-check        → 2pm daily: check for items expiring today, fire alerts
 *  - weekly-waste-report → Sunday 7am: weekly waste cost report SMS
 *
 * Additional cron:
 *  - Every 4 hours: pull new POS sales data, update usage rates in daily_sales
 *
 * All jobs registered here. index.js schedules them via node-cron.
 */

'use strict';

require('dotenv').config();

const Bull      = require('bull');
const dayjs     = require('dayjs');
const inventory = require('./inventory');
const pos       = require('./pos');
const pred      = require('./predictions');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const scanInventoryQueue    = new Bull('waste-watcher:scan-inventory',    REDIS_URL);
const predictWasteQueue     = new Bull('waste-watcher:predict-waste',     REDIS_URL);
const dailyReportQueue      = new Bull('waste-watcher:daily-report',      REDIS_URL);
const expiryCheckQueue      = new Bull('waste-watcher:expiry-check',      REDIS_URL);
const weeklyWasteQueue      = new Bull('waste-watcher:weekly-waste-report', REDIS_URL);
const salesSyncQueue        = new Bull('waste-watcher:sales-sync',        REDIS_URL);

// ─── DB Helper ────────────────────────────────────────────────────────────────

async function getAllClients() {
    const { data, error } = await supabase
        .from('watcher_connections')
        .select('client_slug');

    if (error) throw new Error(`getAllClients failed: ${error.message}`);
    return data || [];
}

// ─── Job: Scan Inventory ──────────────────────────────────────────────────────
// 6am daily: pull fresh inventory, predict waste, send morning prep briefing.

scanInventoryQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[ScanInventory] Starting for ${clientSlug}`);

    // 1. Pull inventory from active system
    const items = await inventory.getInventoryForClient(clientSlug);
    if (!items || items.length === 0) {
        console.warn(`[ScanInventory] No items returned for ${clientSlug}`);
        return { clientSlug, itemCount: 0 };
    }

    // 2. Save snapshot to DB
    await inventory.saveInventorySnapshot(clientSlug, items);

    // 3. Run waste predictions for each item
    const predictions = await Promise.all(
        items.map(item => pred.predictWaste(clientSlug, item).catch(err => {
            console.error(`[ScanInventory] predictWaste error for ${item.itemName}: ${err.message}`);
            return null;
        }))
    );
    const validPredictions = predictions.filter(Boolean);

    // 4. Save predictions to DB
    for (const p of validPredictions) {
        await pred.savePrediction(clientSlug, p).catch(err =>
            console.warn(`[ScanInventory] savePrediction warning: ${err.message}`)
        );
    }

    // 5. Compute prep suggestions for today (day of week)
    const dayOfWeek = dayjs().day();
    const prepItems = await Promise.all(
        items
            .filter(item => (item.parLevel || item.par_level)) // only items with par levels set
            .slice(0, 10) // top 10 items to include in briefing
            .map(item => pred.suggestPrepQuantity(clientSlug, item, dayOfWeek).catch(() => null))
    );
    const validPrep = prepItems.filter(Boolean).filter(p => p.suggestedPrepQty > 0);

    // 6. Detect expiring and low-stock items
    const expiringToday = items.filter(item => {
        if (!item.expiryDate && !item.expiry_date) return false;
        const expiry = dayjs(item.expiryDate || item.expiry_date);
        return expiry.isSame(dayjs(), 'day') || expiry.isBefore(dayjs());
    });

    const storedItems  = items.map(item => ({
        ...item,
        current_qty: item.currentQty,
        par_level:   item.parLevel,
        item_name:   item.itemName,
        unit_cost:   item.unitCost,
    }));
    const lowStockItems = inventory.detectLowStock(storedItems);

    // 7. Send morning prep briefing SMS
    await pred.sendDailyReport(clientSlug, {
        prepItems:     validPrep,
        expiringToday,
        lowStockItems,
    });

    // 8. Send expiry alerts for items expiring today
    if (expiringToday.length > 0) {
        await pred.sendExpiryAlert(clientSlug, expiringToday);
    }

    console.log(`[ScanInventory] Done for ${clientSlug}: ${items.length} items scanned, ${validPredictions.length} predictions made`);
    return {
        clientSlug,
        itemCount:        items.length,
        predictionsCount: validPredictions.length,
        expiringCount:    expiringToday.length,
        lowStockCount:    lowStockItems.length,
        prepItemCount:    validPrep.length,
    };
});

// ─── Job: Predict Waste ───────────────────────────────────────────────────────
// On-demand: run predictions only, no SMS, no inventory sync.

predictWasteQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[PredictWaste] Running for ${clientSlug}`);

    const items = await inventory.getStoredInventory(clientSlug);

    const predictions = await Promise.all(
        items.map(item => pred.predictWaste(clientSlug, item).catch(err => {
            console.error(`[PredictWaste] Error for ${item.item_name}: ${err.message}`);
            return null;
        }))
    );
    const valid = predictions.filter(Boolean);

    for (const p of valid) {
        await pred.savePrediction(clientSlug, p).catch(() => {});
    }

    const highRisk = valid.filter(p => p.riskScore >= 1.5);
    console.log(`[PredictWaste] Done for ${clientSlug}: ${valid.length} predictions, ${highRisk.length} high-risk`);

    return {
        clientSlug,
        totalPredictions: valid.length,
        highRiskCount:    highRisk.length,
        topRisk:          valid.sort((a, b) => b.riskScore - a.riskScore).slice(0, 5),
    };
});

// ─── Job: Daily Report ────────────────────────────────────────────────────────
// Alias for scan-inventory — used by manual /trigger/daily-report endpoint.

dailyReportQueue.process(async (job) => {
    const { clientSlug } = job.data;
    // Delegate to scan-inventory logic
    return scanInventoryQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
});

// ─── Job: Expiry Check ────────────────────────────────────────────────────────
// 2pm daily: check for items expiring today or already expired, fire alerts.

expiryCheckQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[ExpiryCheck] Running for ${clientSlug}`);

    const items = await inventory.getStoredInventory(clientSlug);

    // Items expiring today or already past expiry
    const today = dayjs().format('YYYY-MM-DD');
    const expiringNow = items.filter(item => {
        if (!item.expiry_date) return false;
        return item.expiry_date <= today;
    });

    // Items expiring within 3 days (for advance warning)
    const expiringSoon = items.filter(item => {
        if (!item.expiry_date) return false;
        const daysOut = dayjs(item.expiry_date).diff(dayjs(), 'day');
        return daysOut > 0 && daysOut <= 3;
    });

    let alertsSent = 0;

    // Alert on items expiring today/expired
    if (expiringNow.length > 0) {
        await pred.sendExpiryAlert(clientSlug, expiringNow);
        alertsSent++;
    }

    // For items expiring soon — check if we already alerted on them today
    for (const item of expiringSoon) {
        const { data: existingAlert } = await supabase
            .from('waste_alerts')
            .select('id')
            .eq('client_slug', clientSlug)
            .eq('alert_type', 'expiry_alert')
            .gte('sent_at', dayjs().startOf('day').toISOString())
            .limit(1);

        if (existingAlert && existingAlert.length > 0) continue; // already alerted today

        const prediction = await pred.predictWaste(clientSlug, {
            item_name:   item.item_name,
            current_qty: item.current_qty,
            unit:        item.unit,
            unit_cost:   item.unit_cost,
            expiry_date: item.expiry_date,
        }).catch(() => null);

        if (prediction && prediction.riskScore >= 1.5) {
            await pred.sendWasteAlert(clientSlug, item, prediction);
            alertsSent++;
        }
    }

    console.log(`[ExpiryCheck] Done for ${clientSlug}: ${expiringNow.length} expiring today, ${expiringSoon.length} expiring soon, ${alertsSent} alerts sent`);
    return { clientSlug, expiringNow: expiringNow.length, expiringSoon: expiringSoon.length, alertsSent };
});

// ─── Job: Weekly Waste Report ─────────────────────────────────────────────────
// Sunday 7am: generate and SMS the weekly waste cost report.

weeklyWasteQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[WeeklyWasteReport] Running for ${clientSlug}`);

    const report = await pred.generateWasteReport(clientSlug, 'week');
    await pred.sendWeeklyWasteReport(clientSlug, report);

    console.log(`[WeeklyWasteReport] Done for ${clientSlug}: $${report.totalWasteCost.toFixed(2)} waste cost`);
    return {
        clientSlug,
        totalWasteCost:  report.totalWasteCost,
        topWastedCount:  report.topWasted.length,
        savingsOpportunity: report.savingsOpportunity,
    };
});

// ─── Job: Sales Sync ──────────────────────────────────────────────────────────
// Every 4 hours: pull sales data from POS, persist to daily_sales table.

salesSyncQueue.process(async (job) => {
    const { clientSlug } = job.data;
    const today = dayjs().format('YYYY-MM-DD');
    console.log(`[SalesSync] Running for ${clientSlug} — date: ${today}`);

    let items;
    try {
        items = await pos.getSalesByItem(clientSlug, today);
    } catch (err) {
        console.error(`[SalesSync] getSalesByItem failed for ${clientSlug}: ${err.message}`);
        throw err;
    }

    if (items && items.length > 0) {
        await pos.saveDailySales(clientSlug, today, items);
        console.log(`[SalesSync] Saved ${items.length} item sales for ${clientSlug}`);
    } else {
        console.log(`[SalesSync] No sales data returned for ${clientSlug} on ${today}`);
    }

    return { clientSlug, date: today, itemCount: items?.length || 0 };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

const queues = [
    ['scan-inventory',    scanInventoryQueue],
    ['predict-waste',     predictWasteQueue],
    ['daily-report',      dailyReportQueue],
    ['expiry-check',      expiryCheckQueue],
    ['weekly-waste-report', weeklyWasteQueue],
    ['sales-sync',        salesSyncQueue],
];

for (const [name, queue] of queues) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} job FAILED for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job, result) => {
        console.log(`[Jobs] ${name} job completed for ${job.data.clientSlug}`);
    });
    queue.on('error', (err) => {
        console.error(`[Jobs] ${name} queue error: ${err.message}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runScanInventory(clientSlug) {
    return scanInventoryQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runPredictWaste(clientSlug) {
    return predictWasteQueue.add({ clientSlug }, { attempts: 2, backoff: 30000 });
}

async function runDailyReport(clientSlug) {
    return dailyReportQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runExpiryCheck(clientSlug) {
    return expiryCheckQueue.add({ clientSlug }, { attempts: 3, backoff: 30000 });
}

async function runWeeklyWasteReport(clientSlug) {
    return weeklyWasteQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runSalesSync(clientSlug) {
    return salesSyncQueue.add({ clientSlug }, { attempts: 3, backoff: 15000 });
}

/**
 * Run a job function for all connected clients.
 * Called by cron triggers in index.js.
 */
async function runForAllClients(jobFn) {
    const clients = await getAllClients();
    const results = [];

    for (const { client_slug } of clients) {
        try {
            const job = await jobFn(client_slug);
            results.push({ clientSlug: client_slug, jobId: job?.id });
        } catch (err) {
            console.error(`[Jobs] Failed to queue job for ${client_slug}: ${err.message}`);
            results.push({ clientSlug: client_slug, error: err.message });
        }
    }

    return results;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    runScanInventory,
    runPredictWaste,
    runDailyReport,
    runExpiryCheck,
    runWeeklyWasteReport,
    runSalesSync,
    runForAllClients,
    // Queue references (for index.js health checks)
    scanInventoryQueue,
    predictWasteQueue,
    dailyReportQueue,
    expiryCheckQueue,
    weeklyWasteQueue,
    salesSyncQueue,
};
