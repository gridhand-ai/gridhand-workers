/**
 * GRIDHAND Billable Hour Hawk — Billing Tracker
 *
 * Core intelligence layer: syncs time entries, flags problems, computes stats.
 *
 * Public surface:
 *   scanUnbilledWork(clientSlug)
 *   flagUnbilledEntry(entry, threshold)
 *   calculateAttorneyStats(clientSlug, period)
 *   checkRetainerLimits(clientSlug)
 *   detectMissingTimeEntries(clientSlug)
 *   summarizeBillingPeriod(clientSlug, month)
 */

'use strict';

require('dotenv').config();

const dayjs  = require('dayjs');
const { createClient } = require('@supabase/supabase-js');
const billingApi = require('./billing-api');

// ─── Supabase ─────────────────────────────────────────────────────────────────

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Internal: DB helpers ─────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('hawk_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    if (error) throw new Error(`No connection found for ${clientSlug}: ${error.message}`);
    return data;
}

async function getAllConnectedClients() {
    const { data, error } = await supabase
        .from('hawk_connections')
        .select('client_slug, firm_name')
        .eq('active', true)
        .order('created_at', { ascending: true });

    // active column may not exist — fall back gracefully
    if (error) {
        const { data: all, error: e2 } = await supabase
            .from('hawk_connections')
            .select('client_slug, firm_name');
        if (e2) throw new Error(`Failed to load clients: ${e2.message}`);
        return all || [];
    }
    return data || [];
}

async function upsertTimeEntry(clientSlug, entry) {
    const { error } = await supabase
        .from('time_entries')
        .upsert({
            client_slug:          clientSlug,
            external_entry_id:    entry.external_entry_id,
            attorney_name:        entry.attorney_name,
            matter_id:            entry.matter_id,
            matter_name:          entry.matter_name,
            client_name:          entry.client_name,
            activity_description: entry.activity_description,
            hours:                entry.hours,
            rate:                 entry.rate,
            amount:               entry.amount,
            entry_date:           entry.entry_date,
            billed:               entry.billed,
            invoice_id:           entry.invoice_id || null,
            flagged_unbilled:     entry.flagged_unbilled || false,
        }, { onConflict: 'client_slug,external_entry_id' });

    if (error) throw new Error(`Failed to upsert time entry ${entry.external_entry_id}: ${error.message}`);
}

async function getLocalUnbilledEntries(clientSlug) {
    const { data, error } = await supabase
        .from('time_entries')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('billed', false)
        .order('entry_date', { ascending: true });

    if (error) throw new Error(`Failed to load unbilled entries: ${error.message}`);
    return data || [];
}

async function markEntryFlagged(clientSlug, externalEntryId) {
    const { error } = await supabase
        .from('time_entries')
        .update({ flagged_unbilled: true })
        .eq('client_slug', clientSlug)
        .eq('external_entry_id', externalEntryId);

    if (error) throw new Error(`Failed to flag entry ${externalEntryId}: ${error.message}`);
}

// ─── scanUnbilledWork ─────────────────────────────────────────────────────────

/**
 * Pull all unbilled time entries from the billing system, save to DB,
 * and flag any that have been sitting unbilled beyond the threshold.
 *
 * Returns: { total, newlyFlagged, entries }
 */
async function scanUnbilledWork(clientSlug) {
    console.log(`[Tracker] Scanning unbilled work for ${clientSlug}`);

    const conn    = await getConnection(clientSlug);
    const entries = await billingApi.getUnbilledEntries(clientSlug);

    const threshold = conn.unbilled_flag_days || 30;
    let newlyFlagged = 0;

    for (const entry of entries) {
        const shouldFlag = flagUnbilledEntry(entry, threshold);

        await upsertTimeEntry(clientSlug, {
            ...entry,
            flagged_unbilled: shouldFlag,
        });

        if (shouldFlag) {
            newlyFlagged++;
        }
    }

    console.log(`[Tracker] ${clientSlug}: ${entries.length} unbilled entries, ${newlyFlagged} newly flagged`);
    return { total: entries.length, newlyFlagged, entries };
}

// ─── flagUnbilledEntry ────────────────────────────────────────────────────────

/**
 * Returns true if the time entry has been unbilled for more than `threshold` days.
 * @param {Object} entry  - normalized time entry with entry_date (YYYY-MM-DD)
 * @param {number} threshold - days before flagging (default 30)
 */
