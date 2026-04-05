/**
 * GRIDHAND Open House Brain — Main Express Server
 *
 * Standalone microservice for real estate open house automation.
 * Runs on PORT 3007.
 *
 * Routes:
 *   GET  /                                       → health check
 *   POST /webhooks/twilio                        → inbound SMS from visitors
 *   POST /open-houses                            → create new open house event
 *   POST /visitors/register                      → register visitor at open house
 *   POST /trigger/send-invites                   → blast invites to area CRM leads
 *   POST /trigger/followup-campaign              → start post-event follow-up sequence
 *   POST /trigger/weekly-report                  → open house performance summary
 *   GET  /open-houses/:clientSlug                → list open houses (upcoming + past)
 *   GET  /open-houses/:clientSlug/:openHouseId   → open house detail with visitor list
 *   GET  /visitors/:clientSlug/:openHouseId      → visitor list with follow-up status
 *   GET  /stats/:clientSlug                      → aggregate stats
 *
 * Environment:
 *   PORT, SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   ANTHROPIC_API_KEY
 *   REDIS_URL
 *   GRIDHAND_API_KEY
 */

'use strict';

require('dotenv').config();

const express  = require('express');
const cron     = require('node-cron');
const twilio   = require('twilio');
const calendar = require('./calendar');
const db       = require('./db');
const jobs     = require('./jobs');
const followup = require('./followup');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // for Twilio webhook form-encoded body

// ─── Auth Middleware ───────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
    const serverKey = process.env.GRIDHAND_API_KEY;
    if (!serverKey) return res.status(503).json({ error: 'GRIDHAND_API_KEY not configured' });
    const provided = (req.headers['authorization'] || '').replace('Bearer ', '');
    if (provided !== serverKey) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.json({
        worker:  'Open House Brain',
        version: '1.0.0',
        status:  'online',
        jobs: [
            'oh:send-invites',
            'oh:day-before-reminder',
            'oh:post-event-thankyou',
            'oh:day-after-followup',
            'oh:week-followup',
            'oh:notify-agent-interest',
            'oh:weekly-report',
        ],
        integrations: ['Google Calendar', 'CRM', 'Twilio'],
    });
});

// ─── Twilio Inbound SMS Webhook ───────────────────────────────────────────────

