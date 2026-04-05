/**
 * GRIDHAND Chair Filler — Bull Queue Job Definitions
 *
 * Jobs:
 *  - check-openings  → 8am & 4pm daily: scan for open slots, queue Instagram post + text matches
 *  - post-instagram  → post available slots to Instagram Stories/Feed
 *  - text-matches    → text clients whose usual service matches the open slot
 *
 * All jobs are registered here. index.js schedules them via node-cron.
 */

'use strict';

const Bull      = require('bull');
const dayjs     = require('dayjs');
const booking   = require('./booking');
const db        = require('./db');
const instagram = require('./instagram');
const sms       = require('./sms');

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const checkOpeningsQueue = new Bull('chair-filler:check-openings', REDIS_URL);
const postInstagramQueue = new Bull('chair-filler:post-instagram', REDIS_URL);
const textMatchesQueue   = new Bull('chair-filler:text-matches',   REDIS_URL);

// ─── Job: Check Openings ──────────────────────────────────────────────────────

checkOpeningsQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[CheckOpenings] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    // Get unbooked slots for today and tomorrow from booking system
    const openSlots = await booking.getOpenSlots(conn);

    if (!openSlots || openSlots.length === 0) {
        console.log(`[CheckOpenings] No open slots found for ${clientSlug}`);
        return { clientSlug, slotsFound: 0 };
    }

    console.log(`[CheckOpenings] Found ${openSlots.length} open slot(s) for ${clientSlug}`);

    // Upsert each slot to DB
    for (const slot of openSlots) {
        await db.upsertSlot(clientSlug, {
            slotId:      slot.id,
            serviceType: slot.serviceType,
            stylistName: slot.stylistName,
            startTime:   slot.startTime,
            endTime:     slot.endTime,
            date:        slot.date,
        });
    }

    // Queue Instagram post if connection has Instagram token
    if (conn.instagram_access_token) {
        const igJob = await postInstagramQueue.add(
            { clientSlug },
            { attempts: 2, backoff: 30000 }
        );
        console.log(`[CheckOpenings] Queued Instagram post job ${igJob.id} for ${clientSlug}`);
    }

    // Queue text-matches to notify relevant clients
    const textJob = await textMatchesQueue.add(
        { clientSlug },
        { attempts: 2, backoff: 30000 }
    );
    console.log(`[CheckOpenings] Queued text-matches job ${textJob.id} for ${clientSlug}`);

    return { clientSlug, slotsFound: openSlots.length };
});

// ─── Job: Post to Instagram ───────────────────────────────────────────────────

postInstagramQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[PostInstagram] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    if (!conn.instagram_access_token || !conn.instagram_account_id) {
        console.log(`[PostInstagram] No Instagram token for ${clientSlug} — skipping`);
        return { clientSlug, posted: 0 };
    }

    // Check if token is close to expiry (within 7 days) and refresh
    if (conn.instagram_token_expires_at) {
        const daysUntilExpiry = dayjs(conn.instagram_token_expires_at).diff(dayjs(), 'day');
        if (daysUntilExpiry < 7) {
            try {
                const refreshed = await instagram.refreshLongLivedToken(conn.instagram_access_token);
                const newExpiry = new Date(Date.now() + (refreshed.expires_in || 5184000) * 1000).toISOString();
                await db.updateInstagramToken(clientSlug, {
                    accessToken:              refreshed.access_token,
                    instagramAccountId:       conn.instagram_account_id,
                    instagramTokenExpiresAt:  newExpiry,
                });
                conn.instagram_access_token = refreshed.access_token;
                console.log(`[PostInstagram] Refreshed Instagram token for ${clientSlug}`);
            } catch (refreshErr) {
                console.error(`[PostInstagram] Token refresh failed for ${clientSlug}: ${refreshErr.message}`);
            }
        }
    }

    // Get open slots added in this run
    const slots = await db.getOpenSlots(clientSlug);

    if (slots.length === 0) {
        console.log(`[PostInstagram] No open slots in DB for ${clientSlug}`);
        return { clientSlug, posted: 0 };
    }

    let posted = 0;

    for (const slot of slots) {
        // Skip if already posted to Instagram
        if (slot.post_id) continue;

        const timeStr  = dayjs(slot.start_time).format('h:mma');
        const dateStr  = dayjs(slot.date).isSame(dayjs(), 'day') ? 'today' : 'tomorrow';
        const service  = slot.service_type || 'appointment';
        const stylist  = slot.stylist_name ? ` with ${slot.stylist_name}` : '';
        const bookUrl  = conn.booking_url || '';

        const caption = [
            `📅 Last minute availability!`,
            ``,
            `${service} open ${dateStr} at ${timeStr}${stylist} 💇`,
            ``,
            `Book now: ${bookUrl}`,
            ``,
            `#salon #lastminute #bookingopen #${(conn.salon_name || 'salon').toLowerCase().replace(/\s+/g, '')} #hairappointment #openslot`,
        ].join('\n');

        try {
            const imageUrl = conn.default_post_image || null;
            const postId = await instagram.createPost(conn, { caption, imageUrl });

            // Update slot with post ID
            await db.__supabase()
                .from('open_slots')
                .update({ post_id: postId, updated_at: new Date().toISOString() })
                .eq('client_slug', clientSlug)
                .eq('slot_id', slot.slot_id);

            await db.logAlert(clientSlug, {
                alertType:   'instagram_post',
                recipient:   `instagram:${conn.instagram_account_id}`,
                messageBody: caption,
                slotId:      slot.id,
            });

            posted++;
            console.log(`[PostInstagram] Posted slot ${slot.slot_id} for ${clientSlug} — post ID: ${postId}`);
        } catch (err) {
            console.error(`[PostInstagram] Failed to post slot ${slot.slot_id}: ${err.message}`);
        }
    }

    console.log(`[PostInstagram] Done for ${clientSlug} — ${posted} posts created`);
    return { clientSlug, posted };
});

