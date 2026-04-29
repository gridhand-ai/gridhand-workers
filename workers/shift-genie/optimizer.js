/**
 * GRIDHAND Shift Genie — Schedule Optimizer
 *
 * Core intelligence layer:
 *  - Analyzes demand patterns from POS data
 *  - Recommends optimal staffing levels per hour/role
 *  - Processes shift swap requests via SMS
 *  - Detects understaffed shifts
 *  - Sends manager alerts and daily schedule summaries
 */

'use strict';

require('dotenv').config();

const dayjs   = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

const scheduling = require('./scheduling');
const pos        = require('./pos');
const { sendSMS } = require('../../lib/twilio-client');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── SMS Helper ───────────────────────────────────────────────────────────────

async function sendSms(to, body, clientSlug, alertType) {
    if (!to) {
        console.warn(`[optimizer] sendSms — no recipient for alertType=${alertType}`);
        return;
    }

    await sendSMS({
        to,
        body,
        clientSlug,
        clientTimezone: undefined,
    });

    // Log to schedule_alerts
    await supabase.from('schedule_alerts').insert({
        client_slug:  clientSlug,
        alert_type:   alertType,
        recipient:    to,
        message_body: body,
    });

    console.log(`[optimizer] SMS sent to ${to} (${alertType})`);
}

// ─── Staffing Model ───────────────────────────────────────────────────────────

/**
 * Calculate optimal staff count by role for a given hour, based on projected revenue.
 *
 * Tiers:
 *   < $500/hr  → skeleton crew
 *   $500–1500  → standard staffing
 *   $1500+     → full crew
 *
 * @param {number} projectedHourlyRevenue
 * @param {number} dayOfWeek — 0=Sunday, 6=Saturday
 * @returns {Object} { server, cook, host, bartender, busser }
 */
function calculateOptimalStaffing(projectedHourlyRevenue, dayOfWeek) {
    const rev = projectedHourlyRevenue;

    if (rev < 500) {
        // Skeleton crew
        return {
            server:    1,
            cook:      1,
            host:      0,
            bartender: dayOfWeek >= 5 ? 1 : 0,  // Fri/Sat always need bar
            busser:    0,
        };
    }

    if (rev < 1500) {
        // Standard staffing
        return {
            server:    2,
            cook:      2,
            host:      1,
            bartender: 1,
            busser:    1,
        };
    }

    // Full crew ($1500+/hr)
    return {
        server:    4,
        cook:      3,
        host:      2,
        bartender: 2,
        busser:    2,
    };
}

// ─── Schedule Optimization ────────────────────────────────────────────────────

/**
 * Analyze next week's schedule against projected demand.
 * Returns suggestions the manager can act on.
 *
 * @param {string} clientSlug
 * @param {string} weekStart — YYYY-MM-DD (Monday)
 * @returns {Object} { suggestions, laborProjection }
 */
