/**
 * GRIDHAND Open House Brain — Bull Queue Job Definitions
 *
 * Queues (all prefixed 'oh:'):
 *   oh:send-invites          → blast invites to targeted CRM leads
 *   oh:day-before-reminder   → reminder to invited leads day before event
 *   oh:post-event-thankyou   → same-day thank you to registered visitors
 *   oh:day-after-followup    → follow-up next day to all visitors
 *   oh:week-followup         → 7-day follow-up to visitors still in pipeline
 *   oh:notify-agent-interest → immediately SMS agent when visitor shows high interest
 *   oh:weekly-report         → weekly open house performance report to agent
 *
 * Crons scheduled in index.js:
 *   10:00 AM Chicago daily — day-before reminders
 *   Every 30 min           — post-event follow-up scheduler
 *   6:00 PM Sunday         — weekly report
 */

'use strict';

require('dotenv').config();

const Bull            = require('bull');
const dayjs           = require('dayjs');
const db              = require('./db');
const followup        = require('./followup');
const twilioLib       = require('../../lib/twilio-client');
const { validateSMS } = require('../../lib/message-gate');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const sendInvitesQueue       = new Bull('oh:send-invites',          REDIS_URL);
const dayBeforeReminderQueue = new Bull('oh:day-before-reminder',   REDIS_URL);
const postEventThankyouQueue = new Bull('oh:post-event-thankyou',   REDIS_URL);
const dayAfterQueue          = new Bull('oh:day-after-followup',    REDIS_URL);
const weekFollowupQueue      = new Bull('oh:week-followup',         REDIS_URL);
const notifyAgentQueue       = new Bull('oh:notify-agent-interest', REDIS_URL);
const weeklyReportQueue      = new Bull('oh:weekly-report',         REDIS_URL);

// ─── SMS Helper — routes through lib/twilio-client.js for TCPA + opt-out compliance ──

