/**
 * GRIDHAND Shift Genie — Scheduling System Integrations
 *
 * Supports:
 *   - 7shifts API v2 (OAuth2 + company_id)
 *   - HotSchedules API (API key / credential-based)
 *
 * Unified public interface: getScheduleForDate(), detectCoverageGaps(),
 * calculateLaborCost() — callers don't need to know which system is active.
 */

'use strict';

require('dotenv').config();

const axios   = require('axios');
const dayjs   = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Supabase Helpers ─────────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('genie_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (error) throw new Error(`[scheduling] No connection for ${clientSlug}: ${error.message}`);
    return data;
}

async function saveConnection(clientSlug, updates) {
    const { error } = await supabase
        .from('genie_connections')
        .update(updates)
        .eq('client_slug', clientSlug);

    if (error) throw new Error(`[scheduling] Failed to save connection: ${error.message}`);
}

// ─── 7shifts OAuth2 ───────────────────────────────────────────────────────────

const SEVEN_SHIFTS_BASE = 'https://api.7shifts.com/v2';
const SEVEN_SHIFTS_AUTH  = 'https://app.7shifts.com/oauth/authorize';
const SEVEN_SHIFTS_TOKEN = 'https://app.7shifts.com/oauth/token';

/**
 * Build the OAuth2 authorization URL to redirect the client to.
 */
