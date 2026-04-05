/**
 * GRIDHAND Parts Prophet — Bull Queue Job Definitions
 *
 * Jobs:
 *  - schedule-scan    → 2pm daily: pull tomorrow's appointments, identify parts needed
 *  - price-compare    → 2:30pm daily: get prices from WorldPac + AutoZone for all pending parts
 *  - pre-order        → 3pm daily: auto-order (if enabled) or SMS recommendation to owner
 *
 * All jobs are registered here. index.js schedules them via node-cron.
 */

'use strict';

const Bull      = require('bull');
const dayjs     = require('dayjs');
const tekmetric = require('./tekmetric');
const suppliers = require('./suppliers');
const reports   = require('./reports');
const db        = require('./db');
const sms       = require('./sms');

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const scheduleScanQueue = new Bull('parts:schedule-scan',  REDIS_URL);
const priceCompareQueue = new Bull('parts:price-compare',  REDIS_URL);
const preOrderQueue     = new Bull('parts:pre-order',      REDIS_URL);

// ─── Job: Schedule Scan ───────────────────────────────────────────────────────

scheduleScanQueue.process(async (job) => {
    const { clientSlug, targetDate } = job.data;
    const date = targetDate || dayjs().add(1, 'day').format('YYYY-MM-DD');
    console.log(`[ScheduleScan] Running for ${clientSlug}, target: ${date}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const jobs = await tekmetric.getTomorrowsJobsWithParts(clientSlug, conn, date);

    let partsIdentified = 0;

    for (const j of jobs) {
        for (const part of j.parts) {
            await db.upsertPartNeeded(clientSlug, {
                tekmetricJobId:  j.tekmetricJobId,
                roNumber:        j.roNumber,
                appointmentDate: date,
                vehicleYear:     j.vehicleYear,
                vehicleMake:     j.vehicleMake,
                vehicleModel:    j.vehicleModel,
                vehicleEngine:   j.vehicleEngine,
                partNumber:      part.partNumber,
                partDescription: part.partDescription,
                quantityNeeded:  part.quantityNeeded,
                status:          'pending',
            });
            partsIdentified++;
        }
    }

    await db.upsertScheduleScan(clientSlug, {
        scanDate:           dayjs().format('YYYY-MM-DD'),
        targetDate:         date,
        appointmentsFound:  jobs.length,
        partsIdentified,
    });

    console.log(`[ScheduleScan] Done for ${clientSlug} — ${jobs.length} jobs, ${partsIdentified} parts`);
    return { clientSlug, jobs: jobs.length, partsIdentified };
});

// ─── Job: Price Compare ───────────────────────────────────────────────────────

priceCompareQueue.process(async (job) => {
    const { clientSlug, targetDate } = job.data;
    const date = targetDate || dayjs().add(1, 'day').format('YYYY-MM-DD');
    console.log(`[PriceCompare] Running for ${clientSlug}, target: ${date}`);

    const conn         = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const pendingParts = await db.getPendingParts(clientSlug, date);
    let totalSavings   = 0;
    let compared       = 0;

    for (const part of pendingParts) {
        const comparison = await suppliers.comparePrices(conn, {
            partNumber:     part.part_number,
            partDescription: part.part_description,
            vehicleYear:    part.vehicle_year,
            vehicleMake:    part.vehicle_make,
            vehicleModel:   part.vehicle_model,
            vehicleEngine:  part.vehicle_engine,
            quantityNeeded: part.quantity_needed,
        });

        await db.saveComparison(clientSlug, comparison);

        // Update part with best supplier/price
        if (comparison.bestSupplier) {
            await db.updatePartStatus(clientSlug, part.id, {
                status:          'quoted',
                chosenSupplier:  comparison.bestSupplier,
                chosenPrice:     comparison.bestPrice,
            });
        }

        if (comparison.savingsVsWorst) totalSavings += comparison.savingsVsWorst;
        compared++;
    }

    console.log(`[PriceCompare] Done for ${clientSlug} — ${compared} parts compared, $${totalSavings.toFixed(2)} potential savings`);
    return { clientSlug, compared, totalSavings };
});

// ─── Job: Pre-Order ───────────────────────────────────────────────────────────

preOrderQueue.process(async (job) => {
    const { clientSlug, targetDate } = job.data;
    const date = targetDate || dayjs().add(1, 'day').format('YYYY-MM-DD');
    console.log(`[PreOrder] Running for ${clientSlug}, target: ${date}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    // Get all quoted parts for tomorrow
    const { data: quotedParts } = await require('@supabase/supabase-js')
        .createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
        .from('parts_needed')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('appointment_date', date)
        .eq('status', 'quoted');

    if (!quotedParts || quotedParts.length === 0) {
        console.log(`[PreOrder] No quoted parts for ${clientSlug} on ${date}`);
        return { clientSlug, ordered: 0 };
    }

    // Group by supplier
    const bySupplier = {};
    for (const part of quotedParts) {
        const sup = part.chosen_supplier;
        if (!sup) continue;
        if (!bySupplier[sup]) bySupplier[sup] = [];
        bySupplier[sup].push(part);
    }

    // Build job list for SMS
    const jobMap = {};
    for (const part of quotedParts) {
        if (!jobMap[part.tekmetric_job_id]) {
            jobMap[part.tekmetric_job_id] = {
                roNumber:   part.tekmetric_ro_number,
                vehicleYear:  part.vehicle_year,
                vehicleMake:  part.vehicle_make,
                vehicleModel: part.vehicle_model,
                parts: [],
            };
        }
        jobMap[part.tekmetric_job_id].parts.push({
            partDescription: part.part_description,
            bestSupplier:    part.chosen_supplier,
            bestPrice:       part.chosen_price,
        });
    }

    const jobList = Object.values(jobMap);
    const totalSavings = quotedParts.reduce((s, p) => s + (p.chosen_price || 0), 0);

    if (conn.auto_order_enabled) {
        // Auto-place orders with each supplier
        let totalOrdered = 0;

        for (const [supplier, parts] of Object.entries(bySupplier)) {
            const lineItems = parts.map(p => ({
                partNumber:  p.part_number,
                description: p.part_description,
                quantity:    p.quantity_needed,
                price:       p.chosen_price,
            }));

            try {
                const orderResult = await suppliers.placeOrder(conn, supplier, lineItems);

                const savedOrder = await db.saveOrder(clientSlug, {
                    supplier,
                    orderId:      orderResult.orderId,
                    orderDate:    dayjs().format('YYYY-MM-DD'),
                    deliveryDate: orderResult.deliveryDate,
                    totalParts:   parts.length,
                    totalCost:    orderResult.totalCost,
                    lineItems,
                });

                // Update each part's status
                for (const part of parts) {
                    await db.updatePartStatus(clientSlug, part.id, {
                        status:   'ordered',
                        orderId:  String(savedOrder.id),
                        chosenSupplier: supplier,
                        chosenPrice:    part.chosen_price,
                    });
                }

                const confirmMsg = reports.generateOrderConfirmation({
                    supplier,
                    orderId:      orderResult.orderId,
                    totalParts:   parts.length,
                    totalCost:    orderResult.totalCost,
                    deliveryDate: orderResult.deliveryDate,
                    shopName:     conn.shop_name || clientSlug,
                });

                await sms.sendToOwner(conn, confirmMsg, 'order_placed');
                totalOrdered += parts.length;

            } catch (err) {
                console.error(`[PreOrder] Order failed with ${supplier} for ${clientSlug}: ${err.message}`);
            }
        }

        console.log(`[PreOrder] Done for ${clientSlug} — ${totalOrdered} parts ordered`);
        return { clientSlug, ordered: totalOrdered };

    } else {
        // SMS-only mode — send recommendation to owner
        const recoMsg = reports.generatePartsRecommendation({
            jobs:       jobList,
            shopName:   conn.shop_name || clientSlug,
            targetDate: date,
        });

        if (recoMsg) {
            await sms.sendToOwner(conn, recoMsg, 'parts_recommendation');
        }

        console.log(`[PreOrder] Done for ${clientSlug} — recommendation sent`);
        return { clientSlug, ordered: 0, recommended: quotedParts.length };
    }
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['schedule-scan', scheduleScanQueue],
    ['price-compare', priceCompareQueue],
    ['pre-order',     preOrderQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} job failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} job completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runScheduleScan(clientSlug, targetDate = null) {
    return scheduleScanQueue.add({ clientSlug, targetDate }, { attempts: 2, backoff: 60000 });
}

async function runPriceCompare(clientSlug, targetDate = null) {
    return priceCompareQueue.add({ clientSlug, targetDate }, { attempts: 3, backoff: 30000 });
}

async function runPreOrder(clientSlug, targetDate = null) {
    return preOrderQueue.add({ clientSlug, targetDate }, { attempts: 2, backoff: 60000 });
}

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
    runScheduleScan,
    runPriceCompare,
    runPreOrder,
    runForAllClients,
    scheduleScanQueue,
    priceCompareQueue,
    preOrderQueue,
};
