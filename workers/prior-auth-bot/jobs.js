/**
 * GRIDHAND AI — Prior Auth Bot
 * Bull Queue Job Definitions
 *
 * Queues:
 *   pab:scan-orders    — scan EHR for new orders needing auth
 *   pab:submit         — submit a single auth request
 *   pab:status-check   — poll all pending auths for decisions
 *   pab:appeal         — run appeal workflow for a denied auth
 *   pab:digest         — morning summary to staff
 */

'use strict';

const Bull = require('bull');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const ehr = require('./ehr');
const payers = require('./payers');
const workflow = require('./auth-workflow');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ============================================================
// REDIS CONFIG
// ============================================================

const REDIS_CONFIG = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined
};

const QUEUE_OPTS = {
    redis: REDIS_CONFIG,
    defaultJobOptions: {
        removeOnComplete: 50,
        removeOnFail: 100,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 }
    }
};

// ============================================================
// QUEUE DEFINITIONS
// ============================================================

const queues = {
    'pab:scan-orders':  new Bull('pab:scan-orders', QUEUE_OPTS),
    'pab:submit':       new Bull('pab:submit', QUEUE_OPTS),
    'pab:status-check': new Bull('pab:status-check', QUEUE_OPTS),
    'pab:appeal':       new Bull('pab:appeal', QUEUE_OPTS),
    'pab:digest':       new Bull('pab:digest', QUEUE_OPTS)
};

// ============================================================
// JOB: SCAN ORDERS
// Pull pending EHR orders for all/one client, queue submissions
// ============================================================

queues['pab:scan-orders'].process('scan', 2, async (job) => {
    const { clientSlug } = job.data;
    return runScanOrders(clientSlug);
});

async function runScanOrders(clientSlug) {
    let orders;
    try {
        orders = await ehr.getPendingOrders(clientSlug);
    } catch (err) {
        console.error(`[Jobs] getPendingOrders failed for ${clientSlug}:`, err.message);
        return { ok: false, error: err.message };
    }

    let queued = 0;
    let skipped = 0;

    for (const order of orders) {
        // Skip orders that have no procedure code
        if (!order.procedureCode) {
            skipped++;
            continue;
        }

        // Skip if auth not required
        if (!payers.isAuthRequired(order.procedureCode)) {
            skipped++;
            continue;
        }

        // Skip if we already have an active auth for this order
        const { data: existing } = await supabase
            .from('pab_auths')
            .select('id')
            .eq('client_slug', clientSlug)
            .eq('order_id', order.id)
            .not('status', 'in', '("cancelled","expired")')
            .maybeSingle();

        if (existing) {
            skipped++;
            continue;
        }

        await queues['pab:submit'].add('submit', {
            clientSlug,
            orderId: order.id,
            order
        }, { jobId: `submit-${clientSlug}-${order.id}` });

        queued++;
    }

    return { ok: true, total: orders.length, queued, skipped };
}

// ============================================================
// JOB: SUBMIT AUTH
// ============================================================

queues['pab:submit'].process('submit', 5, async (job) => {
    const { clientSlug, order } = job.data;
    return runSubmitAuth(clientSlug, order.id, order);
});

async function runSubmitAuth(clientSlug, orderId, order) {
    // If only orderId was passed (e.g. from manual trigger), fetch from EHR
    let targetOrder = order;
    if (!targetOrder) {
        const orders = await ehr.getPendingOrders(clientSlug);
        targetOrder = orders.find(o => o.id === orderId);
        if (!targetOrder) {
            return { ok: false, error: `Order ${orderId} not found in EHR` };
        }
    }

    return workflow.processNewOrder(clientSlug, targetOrder);
}

// ============================================================
// JOB: STATUS CHECK
// Poll all pending/submitted auths for a client
// ============================================================

queues['pab:status-check'].process('check', 3, async (job) => {
    const { clientSlug } = job.data;
    return runStatusChecks(clientSlug);
});

