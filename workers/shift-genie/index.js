/**
 * GRIDHAND Shift Genie — Main Express Server
 *
 * Port: 3008
 *
 * Routes:
 *   POST /webhook/sms                — Twilio SMS webhook (staff commands)
 *   POST /webhook/7shifts            — 7shifts schedule change notifications
 *   POST /trigger/optimize-schedule  — Manually trigger weekly optimization
 *   POST /trigger/daily-summary      — Manually trigger daily schedule summary
 *   POST /trigger/check-coverage     — Manually trigger coverage gap check
 *   GET  /clients/:clientSlug/schedule    — Current schedule for a client
 *   GET  /clients/:clientSlug/labor-cost  — Labor cost snapshot
 *   GET  /health                     — Health check
 *
 * SMS Commands (from staff via text):
 *   SCHEDULE              → Their upcoming shifts (next 7 days)
 *   SWAP [date] [shift]   → Initiate swap for a shift
 *   AVAILABLE [date]      → Mark themselves available for pickup
 *   DROP [shift_id]       → Request to drop a shift
 *   PICKUP [shift_id]     → Accept a swap offer
 *
 * Environment:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   SEVEN_SHIFTS_CLIENT_ID, SEVEN_SHIFTS_CLIENT_SECRET, SEVEN_SHIFTS_REDIRECT_URI
 *   REDIS_URL
 *   GRIDHAND_API_KEY
 *   PORT (default: 3008)
 */

'use strict';

require('dotenv').config();

const express  = require('express');
const cron     = require('node-cron');
const { validateRequest } = require('twilio/lib/webhooks/webhooks');
const MessagingResponse   = require('twilio/lib/twiml/MessagingResponse');
const dayjs    = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

const scheduling = require('./scheduling');
const optimizer  = require('./optimizer');
const jobs       = require('./jobs');

const app      = express();
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Body Parsing ─────────────────────────────────────────────────────────────

// Raw body needed for Twilio webhook signature validation
app.use('/webhook/sms',    express.urlencoded({ extended: false }));
app.use('/webhook/7shifts', express.json());
app.use(express.json());

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
    const serverKey = process.env.GRIDHAND_API_KEY;
    if (!serverKey) return res.status(503).json({ error: 'GRIDHAND_API_KEY not configured' });
    const provided = (req.headers['authorization'] || '').replace('Bearer ', '');
    if (provided !== serverKey) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ─── Twilio Webhook Signature Validation ──────────────────────────────────────

function validateTwilioSignature(req, res, next) {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) return res.status(503).send('Twilio not configured');

    const twilioSignature = req.headers['x-twilio-signature'];
    const url             = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const params          = req.body || {};

    const isValid = validateRequest(authToken, twilioSignature, url, params);
    if (!isValid) {
        console.warn('[Webhook/SMS] Invalid Twilio signature — rejected');
        return res.status(403).send('Forbidden');
    }
    next();
}

// ─── SMS Command Parser ───────────────────────────────────────────────────────

/**
 * Parse an inbound SMS body into a structured command.
 * Returns { command, args } or null if unrecognized.
 */
function parseSmsCommand(body) {
    const text = (body || '').trim().toUpperCase();

    // SCHEDULE → get upcoming shifts
    if (text === 'SCHEDULE') {
        return { command: 'SCHEDULE', args: {} };
    }

    // SWAP [date] [shift] — e.g. "SWAP 03/25 dinner" or "SWAP 03/25 17:00"
    const swapMatch = text.match(/^SWAP\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.+)$/);
    if (swapMatch) {
        return {
            command: 'SWAP',
            args: {
                date:  swapMatch[1],
                shift: swapMatch[2].toLowerCase(),
            },
        };
    }

    // AVAILABLE [date] — e.g. "AVAILABLE 03/25"
    const availMatch = text.match(/^AVAILABLE\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/);
    if (availMatch) {
        return { command: 'AVAILABLE', args: { date: availMatch[1] } };
    }

    // DROP [shift_id] — e.g. "DROP 12345" or "DROP a3f9b2c1"
    const dropMatch = text.match(/^DROP\s+([A-Z0-9\-]{1,40})$/);
    if (dropMatch) {
        return { command: 'DROP', args: { shiftId: dropMatch[1] } };
    }

    // PICKUP [shift_id] — e.g. "PICKUP 12345" or "PICKUP a3f9b2c1"
    const pickupMatch = text.match(/^PICKUP\s+([A-Z0-9\-]{1,40})$/);
    if (pickupMatch) {
        return { command: 'PICKUP', args: { shiftId: pickupMatch[1] } };
    }

    return null;
}