// POST /webhooks/twilio — visitors replying to follow-up messages
app.post('/webhooks/twilio', async (req, res) => {
    // Fast TwiML ACK first — Twilio requires a response within 15 seconds
    const twiml = new twilio.twiml.MessagingResponse();

    const { Body: replyText, From: fromPhone } = req.body;

    if (!fromPhone || !replyText) {
        res.type('text/xml').send(twiml.toString());
        return;
    }

    // Respond immediately so Twilio doesn't timeout
    res.type('text/xml').send(twiml.toString());

    // Process asynchronously
    setImmediate(async () => {
        try {
            // Find the visitor by phone — check all clients since Twilio number may be shared
            // In practice, each client has their own Twilio number stored in oh_clients.twilio_from
            const To = req.body.To || '';
            let visitor = null;
            let clientConfig = null;

            // Find client by Twilio from number
            const clients = await db.getClients();
            for (const c of clients) {
                if (c.twilio_from && c.twilio_from === To) {
                    clientConfig = c;
                    visitor = await db.getVisitorByPhoneAnyHouse(fromPhone, c.id);
                    if (visitor) break;
                }
            }

            // Fallback: search all clients if no match by twilio_from
            if (!visitor) {
                for (const c of clients) {
                    visitor = await db.getVisitorByPhoneAnyHouse(fromPhone, c.id);
                    if (visitor) {
                        clientConfig = c;
                        break;
                    }
                }
            }

            if (!visitor || !clientConfig) {
                console.log(`[Webhook/Twilio] Unknown number: ${fromPhone}`);
                return;
            }

            // Log inbound
            await db.logSms({
                client_id:     clientConfig.id,
                visitor_id:    visitor.id,
                open_house_id: visitor.open_house_id,
                direction:     'inbound',
                to_number:     To,
                from_number:   fromPhone,
                body:          replyText,
            });

            await db.logConversation({
                visitor_id:    visitor.id,
                open_house_id: visitor.open_house_id,
                client_id:     clientConfig.id,
                direction:     'inbound',
                message:       replyText,
            });

            // Load their most recent open house for context
            const openHouse = visitor.open_house_id
                ? await db.getOpenHouse(visitor.open_house_id)
                : null;

            if (!openHouse) {
                console.log(`[Webhook/Twilio] No open house context for visitor ${visitor.id}`);
                return;
            }

            // Use AI to understand intent and generate response
            const { response, intent, shouldNotifyAgent, aiNotes } =
                await followup.handleVisitorReply(visitor, openHouse, clientConfig, replyText);

            // Update visitor with intent and AI notes
            const updates = { ai_notes: aiNotes };
            if (intent === 'not_interested') updates.interest_level = 'not_interested';
            if (intent === 'interested')     updates.interest_level = 'high';
            if (intent === 'schedule_showing') {
                updates.interest_level   = 'high';
                updates.followup_status  = 'converted';
            }
            await db.updateVisitor(visitor.id, updates);

            // Send response via Twilio (new outbound message)
            const accountSid = process.env.TWILIO_ACCOUNT_SID;
            const authToken  = process.env.TWILIO_AUTH_TOKEN;
            const fromNumber = clientConfig.twilio_from || process.env.TWILIO_FROM_NUMBER;

            if (accountSid && authToken && fromNumber) {
                const twilioClient = twilio(accountSid, authToken);
                const msg = await twilioClient.messages.create({
                    body: response,
                    from: fromNumber,
                    to:   fromPhone,
                });

                await db.logSms({
                    client_id:     clientConfig.id,
                    visitor_id:    visitor.id,
                    open_house_id: openHouse.id,
                    direction:     'outbound',
                    to_number:     fromPhone,
                    from_number:   fromNumber,
                    body:          response,
                    twilio_sid:    msg.sid,
                });

                await db.logConversation({
                    visitor_id:    visitor.id,
                    open_house_id: openHouse.id,
                    client_id:     clientConfig.id,
                    direction:     'outbound',
                    message:       response,
                    intent,
                    twilio_sid:    msg.sid,
                });
            }

            // Notify agent immediately if high interest
            if (shouldNotifyAgent) {
                await jobs.dispatchNotifyAgent(visitor.id, openHouse.id, clientConfig.client_slug, intent);
            }
        } catch (err) {
            console.error(`[Webhook/Twilio] Processing error: ${err.message}`);
        }
    });
});

// ─── Create Open House ─────────────────────────────────────────────────────────

