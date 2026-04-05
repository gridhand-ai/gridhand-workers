/**
 * GRIDHAND Lease Renewal Agent — Bull Queue Job Definitions
 *
 * Jobs:
 *  - scan-expiring-leases  → daily: find leases expiring in 60 days, create renewal records
 *  - send-renewal-offers   → daily: send email + SMS offers to tenants who haven't been contacted
 *  - check-envelope-status → daily: poll DocuSign for signed envelopes
 *  - weekly-pipeline       → Monday 8am: owner gets renewal pipeline report
 */

'use strict';

const Bull     = require('bull');
const dayjs    = require('dayjs');
const pms      = require('./pms');
const docusign = require('./docusign');
const email    = require('./email');
const sms      = require('./sms');
const db       = require('./db');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const scanQueue     = new Bull('lease-renewal-agent:scan-expiring-leases',  REDIS_URL);
const offerQueue    = new Bull('lease-renewal-agent:send-renewal-offers',   REDIS_URL);
const envelopeQueue = new Bull('lease-renewal-agent:check-envelope-status', REDIS_URL);
const pipelineQueue = new Bull('lease-renewal-agent:weekly-pipeline',       REDIS_URL);

// ─── Job: Scan Expiring Leases ────────────────────────────────────────────────

scanQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[ScanLeases] Running for ${clientSlug}`);

    const conn   = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const noticeDays = conn.renewal_notice_days || 60;
    const leases     = await pms.getExpiringLeases(clientSlug, conn, noticeDays);

    let newRenewals = 0;
    for (const lease of leases) {
        const existing = await db.getRenewal(clientSlug, lease.pmsLeaseId);
        if (existing) continue; // already tracking

        // Calculate offered rent (current rent + configured increase %)
        const increaseRate = parseFloat(conn.rent_increase_pct || 0.03);
        const offeredRent  = Math.ceil(lease.currentRent * (1 + increaseRate) / 5) * 5; // round to nearest $5

        // Calculate new lease dates
        const termMonths   = 12;
        const newStart     = dayjs(lease.leaseEndDate).add(1, 'day').format('YYYY-MM-DD');
        const newEnd       = dayjs(newStart).add(termMonths, 'month').subtract(1, 'day').format('YYYY-MM-DD');

        await db.upsertRenewal(clientSlug, {
            ...lease,
            offeredRent,
            offeredTermMonths: termMonths,
            newLeaseStart: newStart,
            newLeaseEnd:   newEnd,
            status:        'pending',
        });

        newRenewals++;
        console.log(`[ScanLeases] New renewal record for ${lease.tenantName} — expires ${lease.leaseEndDate}`);
    }

    console.log(`[ScanLeases] Done for ${clientSlug} — ${newRenewals} new, ${leases.length} total expiring`);
    return { clientSlug, newRenewals, expiringTotal: leases.length };
});

// ─── Job: Send Renewal Offers ─────────────────────────────────────────────────

offerQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[SendOffers] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    // Get renewals not yet offered
    const pending  = await db.getPipelineByStatus(clientSlug, 'pending');
    let offersSent = 0;

    for (const renewal of pending) {
        const daysUntil = dayjs(renewal.lease_end_date).diff(dayjs(), 'day');

        // Only start outreach if within notice window
        const noticeDays = conn.renewal_notice_days || 60;
        if (daysUntil > noticeDays) continue;

        try {
            // Send email if tenant has email
            if (renewal.tenant_email) {
                const result = await email.sendRenewalOffer(conn, renewal);
                await db.logCommunication(clientSlug, renewal.id, {
                    channel:     'email',
                    direction:   'outbound',
                    recipient:   renewal.tenant_email,
                    subject:     result.subject,
                    messageBody: `Lease renewal offer sent — ${renewal.property_address}`,
                });
            }

            // Send SMS if tenant has phone
            if (renewal.tenant_phone) {
                const fmt = n => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
                await sms.sendToTenant(conn, renewal.id, renewal.tenant_phone,
                    `Hi ${renewal.tenant_name}! Your lease at ${renewal.property_address || 'your unit'} expires ${renewal.lease_end_date}. We'd love to have you stay — renewal offer: ${fmt(renewal.offered_rent)}/mo. Check your email for details or reply to discuss. — ${conn.business_name || 'Property Mgmt'}`
                );
            }

            await db.updateRenewal(renewal.id, {
                status:        'offer_sent',
                offer_sent_at: new Date().toISOString(),
                offer_method:  renewal.tenant_email && renewal.tenant_phone ? 'both' : (renewal.tenant_email ? 'email' : 'sms'),
            });

            offersSent++;
        } catch (err) {
            console.error(`[SendOffers] Failed for ${renewal.tenant_name}: ${err.message}`);
        }
    }

    console.log(`[SendOffers] Done for ${clientSlug} — ${offersSent} offers sent`);
    return { clientSlug, offersSent };
});

