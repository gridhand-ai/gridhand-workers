/**
 * GRIDHAND Churn Blocker — Bull Queue Job Definitions
 *
 * Queues:
 *   cb:member-sync    → sync all Mindbody members → cb_members table
 *   cb:churn-detect   → find inactive members, queue reengagement jobs
 *   cb:reengagement   → send individual SMS to one member
 *
 * Job dispatchers exported:
 *   scheduleMemberSync(clientSlug)
 *   scheduleChurnDetect(clientSlug)
 *   scheduleReengagement(clientSlug, memberId, daysSinceVisit)
 *   runForAllClients(jobFn)
 */

'use strict';

const Bull     = require('bull');
const mindbody = require('./mindbody');
const db       = require('./db');
const sms      = require('./sms');

// ─── Queue Config ─────────────────────────────────────────────────────────────

function buildRedisOpts() {
    const host     = process.env.REDIS_HOST     || '127.0.0.1';
    const port     = parseInt(process.env.REDIS_PORT || '6379', 10);
    const password = process.env.REDIS_PASSWORD || undefined;
    const tls      = process.env.REDIS_TLS === 'true' ? {} : undefined;

    return { host, port, password, tls };
}

const QUEUE_OPTS = {
    redis: buildRedisOpts(),
    defaultJobOptions: {
        attempts:      3,
        backoff:       { type: 'exponential', delay: 5000 },
        removeOnComplete: 50,
        removeOnFail:     100,
    },
};

const memberSync  = new Bull('cb:member-sync',   QUEUE_OPTS);
const churnDetect = new Bull('cb:churn-detect',  QUEUE_OPTS);
const reengagement = new Bull('cb:reengagement', QUEUE_OPTS);

// ─── Job: Member Sync ─────────────────────────────────────────────────────────
// Fetches all active Mindbody clients and upserts them into cb_members.

memberSync.process('sync', 3, async (job) => {
    const { clientSlug } = job.data;
    console.log(`[MemberSync] Starting for ${clientSlug}`);

    const conn = await db.getClient(clientSlug);
    if (!conn) throw new Error(`No client config found for slug: ${clientSlug}`);

    const inactiveThreshold = conn.inactivity_threshold_days || 7;

    // Use Mindbody helper to pull all active members + last visit dates
    const inactiveList = await mindbody.getInactiveMembers(
        conn.mindbody_site_id,
        conn.mindbody_api_key,
        inactiveThreshold
    );

    // Also pull all active clients to upsert their base records
    let offset = 0;
    const pageSize = 200;
    let totalUpserted = 0;

    while (true) {
        const result = await mindbody.getClients(
            conn.mindbody_site_id,
            conn.mindbody_api_key,
            { Offset: offset, Limit: pageSize, ActiveOnly: true }
        );

        if (!result.ok) {
            console.error(`[MemberSync] Mindbody client fetch failed at offset ${offset}: ${result.error}`);
            break;
        }

        const clients = result.data.Clients || [];
        const total   = result.data.PaginationResponse?.TotalResults || 0;

        for (const c of clients) {
            const phone = c.MobilePhone || c.HomePhone || c.WorkPhone;
            await db.upsertMember(conn.id, {
                clientId:    String(c.UniqueId || c.Id),
                firstName:   c.FirstName || '',
                lastName:    c.LastName  || '',
                email:       c.Email     || null,
                phone:       phone ? mindbody.sanitizePhone(phone) : null,
                isActive:    true,
            });
            totalUpserted++;
        }

        // Update last_visit_date for members we identified as inactive
        // (their visit data was already fetched by getInactiveMembers)
        for (const inactive of inactiveList) {
            await db.upsertMember(conn.id, {
                clientId:       inactive.clientId,
                firstName:      inactive.firstName,
                lastName:       inactive.lastName,
                email:          inactive.email,
                phone:          inactive.phone,
                lastVisitDate:  inactive.lastVisitDate,
                isActive:       true,
            });
        }

        offset += pageSize;
        if (offset >= total || clients.length === 0) break;
    }

    console.log(`[MemberSync] Done for ${clientSlug} — ${totalUpserted} members upserted`);
    return { clientSlug, totalUpserted };
});

// ─── Job: Churn Detection ─────────────────────────────────────────────────────
// Queries cb_members for inactives, filters recently-alerted, queues SMS jobs.

