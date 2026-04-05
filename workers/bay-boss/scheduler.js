// Bay Boss Scheduler — Optimization engine for shop scheduling
// Takes Tekmetric data + Google Calendar availability and produces
// optimized daily schedule with alerts and recommendations

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Utilization Thresholds ───────────────────────────────────────────────────
const THRESHOLDS = {
    UNDERUTILIZED:  40, // % — below this, alert owner to push more appointments
    OVERBOOKED:     95, // % — above this, alert owner, risk of overtime
    TECH_IDLE:       2, // hours of idle time = alert worth sending
    JOB_OVER_EST:   30, // minutes over estimate before flagging
};

// ─── Utilization Analysis ─────────────────────────────────────────────────────
function analyzeBayUtilization(bayStatus) {
    const { utilizationPct, occupiedBays, freeBays, totalBays } = bayStatus;

    let status, message;

    if (utilizationPct >= THRESHOLDS.OVERBOOKED) {
        status  = 'overbooked';
        message = `All ${totalBays} bays occupied. Risk of overtime and customer delays.`;
    } else if (utilizationPct <= THRESHOLDS.UNDERUTILIZED) {
        status  = 'underutilized';
        message = `Only ${occupiedBays}/${totalBays} bays active (${utilizationPct}%). ${freeBays} bay${freeBays !== 1 ? 's' : ''} sitting empty.`;
    } else {
        status  = 'healthy';
        message = `${occupiedBays}/${totalBays} bays active (${utilizationPct}%). Running smoothly.`;
    }

    return { status, utilizationPct, occupiedBays, freeBays, totalBays, message };
}

// ─── Tech Workload Analysis ───────────────────────────────────────────────────
function analyzeTechWorkloads(techWorkload, techSchedules = {}) {
    const analysis = [];

    for (const [techId, data] of Object.entries(techWorkload)) {
        const { tech, assignedOrders, estimatedHours } = data;
        const calendarData = techSchedules[techId];
        const calendarHours = calendarData?.busyHours || 0;
        const availableHours = calendarData?.availableHours ?? 8;

        const workloadPct = availableHours > 0
            ? Math.round((estimatedHours / availableHours) * 100)
            : 0;

        let status;
        if (estimatedHours === 0) status = 'idle';
        else if (workloadPct > 95) status = 'overloaded';
        else if (workloadPct < 30) status = 'light';
        else status = 'healthy';

        analysis.push({
            techId,
            techName: `${tech.firstName || ''} ${tech.lastName || ''}`.trim() || `Tech #${techId}`,
            assignedOrders,
            estimatedHours,
            availableHours,
            workloadPct,
            status,
            idleHours: Math.max(0, parseFloat((availableHours - estimatedHours).toFixed(1))),
        });
    }

    return analysis;
}

// ─── Match Jobs to Techs ──────────────────────────────────────────────────────
// Given unassigned jobs and tech availability, suggest assignments
function matchJobsToTechs(unassignedJobs, techAnalysis) {
    const availableTechs = techAnalysis
        .filter(t => t.status !== 'overloaded' && t.availableHours > 0)
        .sort((a, b) => a.workloadPct - b.workloadPct); // lightest load first

    const assignments = [];
    const unmatched   = [];

    for (const job of unassignedJobs) {
        const jobHours = job.estimatedHours || job.laborHours || 1;
        const skills   = job.requiredSkills || [];

        // Find best tech: has capacity + matching skills
        const match = availableTechs.find(t => {
            const hasCapacity = t.availableHours >= jobHours;
            const hasSkill    = skills.length === 0 || skills.some(s =>
                (t.tech?.skills || []).map(sk => sk.toLowerCase()).includes(s.toLowerCase())
            );
            return hasCapacity && hasSkill;
        });

        if (match) {
            // Update available hours so next job accounts for this
            match.availableHours -= jobHours;
            match.assignedOrders += 1;
            match.workloadPct = match.availableHours > 0
                ? Math.round(((8 - match.availableHours) / 8) * 100)
                : 100;

            assignments.push({
                job,
                recommendedTech: match.techId,
                techName:        match.techName,
                reason:          skills.length > 0
                    ? `Best skill match with ${match.workloadPct}% workload`
                    : `Lightest workload (${match.workloadPct}%)`,
            });
        } else {
            unmatched.push({ job, reason: 'No available tech with required capacity/skills' });
        }
    }

    return { assignments, unmatched };
}

