/**
 * GRIDHAND Deadline Sentinel — Deadline Engine
 *
 * Core logic for scanning, categorizing, scoring urgency,
 * detecting missed deadlines, and generating reports.
 */

'use strict';

require('dotenv').config();

const dayjs    = require('dayjs');
const { createClient } = require('@supabase/supabase-js');
const caseMgmt = require('./case-mgmt');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Deadline Type Classification ─────────────────────────────────────────────

// Keywords that map task titles to deadline types.
const TYPE_PATTERNS = [
    { type: 'statute_of_limitations', keywords: ['statute', 'sol', 'limitations', 'limitation period'] },
    { type: 'court_date',             keywords: ['hearing', 'trial', 'court', 'deposition', 'mediation', 'arbitration', 'conference'] },
    { type: 'filing_deadline',        keywords: ['file', 'filing', 'submit', 'submission', 'serve', 'service', 'complaint', 'motion', 'brief', 'answer', 'petition', 'appeal'] },
    { type: 'discovery_cutoff',       keywords: ['discovery', 'interrogatories', 'depose', 'production', 'disclosure', 'expert'] },
    { type: 'response_due',           keywords: ['respond', 'response', 'reply', 'objection', 'opposition'] },
];

/**
 * Classify a deadline by its title/description text.
 *
 * @param {{ title: string, description?: string }} deadline
 * @returns {'statute_of_limitations'|'filing_deadline'|'court_date'|'discovery_cutoff'|'response_due'|'general_task'}
 */
function categorizeDeadline(deadline) {
    const text = `${deadline.title || ''} ${deadline.description || ''}`.toLowerCase();

    for (const { type, keywords } of TYPE_PATTERNS) {
        if (keywords.some(kw => text.includes(kw))) return type;
    }

    return 'general_task';
}

// ─── Urgency Calculation ──────────────────────────────────────────────────────

/**
 * Calculate urgency based on how many days until the deadline.
 *
 * @param {{ dueDate: string }} deadline  — dueDate as 'YYYY-MM-DD'
 * @returns {'critical'|'urgent'|'warning'|'normal'}
 */
function calculateUrgency(deadline) {
    const daysUntil = dayjs(deadline.dueDate).diff(dayjs().startOf('day'), 'day');

    if (daysUntil <= 3)  return 'critical';
    if (daysUntil <= 7)  return 'urgent';
    if (daysUntil <= 14) return 'warning';
    return 'normal';
}

// ─── Scan All Deadlines ───────────────────────────────────────────────────────

/**
 * Full sweep for a client:
 *  1. Fetch all active matters from Clio/MyCase
 *  2. Fetch all tasks/calendar entries per matter
 *  3. Upsert into tracked_deadlines with current urgency
 *
 * @param {string} clientSlug
 * @returns {{ upserted: number, matters: number }}
 */
async function scanAllDeadlines(clientSlug) {
    console.log(`[Deadlines] Starting full scan for ${clientSlug}`);
    const matters = await caseMgmt.getMatters(clientSlug);
    let upserted = 0;

    for (const matter of matters) {
        let rawDeadlines;
        try {
            rawDeadlines = await caseMgmt.getDeadlinesForMatter(clientSlug, matter.id);
        } catch (err) {
            console.error(`[Deadlines] Failed to fetch deadlines for matter ${matter.id}: ${err.message}`);
            continue;
        }

        for (const raw of rawDeadlines) {
            // Skip already-completed items
            if (raw.status === 'completed' || raw.completedAt) {
                // Mark completed in our DB if we were tracking it as upcoming
                await supabase
                    .from('tracked_deadlines')
                    .update({ status: 'completed', updated_at: new Date().toISOString() })
                    .eq('client_slug', clientSlug)
                    .eq('external_task_id', raw.externalId)
                    .eq('status', 'upcoming');
                continue;
            }

            const type    = categorizeDeadline({ title: raw.title });
            const urgency = calculateUrgency({ dueDate: raw.dueDate });

            const row = {
                client_slug:      clientSlug,
                matter_id:        matter.id,
                matter_name:      matter.name,
                client_name:      matter.clientName,
                attorney_name:    matter.assignedAttorney,
                deadline_date:    raw.dueDate,
                deadline_type:    type,
                description:      raw.title,
                urgency,
                status:           'upcoming',
                external_task_id: raw.externalId,
                updated_at:       new Date().toISOString(),
            };

            const { error } = await supabase
                .from('tracked_deadlines')
                .upsert(row, { onConflict: 'client_slug,external_task_id' });

            if (error) {
                console.error(`[Deadlines] Upsert failed for ${raw.externalId}: ${error.message}`);
            } else {
                upserted++;
            }
        }
    }

    console.log(`[Deadlines] Scan complete for ${clientSlug}: ${upserted} deadlines upserted across ${matters.length} matters`);
    return { upserted, matters: matters.length };
}

// ─── Missed Deadline Detection ────────────────────────────────────────────────

/**
 * Find all deadlines whose date has passed and status is still 'upcoming'.
 * Marks them as 'missed' in the DB.
 *
 * @param {string} clientSlug
 * @returns {Array} missed deadline rows
 */