async function optimizeSchedule(clientSlug, weekStart) {
    const conn      = await scheduling.getConnection(clientSlug);
    const weekEnd   = dayjs(weekStart).add(6, 'day').format('YYYY-MM-DD');
    const employees = await scheduling.getEmployees(clientSlug);

    const suggestions    = [];
    let   totalWeekCost  = 0;
    let   totalWeekHours = 0;

    for (let i = 0; i < 7; i++) {
        const date    = dayjs(weekStart).add(i, 'day').format('YYYY-MM-DD');
        const dayName = dayjs(date).format('dddd');

        let shifts = [];
        try {
            shifts = await scheduling.getScheduleForDate(clientSlug, date);
        } catch (err) {
            console.warn(`[optimizer] Could not get schedule for ${date}: ${err.message}`);
        }

        // Get projected revenue for staffing decisions
        let hourlyPattern = {};
        let totalProjected = 0;
        try {
            const posData    = await pos.getHourlySalesPattern(clientSlug, date);
            hourlyPattern    = posData.hourlyPattern;
            totalProjected   = posData.totalProjected;
        } catch (err) {
            console.warn(`[optimizer] POS data unavailable for ${date}: ${err.message}`);
        }

        // Labor cost for the day
        const laborData = scheduling.calculateLaborCost(shifts, employees, totalProjected);
        totalWeekCost  += laborData.totalCost;
        totalWeekHours += laborData.totalHours;

        // Check coverage gaps
        const gaps = scheduling.detectCoverageGaps(shifts, date);
        for (const gap of gaps) {
            suggestions.push({
                date,
                dayName,
                type:    'understaffed',
                period:  gap.period,
                role:    gap.role,
                need:    gap.need,
                have:    gap.have,
                message: `${dayName} ${gap.period}: Need ${gap.gap} more ${gap.role}(s)`,
            });
        }

        // Check for overstaffing during slow hours
        const peakHour  = Object.entries(hourlyPattern).sort((a, b) => b[1] - a[1])[0];
        const slowHour  = Object.entries(hourlyPattern).sort((a, b) => a[1] - b[1])[0];
        const peakRev   = peakHour ? peakHour[1] : 0;

        if (peakRev < 300 && shifts.length > 4) {
            suggestions.push({
                date,
                dayName,
                type:    'overstaffed',
                message: `${dayName}: Low projected revenue ($${peakRev.toFixed(0)}/hr peak) — consider reducing staff by 1–2`,
            });
        }

        // Labor cost warning
        if (laborData.laborPct > conn.labor_cost_target * 100 * 1.1) { // 10% over target
            suggestions.push({
                date,
                dayName,
                type:    'high_labor_cost',
                message: `${dayName}: Labor at ${laborData.laborPct}% — target is ${(conn.labor_cost_target * 100).toFixed(0)}%`,
            });
        }
    }

    const target = conn.labor_cost_target || 0.30;

    // Send summary to GM
    if (conn.gm_phone && suggestions.length > 0) {
        const lines = suggestions.slice(0, 8).map(s => `• ${s.message}`).join('\n');
        const msg = [
            `📋 Next Week Schedule Review — ${conn.restaurant_name}`,
            `Week of ${dayjs(weekStart).format('MMM D')}`,
            `─────────────────`,
            `Suggestions (${suggestions.length}):`,
            lines,
            `─────────────────`,
            `Projected labor: $${totalWeekCost.toFixed(0)} | ${totalWeekHours.toFixed(0)}hrs`,
            `Target: ${(target * 100).toFixed(0)}% labor cost`,
        ].join('\n');

        await sendSms(conn.gm_phone, msg, clientSlug, 'schedule_optimization');
    }

    return {
        weekStart,
        weekEnd,
        suggestions,
        laborProjection: {
            totalCost:  parseFloat(totalWeekCost.toFixed(2)),
            totalHours: parseFloat(totalWeekHours.toFixed(2)),
            target,
        },
    };
}

// ─── Shift Swap Flow ──────────────────────────────────────────────────────────

/**
 * Process a swap request from an employee.
 * Finds eligible available staff and sends them a pickup offer via SMS.
 *
 * @param {string} clientSlug
 * @param {string} requesterId — employee_id
 * @param {string} targetDate — YYYY-MM-DD
 * @param {string} targetShift — 'lunch', 'dinner', or time like '17:00'
 * @returns {Object} { swapId, offered, offeredTo }
 */
