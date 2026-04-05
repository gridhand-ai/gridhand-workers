/**
 * GRIDHAND No-Show Nurse — Main Express Server
 *
 * Medical appointment no-show automation worker.
 * Detects no-shows in real time, auto-texts patients, fills slots from waitlist,
 * tracks patterns, and sends pre-appointment reminders.
 *
 * Routes:
 *   GET  /                              → health check
 *   POST /auth/connect                  → register a medical practice
 *   POST /webhooks/sms                  → Twilio inbound SMS (patient replies)
 *   POST /webhooks/ehr                  → EHR scheduling events webhook
 *
 *   Protected (Bearer: GRIDHAND_API_KEY):
 *   GET  /no-shows/:clientSlug          → list no-shows (query: ?date=YYYY-MM-DD)
 *   GET  /waitlist/:clientSlug          → current waitlist
 *   POST /waitlist/:clientSlug          → add patient to waitlist
 *   DEL  /waitlist/:clientSlug/:waitlistId → remove from waitlist
 *   GET  /analytics/:clientSlug         → no-show rate, fill rate, revenue saved
 *   POST /trigger/detect-no-shows       → manually check for no-shows
 *   POST /trigger/send-reminders        → manually send upcoming reminders
 *   POST /trigger/fill-slot             → manually fill a specific slot
 *
 * Environment:
 *   NSN_PORT                    (default 3011)
 *   GRIDHAND_API_KEY            — protects admin endpoints
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
 *   REDIS_URL
 */

'use strict';

require('dotenv').config();

const express    = require('express');
const cron       = require('node-cron');
const cors       = require('cors');
const dayjs      = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

const scheduling = require('./scheduling');
const waitlist   = require('./waitlist');
const outreach   = require('./outreach');
const jobs       = require('./jobs');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const app  = express();
const PORT = process.env.NSN_PORT || 3011;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // required for Twilio webhooks

// ─── Auth Middleware ───────────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
    const serverKey = process.env.GRIDHAND_API_KEY;
    if (!serverKey) return res.status(503).json({ error: 'GRIDHAND_API_KEY not configured' });
    const provided = (req.headers['authorization'] || '').replace('Bearer ', '');
    if (provided !== serverKey) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ─── Health Check ──────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.json({
        worker:       'No-Show Nurse',
        status:       'online',
        version:      '1.0.0',
        port:         PORT,
        jobs:         ['detect-no-shows', 'send-reminders', 'fill-slot', 'followup', 'weekly-digest'],
        integrations: ['Epic FHIR R4', 'Cerner FHIR R4', 'Twilio SMS', 'Supabase'],
        crons: {
            'detect-no-shows': 'Every 30 min, 8am–6pm',
            '24hr-reminder':   '8am daily',
            '2hr-reminder':    '3pm daily (for next-day appts)',
            'weekly-digest':   '8am Monday',
        },
    });
});

// ─── Auth: Register Practice ───────────────────────────────────────────────────

/**
 * POST /auth/connect
 * Body: { clientSlug, practiceName, staffPhone, frontDeskPhone,
 *         ehrType, ehrBaseUrl, ehrClientId, ehrClientSecret,
 *         noShowThresholdMinutes?, slotOfferExpiryMinutes?,
 *         reminder24hrEnabled?, reminder2hrEnabled? }
 */