async function sendSms(clientConfig, toNumber, body, meta = {}) {
    const fromNumber = clientConfig.twilio_from || process.env.TWILIO_FROM_NUMBER;

    if (!fromNumber) {
        console.warn('[Jobs/SMS] No from number configured — skipping send');
        return null;
    }

    try {
        const result = await twilioLib.sendSMS({
            from:           fromNumber,
            to:             toNumber,
            body,
            clientSlug:     clientConfig.client_slug || null,
            clientTimezone: clientConfig.timezone || 'America/Chicago',
        });

        const sid = result.sid || null;

        // Log to DB
        await db.logSms({
            client_id:     meta.client_id || null,
            visitor_id:    meta.visitor_id || null,
            open_house_id: meta.open_house_id || null,
            direction:     'outbound',
            to_number:     toNumber,
            from_number:   fromNumber,
            body,
            twilio_sid:    sid,
        });

        if (meta.visitor_id) {
            await db.logConversation({
                visitor_id:    meta.visitor_id,
                open_house_id: meta.open_house_id || null,
                client_id:     meta.client_id || null,
                direction:     'outbound',
                message:       body,
                twilio_sid:    sid,
            });
        }

        return sid;
    } catch (err) {
        console.error(`[Jobs/SMS] Send failed to ${toNumber.slice(-4)}: ${err.message}`);
        return null;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Job: Send Invites ────────────────────────────────────────────────────────

sendInvitesQueue.process(async (job) => {
    const { openHouseId, clientSlug } = job.data;
    console.log(`[SendInvites] Running for open house ${openHouseId}`);

    const [openHouse, clientConfig] = await Promise.all([
        db.getOpenHouse(openHouseId),
        db.getClient(clientSlug),
    ]);

    if (!openHouse) throw new Error(`Open house not found: ${openHouseId}`);
    if (!clientConfig) throw new Error(`Client not found: ${clientSlug}`);

    const targets = await followup.getInviteTargets(clientSlug, openHouse);

    if (!targets.length) {
        console.log(`[SendInvites] No targets found for ${openHouseId}`);
        return { openHouseId, sent: 0 };
    }

    let sent = 0;

    for (const lead of targets) {
        if (!lead.phone) continue;

        const rawMessage = await followup.generateInviteMessage(lead, openHouse, clientConfig);
        const inviteGate = validateSMS(rawMessage);
        if (!inviteGate.valid) {
            console.warn(`[SendInvites] SMS blocked for lead ${lead.id}: ${inviteGate.issues.join('; ')}`);
            continue;
        }
        const message = inviteGate.text;

        const sid = await sendSms(clientConfig, lead.phone, message, {
            client_id:     clientConfig.id,
            open_house_id: openHouseId,
        });

        if (sid) {
            await db.logInvite({
                open_house_id:  openHouseId,
                client_id:      clientConfig.id,
                crm_contact_id: lead.id,
                name:           lead.name,
                phone:          lead.phone,
                message,
                sent_at:        new Date().toISOString(),
            });
            sent++;
        }

        // Rate limit: 1 SMS per second
        await sleep(1000);
    }

    await db.incrementInvitesSent(openHouseId, sent);
    console.log(`[SendInvites] Done — ${sent}/${targets.length} invites sent`);
    return { openHouseId, sent, total: targets.length };
});

// ─── Job: Day-Before Reminder ─────────────────────────────────────────────────

dayBeforeReminderQueue.process(async (job) => {
    const { openHouseId, clientSlug } = job.data;
    console.log(`[DayBeforeReminder] Running for open house ${openHouseId}`);

    const [openHouse, clientConfig] = await Promise.all([
        db.getOpenHouse(openHouseId),
        db.getClient(clientSlug),
    ]);

    if (!openHouse || !clientConfig) throw new Error('Open house or client not found');

    const invites = await db.getInvites(openHouseId);
    const pending = invites.filter(i => !i.replied);

    const dateStr   = dayjs(openHouse.date).format('tomorrow, MMMM D');
    const startTime = followup.formatTime(openHouse.start_time);
    const endTime   = followup.formatTime(openHouse.end_time);

    let sent = 0;

    for (const invite of pending) {
        if (!invite.phone) continue;

        const firstName = (invite.name || '').split(' ')[0] || 'there';
        const message   = `Hi ${firstName}! Reminder: open house at ${openHouse.listing_address} is ${dateStr}, ${startTime}–${endTime}. Hope to see you! – ${clientConfig.agent_name}`.slice(0, 200);

        const sid = await sendSms(clientConfig, invite.phone, message, {
            client_id:     clientConfig.id,
            open_house_id: openHouseId,
        });

        if (sid) sent++;
        await sleep(1000);
    }

    console.log(`[DayBeforeReminder] Done — ${sent} reminders sent for ${openHouseId}`);
    return { openHouseId, sent };
});

// ─── Job: Post-Event Thank You ────────────────────────────────────────────────

postEventThankyouQueue.process(async (job) => {
    const { openHouseId, clientSlug } = job.data;
    console.log(`[PostEventThankYou] Running for open house ${openHouseId}`);

    const [openHouse, clientConfig, visitors] = await Promise.all([
        db.getOpenHouse(openHouseId),
        db.getClient(clientSlug),
        db.getVisitors(openHouseId),
    ]);

    if (!openHouse || !clientConfig) throw new Error('Open house or client not found');

    const pending = visitors.filter(v => v.followup_status === 'pending');
    let sent = 0;

    for (const visitor of pending) {
        const rawThankYou = await followup.generatePostEventThankYou(visitor, openHouse, clientConfig);
        const thankYouGate = validateSMS(rawThankYou);
        if (!thankYouGate.valid) {
            console.warn(`[PostEventThankYou] SMS blocked for visitor ${visitor.id}: ${thankYouGate.issues.join('; ')}`);
            continue;
        }
        const message = thankYouGate.text;

        const sid = await sendSms(clientConfig, visitor.phone, message, {
            client_id:     clientConfig.id,
            visitor_id:    visitor.id,
            open_house_id: openHouseId,
        });

        if (sid) {
            await db.updateVisitor(visitor.id, { followup_status: 'thankyou_sent' });

            // If they have no CRM contact yet, create one
            if (!visitor.crm_contact_id) {
                try {
                    const crmResult = await require('./crm').createContact(clientSlug, visitor);
                    if (crmResult.ok && crmResult.data?.id) {
                        await db.updateVisitor(visitor.id, { crm_contact_id: String(crmResult.data.id) });
                        await require('./crm').addNote(clientSlug, String(crmResult.data.id),
                            `Attended open house at ${openHouse.listing_address} on ${openHouse.date}. GRIDHAND follow-up started.`);
                    }
                } catch (crmErr) {
                    console.warn(`[PostEventThankYou] CRM create failed: ${crmErr.message}`);
                }
            }

            sent++;
        }
        await sleep(1000);
    }

    // Mark open house as completed if it was still scheduled
    if (openHouse.status === 'scheduled') {
        await db.updateOpenHouseStatus(openHouseId, 'completed');
    }

    console.log(`[PostEventThankYou] Done — ${sent} thank-yous sent for ${openHouseId}`);
    return { openHouseId, sent };
});

// ─── Job: Day-After Follow-Up ─────────────────────────────────────────────────

dayAfterQueue.process(async (job) => {
    const { openHouseId, clientSlug } = job.data;
    console.log(`[DayAfterFollowup] Running for open house ${openHouseId}`);

    const [openHouse, clientConfig, visitors] = await Promise.all([
        db.getOpenHouse(openHouseId),
        db.getClient(clientSlug),
        db.getVisitors(openHouseId),
    ]);

    if (!openHouse || !clientConfig) throw new Error('Open house or client not found');

    const eligible = visitors.filter(v => v.followup_status === 'thankyou_sent');
    let sent = 0;

    for (const visitor of eligible) {
        const rawDayAfter = await followup.generateDayAfterFollowup(visitor, openHouse, clientConfig);
        const dayAfterGate = validateSMS(rawDayAfter);
        if (!dayAfterGate.valid) {
            console.warn(`[DayAfterFollowup] SMS blocked for visitor ${visitor.id}: ${dayAfterGate.issues.join('; ')}`);
            continue;
        }
        const message = dayAfterGate.text;

        const sid = await sendSms(clientConfig, visitor.phone, message, {
            client_id:     clientConfig.id,
            visitor_id:    visitor.id,
            open_house_id: openHouseId,
        });

        if (sid) {
            await db.updateVisitor(visitor.id, { followup_status: 'day_after_sent' });
            sent++;
        }
        await sleep(1000);
    }

    console.log(`[DayAfterFollowup] Done — ${sent} follow-ups sent for ${openHouseId}`);
    return { openHouseId, sent };
});

// ─── Job: Week Follow-Up ──────────────────────────────────────────────────────

weekFollowupQueue.process(async (job) => {
    const { openHouseId, clientSlug } = job.data;
    console.log(`[WeekFollowup] Running for open house ${openHouseId}`);

    const [openHouse, clientConfig, visitors] = await Promise.all([
        db.getOpenHouse(openHouseId),
        db.getClient(clientSlug),
        db.getVisitors(openHouseId),
    ]);

    if (!openHouse || !clientConfig) throw new Error('Open house or client not found');

    const eligible = visitors.filter(v =>
        v.followup_status === 'day_after_sent' &&
        !['converted', 'opted_out', 'not_interested'].includes(v.interest_level)
    );

    let sent = 0;

    for (const visitor of eligible) {
        const rawWeek = await followup.generateWeekFollowup(visitor, openHouse, clientConfig);
        const weekGate = validateSMS(rawWeek);
        if (!weekGate.valid) {
            console.warn(`[WeekFollowup] SMS blocked for visitor ${visitor.id}: ${weekGate.issues.join('; ')}`);
            continue;
        }
        const message = weekGate.text;

        const sid = await sendSms(clientConfig, visitor.phone, message, {
            client_id:     clientConfig.id,
            visitor_id:    visitor.id,
            open_house_id: openHouseId,
        });

        if (sid) {
            await db.updateVisitor(visitor.id, { followup_status: 'week_sent' });
            sent++;
        }
        await sleep(1000);
    }

    console.log(`[WeekFollowup] Done — ${sent} week follow-ups sent for ${openHouseId}`);
    return { openHouseId, sent };
});

// ─── Job: Notify Agent of High Interest ───────────────────────────────────────

notifyAgentQueue.process(async (job) => {
    const { visitorId, openHouseId, clientSlug, intent } = job.data;
    console.log(`[NotifyAgent] High interest visitor ${visitorId}`);

    const [visitor, openHouse, clientConfig] = await Promise.all([
        db.getVisitor(visitorId),
        db.getOpenHouse(openHouseId),
        db.getClient(clientSlug),
    ]);

    if (!visitor || !openHouse || !clientConfig) throw new Error('Missing data for agent notification');

    const message = [
        `🔥 HOT LEAD — ${openHouse.listing_address}`,
        `Visitor: ${visitor.name}`,
        `Phone: ${visitor.phone}`,
        `Intent: ${intent || 'Interested'}`,
        visitor.ai_notes ? `Notes: ${visitor.ai_notes}` : null,
    ]
        .filter(Boolean)
        .join('\n');

    const sid = await sendSms(
        clientConfig,
        clientConfig.agent_phone,
        message.slice(0, 320),
        { client_id: clientConfig.id, open_house_id: openHouseId }
    );

    console.log(`[NotifyAgent] Agent notified — SID: ${sid}`);
    return { visitorId, agentPhone: clientConfig.agent_phone, sid };
});

// ─── Job: Weekly Report ───────────────────────────────────────────────────────

weeklyReportQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[WeeklyReport] Running for ${clientSlug}`);

    const clientConfig = await db.getClient(clientSlug);
    if (!clientConfig) throw new Error(`Client not found: ${clientSlug}`);

    const allOpenHouses = await db.getOpenHousesByClient(clientSlug);

    // Only include this week's open houses
    const weekAgo    = dayjs().subtract(7, 'day').toDate();
    const thisWeek   = allOpenHouses.filter(oh => new Date(oh.date) >= weekAgo);

    // Gather all visitors for those open houses
    const visitorSets = await Promise.all(thisWeek.map(oh => db.getVisitors(oh.id)));
    const allVisitors = visitorSets.flat();

    const { chunks } = await followup.generateWeeklyReport(thisWeek, allVisitors, clientConfig);

    let sent = 0;
    for (const chunk of chunks) {
        const sid = await sendSms(
            clientConfig,
            clientConfig.agent_phone,
            chunk,
            { client_id: clientConfig.id }
        );
        if (sid) sent++;
        await sleep(1500);
    }

    console.log(`[WeeklyReport] Done for ${clientSlug} — ${sent} SMS chunks sent`);
    return { clientSlug, openHouses: thisWeek.length, visitors: allVisitors.length, smsSent: sent };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

const allQueues = [
    ['oh:send-invites',          sendInvitesQueue],
    ['oh:day-before-reminder',   dayBeforeReminderQueue],
    ['oh:post-event-thankyou',   postEventThankyouQueue],
    ['oh:day-after-followup',    dayAfterQueue],
    ['oh:week-followup',         weekFollowupQueue],
    ['oh:notify-agent-interest', notifyAgentQueue],
    ['oh:weekly-report',         weeklyReportQueue],
];

for (const [name, queue] of allQueues) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} failed — ${JSON.stringify(job.data)}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} completed — job ${job.id}`);
    });
}