async function processShiftSwapRequest(clientSlug, requesterId, targetDate, targetShift) {
    const conn = await scheduling.getConnection(clientSlug);

    // Find the requester's shift on that date
    const shifts = await scheduling.getScheduleForDate(clientSlug, targetDate);
    const employees = await scheduling.getEmployees(clientSlug);

    // Match shift by period name or time
    const shiftPeriod = (targetShift || '').toLowerCase();
    let requesterShift = null;

    for (const shift of shifts) {
        if (shift.employeeId !== requesterId) continue;
        const hour = parseInt((shift.startTime || '00').split(':')[0]);
        const isLunch  = hour >= 10 && hour < 15;
        const isDinner = hour >= 15;

        if (shiftPeriod === 'lunch' && isLunch)  { requesterShift = shift; break; }
        if (shiftPeriod === 'dinner' && isDinner) { requesterShift = shift; break; }

        // Try matching time directly
        if (shift.startTime && shift.startTime.startsWith(shiftPeriod)) {
            requesterShift = shift;
            break;
        }
    }

    // If no match by period, take first shift of the day for this employee
    if (!requesterShift) {
        requesterShift = shifts.find(s => s.employeeId === requesterId);
    }

    if (!requesterShift) {
        throw new Error(`No shift found for employee ${requesterId} on ${targetDate} (${targetShift})`);
    }

    // Find employees available for pickup (not already scheduled that shift)
    const scheduledEmployeeIds = new Set(
        shifts
            .filter(s => {
                const sHour = parseInt((s.startTime || '00').split(':')[0]);
                const rHour = parseInt((requesterShift.startTime || '00').split(':')[0]);
                return Math.abs(sHour - rHour) <= 2; // overlapping window
            })
            .map(s => s.employeeId)
    );

    // Check employee_availability table
    const { data: availableRows } = await supabase
        .from('employee_availability')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('available_date', targetDate);

    const availableIds = new Set((availableRows || []).map(r => r.employee_id));

    // Find a matching employee — same role, not already scheduled
    const eligible = employees.filter(emp => {
        if (emp.id === requesterId) return false;
        if (scheduledEmployeeIds.has(emp.id)) return false;
        const hasRole = emp.roles.some(r =>
            r.toLowerCase().includes(requesterShift.role.toLowerCase())
        );
        return hasRole || availableIds.has(emp.id);
    });

    if (eligible.length === 0) {
        // No one available — alert manager instead
        const shiftStart = requesterShift.startTime.slice(0, 5);
        const shiftEnd   = requesterShift.endTime.slice(0, 5);
        const msg = [
            `⚠️ Swap Request — ${conn.restaurant_name}`,
            `Employee needs coverage on ${dayjs(targetDate).format('MMM D')}`,
            `Shift: ${shiftStart}–${shiftEnd} (${requesterShift.role})`,
            `No available staff found. Manual coverage needed.`,
        ].join('\n');

        if (conn.manager_phone) {
            await sendSms(conn.manager_phone, msg, clientSlug, 'coverage_gap');
        }
        return { swapId: null, offered: false, offeredTo: null };
    }

    // Pick the first eligible employee
    const target = eligible[0];

    // Create swap record
    const { data: swapRecord, error: swapErr } = await supabase
        .from('swap_requests')
        .insert({
            client_slug:      clientSlug,
            requester_id:     requesterId,
            requester_phone:  employees.find(e => e.id === requesterId)?.phone || '',
            shift_id:         null, // we'll use the external ID lookup
            target_date:      targetDate,
            target_shift_start: requesterShift.startTime,
            status:           'offered',
            offered_to_employee_id: target.id,
            offered_at:       new Date().toISOString(),
        })
        .select()
        .single();

    if (swapErr) throw new Error(`[optimizer] Failed to create swap record: ${swapErr.message}`);

    // Estimate pay for the shift
    const hours          = requesterShift.scheduledHours || 0;
    const estimatedPay   = parseFloat((hours * (target.hourlyRate || 0)).toFixed(2));
    const shiftStart     = requesterShift.startTime.slice(0, 5);
    const shiftEnd       = requesterShift.endTime.slice(0, 5);

    const offerMsg = [
        `📲 Shift Pickup Opportunity — ${conn.restaurant_name}`,
        `${dayjs(targetDate).format('ddd MMM D')} ${shiftStart}–${shiftEnd} - ${requesterShift.role}`,
        estimatedPay > 0 ? `Pay: ~$${estimatedPay.toFixed(0)}` : '',
        `Reply PICKUP ${swapRecord.id.slice(0, 8)} to accept`,
        `Offer expires in 2 hours`,
    ].filter(Boolean).join('\n');

    if (target.phone) {
        await sendSms(target.phone, offerMsg, clientSlug, 'swap_offer');
    }

    return {
        swapId:    swapRecord.id,
        offered:   true,
        offeredTo: { id: target.id, name: target.name, phone: target.phone },
    };
}