// ─── Detect Jobs Running Over Estimate ────────────────────────────────────────
function detectOverrunJobs(activeOrders) {
    const now = new Date();
    const overruns = [];

    for (const order of activeOrders) {
        if (!order.startedAt || !order.estimatedHours) continue;

        const started    = new Date(order.startedAt);
        const elapsedMin = (now - started) / 60000;
        const estimatedMin = (order.estimatedHours || 0) * 60;

        if (elapsedMin > estimatedMin + THRESHOLDS.JOB_OVER_EST) {
            const overrunMin = Math.round(elapsedMin - estimatedMin);
            overruns.push({
                repairOrderId: order.id || order.repairOrderId,
                customerName:  order.customerName || 'Unknown',
                service:       order.serviceType || order.jobType || 'Service',
                estimatedHours: order.estimatedHours,
                elapsedHours:  parseFloat((elapsedMin / 60).toFixed(1)),
                overrunMinutes: overrunMin,
            });
        }
    }

    return overruns;
}

// ─── Generate AI Schedule Brief ───────────────────────────────────────────────
// Uses Claude to write a natural-language schedule overview
async function generateScheduleBrief(snapshot, techAnalysis, bayUtilization, type = 'morning') {
    const { date, appointments, allOrders, techs } = snapshot;

    const techSummary = techAnalysis.map(t =>
        `- ${t.techName}: ${t.assignedOrders} jobs, ${t.estimatedHours}h scheduled, ${t.idleHours}h available (${t.status})`
    ).join('\n');

    const apptList = appointments.slice(0, 10).map(a =>
        `- ${a.appointmentTime || a.startTime || 'TBD'}: ${a.customerName || 'Customer'} — ${a.serviceType || 'Service'}`
    ).join('\n');

    const prompt = type === 'morning'
        ? `You are Bay Boss, an AI shop manager for an auto repair shop.
Write a MORNING BRIEFING text message for the shop owner.
Be concise — this is an SMS, max 320 characters. Use short sentences.

TODAY'S DATA:
Date: ${date}
Total appointments: ${appointments.length}
Active repair orders: ${allOrders.length}
Bay utilization: ${bayUtilization.utilizationPct}% (${bayUtilization.occupiedBays}/${bayUtilization.totalBays} bays)
Bay status: ${bayUtilization.status}

Technicians:
${techSummary}

Today's appointments:
${apptList || 'None scheduled yet'}

Write a brief, useful morning summary the owner can read in 10 seconds.
Format: Start with "Good morning! Here's today's shop lineup:"
Include: appointment count, bay status, any idle techs to watch.
End with one actionable tip if utilization is low or high.`

        : `You are Bay Boss, an AI shop manager for an auto repair shop.
Write an END-OF-DAY SUMMARY text message for the shop owner.
Be concise — this is an SMS, max 320 characters.

TODAY'S DATA:
Date: ${date}
Jobs completed: ${allOrders.filter(o => o.status === 'COMPLETE').length}
Total jobs: ${allOrders.length}
Bay utilization: ${bayUtilization.utilizationPct}%
Technicians today:
${techSummary}

Write a brief EOD summary the owner gets to see their day at a glance.
Format: Start with "Day wrap-up for [date]:"
Include: jobs done, utilization %, standout metrics, tomorrow callout if any.`;

    try {
        const response = await anthropic.messages.create({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 200,
            messages:   [{ role: 'user', content: prompt }],
        });

        return response.content[0]?.text?.trim() || buildFallbackBrief(snapshot, bayUtilization, type);
    } catch (e) {
        console.error(`[Scheduler] AI brief error: ${e.message}`);
        return buildFallbackBrief(snapshot, bayUtilization, type);
    }
}