function flagUnbilledEntry(entry, threshold = 30) {
    if (entry.billed) return false;
    if (!entry.entry_date) return false;

    const daysSinceEntry = dayjs().diff(dayjs(entry.entry_date), 'day');
    return daysSinceEntry >= threshold;
}

// ─── calculateAttorneyStats ───────────────────────────────────────────────────

/**
 * Per-attorney billing stats for a given period.
 * period: { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
 *
 * Returns array of:
 *   { attorney_name, hours_logged, hours_billed, realization_rate, revenue_generated }
 */
async function calculateAttorneyStats(clientSlug, period) {
    const { start, end } = period || {
        start: dayjs().startOf('month').format('YYYY-MM-DD'),
        end:   dayjs().endOf('month').format('YYYY-MM-DD'),
    };

    // Pull all entries from billing system for the period
    const entries = await billingApi.getTimeEntries(clientSlug, start, end);

    // Sync to DB
    for (const entry of entries) {
        await upsertTimeEntry(clientSlug, entry);
    }

    // Aggregate by attorney
    const statsMap = {};

    for (const entry of entries) {
        const name = entry.attorney_name || 'Unknown';
        if (!statsMap[name]) {
            statsMap[name] = {
                attorney_name:     name,
                hours_logged:      0,
                hours_billed:      0,
                revenue_generated: 0,
                realization_rate:  0,
            };
        }

        const hours  = parseFloat(entry.hours || 0);
        const amount = parseFloat(entry.amount || 0);

        statsMap[name].hours_logged += hours;

        if (entry.billed) {
            statsMap[name].hours_billed      += hours;
            statsMap[name].revenue_generated += amount;
        }
    }

    // Compute realization rates
    const stats = Object.values(statsMap).map(s => ({
        ...s,
        hours_logged:      Math.round(s.hours_logged * 100) / 100,
        hours_billed:      Math.round(s.hours_billed * 100) / 100,
        revenue_generated: Math.round(s.revenue_generated * 100) / 100,
        realization_rate:  s.hours_logged > 0
            ? Math.round((s.hours_billed / s.hours_logged) * 10000) / 100  // as %
            : 0,
    }));

    // Sort by hours logged descending
    stats.sort((a, b) => b.hours_logged - a.hours_logged);

    console.log(`[Tracker] Attorney stats for ${clientSlug} (${start} to ${end}): ${stats.length} attorneys`);
    return stats;
}

// ─── checkRetainerLimits ──────────────────────────────────────────────────────

/**
 * Find all matters where the retainer balance is below the alert threshold.
 * Default threshold: 20% of total retainer.
 *
 * Returns array of matters needing replenishment alerts.
 */
async function checkRetainerLimits(clientSlug) {
    const conn    = await getConnection(clientSlug);
    const matters = await billingApi.getMatters(clientSlug);

    const threshold = conn.retainer_alert_threshold || 0.20;
    const alerts    = [];

    for (const matter of matters) {
        const retainerLimit   = parseFloat(matter.retainer_limit || 0);
        const retainerBalance = parseFloat(matter.retainer_balance || 0);

        if (retainerLimit <= 0) continue; // no retainer set — skip

        const balancePct = retainerBalance / retainerLimit;

        if (balancePct <= threshold) {
            alerts.push({
                ...matter,
                retainer_limit:   retainerLimit,
                retainer_balance: retainerBalance,
                balance_pct:      Math.round(balancePct * 10000) / 100,  // as %
            });

            // Log alert to DB
            await supabase.from('retainer_alerts').insert({
                client_slug:      clientSlug,
                matter_id:        matter.id,
                matter_name:      matter.description || matter.matter_number,
                retainer_balance: retainerBalance,
                retainer_limit:   retainerLimit,
                balance_pct:      Math.round(balancePct * 10000) / 100,
            });
        }
    }

    console.log(`[Tracker] Retainer check for ${clientSlug}: ${alerts.length} matters below threshold`);
    return alerts;
}

// ─── detectMissingTimeEntries ─────────────────────────────────────────────────

/**
 * Flag attorneys who haven't logged any time in 2+ business days.
 * Returns array of { attorney_name, last_entry_date, days_since_entry }
 */