/**
 * Handle a swap acceptance (employee replies PICKUP [id]).
 * Updates the schedule in 7shifts and notifies both parties.
 *
 * @param {string} clientSlug
 * @param {string} swapId — swap_requests.id (first 8 chars allowed)
 * @param {string} acceptorId — employee_id
 */
async function handleSwapAcceptance(clientSlug, swapId, acceptorId) {
    const conn = await scheduling.getConnection(clientSlug);

    // Look up the swap record — allow partial ID match
    const { data: swaps, error } = await supabase
        .from('swap_requests')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'offered')
        .ilike('id::text', `${swapId}%`);

    if (error || !swaps?.length) {
        throw new Error(`Swap request not found: ${swapId}`);
    }

    const swap = swaps[0];

    // Verify acceptor is the person the offer was made to
    if (swap.offered_to_employee_id !== acceptorId) {
        throw new Error(`Employee ${acceptorId} was not the offer recipient`);
    }

    // Check offer not expired (2 hours)
    const offeredAt = dayjs(swap.offered_at);
    if (dayjs().diff(offeredAt, 'hour') > 2) {
        await supabase
            .from('swap_requests')
            .update({ status: 'declined' })
            .eq('id', swap.id);
        throw new Error('Swap offer expired');
    }

    // Update swap status
    await supabase
        .from('swap_requests')
        .update({ status: 'accepted', accepted_at: new Date().toISOString() })
        .eq('id', swap.id);

    // Update scheduled_shifts table
    const employees  = await scheduling.getEmployees(clientSlug);
    const acceptor   = employees.find(e => e.id === acceptorId);
    const requester  = employees.find(e => e.id === swap.requester_id);

    // Mark the original shift as swapped
    await supabase
        .from('scheduled_shifts')
        .update({ status: 'swapped', employee_id: acceptorId, employee_name: acceptor?.name || '' })
        .eq('client_slug', clientSlug)
        .eq('employee_id', swap.requester_id)
        .eq('shift_date', swap.target_date);

    // Notify requester (their shift is covered)
    if (requester?.phone) {
        const confirmedMsg = [
            `✅ Shift Covered — ${conn.restaurant_name}`,
            `Your ${dayjs(swap.target_date).format('MMM D')} shift has been picked up by ${acceptor?.name || 'a colleague'}.`,
            `You're all set!`,
        ].join('\n');
        await sendSms(requester.phone, confirmedMsg, clientSlug, 'swap_confirmed');
    }

    // Notify acceptor (confirm they have the shift)
    if (acceptor?.phone) {
        const acceptedMsg = [
            `✅ Shift Confirmed — ${conn.restaurant_name}`,
            `You're now scheduled for ${dayjs(swap.target_date).format('ddd MMM D')} at ${swap.target_shift_start?.slice(0, 5) || 'TBD'}.`,
            `See you then!`,
        ].join('\n');
        await sendSms(acceptor.phone, acceptedMsg, clientSlug, 'swap_confirmed');
    }

    // Alert manager
    if (conn.manager_phone) {
        const managerMsg = [
            `🔄 Shift Swap Confirmed — ${conn.restaurant_name}`,
            `${dayjs(swap.target_date).format('MMM D')}: ${requester?.name || swap.requester_id} → ${acceptor?.name || acceptorId}`,
            `Schedule updated automatically.`,
        ].join('\n');
        await sendSms(conn.manager_phone, managerMsg, clientSlug, 'swap_confirmed');
    }

    return { success: true, swapId: swap.id, acceptor: acceptor?.name };
}

// ─── Coverage Gap Detection ───────────────────────────────────────────────────

/**
 * Detect understaffed shifts for a given date.
 * Compares actual scheduling against demand-based optimal staffing.
 *
 * @returns {Array} understaffedShifts — shifts needing coverage
 */
