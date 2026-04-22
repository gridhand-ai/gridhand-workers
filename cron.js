'use strict';

/**
 * GRIDHAND Workers — Scheduled Cron Jobs
 *
 * Uses node-cron for time-based sweeps that cannot be triggered by external
 * events (e.g. weekly report, cross-sell digest). All times are in UTC.
 *
 * CT offsets:  CDT = UTC-5   CST = UTC-6
 *
 * All other recurring tasks (retention, lead nurture, reputation, commander,
 * sequences, credential monitor) already run via setInterval in server.js
 * and do NOT need a cron entry here.
 *
 * Token impact: neutral — no new AI calls introduced here. weekly-report uses
 * Twilio (not Claude) to send the report text.
 */

const cron         = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const weeklyReport = require('./workers/weekly-report');

// ─── Weekly Report Sweep ──────────────────────────────────────────────────────
// Every Monday at 8:00am CT (13:00 UTC — conservative: CDT=UTC-5, CST=UTC-6)
// Queries all active clients from Supabase and sends each a performance SMS.
// workers_paused = true → skip (client is cancelled or paused).
// Missing owner_phone → skip with a log warning (not a crash).
//
// Schedule: "0 13 * * 1"
//   - minute 0, hour 13 UTC, any day-of-month, any month, Monday (1)
cron.schedule('0 13 * * 1', async () => {
    console.log('[WeeklyReport] Cron fired — sweeping active clients');

    let clients;
    try {
        const { data, error } = await supabase
            .from('clients')
            .select('id, business_name, owner_phone, workers_paused')
            .eq('workers_paused', false);

        if (error) throw error;
        clients = data || [];
    } catch (err) {
        console.error('[WeeklyReport] Supabase query failed:', err.message);
        return;
    }

    if (!clients.length) {
        console.log('[WeeklyReport] No active clients found — nothing to send');
        return;
    }

    console.log(`[WeeklyReport] Sending to ${clients.length} active client(s)`);

    let sent = 0;
    let skipped = 0;

    for (const client of clients) {
        if (!client.owner_phone) {
            console.warn(`[WeeklyReport] Skipping client ${client.id} — no owner_phone set`);
            skipped++;
            continue;
        }

        try {
            await weeklyReport.run(
                client.id,
                client.business_name || 'Your Business',
                client.owner_phone
            );
            sent++;
        } catch (err) {
            console.error(`[WeeklyReport] Failed for client ${client.id}:`, err.message);
            skipped++;
        }
    }

    console.log(`[WeeklyReport] Done — sent: ${sent}, skipped/errored: ${skipped}`);
}, {
    timezone: 'UTC',
});

console.log('[Cron] Weekly report scheduled — Mondays 8am CT (13:00 UTC)');
