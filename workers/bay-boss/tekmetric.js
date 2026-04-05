// Tekmetric API v1 Client
// Docs: https://api.tekmetric.com/api/v1
// Auth: Bearer token in Authorization header
// All requests scoped to a shop ID

const axios = require('axios');

const BASE_URL = 'https://api.tekmetric.com/api/v1';

// ─── HTTP client factory ──────────────────────────────────────────────────────
function getClient(apiKey) {
    if (!apiKey) throw new Error('Tekmetric API key required. Set TEKMETRIC_API_KEY or add to client config.');
    return axios.create({
        baseURL: BASE_URL,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        timeout: 15000,
    });
}

// ─── Repair Orders ────────────────────────────────────────────────────────────
// Returns all open/active repair orders for a shop on a given date
async function getRepairOrders(apiKey, shopId, options = {}) {
    const client = getClient(apiKey);
    const {
        startDate = new Date().toISOString().split('T')[0],
        endDate   = new Date().toISOString().split('T')[0],
        status    = null, // 'ESTIMATE', 'WORK_IN_PROGRESS', 'COMPLETE', 'INVOICED'
        page      = 0,
        size      = 100,
    } = options;

    const params = { shopId, startDate, endDate, page, size };
    if (status) params.repairOrderStatus = status;

    try {
        const res = await client.get('/repair-orders', { params });
        const orders = res.data?.content || res.data || [];

        console.log(`[Tekmetric] Fetched ${orders.length} repair orders for shop ${shopId} on ${startDate}`);
        return orders;
    } catch (e) {
        console.error(`[Tekmetric] getRepairOrders error: ${e.response?.status} ${e.message}`);
        throw new Error(`Tekmetric API error: ${e.response?.data?.message || e.message}`);
    }
}

// ─── Appointments ─────────────────────────────────────────────────────────────
// Returns scheduled appointments for a shop on a given date range
async function getAppointments(apiKey, shopId, options = {}) {
    const client = getClient(apiKey);
    const {
        startDate = new Date().toISOString().split('T')[0],
        endDate   = new Date().toISOString().split('T')[0],
        page      = 0,
        size      = 100,
    } = options;

    try {
        const res = await client.get('/appointments', {
            params: { shopId, startDate, endDate, page, size },
        });
        const appointments = res.data?.content || res.data || [];

        console.log(`[Tekmetric] Fetched ${appointments.length} appointments for shop ${shopId}`);
        return appointments;
    } catch (e) {
        console.error(`[Tekmetric] getAppointments error: ${e.response?.status} ${e.message}`);
        throw new Error(`Tekmetric API error: ${e.response?.data?.message || e.message}`);
    }
}

// ─── Technicians / Employees ──────────────────────────────────────────────────
// Returns all active technicians for a shop
async function getTechnicians(apiKey, shopId) {
    const client = getClient(apiKey);

    try {
        const res = await client.get('/employees', {
            params: { shopId, active: true, size: 100 },
        });
        const employees = res.data?.content || res.data || [];

        // Filter to technicians only (role: TECHNICIAN or type: tech)
        const techs = employees.filter(e => {
            const role = (e.role || e.employeeType || '').toUpperCase();
            return role.includes('TECH') || role.includes('MECHANIC');
        });

        console.log(`[Tekmetric] Fetched ${techs.length} technicians for shop ${shopId}`);
        return techs;
    } catch (e) {
        console.error(`[Tekmetric] getTechnicians error: ${e.response?.status} ${e.message}`);
        throw new Error(`Tekmetric API error: ${e.response?.data?.message || e.message}`);
    }
}

// ─── Bay Status ───────────────────────────────────────────────────────────────
// Derives bay utilization from open repair orders
// Tekmetric doesn't have a direct "bays" endpoint — we infer from ROs
async function getBayStatus(apiKey, shopId, totalBays) {
    const orders = await getRepairOrders(apiKey, shopId, { status: 'WORK_IN_PROGRESS' });

    const occupiedBays = orders.filter(o => o.bays || o.bayNumber || o.technicianId).length;
    const freeBays = Math.max(0, totalBays - occupiedBays);
    const utilizationPct = totalBays > 0 ? Math.round((occupiedBays / totalBays) * 100) : 0;

    return {
        totalBays,
        occupiedBays,
        freeBays,
        utilizationPct,
        activeOrders: orders.length,
        orders,
    };
}