// POST /open-houses
app.post('/open-houses', requireApiKey, async (req, res) => {
    const { client_id, listing_address, listing_id, date, start_time, end_time, notes } = req.body;

    if (!client_id || !listing_address || !date || !start_time || !end_time) {
        return res.status(400).json({ error: 'client_id, listing_address, date, start_time, end_time are required' });
    }

    try {
        // Resolve client config for Google Calendar
        const { data: clientRow, error: clientErr } = await require('@supabase/supabase-js')
            .createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
            .from('oh_clients')
            .select('*')
            .eq('id', client_id)
            .single();

        if (clientErr || !clientRow) {
            return res.status(404).json({ error: 'Client not found' });
        }

        // Build open house record
        const openHouseData = {
            client_id,
            listing_id:      listing_id || null,
            listing_address,
            date,
            start_time,
            end_time,
            notes:           notes || null,
            status:          'scheduled',
            timezone:        clientRow.timezone,
        };

        // Save to DB first
        const openHouse = await db.upsertOpenHouse(openHouseData);

        // Create Google Calendar event
        let calendarEventId  = null;
        let calendarLink     = null;

        if (clientRow.google_refresh_token) {
            const eventObj = calendar.formatOpenHouseEvent({
                ...openHouseData,
                timezone: clientRow.timezone,
            });

            const calResult = await calendar.createEvent(clientRow.client_slug, eventObj);

            if (calResult.ok) {
                calendarEventId = calResult.data.eventId;
                calendarLink    = calResult.data.htmlLink;

                // Update DB with calendar info
                await db.upsertOpenHouse({
                    ...openHouse,
                    google_event_id: calendarEventId,
                    calendar_link:   calendarLink,
                });
            } else {
                console.warn(`[OpenHouses] Calendar create failed: ${calResult.error}`);
            }
        }

        // Queue invite campaign (dispatches send-invites job)
        await jobs.dispatchSendInvites(openHouse.id, clientRow.client_slug);

        res.status(201).json({
            ok:      true,
            openHouse: {
                ...openHouse,
                google_event_id: calendarEventId,
                calendar_link:   calendarLink,
            },
            invitesQueued: true,
        });
    } catch (err) {
        console.error(`[OpenHouses] Create failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// ─── Register Visitor ─────────────────────────────────────────────────────────

// POST /visitors/register
app.post('/visitors/register', requireApiKey, async (req, res) => {
    const { open_house_id, client_id, name, phone, email, notes } = req.body;

    if (!open_house_id || !client_id || !name || !phone) {
        return res.status(400).json({ error: 'open_house_id, client_id, name, phone are required' });
    }

    try {
        // Check for duplicate
        const existing = await db.getVisitorByPhone(phone, open_house_id);
        if (existing) {
            return res.json({ ok: true, visitor: existing, duplicate: true });
        }

        const visitor = await db.registerVisitor({
            open_house_id,
            client_id,
            name,
            phone,
            email:  email || null,
            notes:  notes || null,
        });

        // Increment visitor count on open house
        await db.incrementVisitorCount(open_house_id);

        // Queue post-event thank you (will send after event ends, within 30 min check window)
        const openHouse = await db.getOpenHouse(open_house_id);
        if (openHouse) {
            const clientRow = await db.getClient(openHouse.oh_clients?.client_slug || '');
            const clientSlug = openHouse.oh_clients?.client_slug ||
                (await db.getClients()).find(c => c.id === client_id)?.client_slug;

            if (clientSlug) {
                // Schedule the follow-up campaign to be triggered by the cron checker
                // The post-event thankyou cron will pick this up when the event ends
                console.log(`[Register] Visitor ${visitor.id} registered — follow-up will be queued post-event`);
            }
        }

        res.status(201).json({ ok: true, visitor, duplicate: false });
    } catch (err) {
        if (err.code === '23505') {
            // Unique constraint violation — duplicate phone for this open house
            const existing = await db.getVisitorByPhone(phone, open_house_id);
            return res.json({ ok: true, visitor: existing, duplicate: true });
        }
        console.error(`[Register] Failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// ─── Manual Trigger Endpoints ──────────────────────────────────────────────────

// POST /trigger/send-invites { open_house_id, client_id }
app.post('/trigger/send-invites', requireApiKey, async (req, res) => {
    const { open_house_id, client_id } = req.body;
    if (!open_house_id || !client_id) {
        return res.status(400).json({ error: 'open_house_id and client_id required' });
    }

    try {
        const clients = await db.getClients();
        const clientRow = clients.find(c => c.id === client_id);
        if (!clientRow) return res.status(404).json({ error: 'Client not found' });

        const job = await jobs.dispatchSendInvites(open_house_id, clientRow.client_slug);
        res.json({ ok: true, jobId: job.id, open_house_id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /trigger/followup-campaign { open_house_id, client_id }
app.post('/trigger/followup-campaign', requireApiKey, async (req, res) => {
    const { open_house_id, client_id } = req.body;
    if (!open_house_id || !client_id) {
        return res.status(400).json({ error: 'open_house_id and client_id required' });
    }

    try {
        const clients = await db.getClients();
        const clientRow = clients.find(c => c.id === client_id);
        if (!clientRow) return res.status(404).json({ error: 'Client not found' });

        const [thankYouJob, dayAfterJob, weekJob] = await Promise.all([
            jobs.dispatchPostEventThankyou(open_house_id, clientRow.client_slug),
            jobs.dispatchDayAfterFollowup(open_house_id, clientRow.client_slug),
            jobs.dispatchWeekFollowup(open_house_id, clientRow.client_slug),
        ]);

        res.json({
            ok: true,
            open_house_id,
            jobs: {
                thankyou:  thankYouJob.id,
                dayAfter:  dayAfterJob.id,
                weekFollowup: weekJob.id,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /trigger/weekly-report { client_id }
app.post('/trigger/weekly-report', requireApiKey, async (req, res) => {
    const { client_id } = req.body;
    if (!client_id) return res.status(400).json({ error: 'client_id required' });

    try {
        const clients = await db.getClients();
        const clientRow = clients.find(c => c.id === client_id);
        if (!clientRow) return res.status(404).json({ error: 'Client not found' });

        const job = await jobs.dispatchWeeklyReport(clientRow.client_slug);
        res.json({ ok: true, jobId: job.id, clientSlug: clientRow.client_slug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

// GET /open-houses/:clientSlug — upcoming + past
app.get('/open-houses/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;

    try {
        const openHouses = await db.getOpenHousesByClient(clientSlug);
        const now = new Date().toISOString().split('T')[0];

        res.json({
            clientSlug,
            upcoming: openHouses.filter(oh => oh.date >= now && oh.status !== 'cancelled'),
            past:     openHouses.filter(oh => oh.date < now || oh.status === 'completed'),
            total:    openHouses.length,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /open-houses/:clientSlug/:openHouseId — detail with visitor list
app.get('/open-houses/:clientSlug/:openHouseId', requireApiKey, async (req, res) => {
    const { openHouseId } = req.params;

    try {
        const [openHouse, visitors] = await Promise.all([
            db.getOpenHouse(openHouseId),
            db.getVisitors(openHouseId),
        ]);

        if (!openHouse) return res.status(404).json({ error: 'Open house not found' });

        res.json({ ok: true, openHouse, visitors, visitorCount: visitors.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /visitors/:clientSlug/:openHouseId — visitor list with follow-up status
app.get('/visitors/:clientSlug/:openHouseId', requireApiKey, async (req, res) => {
    const { openHouseId } = req.params;

    try {
        const visitors = await db.getVisitors(openHouseId);

        res.json({
            openHouseId,
            visitors,
            summary: {
                total:         visitors.length,
                highInterest:  visitors.filter(v => v.interest_level === 'high').length,
                thankyouSent:  visitors.filter(v => ['thankyou_sent','day_after_sent','week_sent','converted'].includes(v.followup_status)).length,
                converted:     visitors.filter(v => v.followup_status === 'converted').length,
                optedOut:      visitors.filter(v => v.followup_status === 'opted_out').length,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /stats/:clientSlug — aggregate stats
app.get('/stats/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;

    try {
        const stats = await db.getStats(clientSlug);
        if (!stats) return res.status(404).json({ error: `Client not found: ${clientSlug}` });

        res.json({ ok: true, stats });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Cron Schedules ────────────────────────────────────────────────────────────

// Day-before reminders: 10:00 AM Chicago daily
// Checks for tomorrow's open houses and queues reminders to all invited leads
cron.schedule('0 10 * * *', async () => {
    console.log('[Cron] Checking for tomorrow\'s open houses — day-before reminders...');

    try {
        const tomorrowHouses = await db.getTomorrowOpenHouses();

        for (const oh of tomorrowHouses) {
            const clientSlug = oh.oh_clients?.client_slug;
            if (!clientSlug) continue;

            await jobs.dispatchDayBeforeReminder(oh.id, clientSlug);
            console.log(`[Cron] Day-before reminder queued for ${oh.listing_address}`);
        }
    } catch (err) {
        console.error(`[Cron] Day-before reminder error: ${err.message}`);
    }
}, { timezone: 'America/Chicago' });

// Post-event follow-up scheduler: every 30 minutes
// Checks for recently ended open houses and queues thank-you messages
cron.schedule('*/30 * * * *', async () => {
    console.log('[Cron] Checking for recently ended open houses...');

    try {
        const recentlyEnded = await db.getRecentlyEndedOpenHouses(60);

        for (const oh of recentlyEnded) {
            const clientSlug = oh.oh_clients?.client_slug;
            if (!clientSlug) continue;

            await jobs.dispatchPostEventThankyou(oh.id, clientSlug);
            console.log(`[Cron] Post-event thank-you queued for ${oh.listing_address}`);
        }
    } catch (err) {
        console.error(`[Cron] Post-event scheduler error: ${err.message}`);
    }
});

// Weekly report: Sundays at 6:00 PM Chicago
cron.schedule('0 18 * * 0', async () => {
    console.log('[Cron] Running weekly reports for all clients...');

    try {
        await jobs.runForAllClients(jobs.dispatchWeeklyReport);
    } catch (err) {
        console.error(`[Cron] Weekly report error: ${err.message}`);
    }
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3007;
app.listen(PORT, () => {
    console.log(`[OpenHouseBrain] Online — port ${PORT}`);
    console.log('[OpenHouseBrain] Crons: day-before @ 10am | post-event check every 30min | weekly report Sun 6pm');
});