async function checkForMissedDeadlines(clientSlug) {
    const today = dayjs().format('YYYY-MM-DD');

    const { data: missed, error } = await supabase
        .from('tracked_deadlines')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'upcoming')
        .lt('deadline_date', today);  // strictly before today = overdue

    if (error) {
        console.error(`[Deadlines] checkForMissed query failed for ${clientSlug}: ${error.message}`);
        return [];
    }

    if (!missed || missed.length === 0) return [];

    // Batch update to missed
    const ids = missed.map(d => d.id);
    await supabase
        .from('tracked_deadlines')
        .update({ status: 'missed', updated_at: new Date().toISOString() })
        .in('id', ids);

    console.log(`[Deadlines] Marked ${missed.length} deadlines as missed for ${clientSlug}`);
    return missed;
}

// ─── Upcoming Deadlines Query ─────────────────────────────────────────────────

/**
 * Return all upcoming deadlines within the next N days for a client.
 *
 * @param {string} clientSlug
 * @param {number} days  — look-ahead window
 * @returns {Array} sorted by deadline_date ASC
 */
async function getUpcomingDeadlines(clientSlug, days = 30) {
    const today  = dayjs().format('YYYY-MM-DD');
    const cutoff = dayjs().add(days, 'day').format('YYYY-MM-DD');

    const { data, error } = await supabase
        .from('tracked_deadlines')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'upcoming')
        .gte('deadline_date', today)
        .lte('deadline_date', cutoff)
        .order('deadline_date', { ascending: true });

    if (error) throw new Error(`getUpcomingDeadlines failed: ${error.message}`);
    return data || [];
}

/**
 * Return only critical/urgent deadlines (≤7 days) for a client.
 */
async function getUrgentDeadlines(clientSlug) {
    const cutoff = dayjs().add(7, 'day').format('YYYY-MM-DD');
    const today  = dayjs().format('YYYY-MM-DD');

    const { data, error } = await supabase
        .from('tracked_deadlines')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'upcoming')
        .gte('deadline_date', today)
        .lte('deadline_date', cutoff)
        .order('deadline_date', { ascending: true });

    if (error) throw new Error(`getUrgentDeadlines failed: ${error.message}`);
    return data || [];
}

// ─── Weekly Report Generation ─────────────────────────────────────────────────

/**
 * Compile counts and details for the weekly deadline report.
 *
 * @param {string} clientSlug
 * @returns {object} report data object (used by alerts.js to format the SMS)
 */
async function generateWeeklyReport(clientSlug) {
    const conn = await caseMgmt.getConnection(clientSlug);

    // Date windows
    const today        = dayjs().startOf('day');
    const in3Days      = today.add(3,  'day').format('YYYY-MM-DD');
    const in7Days      = today.add(7,  'day').format('YYYY-MM-DD');
    const in14Days     = today.add(14, 'day').format('YYYY-MM-DD');
    const weekAgo      = today.subtract(7, 'day').format('YYYY-MM-DD');
    const todayStr     = today.format('YYYY-MM-DD');

    // Fetch all upcoming in the next 14 days
    const { data: upcoming } = await supabase
        .from('tracked_deadlines')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'upcoming')
        .gte('deadline_date', todayStr)
        .lte('deadline_date', in14Days)
        .order('deadline_date', { ascending: true });

    // Missed in the past 7 days
    const { data: missedThisWeek } = await supabase
        .from('tracked_deadlines')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'missed')
        .gte('deadline_date', weekAgo)
        .lt('deadline_date', todayStr);

    const upcomingList = upcoming || [];
    const missedList   = missedThisWeek || [];

    const critical  = upcomingList.filter(d => d.deadline_date <= in3Days);
    const urgent    = upcomingList.filter(d => d.deadline_date > in3Days && d.deadline_date <= in7Days);
    const warning   = upcomingList.filter(d => d.deadline_date > in7Days);
    const courtDates  = upcomingList.filter(d => d.deadline_type === 'court_date');
    const filingDates = upcomingList.filter(d => d.deadline_type === 'filing_deadline');

    // Save compliance snapshot
    await supabase.from('compliance_log').upsert({
        client_slug:     clientSlug,
        matter_id:       null,
        check_date:      todayStr,
        total_deadlines: upcomingList.length + missedList.length,
        on_track:        upcomingList.length,
        missed:          missedList.length,
        extended:        0,
    }, { onConflict: 'client_slug,matter_id,check_date' });

    return {
        firmName:       conn?.firm_name || clientSlug,
        weekOf:         today.format('MMM D, YYYY'),
        criticalCount:  critical.length,
        urgentCount:    urgent.length,
        warningCount:   warning.length,
        missedCount:    missedList.length,
        courtDatesCount: courtDates.length,
        filingCount:    filingDates.length,
        criticalItems:  critical,
        urgentItems:    urgent,
        missedItems:    missedList,
        allUpcoming:    upcomingList,
    };
}

module.exports = {
    categorizeDeadline,
    calculateUrgency,
    scanAllDeadlines,
    checkForMissedDeadlines,
    getUpcomingDeadlines,
    getUrgentDeadlines,
    generateWeeklyReport,
};