async function runStatusChecks(clientSlug) {
    const { data: pending } = await supabase
        .from('pab_auths')
        .select('*')
        .eq('client_slug', clientSlug)
        .in('status', ['submitted', 'pending', 'appealing'])
        .not('reference_number', 'is', null)
        .order('submitted_at', { ascending: true });

    const auths = pending || [];
    let updated = 0;
    let unchanged = 0;
    let errors = 0;

    for (const auth of auths) {
        // Don't hammer payer APIs — skip if checked in last 2h
        if (auth.last_status_check_at) {
            const hoursSince = (Date.now() - new Date(auth.last_status_check_at).getTime()) / 3_600_000;
            if (hoursSince < 2) {
                unchanged++;
                continue;
            }
        }

        const result = await workflow.checkAndUpdateStatus(clientSlug, auth);

        if (!result.ok && !result.skipped && !result.unchanged) {
            errors++;
        } else if (result.unchanged || result.skipped) {
            unchanged++;
        } else {
            updated++;
        }

        // Small delay between payer API calls
        await new Promise(r => setTimeout(r, 500));
    }

    return { ok: true, total: auths.length, updated, unchanged, errors };
}

// ============================================================
// JOB: APPEAL
// ============================================================

queues['pab:appeal'].process('appeal', 2, async (job) => {
    const { clientSlug, authId } = job.data;
    return runAppeal(clientSlug, authId);
});

async function runAppeal(clientSlug, authId) {
    return workflow.runAppealWorkflow(clientSlug, authId);
}

// ============================================================
// JOB: DAILY DIGEST
// ============================================================

queues['pab:digest'].process('digest', 2, async (job) => {
    const { clientSlug } = job.data;
    return runDailyDigest(clientSlug);
});

async function runDailyDigest(clientSlug) {
    const conn = await loadConnection(clientSlug);
    if (!conn) return { ok: false, error: 'Connection not found' };
    return workflow.sendDailyDigest(conn);
}

// ============================================================
// RUN FOR ALL CLIENTS
// ============================================================

/**
 * runForAllClients(jobFn)
 * Utility to enqueue a job for every active client.
 * jobFn should be a function that accepts clientSlug and returns a queue job promise.
 */
async function runForAllClients(jobFn) {
    const { data: connections } = await supabase
        .from('pab_connections')
        .select('client_slug');

    const slugs = (connections || []).map(c => c.client_slug);
    for (const slug of slugs) {
        await jobFn(slug);
    }
    return slugs.length;
}

async function loadConnection(clientSlug) {
    const { data } = await supabase
        .from('pab_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    return data;
}

// ============================================================
// CRON SCHEDULERS
// ============================================================

function startCronJobs() {
    // Every 2 hours between 8am–6pm — status check sweep
    cron.schedule('0 8-18/2 * * *', async () => {
        console.log('[Jobs] Running status checks for all clients...');
        await runForAllClients(slug =>
            queues['pab:status-check'].add('check', { clientSlug: slug }, {
                jobId: `status-check-${slug}-${Date.now()}`
            })
        );
    });

    // 7am daily — scan EHR for new orders needing auth
    cron.schedule('0 7 * * *', async () => {
        console.log('[Jobs] Scanning EHR for new orders...');
        await runForAllClients(slug =>
            queues['pab:scan-orders'].add('scan', { clientSlug: slug }, {
                jobId: `scan-${slug}-${Date.now()}`
            })
        );
    });

    // 8am daily — send pending auth digest to staff
    cron.schedule('0 8 * * *', async () => {
        console.log('[Jobs] Sending daily prior auth digest...');
        await runForAllClients(slug =>
            queues['pab:digest'].add('digest', { clientSlug: slug }, {
                jobId: `digest-${slug}-${Date.now()}`
            })
        );
    });

    console.log('[Jobs] Cron jobs started.');
}

// ============================================================
// QUEUE ERROR HANDLERS
// ============================================================

for (const [name, queue] of Object.entries(queues)) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] Queue "${name}" job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts}):`, err.message);
    });

    queue.on('error', (err) => {
        console.error(`[Jobs] Queue "${name}" error:`, err.message);
    });
}

// ============================================================
// QUEUE HEALTH
// ============================================================

async function getQueueStats() {
    const stats = {};
    for (const [name, queue] of Object.entries(queues)) {
        const [waiting, active, completed, failed] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount()
        ]);
        stats[name] = { waiting, active, completed, failed };
    }
    return stats;
}

module.exports = {
    queues,
    runScanOrders,
    runSubmitAuth,
    runStatusChecks,
    runAppeal,
    runDailyDigest,
    runForAllClients,
    startCronJobs,
    getQueueStats
};