/**
 * Normalize a date string like "03/25" or "3/25/2026" to YYYY-MM-DD.
 */
function normalizeDate(rawDate) {
    const parts = rawDate.split('/');
    if (parts.length < 2) return null;

    const month = parseInt(parts[0]);
    const day   = parseInt(parts[1]);
    const year  = parts[2]
        ? (parts[2].length === 2 ? 2000 + parseInt(parts[2]) : parseInt(parts[2]))
        : dayjs().year();

    const d = dayjs(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    return d.isValid() ? d.format('YYYY-MM-DD') : null;
}

/**
 * Find which client a phone number belongs to (via scheduled_shifts or swap_requests).
 * Returns { clientSlug, employeeId } or null.
 */
async function resolvePhoneToEmployee(phone) {
    const clean = phone.replace(/\D/g, '').replace(/^1/, '');

    const { data: shifts } = await supabase
        .from('scheduled_shifts')
        .select('client_slug, employee_id, employee_name')
        .ilike('employee_phone', `%${clean}%`)
        .limit(1);

    if (shifts?.length) {
        return {
            clientSlug: shifts[0].client_slug,
            employeeId: shifts[0].employee_id,
            employeeName: shifts[0].employee_name,
        };
    }

    // Check connections table — maybe it's the manager
    const { data: conns } = await supabase
        .from('genie_connections')
        .select('client_slug, restaurant_name')
        .or(`manager_phone.ilike.%${clean}%,gm_phone.ilike.%${clean}%`)
        .limit(1);

    if (conns?.length) {
        return {
            clientSlug:   conns[0].client_slug,
            employeeId:   'manager',
            employeeName: 'Manager',
        };
    }

    return null;
}

/**
 * Get upcoming shifts for an employee (next 7 days).
 */
async function getUpcomingShifts(clientSlug, employeeId) {
    const today = dayjs().format('YYYY-MM-DD');
    const end   = dayjs().add(7, 'day').format('YYYY-MM-DD');

    const { data: shifts } = await supabase
        .from('scheduled_shifts')
        .select('shift_date, start_time, end_time, role, status')
        .eq('client_slug', clientSlug)
        .eq('employee_id', employeeId)
        .gte('shift_date', today)
        .lte('shift_date', end)
        .order('shift_date');

    return shifts || [];
}

// ─── Twilio Reply Helper ──────────────────────────────────────────────────────

function twilioReply(res, message) {
    const twiml = new MessagingResponse();
    twiml.message(message);
    res.type('text/xml');
    res.send(twiml.toString());
}

// ─── SMS Webhook ──────────────────────────────────────────────────────────────

app.post('/webhook/sms', validateTwilioSignature, async (req, res) => {
    const fromPhone = req.body.From || '';
    const body      = req.body.Body || '';

    console.log(`[SMS] Incoming from ${fromPhone}: "${body}"`);

    // Resolve who sent this
    const sender = await resolvePhoneToEmployee(fromPhone);
    if (!sender) {
        return twilioReply(res, 'Your number is not registered in our scheduling system. Contact your manager.');
    }

    const { clientSlug, employeeId } = sender;
    const parsed = parseSmsCommand(body);

    if (!parsed) {
        return twilioReply(
            res,
            'Reply SCHEDULE, SWAP [date] [shift], AVAILABLE [date], DROP [id], or PICKUP [id]'
        );
    }

    try {
        switch (parsed.command) {

            // ── SCHEDULE ──────────────────────────────────────────────────────
            case 'SCHEDULE': {
                const shifts = await getUpcomingShifts(clientSlug, employeeId);
                if (shifts.length === 0) {
                    return twilioReply(res, 'You have no scheduled shifts in the next 7 days.');
                }
                const lines = shifts.map(s => {
                    const date  = dayjs(s.shift_date).format('ddd MMM D');
                    const start = (s.start_time || '').slice(0, 5);
                    const end   = (s.end_time   || '').slice(0, 5);
                    return `• ${date} ${start}–${end} (${s.role})`;
                });
                return twilioReply(res, `Your upcoming shifts:\n${lines.join('\n')}`);
            }

            // ── SWAP ──────────────────────────────────────────────────────────
            case 'SWAP': {
                const targetDate = normalizeDate(parsed.args.date);
                if (!targetDate) {
                    return twilioReply(res, 'Invalid date. Use format: SWAP MM/DD shift (e.g. SWAP 03/25 dinner)');
                }
                const targetShift = parsed.args.shift; // 'lunch', 'dinner', or time

                // Queue the swap job
                await jobs.runProcessSwap(clientSlug, employeeId, targetDate, targetShift);

                return twilioReply(
                    res,
                    `Swap request received for ${dayjs(targetDate).format('MMM D')} ${targetShift}. ` +
                    `We'll find coverage and notify you. Reply SCHEDULE to see your current shifts.`
                );
            }

            // ── AVAILABLE ─────────────────────────────────────────────────────
            case 'AVAILABLE': {
                const availDate = normalizeDate(parsed.args.date);
                if (!availDate) {
                    return twilioReply(res, 'Invalid date. Use format: AVAILABLE MM/DD');
                }

                const emp = await supabase
                    .from('scheduled_shifts')
                    .select('employee_phone')
                    .eq('client_slug', clientSlug)
                    .eq('employee_id', employeeId)
                    .limit(1);

                await supabase
                    .from('employee_availability')
                    .upsert({
                        client_slug:    clientSlug,
                        employee_id:    employeeId,
                        employee_phone: fromPhone,
                        available_date: availDate,
                    }, { onConflict: 'client_slug,employee_id,available_date' });

                return twilioReply(
                    res,
                    `Got it! You're marked available on ${dayjs(availDate).format('ddd MMM D')}. ` +
                    `We'll contact you if a shift pickup opportunity comes up.`
                );
            }

            // ── DROP ──────────────────────────────────────────────────────────
            case 'DROP': {
                const shiftId = parsed.args.shiftId.toLowerCase();

                // Look up the shift — match by external_shift_id or partial UUID
                const { data: shiftRows } = await supabase
                    .from('scheduled_shifts')
                    .select('*')
                    .eq('client_slug', clientSlug)
                    .eq('employee_id', employeeId)
                    .or(`external_shift_id.ilike.%${shiftId}%,id::text.ilike.${shiftId}%`)
                    .gte('shift_date', dayjs().format('YYYY-MM-DD'))
                    .limit(1);

                if (!shiftRows?.length) {
                    return twilioReply(res, `Shift ${parsed.args.shiftId} not found. Reply SCHEDULE to see your upcoming shifts.`);
                }

                const shift = shiftRows[0];

                // Create a swap request marked as pending
                await supabase.from('swap_requests').insert({
                    client_slug:        clientSlug,
                    requester_id:       employeeId,
                    requester_phone:    fromPhone,
                    shift_id:           shift.id,
                    target_date:        shift.shift_date,
                    target_shift_start: shift.start_time,
                    status:             'pending',
                });

                // Queue swap processing
                const shiftStart = (shift.start_time || '').slice(0, 5);
                const hour       = parseInt((shift.start_time || '00').split(':')[0]);
                const period     = hour < 15 ? 'lunch' : 'dinner';

                await jobs.runProcessSwap(clientSlug, employeeId, shift.shift_date, period);

                return twilioReply(
                    res,
                    `Drop request received for ${dayjs(shift.shift_date).format('MMM D')} (${shiftStart}). ` +
                    `We'll search for coverage and let you know.`
                );
            }

            // ── PICKUP ────────────────────────────────────────────────────────
            case 'PICKUP': {
                const swapId = parsed.args.shiftId.toLowerCase();

                try {
                    const result = await optimizer.handleSwapAcceptance(clientSlug, swapId, employeeId);
                    return twilioReply(res, `Shift confirmed! Check SCHEDULE for your updated shifts.`);
                } catch (err) {
                    console.error(`[SMS] PICKUP error: ${err.message}`);
                    if (err.message.includes('expired')) {
                        return twilioReply(res, `Sorry, that offer has expired. Check SCHEDULE for new opportunities.`);
                    }
                    return twilioReply(res, `Unable to confirm pickup. ${err.message}`);
                }
            }

            default:
                return twilioReply(res, 'Reply SCHEDULE, SWAP [date] [shift], AVAILABLE [date], DROP [id], or PICKUP [id]');
        }
    } catch (err) {
        console.error(`[SMS] Command error (${parsed.command}): ${err.message}`);
        return twilioReply(res, 'Something went wrong. Contact your manager directly.');
    }
});

// ─── 7shifts Webhook ──────────────────────────────────────────────────────────

app.post('/webhook/7shifts', async (req, res) => {
    // 7shifts sends webhook events for schedule changes, shift swaps, etc.
    const event = req.body;
    console.log(`[Webhook/7shifts] Event type: ${event.event || 'unknown'}`);

    // Quick ACK — process async
    res.status(200).json({ received: true });

    setImmediate(async () => {
        try {
            const eventType = event.event || '';

            // Shift published or updated — trigger coverage check
            if (eventType.includes('shift') || eventType.includes('schedule')) {
                const companyId = event.company_id || event.data?.company_id;
                if (!companyId) return;

                // Find client by company ID
                const { data: conn } = await supabase
                    .from('genie_connections')
                    .select('client_slug')
                    .eq('seven_shifts_company_id', String(companyId))
                    .single();

                if (conn) {
                    const date = event.data?.start_time
                        ? dayjs(event.data.start_time).format('YYYY-MM-DD')
                        : dayjs().format('YYYY-MM-DD');
                    await jobs.runCheckCoverage(conn.client_slug, date);
                }
            }
        } catch (err) {
            console.error(`[Webhook/7shifts] Processing error: ${err.message}`);
        }
    });
});

// ─── Manual Trigger Endpoints ─────────────────────────────────────────────────

app.post('/trigger/optimize-schedule', requireApiKey, async (req, res) => {
    const { clientSlug, weekStart } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runOptimizeSchedule(clientSlug, weekStart);
        res.json({ success: true, jobId: job.id, clientSlug, weekStart });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/daily-summary', requireApiKey, async (req, res) => {
    const { clientSlug, date } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runDailySummary(clientSlug, date);
        res.json({ success: true, jobId: job.id, clientSlug, date });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/trigger/check-coverage', requireApiKey, async (req, res) => {
    const { clientSlug, date } = req.body;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    try {
        const job = await jobs.runCheckCoverage(clientSlug, date);
        res.json({ success: true, jobId: job.id, clientSlug, date });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Data Endpoints ───────────────────────────────────────────────────────────

app.get('/clients/:clientSlug/schedule', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { date = dayjs().format('YYYY-MM-DD') } = req.query;

    try {
        const [shifts, employees] = await Promise.all([
            scheduling.getScheduleForDate(clientSlug, date),
            scheduling.getEmployees(clientSlug),
        ]);

        const gaps = scheduling.detectCoverageGaps(shifts, date);

        // Enrich shifts with employee names + wages
        const empMap = {};
        for (const emp of employees) empMap[emp.id] = emp;

        const enriched = shifts.map(s => ({
            ...s,
            employeeName: empMap[s.employeeId]?.name || s.employeeName || '',
            hourlyRate:   empMap[s.employeeId]?.hourlyRate || 0,
        }));

        res.json({
            clientSlug,
            date,
            shifts:   enriched,
            gaps,
            staffCount: shifts.length,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/clients/:clientSlug/labor-cost', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { date = dayjs().format('YYYY-MM-DD') } = req.query;

    try {
        // Get the most recent snapshots
        const { data: snapshots, error } = await supabase
            .from('labor_snapshots')
            .select('*')
            .eq('client_slug', clientSlug)
            .order('snapshot_date', { ascending: false })
            .limit(30);

        if (error) throw error;

        // Get today's live snapshot
        const [shifts, employees] = await Promise.all([
            scheduling.getScheduleForDate(clientSlug, date).catch(() => []),
            scheduling.getEmployees(clientSlug).catch(() => []),
        ]);

        const conn = await scheduling.getConnection(clientSlug);
        const laborData = scheduling.calculateLaborCost(shifts, employees, 0);

        res.json({
            clientSlug,
            date,
            today: laborData,
            target: conn.labor_cost_target || 0.30,
            history: snapshots || [],
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── 7shifts OAuth Endpoints ──────────────────────────────────────────────────

app.get('/auth/7shifts', (req, res) => {
    const { clientSlug } = req.query;
    if (!clientSlug) return res.status(400).json({ error: 'clientSlug required' });

    const url = scheduling.get7shiftsAuthUrl(clientSlug);
    res.redirect(url);
});

app.get('/auth/7shifts/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing code or state from 7shifts.');

    let clientSlug;
    try {
        const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
        clientSlug = decoded.clientSlug;
    } catch {
        return res.status(400).send('Invalid state parameter.');
    }

    try {
        await scheduling.exchange7shiftsCode(code, clientSlug);
        res.send(`
            <html><body style="font-family:sans-serif;text-align:center;padding:60px">
                <h2>7shifts Connected!</h2>
                <p><strong>${clientSlug}</strong> is now connected to 7shifts.</p>
                <p>Shift Genie will start monitoring your schedule automatically.</p>
            </body></html>
        `);
    } catch (err) {
        res.status(500).send(`7shifts OAuth failed: ${err.message}`);
    }
});

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({
        worker:       'Shift Genie',
        status:       'online',
        version:      '1.0.0',
        port:         PORT,
        jobs: [
            'daily-summary',
            'check-coverage',
            'optimize-schedule',
            'process-swap',
            'labor-report',
        ],
        integrations: ['7shifts', 'HotSchedules', 'Toast POS', 'Square POS', 'Twilio SMS', 'Supabase'],
        smsCommands:  ['SCHEDULE', 'SWAP', 'AVAILABLE', 'DROP', 'PICKUP'],
        crons: {
            dailySummary:    '7:00am daily → schedule + labor projection to manager',
            coverageCheck:   '10:00am + 4:00pm daily → check for understaffed shifts',
            optimizeSchedule: 'Sunday 6:00pm → analyze next week, send suggestions',
            laborReport:     'Monday 8:00am → weekly labor cost report to GM',
        },
    });
});

// ─── Cron Schedules ────────────────────────────────────────────────────────────

// 7am daily — send daily schedule summary to manager
cron.schedule('0 7 * * *', async () => {
    console.log('[Cron] Running daily schedule summary for all clients...');
    await jobs.runForAllClients(jobs.runDailySummary);
}, { timezone: 'America/Chicago' });

// 10am daily — check lunch coverage
cron.schedule('0 10 * * *', async () => {
    console.log('[Cron] Checking lunch coverage for all clients...');
    await jobs.runForAllClients(jobs.runCheckCoverage);
}, { timezone: 'America/Chicago' });

// 4pm daily — check dinner coverage
cron.schedule('0 16 * * *', async () => {
    console.log('[Cron] Checking dinner coverage for all clients...');
    await jobs.runForAllClients(jobs.runCheckCoverage);
}, { timezone: 'America/Chicago' });

// Sunday 6pm — optimize next week's schedule
cron.schedule('0 18 * * 0', async () => {
    console.log('[Cron] Optimizing next week schedule for all clients...');
    const nextMonday = dayjs().add(1, 'day').startOf('week').add(1, 'day').format('YYYY-MM-DD');
    await jobs.runForAllClients(jobs.runOptimizeSchedule, nextMonday);
}, { timezone: 'America/Chicago' });

// Monday 8am — weekly labor cost report
cron.schedule('0 8 * * 1', async () => {
    console.log('[Cron] Sending weekly labor reports for all clients...');
    await jobs.runForAllClients(jobs.runLaborReport);
}, { timezone: 'America/Chicago' });

// ─── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3008;
app.listen(PORT, () => {
    console.log(`[ShiftGenie] Online — port ${PORT}`);
    console.log('[ShiftGenie] Crons:');
    console.log('  7am daily     → daily schedule summary');
    console.log('  10am daily    → lunch coverage check');
    console.log('  4pm daily     → dinner coverage check');
    console.log('  Sunday 6pm    → optimize next week');
    console.log('  Monday 8am    → weekly labor report');
    console.log('[ShiftGenie] SMS commands: SCHEDULE | SWAP | AVAILABLE | DROP | PICKUP');
});