churnDetect.process('detect', 5, async (job) => {
    const { clientSlug } = job.data;
    console.log(`[ChurnDetect] Running for ${clientSlug}`);

    const conn = await db.getClient(clientSlug);
    if (!conn) throw new Error(`No client config found for slug: ${clientSlug}`);

    const thresholdDays = conn.inactivity_threshold_days || 7;

    // Fetch inactive members from local DB (fast — no Mindbody API call needed here)
    const inactiveMembers = await db.getInactiveMembers(conn.id, thresholdDays);

    if (inactiveMembers.length === 0) {
        console.log(`[ChurnDetect] No inactive members for ${clientSlug}`);
        return { clientSlug, queued: 0, skipped: 0 };
    }

    // Filter members who were already messaged in the last 48 hours
    const recentlyAlerted = await db.getMembersAlertedRecently(conn.id, 48);

    const toMessage = inactiveMembers.filter(m => !recentlyAlerted.has(m.id));
    const skipped   = inactiveMembers.length - toMessage.length;

    console.log(`[ChurnDetect] ${clientSlug} — ${toMessage.length} to message, ${skipped} skipped (recently alerted)`);

    // Queue individual reengagement jobs
    let queued = 0;
    for (const member of toMessage) {
        await reengagement.add('send', {
            clientSlug,
            memberId:       member.id,
            daysSinceVisit: member.days_since_visit,
        }, {
            // Slight delay between jobs to space out SMS sends
            delay: queued * 500,
        });
        queued++;
    }

    return { clientSlug, queued, skipped, total: inactiveMembers.length };
});

// ─── Job: Reengagement SMS ────────────────────────────────────────────────────
// Sends a single SMS to one inactive member.

reengagement.process('send', 10, async (job) => {
    const { clientSlug, memberId, daysSinceVisit } = job.data;

    const conn = await db.getClient(clientSlug);
    if (!conn) throw new Error(`No client config found for slug: ${clientSlug}`);

    // Fetch the member row
    const { data: member, error } = await (async () => {
        const { createClient } = require('@supabase/supabase-js');
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        return sb.from('cb_members').select('*').eq('id', memberId).single();
    })();

    if (error || !member) {
        throw new Error(`Member ${memberId} not found`);
    }

    const result = await sms.sendReengagement(conn, member, daysSinceVisit);

    if (!result.ok) {
        throw new Error(`SMS failed for member ${memberId}: ${result.error}`);
    }

    console.log(`[Reengagement] Sent to ${member.first_name} ${member.last_name} (${member.phone})`);
    return {
        clientSlug,
        memberId,
        twilioSid: result.twilioSid,
        daysSinceVisit,
    };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['member-sync',  memberSync],
    ['churn-detect', churnDetect],
    ['reengagement', reengagement],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} job failed (id=${job.id}, slug=${job.data.clientSlug}): ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} job completed (id=${job.id}, slug=${job.data.clientSlug})`);
    });
    queue.on('error', (err) => {
        console.error(`[Jobs] Queue ${name} error: ${err.message}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function scheduleMemberSync(clientSlug) {
    return memberSync.add('sync', { clientSlug }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
    });
}

async function scheduleChurnDetect(clientSlug) {
    return churnDetect.add('detect', { clientSlug }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
    });
}

async function scheduleReengagement(clientSlug, memberId, daysSinceVisit) {
    return reengagement.add('send', { clientSlug, memberId, daysSinceVisit }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
    });
}

/**
 * Run a job function for every active client.
 * jobFn must accept (clientSlug) and return a Bull Job promise.
 */
async function runForAllClients(jobFn) {
    const clients = await db.getAllClients();
    const results = [];

    for (const client of clients) {
        try {
            const job = await jobFn(client.client_slug);
            results.push({ clientSlug: client.client_slug, jobId: job.id });
        } catch (err) {
            console.error(`[Jobs] Failed to queue job for ${client.client_slug}: ${err.message}`);
            results.push({ clientSlug: client.client_slug, error: err.message });
        }
    }

    return results;
}

// ─── Queue Stats Helper ───────────────────────────────────────────────────────

async function getQueueStats() {
    const [syncCounts, detectCounts, reengageCounts] = await Promise.all([
        memberSync.getJobCounts(),
        churnDetect.getJobCounts(),
        reengagement.getJobCounts(),
    ]);

    return {
        memberSync:   syncCounts,
        churnDetect:  detectCounts,
        reengagement: reengageCounts,
    };
}

module.exports = {
    memberSync,
    churnDetect,
    reengagement,
    scheduleMemberSync,
    scheduleChurnDetect,
    scheduleReengagement,
    runForAllClients,
    getQueueStats,
};