// ─── Job: Text Matches ────────────────────────────────────────────────────────

textMatchesQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[TextMatches] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const slots = await db.getOpenSlots(clientSlug);

    if (slots.length === 0) {
        console.log(`[TextMatches] No open slots for ${clientSlug}`);
        return { clientSlug, textsSent: 0 };
    }

    let totalTextsSent = 0;

    for (const slot of slots) {
        // Get clients who usually book this service type, haven't been texted recently,
        // and have opted into last-minute texts
        const matchedClients = await booking.getClientsByService(conn, slot.service_type);

        // Filter: must have phone, not texted in last 7 days
        const eligible = matchedClients.filter(c => {
            if (!c.phone)     return false;
            if (c.opted_out)  return false;
            if (c.last_reminder_sent) {
                const daysSince = dayjs().diff(dayjs(c.last_reminder_sent), 'day');
                if (daysSince < 7) return false;
            }
            return true;
        });

        // Cap at 20 texts per slot to avoid spam
        const toText    = eligible.slice(0, 20);
        let slotTexts   = 0;

        const timeStr = dayjs(slot.start_time).format('h:mma');
        const dateStr = dayjs(slot.date).isSame(dayjs(), 'day') ? 'today' : 'tomorrow';

        for (const client of toText) {
            try {
                await sms.sendLastMinuteText(conn, {
                    clientPhone: client.phone,
                    clientName:  client.name,
                    serviceType: slot.service_type,
                    slotTime:    timeStr,
                    slotDate:    dateStr,
                    salonName:   conn.salon_name,
                    bookingUrl:  conn.booking_url,
                });

                await db.logAlert(clientSlug, {
                    alertType:   'last_minute_text',
                    recipient:   client.phone,
                    messageBody: `Last-minute text sent for ${slot.service_type} slot ${dateStr} at ${timeStr}`,
                    slotId:      slot.id,
                });

                slotTexts++;
                totalTextsSent++;
            } catch (err) {
                console.error(`[TextMatches] Failed to SMS ${client.name}: ${err.message}`);
            }
        }

        // Update texts_sent count on the slot
        if (slotTexts > 0) {
            await db.__supabase()
                .from('open_slots')
                .update({
                    texts_sent: (slot.texts_sent || 0) + slotTexts,
                    updated_at: new Date().toISOString(),
                })
                .eq('client_slug', clientSlug)
                .eq('id', slot.id);
        }

        console.log(`[TextMatches] Slot ${slot.slot_id} (${slot.service_type} ${dateStr} ${timeStr}): ${slotTexts} texts sent to ${eligible.length} eligible clients`);
    }

    console.log(`[TextMatches] Done for ${clientSlug} — ${totalTextsSent} texts sent`);
    return { clientSlug, textsSent: totalTextsSent, slotsProcessed: slots.length };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['check-openings', checkOpeningsQueue],
    ['post-instagram', postInstagramQueue],
    ['text-matches',   textMatchesQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} job failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} job completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runCheckOpenings(clientSlug) {
    return checkOpeningsQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runPostInstagram(clientSlug) {
    return postInstagramQueue.add({ clientSlug }, { attempts: 2, backoff: 30000 });
}

async function runTextMatches(clientSlug) {
    return textMatchesQueue.add({ clientSlug }, { attempts: 2, backoff: 30000 });
}

/**
 * Run a job for all connected clients.
 * Called by cron triggers in index.js.
 */
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
    runCheckOpenings,
    runPostInstagram,
    runTextMatches,
    runForAllClients,
    checkOpeningsQueue,
    postInstagramQueue,
    textMatchesQueue,
};