async function detectUnderstaffedShifts(clientSlug, date) {
    const shifts     = await scheduling.getScheduleForDate(clientSlug, date);
    const gaps       = scheduling.detectCoverageGaps(shifts, date);

    let hourlyPattern = {};
    try {
        const posData = await pos.getHourlySalesPattern(clientSlug, date);
        hourlyPattern = posData.hourlyPattern;
    } catch (err) {
        console.warn(`[optimizer] POS unavailable for ${date}: ${err.message}`);
    }

    // Build detailed understaffed shift records
    const understaffed = gaps.map(gap => {
        const periodHour = gap.period === 'Lunch' ? 12 : 18;
        const revenue    = hourlyPattern[periodHour] || 0;
        const optimal    = calculateOptimalStaffing(revenue, dayjs(date).day());
        return {
            date,
            period:      gap.period,
            role:        gap.role,
            have:        gap.have,
            need:        gap.need,
            gap:         gap.gap,
            optimalCrew: optimal,
            revenue,
        };
    });

    return understaffed;
}

/**
 * Get the labor cost % target configured for this client.
 */
async function calculateLaborPercentTarget(clientSlug) {
    const conn = await scheduling.getConnection(clientSlug);
    return conn.labor_cost_target || 0.30;
}

// ─── SMS Alerts ───────────────────────────────────────────────────────────────

/**
 * Send a coverage gap alert to the manager.
 */
async function sendCoverageAlert(clientSlug, gap) {
    const conn = await scheduling.getConnection(clientSlug);
    if (!conn.manager_phone) return;

    const msg = [
        `⚠️ Coverage Gap — ${conn.restaurant_name}`,
        `${gap.period} on ${dayjs(gap.date).format('ddd MMM D')} is understaffed`,
        `Need: ${gap.need} ${gap.role}`,
        `Currently scheduled: ${gap.have}`,
        `Reply FIND to search for coverage`,
    ].join('\n');

    await sendSms(conn.manager_phone, msg, clientSlug, 'coverage_gap');
}

/**
 * Send the daily schedule summary to the manager at 7am.
 * Groups shifts by meal period (Lunch / Dinner).
 */
async function sendDailyScheduleSummary(clientSlug, date) {
    const conn      = await scheduling.getConnection(clientSlug);
    const employees = await scheduling.getEmployees(clientSlug);
    if (!conn.manager_phone) {
        console.warn(`[optimizer] No manager_phone for ${clientSlug} — skipping summary`);
        return;
    }

    let shifts = [];
    try {
        shifts = await scheduling.getScheduleForDate(clientSlug, date);
    } catch (err) {
        console.warn(`[optimizer] Could not get schedule for ${date}: ${err.message}`);
    }

    // Build employee lookup
    const empMap = {};
    for (const emp of employees) empMap[emp.id] = emp;

    // Separate shifts into lunch and dinner crews
    const lunch  = shifts.filter(s => parseInt((s.startTime || '00').split(':')[0]) < 15);
    const dinner = shifts.filter(s => parseInt((s.startTime || '00').split(':')[0]) >= 15);

    function formatCrew(crew) {
        return crew.map(s => {
            const emp   = empMap[s.employeeId];
            const name  = emp?.name || s.employeeName || 'Unknown';
            const start = (s.startTime || '').slice(0, 5);
            const end   = (s.endTime   || '').slice(0, 5);
            return `• ${s.role}: ${name} ${start}–${end}`;
        });
    }

    // Labor projection
    let projectedRevenue = 0;
    try {
        const posData = await pos.getHourlySalesPattern(clientSlug, date);
        projectedRevenue = posData.totalProjected;
    } catch {}

    const laborData  = scheduling.calculateLaborCost(shifts, employees, projectedRevenue);
    const openShifts = shifts.filter(s => !s.employeeId || s.status === 'dropped').length;
    const dayName    = dayjs(date).format('ddd MMM D');

    const lines = [
        `📅 Schedule — ${conn.restaurant_name} ${dayName}`,
        `─────────────────`,
    ];

    if (lunch.length > 0) {
        lines.push(`Lunch crew (${lunch.length} staff):`);
        lines.push(...formatCrew(lunch));
    }

    if (dinner.length > 0) {
        lines.push(`Dinner crew (${dinner.length} staff):`);
        lines.push(...formatCrew(dinner));
    }

    lines.push(
        `─────────────────`,
        `Labor projection: $${laborData.totalCost.toFixed(0)} (${laborData.laborPct}% target)`,
        `Open shifts: ${openShifts}`,
        `Reply DETAIL for full list`
    );

    // Save today's labor snapshot
    try {
        await supabase
            .from('labor_snapshots')
            .upsert({
                client_slug:      clientSlug,
                snapshot_date:    date,
                total_shifts:     shifts.length,
                total_hours:      laborData.totalHours,
                total_labor_cost: laborData.totalCost,
                projected_revenue: projectedRevenue,
                labor_pct:        laborData.laborPct,
            }, { onConflict: 'client_slug,snapshot_date' });
    } catch (err) {
        console.warn(`[optimizer] Failed to save labor snapshot: ${err.message}`);
    }

    await sendSms(conn.manager_phone, lines.join('\n'), clientSlug, 'daily_summary');
}