// ─── Job Line Items for a Repair Order ───────────────────────────────────────
// Returns detailed job line items (services) for a specific RO
async function getJobItems(apiKey, repairOrderId) {
    const client = getClient(apiKey);

    try {
        const res = await client.get(`/repair-orders/${repairOrderId}/jobs`);
        return res.data?.content || res.data || [];
    } catch (e) {
        console.error(`[Tekmetric] getJobItems error: ${e.message}`);
        return [];
    }
}

// ─── Shop Info ────────────────────────────────────────────────────────────────
async function getShopInfo(apiKey, shopId) {
    const client = getClient(apiKey);

    try {
        const res = await client.get(`/shops/${shopId}`);
        return res.data || null;
    } catch (e) {
        console.error(`[Tekmetric] getShopInfo error: ${e.message}`);
        return null;
    }
}

// ─── Daily Snapshot ───────────────────────────────────────────────────────────
// Pull everything needed for a full day's scheduling view
async function getDailySnapshot(apiKey, shopId, totalBays, date = null) {
    const today = date || new Date().toISOString().split('T')[0];

    const [appointments, wipOrders, allOrders, techs] = await Promise.all([
        getAppointments(apiKey, shopId, { startDate: today, endDate: today }),
        getRepairOrders(apiKey, shopId, { status: 'WORK_IN_PROGRESS' }),
        getRepairOrders(apiKey, shopId, { startDate: today, endDate: today }),
        getTechnicians(apiKey, shopId),
    ]);

    const bayStatus = {
        totalBays,
        occupiedBays: wipOrders.length,
        freeBays: Math.max(0, totalBays - wipOrders.length),
        utilizationPct: totalBays > 0 ? Math.round((wipOrders.length / totalBays) * 100) : 0,
    };

    // Compute estimated hours per tech from their assigned ROs
    const techWorkload = {};
    for (const tech of techs) {
        const techId = tech.id || tech.employeeId;
        const assignedOrders = allOrders.filter(o => o.technicianId === techId || o.assignedTechnicianId === techId);
        const estimatedHours = assignedOrders.reduce((sum, o) => sum + (o.estimatedHours || o.laborHours || 0), 0);

        techWorkload[techId] = {
            tech,
            assignedOrders: assignedOrders.length,
            estimatedHours: parseFloat(estimatedHours.toFixed(1)),
        };
    }

    return {
        date: today,
        shopId,
        appointments,
        wipOrders,
        allOrders,
        techs,
        bayStatus,
        techWorkload,
    };
}

// ─── Tech Efficiency Metrics ──────────────────────────────────────────────────
// Calculate efficiency over a date range (jobs/day, billed vs available hours)
async function getTechEfficiency(apiKey, shopId, technicianId, days = 7) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const orders = await getRepairOrders(apiKey, shopId, {
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
        status: 'COMPLETE',
    });

    const techOrders = orders.filter(o =>
        o.technicianId === technicianId || o.assignedTechnicianId === technicianId
    );

    const totalBilledHours = techOrders.reduce((sum, o) => sum + (o.laborHours || 0), 0);
    const availableHours   = days * 8; // assume 8hr workday
    const efficiency       = availableHours > 0
        ? Math.round((totalBilledHours / availableHours) * 100)
        : 0;

    return {
        technicianId,
        period: `${days} days`,
        jobsCompleted: techOrders.length,
        jobsPerDay:    parseFloat((techOrders.length / days).toFixed(1)),
        billedHours:   parseFloat(totalBilledHours.toFixed(1)),
        availableHours,
        efficiencyPct: efficiency,
    };
}

module.exports = {
    getRepairOrders,
    getAppointments,
    getTechnicians,
    getBayStatus,
    getJobItems,
    getShopInfo,
    getDailySnapshot,
    getTechEfficiency,
};