// ─── Dispatcher Functions ─────────────────────────────────────────────────────

async function dispatchSendInvites(openHouseId, clientSlug) {
    return sendInvitesQueue.add({ openHouseId, clientSlug }, { attempts: 2, backoff: 30000 });
}

async function dispatchDayBeforeReminder(openHouseId, clientSlug) {
    return dayBeforeReminderQueue.add({ openHouseId, clientSlug }, { attempts: 2, backoff: 30000 });
}

async function dispatchPostEventThankyou(openHouseId, clientSlug) {
    return postEventThankyouQueue.add({ openHouseId, clientSlug }, { attempts: 3, backoff: 20000 });
}

async function dispatchDayAfterFollowup(openHouseId, clientSlug) {
    return dayAfterQueue.add({ openHouseId, clientSlug }, { attempts: 2, backoff: 30000 });
}

async function dispatchWeekFollowup(openHouseId, clientSlug) {
    return weekFollowupQueue.add({ openHouseId, clientSlug }, { attempts: 2, backoff: 30000 });
}

async function dispatchNotifyAgent(visitorId, openHouseId, clientSlug, intent) {
    return notifyAgentQueue.add({ visitorId, openHouseId, clientSlug, intent }, { attempts: 3, backoff: 10000 });
}

async function dispatchWeeklyReport(clientSlug) {
    return weeklyReportQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

// ─── runForAllClients Utility ─────────────────────────────────────────────────

async function runForAllClients(jobFn) {
    const clients = await db.getClients();
    const results = [];

    for (const client of clients) {
        try {
            const job = await jobFn(client.client_slug);
            results.push({ clientSlug: client.client_slug, jobId: job?.id });
        } catch (err) {
            console.error(`[Jobs] Failed to queue job for ${client.client_slug}: ${err.message}`);
            results.push({ clientSlug: client.client_slug, error: err.message });
        }
    }

    return results;
}

module.exports = {
    // Dispatchers
    dispatchSendInvites,
    dispatchDayBeforeReminder,
    dispatchPostEventThankyou,
    dispatchDayAfterFollowup,
    dispatchWeekFollowup,
    dispatchNotifyAgent,
    dispatchWeeklyReport,
    // Utility
    runForAllClients,
    // Queue refs (for health check)
    sendInvitesQueue,
    dayBeforeReminderQueue,
    postEventThankyouQueue,
    dayAfterQueue,
    weekFollowupQueue,
    notifyAgentQueue,
    weeklyReportQueue,
};