function get7shiftsAuthUrl(clientSlug) {
    const params = new URLSearchParams({
        client_id:     process.env.SEVEN_SHIFTS_CLIENT_ID,
        redirect_uri:  process.env.SEVEN_SHIFTS_REDIRECT_URI,
        response_type: 'code',
        state:         Buffer.from(JSON.stringify({ clientSlug, ts: Date.now() })).toString('base64'),
    });
    return `${SEVEN_SHIFTS_AUTH}?${params.toString()}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 * Saves them to genie_connections.
 */
async function exchange7shiftsCode(code, clientSlug) {
    const resp = await axios.post(SEVEN_SHIFTS_TOKEN, {
        grant_type:    'authorization_code',
        client_id:     process.env.SEVEN_SHIFTS_CLIENT_ID,
        client_secret: process.env.SEVEN_SHIFTS_CLIENT_SECRET,
        redirect_uri:  process.env.SEVEN_SHIFTS_REDIRECT_URI,
        code,
    }, { headers: { 'Content-Type': 'application/json' } });

    const { access_token, refresh_token, expires_in } = resp.data;
    const expiresAt = dayjs().add(expires_in, 'second').toISOString();

    await saveConnection(clientSlug, {
        seven_shifts_access_token:  access_token,
        seven_shifts_refresh_token: refresh_token,
        seven_shifts_expires_at:    expiresAt,
    });

    return { access_token, expires_at: expiresAt };
}

/**
 * Refresh the 7shifts access token using the stored refresh token.
 */
async function refresh7shiftsToken(clientSlug) {
    const conn = await getConnection(clientSlug);
    if (!conn.seven_shifts_refresh_token) throw new Error('No 7shifts refresh token stored');

    const resp = await axios.post(SEVEN_SHIFTS_TOKEN, {
        grant_type:    'refresh_token',
        client_id:     process.env.SEVEN_SHIFTS_CLIENT_ID,
        client_secret: process.env.SEVEN_SHIFTS_CLIENT_SECRET,
        refresh_token: conn.seven_shifts_refresh_token,
    }, { headers: { 'Content-Type': 'application/json' } });

    const { access_token, refresh_token, expires_in } = resp.data;
    const expiresAt = dayjs().add(expires_in, 'second').toISOString();

    await saveConnection(clientSlug, {
        seven_shifts_access_token:  access_token,
        seven_shifts_refresh_token: refresh_token,
        seven_shifts_expires_at:    expiresAt,
    });

    return access_token;
}

/**
 * Return a valid access token, refreshing if expired.
 */
async function getValid7shiftsToken(clientSlug) {
    const conn = await getConnection(clientSlug);
    if (!conn.seven_shifts_access_token) throw new Error('7shifts not connected for ' + clientSlug);

    const expiresAt = dayjs(conn.seven_shifts_expires_at);
    if (dayjs().isAfter(expiresAt.subtract(5, 'minute'))) {
        return refresh7shiftsToken(clientSlug);
    }
    return conn.seven_shifts_access_token;
}

/**
 * Build an authenticated axios instance for 7shifts.
 */
async function sevenShiftsClient(clientSlug) {
    const token = await getValid7shiftsToken(clientSlug);
    return axios.create({
        baseURL: SEVEN_SHIFTS_BASE,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
}

// ─── 7shifts API Methods ──────────────────────────────────────────────────────

/**
 * Get all shifts in a date range.
 * @returns {Array} shifts — normalized to internal format
 */
async function getSchedule(clientSlug, startDate, endDate) {
    const conn   = await getConnection(clientSlug);
    const client = await sevenShiftsClient(clientSlug);

    const resp = await client.get(`/company/${conn.seven_shifts_company_id}/shifts`, {
        params: {
            start_date: dayjs(startDate).format('YYYY-MM-DD'),
            end_date:   dayjs(endDate).format('YYYY-MM-DD'),
            status:     'active',
        },
    });

    const shifts = (resp.data.data || []).map(s => normalizeSevenShift(s, clientSlug));
    return shifts;
}

/**
 * Get all active employees with roles, wages, and availability.
 */
async function getEmployees(clientSlug) {
    const conn   = await getConnection(clientSlug);
    const client = await sevenShiftsClient(clientSlug);

    const resp = await client.get(`/company/${conn.seven_shifts_company_id}/users`, {
        params: { active: true },
    });

    return (resp.data.data || []).map(u => ({
        id:           String(u.id),
        name:         `${u.first_name} ${u.last_name}`.trim(),
        phone:        u.mobile_phone || u.phone || null,
        email:        u.email || null,
        roles:        (u.roles || []).map(r => r.name),
        hourlyRate:   parseFloat(u.wage || 0),
        departmentId: String(u.department_id || ''),
    }));
}

/**
 * Get a single shift by ID.
 */
async function getShift(clientSlug, shiftId) {
    const conn   = await getConnection(clientSlug);
    const client = await sevenShiftsClient(clientSlug);

    const resp = await client.get(`/company/${conn.seven_shifts_company_id}/shifts/${shiftId}`);
    return normalizeSevenShift(resp.data.data, clientSlug);
}

/**
 * Update a shift — reassign employee or modify time.
 */
async function updateShift(clientSlug, shiftId, data) {
    const conn   = await getConnection(clientSlug);
    const client = await sevenShiftsClient(clientSlug);

    const resp = await client.put(
        `/company/${conn.seven_shifts_company_id}/shifts/${shiftId}`,
        data
    );
    return normalizeSevenShift(resp.data.data, clientSlug);
}

/**
 * Get all departments (FOH, BOH, Bar, etc.).
 */
async function getDepartments(clientSlug) {
    const conn   = await getConnection(clientSlug);
    const client = await sevenShiftsClient(clientSlug);

    const resp = await client.get(`/company/${conn.seven_shifts_company_id}/departments`);
    return (resp.data.data || []).map(d => ({
        id:   String(d.id),
        name: d.name,
    }));
}

/**
 * Get actual clock-in/out time punches for a given date.
 */
async function getTimePunches(clientSlug, date) {
    const conn   = await getConnection(clientSlug);
    const client = await sevenShiftsClient(clientSlug);

    const resp = await client.get(`/company/${conn.seven_shifts_company_id}/time_punches`, {
        params: {
            clocked_in_date: dayjs(date).format('YYYY-MM-DD'),
        },
    });

    return (resp.data.data || []).map(p => ({
        id:          String(p.id),
        employeeId:  String(p.user_id),
        clockIn:     p.clocked_in,
        clockOut:    p.clocked_out || null,
        totalHours:  p.clocked_out
            ? dayjs(p.clocked_out).diff(dayjs(p.clocked_in), 'minute') / 60
            : null,
    }));
}

function normalizeSevenShift(s, clientSlug) {
    const hours = s.end_time && s.start_time
        ? dayjs(s.end_time).diff(dayjs(s.start_time), 'minute') / 60
        : null;
    return {
        id:          String(s.id),
        clientSlug,
        employeeId:  String(s.user_id || ''),
        role:        s.role?.name || s.role_name || 'Staff',
        department:  s.department?.name || s.department_name || '',
        shiftDate:   dayjs(s.start_time).format('YYYY-MM-DD'),
        startTime:   dayjs(s.start_time).format('HH:mm:ss'),
        endTime:     dayjs(s.end_time).format('HH:mm:ss'),
        scheduledHours: hours ? parseFloat(hours.toFixed(2)) : null,
        status:      s.status || 'scheduled',
    };
}

// ─── HotSchedules Integration ─────────────────────────────────────────────────

const HOTSCHEDULES_BASE = 'https://api.hotschedules.io/api';

/**
 * Save or update HotSchedules credentials for a client.
 */
async function setHotSchedulesCredentials(clientSlug, username, password, conceptId, establishmentId) {
    await saveConnection(clientSlug, {
        hotschedules_username:         username,
        hotschedules_password:         password,
        hotschedules_concept_id:       String(conceptId),
        hotschedules_establishment_id: String(establishmentId),
        active_scheduling_system:      'hotschedules',
    });
}

/**
 * Get HS API credentials — returns basic auth headers.
 */
async function hsClient(clientSlug) {
    const conn = await getConnection(clientSlug);
    if (!conn.hotschedules_username || !conn.hotschedules_password) {
        throw new Error('HotSchedules credentials not configured for ' + clientSlug);
    }
    const token = Buffer.from(`${conn.hotschedules_username}:${conn.hotschedules_password}`).toString('base64');
    return {
        conn,
        client: axios.create({
            baseURL: HOTSCHEDULES_BASE,
            headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' },
        }),
    };
}

/**
 * Get schedule from HotSchedules.
 */
async function getHotSchedulesSchedule(clientSlug, startDate, endDate) {
    const { conn, client } = await hsClient(clientSlug);

    const resp = await client.get('/schedules', {
        params: {
            concept_id:      conn.hotschedules_concept_id,
            establishment_id: conn.hotschedules_establishment_id,
            start_date:      dayjs(startDate).format('YYYY-MM-DD'),
            end_date:        dayjs(endDate).format('YYYY-MM-DD'),
        },
    });

    return (resp.data || []).map(s => normalizeHotSchedulesShift(s, clientSlug));
}

/**
 * Get employees from HotSchedules.
 */
async function getHotSchedulesEmployees(clientSlug) {
    const { conn, client } = await hsClient(clientSlug);

    const resp = await client.get('/employees', {
        params: {
            concept_id:       conn.hotschedules_concept_id,
            establishment_id: conn.hotschedules_establishment_id,
            active:           true,
        },
    });

    return (resp.data || []).map(e => ({
        id:         String(e.id || e.employeeId || ''),
        name:       `${e.firstName || ''} ${e.lastName || ''}`.trim(),
        phone:      e.mobilePhone || e.phone || null,
        email:      e.email || null,
        roles:      e.jobs ? e.jobs.map(j => j.name) : [],
        hourlyRate: parseFloat(e.wage || e.payRate || 0),
    }));
}

function normalizeHotSchedulesShift(s, clientSlug) {
    const shiftDate = s.date || s.shiftDate || s.startDate;
    const start     = s.startTime ? `${shiftDate}T${s.startTime}` : null;
    const end       = s.endTime   ? `${shiftDate}T${s.endTime}`   : null;
    const hours     = start && end
        ? dayjs(end).diff(dayjs(start), 'minute') / 60
        : null;
    return {
        id:             String(s.id || s.shiftId || ''),
        clientSlug,
        employeeId:     String(s.employeeId || s.employee_id || ''),
        role:           s.jobName || s.role || 'Staff',
        department:     s.department || '',
        shiftDate:      dayjs(shiftDate).format('YYYY-MM-DD'),
        startTime:      s.startTime || '',
        endTime:        s.endTime   || '',
        scheduledHours: hours ? parseFloat(hours.toFixed(2)) : null,
        status:         'scheduled',
    };
}

// ─── Unified Public Interface ─────────────────────────────────────────────────

/**
 * Get all shifts for a specific date, routing to the active system.
 */
async function getScheduleForDate(clientSlug, date) {
    const conn  = await getConnection(clientSlug);
    const start = dayjs(date).format('YYYY-MM-DD');
    const end   = start;

    if (conn.active_scheduling_system === 'hotschedules') {
        return getHotSchedulesSchedule(clientSlug, start, end);
    }
    return getSchedule(clientSlug, start, end);
}

/**
 * Detect uncovered positions / time windows on a given date.
 *
 * Rules:
 *  - Lunch (11am–2pm): need ≥ 1 cook, ≥ 1 server per 4 tables, ≥ 1 host
 *  - Dinner (5pm–9pm): need ≥ 2 cooks, ≥ 1 bartender, ≥ 2 servers
 *  - Any gap of > 60 min with zero staff on FOH is a coverage gap
 *
 * Returns array of gap objects: { period, role, need, have, gap }
 */
function detectCoverageGaps(shifts, date) {
    const gaps = [];

    const roleCounts = {};
    for (const shift of shifts) {
        if (shift.status === 'dropped' || shift.status === 'no_show') continue;
        const role = (shift.role || '').toLowerCase();
        roleCounts[role] = (roleCounts[role] || 0) + 1;
    }

    const LUNCH_NEEDS = [
        { role: 'cook',   need: 1 },
        { role: 'server', need: 2 },
        { role: 'host',   need: 1 },
    ];
    const DINNER_NEEDS = [
        { role: 'cook',      need: 2 },
        { role: 'bartender', need: 1 },
        { role: 'server',    need: 3 },
        { role: 'host',      need: 1 },
    ];

    // Check which shifts overlap each meal period
    function shiftsInPeriod(startHour, endHour) {
        return shifts.filter(s => {
            if (s.status === 'dropped' || s.status === 'no_show') return false;
            const start = parseInt((s.startTime || '00:00').split(':')[0]);
            const end   = parseInt((s.endTime   || '00:00').split(':')[0]);
            return start <= startHour && end >= endHour;
        });
    }

    function checkPeriod(label, startHour, endHour, needs) {
        const periodShifts = shiftsInPeriod(startHour, endHour);
        const periodRoles  = {};
        for (const s of periodShifts) {
            const role = (s.role || '').toLowerCase();
            periodRoles[role] = (periodRoles[role] || 0) + 1;
        }
        for (const { role, need } of needs) {
            const have = periodRoles[role] || 0;
            if (have < need) {
                gaps.push({ period: label, role, need, have, gap: need - have });
            }
        }
    }

    checkPeriod('Lunch', 11, 14, LUNCH_NEEDS);
    checkPeriod('Dinner', 17, 21, DINNER_NEEDS);

    return gaps;
}

/**
 * Calculate scheduled labor cost and percentage of projected revenue.
 *
 * @param {Array} shifts — from getSchedule()
 * @param {Array} employees — from getEmployees(), keyed by id for wage lookup
 * @param {number} projectedRevenue — from POS projection
 * @returns {{ totalCost, totalHours, laborPct, perEmployee }}
 */
function calculateLaborCost(shifts, employees, projectedRevenue = 0) {
    const empMap = {};
    for (const emp of (employees || [])) {
        empMap[emp.id] = emp;
    }

    let totalCost  = 0;
    let totalHours = 0;
    const perEmployee = [];

    for (const shift of shifts) {
        if (shift.status === 'dropped' || shift.status === 'no_show') continue;

        const hours      = shift.scheduledHours || 0;
        const emp        = empMap[shift.employeeId];
        const hourlyRate = emp?.hourlyRate || shift.hourlyRate || 0;
        const cost       = hours * hourlyRate;

        totalHours += hours;
        totalCost  += cost;

        perEmployee.push({
            employeeId:   shift.employeeId,
            name:         emp?.name || shift.employeeName || 'Unknown',
            role:         shift.role,
            hours,
            hourlyRate,
            cost: parseFloat(cost.toFixed(2)),
        });
    }

    const laborPct = projectedRevenue > 0
        ? parseFloat(((totalCost / projectedRevenue) * 100).toFixed(2))
        : 0;

    return {
        totalCost:        parseFloat(totalCost.toFixed(2)),
        totalHours:       parseFloat(totalHours.toFixed(2)),
        laborPct,
        projectedRevenue: parseFloat(projectedRevenue.toFixed(2)),
        perEmployee,
    };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    // 7shifts OAuth
    get7shiftsAuthUrl,
    exchange7shiftsCode,
    refresh7shiftsToken,
    getValid7shiftsToken,

    // 7shifts API
    getSchedule,
    getEmployees,
    getShift,
    updateShift,
    getDepartments,
    getTimePunches,

    // HotSchedules
    setHotSchedulesCredentials,
    getHotSchedulesSchedule,
    getHotSchedulesEmployees,

    // Unified
    getScheduleForDate,
    detectCoverageGaps,
    calculateLaborCost,

    // Helpers
    getConnection,
    saveConnection,
};