/**
 * Send the weekly labor cost report to the GM (every Monday morning).
 */
async function sendWeeklyLaborReport(clientSlug) {
    const conn = await scheduling.getConnection(clientSlug);
    if (!conn.gm_phone && !conn.manager_phone) return;

    const weekEnd   = dayjs().subtract(1, 'day').format('YYYY-MM-DD'); // yesterday (Sunday)
    const weekStart = dayjs(weekEnd).subtract(6, 'day').format('YYYY-MM-DD');

    const { data: snapshots } = await supabase
        .from('labor_snapshots')
        .select('*')
        .eq('client_slug', clientSlug)
        .gte('snapshot_date', weekStart)
        .lte('snapshot_date', weekEnd)
        .order('snapshot_date');

    if (!snapshots?.length) {
        console.warn(`[optimizer] No snapshots found for ${clientSlug} week ${weekStart}–${weekEnd}`);
        return;
    }

    const totalCost    = snapshots.reduce((s, r) => s + parseFloat(r.total_labor_cost), 0);
    const totalRevenue = snapshots.reduce((s, r) => s + parseFloat(r.projected_revenue), 0);
    const totalHours   = snapshots.reduce((s, r) => s + parseFloat(r.total_hours), 0);
    const weeklyPct    = totalRevenue > 0
        ? ((totalCost / totalRevenue) * 100).toFixed(1)
        : '—';
    const target       = ((conn.labor_cost_target || 0.30) * 100).toFixed(0);
    const overUnder    = totalRevenue > 0
        ? ((totalCost / totalRevenue) - (conn.labor_cost_target || 0.30)) * 100
        : 0;
    const status       = overUnder > 0
        ? `⚠️ ${overUnder.toFixed(1)}% over target`
        : `✅ ${Math.abs(overUnder).toFixed(1)}% under target`;

    const msg = [
        `📊 Weekly Labor Report — ${conn.restaurant_name}`,
        `Week of ${dayjs(weekStart).format('MMM D')}`,
        `─────────────────`,
        `Total labor cost:  $${totalCost.toFixed(0)}`,
        `Total revenue:     $${totalRevenue.toFixed(0)}`,
        `Total hours:       ${totalHours.toFixed(0)}hrs`,
        `Labor %:           ${weeklyPct}% (target ${target}%)`,
        status,
        `─────────────────`,
        ...snapshots.map(s =>
            `${dayjs(s.snapshot_date).format('ddd')}: $${parseFloat(s.total_labor_cost).toFixed(0)} (${parseFloat(s.labor_pct).toFixed(1)}%)`
        ),
    ].join('\n');

    const phone = conn.gm_phone || conn.manager_phone;
    await sendSms(phone, msg, clientSlug, 'labor_report');
}

module.exports = {
    calculateOptimalStaffing,
    optimizeSchedule,
    processShiftSwapRequest,
    handleSwapAcceptance,
    detectUnderstaffedShifts,
    calculateLaborPercentTarget,
    sendCoverageAlert,
    sendDailyScheduleSummary,
    sendWeeklyLaborReport,
    sendSms,
};