// ─── Fallback Brief (no AI needed) ───────────────────────────────────────────
function buildFallbackBrief(snapshot, bayUtilization, type) {
    const { date, appointments, allOrders } = snapshot;
    const { utilizationPct, occupiedBays, totalBays } = bayUtilization;

    if (type === 'morning') {
        return `Good morning! Bay Boss here. Today: ${appointments.length} appts, ${occupiedBays}/${totalBays} bays active (${utilizationPct}%). ${utilizationPct < 40 ? 'Bays are light — push walk-ins.' : utilizationPct > 90 ? 'Bays nearly full — heads up on timing.' : 'Looking good. Have a great day!'}`;
    }

    const completed = allOrders.filter(o => o.status === 'COMPLETE').length;
    return `Day wrap-up: ${completed}/${allOrders.length} jobs done. Bay utilization: ${utilizationPct}%. ${completed === allOrders.length ? 'Clean sweep — great work today!' : 'Check open ROs before close.'}`;
}

// ─── Generate Adjustment Recommendations ─────────────────────────────────────
async function generateAdjustmentRecommendations(overrunJobs, techAnalysis, bayUtilization) {
    if (overrunJobs.length === 0 && bayUtilization.status === 'healthy') {
        return null;
    }

    const idleTechs = techAnalysis.filter(t => t.status === 'idle' || t.idleHours > THRESHOLDS.TECH_IDLE);

    const lines = [];

    if (overrunJobs.length > 0) {
        lines.push(`${overrunJobs.length} job(s) running over estimate:`);
        overrunJobs.slice(0, 3).forEach(j => {
            lines.push(`• RO #${j.repairOrderId} (${j.service}): ${j.overrunMinutes}min over`);
        });
        if (idleTechs.length > 0) {
            lines.push(`Suggestion: Reassign to ${idleTechs[0].techName} (${idleTechs[0].idleHours}h free).`);
        }
    }

    if (bayUtilization.status === 'underutilized') {
        lines.push(`Bays at ${bayUtilization.utilizationPct}% — ${bayUtilization.freeBays} bays open.`);
        lines.push('Suggestion: Call waitlist or offer same-day slots.');
    }

    if (bayUtilization.status === 'overbooked') {
        lines.push('All bays full. Heads up on backlog.');
        lines.push('Suggestion: Confirm tomorrow\'s appointments and manage expectations.');
    }

    return lines.join('\n');
}

// ─── Full Schedule Optimization Pass ─────────────────────────────────────────
// Master function — run on startup and periodically
async function runScheduleOptimization(snapshot, techSchedules = {}) {
    const { bayStatus, techWorkload, wipOrders } = snapshot;

    const bayUtilization = analyzeBayUtilization(bayStatus);
    const techAnalysis   = analyzeTechWorkloads(techWorkload, techSchedules);
    const overrunJobs    = detectOverrunJobs(wipOrders);

    // Unassigned jobs (orders without a tech)
    const unassignedJobs = snapshot.allOrders.filter(o =>
        !o.technicianId && !o.assignedTechnicianId && o.status !== 'COMPLETE'
    );

    const { assignments, unmatched } = matchJobsToTechs(unassignedJobs, techAnalysis);

    const alerts = [];

    if (bayUtilization.status !== 'healthy') {
        alerts.push({ type: bayUtilization.status, message: bayUtilization.message, severity: 'medium' });
    }

    if (overrunJobs.length > 0) {
        alerts.push({
            type:     'overrun',
            message:  `${overrunJobs.length} job(s) running over estimate`,
            details:  overrunJobs,
            severity: 'high',
        });
    }

    for (const tech of techAnalysis) {
        if (tech.status === 'idle') {
            alerts.push({
                type:     'idle_tech',
                message:  `${tech.techName} has no assigned work today`,
                severity: 'medium',
            });
        }
        if (tech.status === 'overloaded') {
            alerts.push({
                type:     'overloaded_tech',
                message:  `${tech.techName} is overloaded (${tech.workloadPct}% capacity)`,
                severity: 'high',
            });
        }
    }

    const recommendations = await generateAdjustmentRecommendations(overrunJobs, techAnalysis, bayUtilization);

    return {
        timestamp:       new Date().toISOString(),
        date:            snapshot.date,
        bayUtilization,
        techAnalysis,
        overrunJobs,
        unassignedJobs:  unassignedJobs.length,
        assignments,
        unmatched,
        alerts,
        recommendations,
    };
}

module.exports = {
    analyzeBayUtilization,
    analyzeTechWorkloads,
    matchJobsToTechs,
    detectOverrunJobs,
    generateScheduleBrief,
    generateAdjustmentRecommendations,
    runScheduleOptimization,
    THRESHOLDS,
};