app.post('/auth/connect', async (req, res) => {
    const {
        clientSlug, practiceName, staffPhone, frontDeskPhone,
        ehrType, ehrBaseUrl, ehrClientId, ehrClientSecret,
        noShowThresholdMinutes = 15,
        slotOfferExpiryMinutes = 120,
        reminder24hrEnabled    = true,
        reminder2hrEnabled     = true,
    } = req.body;

    if (!clientSlug || !practiceName || !staffPhone || !ehrType || !ehrBaseUrl || !ehrClientId || !ehrClientSecret) {
        return res.status(400).json({
            error: 'Required: clientSlug, practiceName, staffPhone, ehrType, ehrBaseUrl, ehrClientId, ehrClientSecret',
        });
    }

    if (!['epic', 'cerner'].includes(ehrType)) {
        return res.status(400).json({ error: 'ehrType must be "epic" or "cerner"' });
    }

    try {
        const { error } = await supabase
            .from('nsn_connections')
            .upsert({
                client_slug:                clientSlug,
                practice_name:              practiceName,
                staff_phone:                staffPhone,
                front_desk_phone:           frontDeskPhone || null,
                ehr_type:                   ehrType,
                ehr_base_url:               ehrBaseUrl,
                ehr_client_id:              ehrClientId,
                ehr_client_secret:          ehrClientSecret,
                no_show_threshold_minutes:  noShowThresholdMinutes,
                slot_offer_expiry_minutes:  slotOfferExpiryMinutes,
                reminder_24hr_enabled:      reminder24hrEnabled,
                reminder_2hr_enabled:       reminder2hrEnabled,
                updated_at:                 new Date().toISOString(),
            }, { onConflict: 'client_slug' });

        if (error) throw error;

        // Verify token acquisition
        await scheduling.getAccessToken(clientSlug);

        console.log(`[NSN] Practice connected: ${clientSlug} (${ehrType})`);
        res.json({ success: true, clientSlug, ehrType, message: `${practiceName} connected successfully.` });
    } catch (err) {
        console.error(`[NSN] /auth/connect failed for ${clientSlug}: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// ─── Webhook: Twilio Inbound SMS ───────────────────────────────────────────────

/**
 * POST /webhooks/sms
 * Twilio posts form-encoded data. Required fields: From, Body.
 * We look up the client by matching phone against known connections.
 */
app.post('/webhooks/sms', async (req, res) => {
    // Always respond 204 immediately — Twilio does not need a body
    res.status(204).send();

    const from = req.body.From;
    const body = req.body.Body || '';

    if (!from) return;

    try {
        // Find the connection(s) this patient phone belongs to
        // We search recent no-shows and waitlist entries for this phone
        const { data: noShowMatch } = await supabase
            .from('nsn_no_shows')
            .select('client_slug')
            .eq('patient_phone', from)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        const { data: waitlistMatch } = await supabase
            .from('nsn_waitlist')
            .select('client_slug')
            .eq('patient_phone', from)
            .in('status', ['waiting', 'offered'])
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        const clientSlug = (noShowMatch || waitlistMatch)?.client_slug;
        if (!clientSlug) {
            console.warn(`[NSN] SMS from unknown patient ${from} — no matching client`);
            return;
        }

        const conn = await scheduling.getConnection(clientSlug);
        await outreach.handlePatientReply(conn, from, body);

    } catch (err) {
        console.error(`[NSN] /webhooks/sms error for ${from}: ${err.message}`);
    }
});

// ─── Webhook: EHR Scheduling Events ───────────────────────────────────────────

/**
 * POST /webhooks/ehr
 * EHR systems (Epic/Cerner) can POST appointment status-change events here.
 * Body: { clientSlug, appointmentId, status, patientId, start, appointmentType }
 */
app.post('/webhooks/ehr', async (req, res) => {
    res.status(204).send();

    const { clientSlug, appointmentId, status, patientId, start, appointmentType } = req.body;
    if (!clientSlug || !appointmentId || !status) return;

    console.log(`[NSN] EHR webhook: appt ${appointmentId} → ${status} for ${clientSlug}`);

    try {
        if (status === 'cancelled') {
            // Cancelled slot — trigger waitlist fill
            const slot = {
                id:              appointmentId,
                start:           start || null,
                appointmentType: appointmentType || null,
            };
            const matches = await waitlist.findMatchingWaitlistPatients(clientSlug, slot);
            if (matches.length > 0) {
                await waitlist.offerSlotToPatient(clientSlug, matches[0], slot);
            }
        }

        if (status === 'noshow') {
            // EHR confirmed no-show — ensure it's in our DB and follow up
            const { data: existing } = await supabase
                .from('nsn_no_shows')
                .select('id')
                .eq('client_slug', clientSlug)
                .eq('appointment_id', appointmentId)
                .single();

            if (!existing) {
                const conn = await scheduling.getConnection(clientSlug);
                let patient = { id: patientId, name: 'Patient', phone: null };
                if (patientId) {
                    try { patient = await scheduling.getPatient(clientSlug, patientId); } catch {}
                }
                await supabase.from('nsn_no_shows').insert({
                    client_slug:      clientSlug,
                    appointment_id:   appointmentId,
                    patient_id:       patientId,
                    patient_name:     patient.name,
                    patient_phone:    patient.phone,
                    scheduled_at:     start || new Date().toISOString(),
                    appointment_type: appointmentType,
                    status:           'detected',
                });
                if (patient.phone) {
                    await outreach.sendNoShowFollowUp(conn, patient, { id: appointmentId, start, appointmentType });
                }
            }
        }

    } catch (err) {
        console.error(`[NSN] /webhooks/ehr error for ${appointmentId}: ${err.message}`);
    }
});

// ─── Protected Routes ──────────────────────────────────────────────────────────

// GET /no-shows/:clientSlug?date=YYYY-MM-DD
app.get('/no-shows/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { date, status } = req.query;

    try {
        let query = supabase
            .from('nsn_no_shows')
            .select('*')
            .eq('client_slug', clientSlug)
            .order('scheduled_at', { ascending: false });

        if (date) {
            query = query
                .gte('scheduled_at', `${date}T00:00:00Z`)
                .lte('scheduled_at', `${date}T23:59:59Z`);
        }
        if (status) {
            query = query.eq('status', status);
        }

        const { data, error } = await query;
        if (error) throw error;
        res.json({ clientSlug, count: data.length, noShows: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /waitlist/:clientSlug
app.get('/waitlist/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { status: filterStatus, appointmentType } = req.query;

    try {
        const list  = await waitlist.getWaitlist(clientSlug, {
            status:          filterStatus,
            appointmentType: appointmentType,
        });
        const stats = await waitlist.getWaitlistStats(clientSlug);
        res.json({ clientSlug, stats, waitlist: list });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /waitlist/:clientSlug
app.post('/waitlist/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const {
        patientId, patientName, patientPhone,
        preferredDays, preferredTimes,
        appointmentType, notes,
    } = req.body;

    if (!patientName || !patientPhone || !appointmentType) {
        return res.status(400).json({ error: 'Required: patientName, patientPhone, appointmentType' });
    }

    try {
        const entry = await waitlist.addToWaitlist(clientSlug, {
            patientId, patientName, patientPhone,
            preferredDays:  preferredDays  || [],
            preferredTimes: preferredTimes || [],
            appointmentType, notes,
        });
        res.status(201).json({ success: true, entry });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /waitlist/:clientSlug/:waitlistId
app.delete('/waitlist/:clientSlug/:waitlistId', requireApiKey, async (req, res) => {
    const { clientSlug, waitlistId } = req.params;
    try {
        await waitlist.removeFromWaitlist(clientSlug, waitlistId);
        res.json({ success: true, waitlistId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /analytics/:clientSlug
app.get('/analytics/:clientSlug', requireApiKey, async (req, res) => {
    const { clientSlug } = req.params;
    const { days = 30 } = req.query;
    const since = dayjs().subtract(Number(days), 'day').format('YYYY-MM-DD');

    try {
        const { data: stats, error: statsErr } = await supabase
            .from('nsn_daily_stats')
            .select('*')
            .eq('client_slug', clientSlug)
            .gte('stat_date', since)
            .order('stat_date', { ascending: false });

        if (statsErr) throw statsErr;

        const { data: fills, error: fillsErr } = await supabase
            .from('nsn_slot_fills')
            .select('*')
            .eq('client_slug', clientSlug)
            .gte('created_at', dayjs(since).toISOString());

        if (fillsErr) throw fillsErr;

        const totals = (stats || []).reduce((acc, row) => {
            acc.appointments += row.appointments_total || 0;
            acc.noShows      += row.no_show_count      || 0;
            acc.cancellations+= row.cancellations      || 0;
            acc.confirmations+= row.confirmations      || 0;
            acc.slotsFilled  += row.slots_filled       || 0;
            acc.reminders    += row.reminders_sent     || 0;
            return acc;
        }, { appointments: 0, noShows: 0, cancellations: 0, confirmations: 0, slotsFilled: 0, reminders: 0 });

        const noShowRate = totals.appointments > 0
            ? Number(((totals.noShows / totals.appointments) * 100).toFixed(1))
            : 0;

        const fillRate = (totals.noShows + totals.cancellations) > 0
            ? Number(((totals.slotsFilled / (totals.noShows + totals.cancellations)) * 100).toFixed(1))
            : 0;

        const waitlistStats = await waitlist.getWaitlistStats(clientSlug);

        res.json({
            clientSlug,
            period:        `Last ${days} days`,
            totals,
            noShowRate,
            fillRate,
            waitlist:      waitlistStats,
            fills:         fills || [],
            dailyStats:    stats || [],
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /trigger/detect-no-shows
app.post('/trigger/detect-no-shows', requireApiKey, async (req, res) => {
    const { clientSlug } = req.body;
    try {
        if (clientSlug) {
            const job = await jobs.runDetectNoShows(clientSlug);
            return res.json({ queued: true, jobId: job.id, clientSlug });
        }
        const results = await jobs.runForAllClients(jobs.runDetectNoShows);
        res.json({ queued: true, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /trigger/send-reminders
app.post('/trigger/send-reminders', requireApiKey, async (req, res) => {
    const { clientSlug, hoursOut = 24 } = req.body;
    try {
        if (clientSlug) {
            const job = await jobs.runSendReminders(clientSlug, hoursOut);
            return res.json({ queued: true, jobId: job.id, clientSlug, hoursOut });
        }
        const results = await jobs.runForAllClients(slug => jobs.runSendReminders(slug, hoursOut));
        res.json({ queued: true, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /trigger/fill-slot
app.post('/trigger/fill-slot', requireApiKey, async (req, res) => {
    const { clientSlug, slotId, appointmentType, slotStart } = req.body;
    if (!clientSlug || !slotId) {
        return res.status(400).json({ error: 'Required: clientSlug, slotId' });
    }
    try {
        const job = await jobs.runFillSlot(clientSlug, slotId, { appointmentType, slotStart });
        res.json({ queued: true, jobId: job.id, clientSlug, slotId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Cron Schedule ─────────────────────────────────────────────────────────────

// Every 30 minutes during business hours (8am–6pm)
cron.schedule('*/30 8-18 * * *', async () => {
    console.log('[NSN] Cron: detect no-shows');
    try { await jobs.runForAllClients(jobs.runDetectNoShows); } catch (e) { console.error('[NSN] Cron detect error:', e.message); }
});

// 8am daily — 24hr reminders for tomorrow's appointments
cron.schedule('0 8 * * *', async () => {
    console.log('[NSN] Cron: 24hr reminders');
    try { await jobs.runForAllClients(slug => jobs.runSendReminders(slug, 24)); } catch (e) { console.error('[NSN] Cron 24hr reminder error:', e.message); }
});

// 3pm daily — 24hr-notice reminders (tomorrow appts get a heads-up today at 3pm)
cron.schedule('0 15 * * *', async () => {
    console.log('[NSN] Cron: 2hr reminders');
    try { await jobs.runForAllClients(slug => jobs.runSendReminders(slug, 2)); } catch (e) { console.error('[NSN] Cron 2hr reminder error:', e.message); }
});

// 8am Monday — weekly no-show digest
cron.schedule('0 8 * * 1', async () => {
    console.log('[NSN] Cron: weekly digest');
    try { await jobs.runForAllClients(jobs.runWeeklyDigest); } catch (e) { console.error('[NSN] Cron digest error:', e.message); }
});

// ─── Start Server ──────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`[NSN] No-Show Nurse running on port ${PORT}`);
    console.log(`[NSN] EHR: Epic FHIR R4 + Cerner FHIR R4`);
    console.log(`[NSN] Crons: detect (every 30min 8-18h), 24hr reminders (8am), 2hr reminders (3pm), digest (Mon 8am)`);
});

module.exports = app;