// ─── Job: Check Envelope Status ───────────────────────────────────────────────

envelopeQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[EnvelopeStatus] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn?.docusign_access_token) return { clientSlug, checked: 0 };

    // Get renewals with pending DocuSign envelopes
    const sent = await db.getPipelineByStatus(clientSlug, 'offer_sent');
    const withEnvelopes = sent.filter(r => r.docusign_envelope_id);
    let signed = 0;

    for (const renewal of withEnvelopes) {
        try {
            const { status, completedAt } = await docusign.getEnvelopeStatus(clientSlug, renewal.docusign_envelope_id);

            if (status === 'completed' && !renewal.docusign_signed_at) {
                await db.updateRenewal(renewal.id, {
                    status:              'signed',
                    docusign_signed_at:  completedAt || new Date().toISOString(),
                });

                // Notify owner
                const fmt = n => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
                await sms.sendToOwner(conn, renewal.id,
                    `🎉 Lease signed! ${renewal.tenant_name} at ${renewal.property_address || 'property'} has signed their renewal for ${fmt(renewal.offered_rent)}/mo.`
                );

                signed++;
            } else if (status === 'declined') {
                await db.updateRenewal(renewal.id, { status: 'declined' });
                await sms.sendToOwner(conn, renewal.id,
                    `❌ Lease declined: ${renewal.tenant_name} at ${renewal.property_address || 'property'} declined the renewal offer.`
                );
            }
        } catch (err) {
            console.warn(`[EnvelopeStatus] Check failed for ${renewal.docusign_envelope_id}: ${err.message}`);
        }
    }

    console.log(`[EnvelopeStatus] Done for ${clientSlug} — ${signed} new signatures`);
    return { clientSlug, checked: withEnvelopes.length, signed };
});

// ─── Job: Weekly Pipeline Report ─────────────────────────────────────────────

pipelineQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[WeeklyPipeline] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const all = await db.getPipelineByStatus(clientSlug);
    if (!all.length) return { clientSlug, total: 0 };

    const expiring   = all.filter(r => r.days_until_expiry <= 60 && r.days_until_expiry >= 0);
    const offersSent = all.filter(r => r.status === 'offer_sent' || r.status === 'negotiating');
    const signed     = all.filter(r => r.status === 'signed');
    const declined   = all.filter(r => r.status === 'declined');

    // SMS summary to owner
    const msg = [
        `📋 Lease Renewal Pipeline — ${conn.business_name || clientSlug}`,
        `Week of ${dayjs().format('MMM D, YYYY')}`,
        ``,
        `Expiring in 60 days: ${expiring.length}`,
        `Offers sent:         ${offersSent.length}`,
        `Signed this cycle:   ${signed.length}`,
        declined.length ? `Declined:            ${declined.length}` : null,
    ].filter(Boolean).join('\n');

    await sms.sendToOwner(conn, null, msg);

    // Also send email summary if owner has email
    await email.sendOwnerRenewalSummary(conn, {
        expiringCount: expiring.length,
        offersSent:    offersSent.length,
        signed:        signed.length,
        pending:       offersSent.length,
    });

    console.log(`[WeeklyPipeline] Done for ${clientSlug}`);
    return { clientSlug, expiring: expiring.length };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['scan-expiring-leases',  scanQueue],
    ['send-renewal-offers',   offerQueue],
    ['check-envelope-status', envelopeQueue],
    ['weekly-pipeline',       pipelineQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runScanLeases(clientSlug) {
    return scanQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runSendOffers(clientSlug) {
    return offerQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runCheckEnvelopes(clientSlug) {
    return envelopeQueue.add({ clientSlug }, { attempts: 3, backoff: 30000 });
}

async function runWeeklyPipeline(clientSlug) {
    return pipelineQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
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
    runScanLeases,
    runSendOffers,
    runCheckEnvelopes,
    runWeeklyPipeline,
    runForAllClients,
    scanQueue,
    offerQueue,
    envelopeQueue,
    pipelineQueue,
};
