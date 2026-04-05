/**
 * GRIDHAND Maintenance Dispatcher — Bull Queue Job Definitions
 *
 * Jobs:
 *  - poll-new-requests  → every 15 min: pull new requests from AppFolio, triage + dispatch
 *  - check-sla          → every hour: flag requests breaching SLA
 *  - daily-summary      → 8am daily: owner gets open request summary
 */

'use strict';

const Bull     = require('bull');
const dayjs    = require('dayjs');
const appfolio = require('./appfolio');
const sms      = require('./sms');
const db       = require('./db');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const pollQueue    = new Bull('maintenance-dispatcher:poll-new-requests', REDIS_URL);
const slaQueue     = new Bull('maintenance-dispatcher:check-sla',         REDIS_URL);
const summaryQueue = new Bull('maintenance-dispatcher:daily-summary',     REDIS_URL);
const dispatchQueue = new Bull('maintenance-dispatcher:dispatch-vendor',  REDIS_URL);

// ─── Job: Poll New Requests ───────────────────────────────────────────────────

pollQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[PollRequests] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const afRequests = await appfolio.getMaintenanceRequests(conn, 'Open');
    let newCount = 0;

    for (const req of afRequests) {
        // Check if we've already seen this request
        const existing = await db.getOpenRequests(clientSlug);
        const alreadySeen = existing.some(r => r.appfolio_request_id === req.appfolioRequestId);
        if (alreadySeen) continue;

        // Create request in our DB
        const created = await db.createRequest(clientSlug, req);
        newCount++;

        // Alert owner of new request
        const urgencyEmoji = { emergency: '🚨', urgent: '⚡', routine: '🔧' };
        await sms.sendToOwner(conn,
            `${urgencyEmoji[req.priority] || '🔧'} New ${req.priority.toUpperCase()} maintenance request at ${req.propertyAddress || 'property'}${req.unitNumber ? ` Unit ${req.unitNumber}` : ''}: ${req.description.slice(0, 100)}`,
            'new_request', created.id
        );

        // Auto-dispatch to best vendor
        await dispatchQueue.add({ clientSlug, requestId: created.id }, { attempts: 2, backoff: 30000 });

        // Alert tenant that request was received
        if (req.tenantPhone) {
            await sms.sendToTenant(conn, req.tenantPhone,
                `Hi ${req.tenantName || 'there'}! We received your maintenance request and are working on it. We'll update you when a vendor is assigned. — ${conn.business_name || 'Property Management'}`,
                'tenant_update', created.id
            );
        }
    }

    console.log(`[PollRequests] Done for ${clientSlug} — ${newCount} new requests`);
    return { clientSlug, newCount };
});

// ─── Job: Dispatch Vendor ─────────────────────────────────────────────────────

dispatchQueue.process(async (job) => {
    const { clientSlug, requestId } = job.data;
    console.log(`[DispatchVendor] Dispatching vendor for request ${requestId}`);

    const conn    = await db.getConnection(clientSlug);
    const request = await db.getRequest(requestId);
    if (!request || !conn) return;

    // Find best available vendor for this trade
    const vendor = await db.getBestVendorForTrade(clientSlug, request.category);

    if (!vendor) {
        // Alert owner — no vendor on file for this trade
        await sms.sendToOwner(conn,
            `⚠️ No ${request.category} vendor on file for maintenance request at ${request.property_address || 'property'}. Please assign a vendor manually.`,
            'new_request', requestId
        );
        return;
    }

    // Update request with vendor assignment
    await db.updateRequest(requestId, {
        vendor_id:    vendor.id,
        vendor_name:  vendor.name,
        vendor_phone: vendor.phone,
        status:       'dispatched',
        dispatched_at: new Date().toISOString(),
    });

    // SMS vendor with job details
    const timeStr = request.priority === 'emergency'
        ? 'ASAP — This is an emergency'
        : `within ${request.priority === 'urgent' ? '24' : '72'} hours`;

    await sms.sendToVendor(conn, vendor.phone,
        `📋 New job from ${conn.business_name || 'Property Mgmt'}: ${request.category.toUpperCase()} at ${request.property_address || 'property'}${request.unit_number ? ` Unit ${request.unit_number}` : ''}.\n\nIssue: ${request.description.slice(0, 120)}\n\nPlease respond ${timeStr}.\n\nTenant: ${request.tenant_name || 'N/A'} (${request.tenant_phone || 'no phone'})`,
        'dispatched', requestId
    );

    // Update tenant
    if (request.tenant_phone) {
        await sms.sendToTenant(conn, request.tenant_phone,
            `Update on your maintenance request: ${vendor.name} has been assigned and will contact you ${timeStr}. — ${conn.business_name || 'Property Management'}`,
            'tenant_update', requestId
        );
    }

    await db.incrementVendorJobs(vendor.id);
    console.log(`[DispatchVendor] Dispatched ${vendor.name} for request ${requestId}`);
});