async function detectMissingTimeEntries(clientSlug) {
    const now       = dayjs();
    const startDate = now.subtract(14, 'day').format('YYYY-MM-DD');
    const endDate   = now.format('YYYY-MM-DD');

    const entries = await billingApi.getTimeEntries(clientSlug, startDate, endDate);

    // Find the most recent entry date per attorney
    const lastEntryMap = {};

    for (const entry of entries) {
        const name = entry.attorney_name || 'Unknown';
        if (!lastEntryMap[name] || entry.entry_date > lastEntryMap[name]) {
            lastEntryMap[name] = entry.entry_date;
        }
    }

    const flagged = [];

    for (const [attorney_name, lastDate] of Object.entries(lastEntryMap)) {
        const daysSince = now.diff(dayjs(lastDate), 'day');
        if (daysSince >= 2) {
            flagged.push({
                attorney_name,
                last_entry_date:  lastDate,
                days_since_entry: daysSince,
            });
        }
    }

    // Also flag attorneys from recent history who logged zero entries in last 2 days
    // (those won't appear in lastEntryMap at all — they have no entries)
    // We detect this by pulling attorney names from the last 30 days and checking
    const { data: recentAttorneys } = await supabase
        .from('time_entries')
        .select('attorney_name')
        .eq('client_slug', clientSlug)
        .gte('entry_date', now.subtract(30, 'day').format('YYYY-MM-DD'))
        .order('attorney_name');

    if (recentAttorneys) {
        const knownAttorneys = new Set((recentAttorneys || []).map(r => r.attorney_name));
        for (const atty of knownAttorneys) {
            if (!lastEntryMap[atty]) {
                flagged.push({
                    attorney_name:    atty,
                    last_entry_date:  null,
                    days_since_entry: 99,  // no entries in lookback window
                });
            }
        }
    }

    // Sort by days since last entry descending
    flagged.sort((a, b) => b.days_since_entry - a.days_since_entry);

    console.log(`[Tracker] Missing time entries for ${clientSlug}: ${flagged.length} attorneys flagged`);
    return flagged;
}

// ─── summarizeBillingPeriod ───────────────────────────────────────────────────

/**
 * Summarize an entire billing month for a client.
 * month: 'YYYY-MM' (e.g. '2025-03')
 *
 * Returns a snapshot object that is also saved to billing_snapshots.
 */
async function summarizeBillingPeriod(clientSlug, month) {
    const startDate = dayjs(month, 'YYYY-MM').startOf('month').format('YYYY-MM-DD');
    const endDate   = dayjs(month, 'YYYY-MM').endOf('month').format('YYYY-MM-DD');

    // Fetch all entries for the period
    const entries = await billingApi.getTimeEntries(clientSlug, startDate, endDate);

    let totalHoursLogged = 0;
    let hoursBilled      = 0;
    let totalBilled      = 0;

    for (const entry of entries) {
        const hours  = parseFloat(entry.hours || 0);
        const amount = parseFloat(entry.amount || 0);
        totalHoursLogged += hours;
        if (entry.billed) {
            hoursBilled  += hours;
            totalBilled  += amount;
        }
    }

    // Get realization rate (collected vs billed)
    const realizationData = await billingApi.getRealizationRate(clientSlug);

    const snapshot = {
        client_slug:        clientSlug,
        snapshot_date:      endDate,
        total_hours_logged: Math.round(totalHoursLogged * 100) / 100,
        hours_billed:       Math.round(hoursBilled * 100) / 100,
        realization_rate:   Math.round(realizationData.realization_rate * 10000) / 100,  // as %
        total_billed:       Math.round(totalBilled * 100) / 100,
        total_collected:    Math.round(realizationData.collected * 100) / 100,
        outstanding:        Math.round((realizationData.billed - realizationData.collected) * 100) / 100,
    };

    // Save to DB
    const { error } = await supabase
        .from('billing_snapshots')
        .upsert(snapshot, { onConflict: 'client_slug,snapshot_date' });

    if (error) {
        console.error(`[Tracker] Failed to save snapshot for ${clientSlug}: ${error.message}`);
    }

    console.log(`[Tracker] Billing summary for ${clientSlug} (${month}): ${snapshot.total_hours_logged}h logged, ${snapshot.hours_billed}h billed`);
    return snapshot;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    scanUnbilledWork,
    flagUnbilledEntry,
    calculateAttorneyStats,
    checkRetainerLimits,
    detectMissingTimeEntries,
    summarizeBillingPeriod,
    getAllConnectedClients,
    getConnection,
};