// ─── Job: SLA Check ───────────────────────────────────────────────────────────

slaQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[SLACheck] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const breaching = await db.getSLABreachingRequests(clientSlug);

    for (const req of breaching) {
        const hoursOverdue = dayjs().diff(dayjs(req.sla_deadline), 'hour');
        await sms.sendToOwner(conn,
            `⏰ SLA BREACH: ${req.priority.toUpperCase()} maintenance at ${req.property_address || 'property'} is ${hoursOverdue}h past deadline. Status: ${req.status}. Vendor: ${req.vendor_name || 'UNASSIGNED'}.`,
            'sla_warning', req.id
        );
        await db.updateRequest(req.id, { sla_breached: true });
    }

    console.log(`[SLACheck] Done for ${clientSlug} — ${breaching.length} SLA breaches`);
    return { clientSlug, breaches: breaching.length };
});

// ─── Job: Daily Summary ───────────────────────────────────────────────────────

summaryQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[DailySummary] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const open = await db.getOpenRequests(clientSlug);
    if (!open.length) {
        console.log(`[DailySummary] No open requests for ${clientSlug}`);
        return { clientSlug, open: 0 };
    }

    const byPriority = {
        emergency: open.filter(r => r.priority === 'emergency'),
        urgent:    open.filter(r => r.priority === 'urgent'),
        routine:   open.filter(r => r.priority === 'routine'),
    };

    const lines = [];
    if (byPriority.emergency.length) lines.push(`🚨 Emergency: ${byPriority.emergency.length}`);
    if (byPriority.urgent.length)    lines.push(`⚡ Urgent: ${byPriority.urgent.length}`);
    if (byPriority.routine.length)   lines.push(`🔧 Routine: ${byPriority.routine.length}`);

    const unassigned = open.filter(r => !r.vendor_id).length;

    const msg = [
        `🏠 Maintenance Summary — ${conn.business_name || clientSlug}`,
        `${dayjs().format('dddd, MMM D')}`,
        ``,
        `OPEN REQUESTS: ${open.length}`,
        ...lines,
        unassigned ? `⚠️ Unassigned: ${unassigned}` : null,
    ].filter(Boolean).join('\n');

    await sms.sendToOwner(conn, msg, 'daily_summary');
    return { clientSlug, open: open.length };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['poll-new-requests', pollQueue],
    ['check-sla',         slaQueue],
    ['daily-summary',     summaryQueue],
    ['dispatch-vendor',   dispatchQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} failed for ${job.data.clientSlug || job.data.requestId}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} completed`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runPollRequests(clientSlug) {
    return pollQueue.add({ clientSlug }, { attempts: 3, backoff: 30000 });
}

async function runSLACheck(clientSlug) {
    return slaQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runDailySummary(clientSlug) {
    return summaryQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
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
    runPollRequests,
    runSLACheck,
    runDailySummary,
    runForAllClients,
    pollQueue,
    slaQueue,
    summaryQueue,
    dispatchQueue,
};
