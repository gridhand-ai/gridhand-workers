/**
 * GRIDHAND AI — Insurance Verifier
 * Bull Queue Job Definitions
 *
 * Queues:
 *   iv:verify-batch     — verify all upcoming appts for a practice
 *   iv:single-verify    — verify one specific appointment
 *   iv:cost-estimate    — send cost estimate texts to patients
 *   iv:flag-alert       — alert staff about flagged verifications
 */

'use strict';

const Bull = require('bull');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const twilio = require('twilio');
const dayjs = require('dayjs');

const pms = require('./pms');
const {
    verifyEligibility,
    formatCostEstimateMessage,
    sendVerificationToStaff
} = require('./eligibility');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// ============================================================
// REDIS CONFIG
// ============================================================

const REDIS_CONFIG = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined
};

const QUEUE_OPTS = {
    redis: REDIS_CONFIG,
    defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 200,
        attempts: 3,
        backoff: { type: 'exponential', delay: 8000 }
    }
};

// ============================================================
// QUEUE DEFINITIONS
// ============================================================

const queues = {
    verifyBatch:   new Bull('iv:verify-batch',   QUEUE_OPTS),
    singleVerify:  new Bull('iv:single-verify',  QUEUE_OPTS),
    costEstimate:  new Bull('iv:cost-estimate',  QUEUE_OPTS),
    flagAlert:     new Bull('iv:flag-alert',      QUEUE_OPTS)
};

// ============================================================
// HELPERS
// ============================================================

function parseName(fullName) {
    if (!fullName) return { firstName: '', lastName: '' };
    const parts = fullName.trim().split(' ');
    return {
        firstName: parts[0] || '',
        lastName: parts.slice(1).join(' ') || ''
    };
}

async function upsertDailyStats(clientSlug, statDate, increments) {
    const { data: existing } = await supabase
        .from('iv_daily_stats')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('stat_date', statDate)
        .single();

    if (existing) {
        const updates = {};
        for (const [key, val] of Object.entries(increments)) {
            if (typeof val === 'number') {
                updates[key] = (existing[key] || 0) + val;
            }
        }
        await supabase
            .from('iv_daily_stats')
            .update(updates)
            .eq('id', existing.id);
    } else {
        await supabase.from('iv_daily_stats').insert({
            client_slug: clientSlug,
            stat_date: statDate,
            appointments_verified: increments.appointments_verified || 0,
            flagged_count: increments.flagged_count || 0,
            inactive_count: increments.inactive_count || 0,
            estimates_sent: increments.estimates_sent || 0,
            avg_patient_portion: increments.avg_patient_portion || null
        });
    }
}

async function logSms(clientSlug, patientId, appointmentId, direction, body, sid, status) {
    await supabase.from('iv_sms_log').insert({
        client_slug: clientSlug,
        patient_id: patientId,
        appointment_id: appointmentId,
        direction,
        message_body: body,
        twilio_sid: sid || null,
        status: status || null
    });
}

// ============================================================
// JOB: VERIFY BATCH
// Verify all appointments within the next 48 hours (configurable)
// ============================================================

queues.verifyBatch.process('batch', 2, async (job) => {
    const { clientSlug } = job.data;

    const { data: conn } = await supabase
        .from('iv_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (!conn) return { error: 'Connection not found', clientSlug };

    const daysAhead = Math.ceil((conn.hours_before_appointment_to_verify || 48) / 24);
    let appointments;

    try {
        appointments = await pms.getUpcomingAppointments(clientSlug, daysAhead);
    } catch (err) {
        console.error(`[Jobs] getUpcomingAppointments failed for ${clientSlug}:`, err.message);
        return { error: err.message, clientSlug };
    }

    if (!appointments || appointments.length === 0) {
        return { ok: true, verified: 0, message: 'No upcoming appointments found' };
    }

    let verified = 0, flagged = 0, inactive = 0, errors = 0;
    const flaggedResults = [];
    const today = dayjs().format('YYYY-MM-DD');

    for (const appt of appointments) {
        try {
            // Check if already verified today
            const { data: existing } = await supabase
                .from('iv_verifications')
                .select('id, status, verified_at')
                .eq('client_slug', clientSlug)
                .eq('appointment_id', appt.appointmentId)
                .gte('verified_at', `${today}T00:00:00Z`)
                .single();

            if (existing && existing.status !== 'error') {
                continue; // Already verified today, skip
            }

            // Queue individual verification
            await queues.singleVerify.add('verify', {
                clientSlug,
                appointmentId: appt.appointmentId
            }, {
                jobId: `verify-${clientSlug}-${appt.appointmentId}-${today}`,
                delay: (verified + flagged + inactive + errors) * 1200 // Stagger by 1.2s to avoid rate limits
            });

            verified++;
        } catch (err) {
            console.error(`[Jobs] Error queuing verification for appt ${appt.appointmentId}:`, err.message);
            errors++;
        }
    }

    return { ok: true, queued: verified, skipped: appointments.length - verified - errors, errors };
});

// ============================================================
// JOB: SINGLE VERIFY
// Verify one appointment fully
// ============================================================

queues.singleVerify.process('verify', 5, async (job) => {
    const { clientSlug, appointmentId } = job.data;

    const { data: conn } = await supabase
        .from('iv_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (!conn) return { error: 'Connection not found' };

    // Get appointment details from PMS
    let appointments;
    try {
        appointments = await pms.getUpcomingAppointments(clientSlug, 7);
    } catch (err) {
        return { error: `PMS error: ${err.message}` };
    }

    const appt = appointments.find(a => a.appointmentId === String(appointmentId));
    if (!appt) {
        return { error: `Appointment ${appointmentId} not found in PMS` };
    }

    // Get procedures for this appointment
    let procedures = [];
    try {
        procedures = await pms.getAppointmentProcedures(clientSlug, appointmentId);
    } catch (_) {
        // Non-fatal — verify without procedure-level estimates
    }

    // Insurance info — use what came with appointment, or re-fetch
    const insuranceInfo = appt.insurance || {};
    if (!insuranceInfo.memberId) {
        try {
            const fresh = await pms.getPatientInsurance(clientSlug, appt.patientId);
            Object.assign(insuranceInfo, fresh || {});
        } catch (_) {}
    }

    const { firstName, lastName } = parseName(appt.patientName);
    const patientInfo = {
        firstName,
        lastName,
        dob: appt.patientDob,
        appointmentDate: appt.appointmentDate
    };

    // Run eligibility check
    const result = await verifyEligibility(clientSlug, patientInfo, insuranceInfo, procedures);

    const status = !result.eligible
        ? 'inactive'
        : result.flags.some(f => f.type === 'api_error')
            ? 'error'
            : result.flags.length > 0
                ? 'flagged'
                : 'verified';

    // Upsert verification record
    const { data: verRecord, error: verError } = await supabase
        .from('iv_verifications')
        .upsert({
            client_slug: clientSlug,
            appointment_id: String(appointmentId),
            patient_id: String(appt.patientId),
            patient_name: appt.patientName,
            patient_phone: appt.patientPhone,
            appointment_date: appt.appointmentDate,
            procedures,
            insurance_carrier: insuranceInfo.carrier,
            member_id: insuranceInfo.memberId,
            group_number: insuranceInfo.groupNumber,
            subscriber_name: insuranceInfo.subscriberName,
            status,
            eligible: result.eligible,
            deductible_remaining: result.deductibleRemaining,
            annual_max_remaining: result.maxRemaining,
            coverage_percent: result.coveragePercent,
            estimated_patient_portion: result.estimatedPatientPortion,
            flags: result.flags,
            raw_response: result.rawResponse,
            verified_at: new Date().toISOString()
        }, {
            onConflict: 'client_slug,appointment_id',
            ignoreDuplicates: false
        })
        .select()
        .single();

    // Log flags
    if (result.flags && result.flags.length > 0 && verRecord) {
        for (const flag of result.flags) {
            await supabase.from('iv_flag_log').insert({
                client_slug: clientSlug,
                verification_id: verRecord.id,
                flag_type: flag.type,
                flag_description: flag.description
            });
        }
    }

    // Write result back to PMS
    try {
        const pmsNotes = result.flags.length > 0
            ? `FLAGS: ${result.flags.map(f => f.description).join(' | ')}`
            : `Verified — Est. patient portion: $${result.estimatedPatientPortion ?? 'N/A'}`;
        await pms.updateVerificationStatus(clientSlug, appointmentId, status, pmsNotes);
    } catch (err) {
        console.warn(`[Jobs] PMS update failed for appt ${appointmentId}:`, err.message);
    }

    // Queue flag alert if issues found
    if ((status === 'flagged' || status === 'inactive') && conn.notify_staff_on_flag) {
        await queues.flagAlert.add('alert', {
            clientSlug,
            verificationId: verRecord?.id,
            patientName: appt.patientName,
            appointmentDate: appt.appointmentDate,
            flags: result.flags,
            eligible: result.eligible
        });
    }

    // Update daily stats
    const today = dayjs().format('YYYY-MM-DD');
    await upsertDailyStats(clientSlug, today, {
        appointments_verified: 1,
        flagged_count: status === 'flagged' ? 1 : 0,
        inactive_count: status === 'inactive' ? 1 : 0
    });

    return {
        ok: true,
        appointmentId,
        status,
        eligible: result.eligible,
        estimatedPatientPortion: result.estimatedPatientPortion,
        flagCount: result.flags.length
    };
});

// ============================================================
// JOB: COST ESTIMATE
// Send cost estimate SMS to a patient for their appointment
// ============================================================

queues.costEstimate.process('estimate', 5, async (job) => {
    const { clientSlug, appointmentId } = job.data;

    const { data: conn } = await supabase
        .from('iv_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (!conn || !conn.cost_estimate_sms_enabled) {
        return { skipped: true, reason: 'Cost estimate SMS disabled or client not found' };
    }

    // Get the verification record for this appointment
    const { data: ver } = await supabase
        .from('iv_verifications')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('appointment_id', String(appointmentId))
        .order('verified_at', { ascending: false })
        .limit(1)
        .single();

    if (!ver) {
        return { skipped: true, reason: 'No verification record found — run verification first' };
    }

    if (!ver.patient_phone) {
        return { skipped: true, reason: 'No patient phone on file' };
    }

    if (ver.cost_estimate_sent_at) {
        return { skipped: true, reason: 'Cost estimate already sent' };
    }

    const { firstName } = parseName(ver.patient_name);
    const patient = {
        firstName,
        patientName: ver.patient_name
    };

    const estimate = {
        eligible: ver.eligible,
        estimatedPatientPortion: ver.estimated_patient_portion,
        totalFee: ver.procedures
            ? ver.procedures.reduce((sum, p) => sum + parseFloat(p.fee || 0), 0)
            : null,
        flags: ver.flags || []
    };

    const message = formatCostEstimateMessage(conn, patient, ver.appointment_date, estimate);

    let twilioSid = null;
    let smsStatus = 'sent';

    try {
        const msg = await twilioClient.messages.create({
            body: message,
            from: process.env.TWILIO_FROM_NUMBER,
            to: ver.patient_phone
        });
        twilioSid = msg.sid;
    } catch (err) {
        console.error(`[Jobs] SMS failed for patient ${ver.patient_id}:`, err.message);
        smsStatus = 'failed';
    }

    // Log the SMS
    await logSms(
        clientSlug,
        ver.patient_id,
        String(appointmentId),
        'outbound',
        message,
        twilioSid,
        smsStatus
    );

    if (smsStatus === 'sent') {
        // Mark estimate as sent
        await supabase
            .from('iv_verifications')
            .update({ cost_estimate_sent_at: new Date().toISOString() })
            .eq('id', ver.id);

        // Update daily stats
        const today = dayjs().format('YYYY-MM-DD');
        await upsertDailyStats(clientSlug, today, { estimates_sent: 1 });
    }

    return { ok: smsStatus === 'sent', patientId: ver.patient_id, twilioSid };
});

// ============================================================
// JOB: FLAG ALERT
// Immediately alert front desk about a flagged/inactive verification
// ============================================================

queues.flagAlert.process('alert', 3, async (job) => {
    const { clientSlug, patientName, appointmentDate, flags, eligible } = job.data;

    const { data: conn } = await supabase
        .from('iv_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (!conn || (!conn.front_desk_phone && !conn.owner_phone)) {
        return { skipped: true, reason: 'No staff phone configured' };
    }

    const to = conn.front_desk_phone || conn.owner_phone;
    const formattedDate = dayjs(appointmentDate).format('MMM D');
    const status = !eligible ? 'INACTIVE COVERAGE' : 'FLAGGED';

    let msg = `[GRIDHAND] ⚠️ Insurance ${status}\n`;
    msg += `Patient: ${patientName || 'Unknown'}\n`;
    msg += `Appt: ${formattedDate}\n`;

    if (flags && flags.length > 0) {
        msg += `Issues:\n`;
        for (const f of flags.slice(0, 4)) {
            msg += `  • ${f.description}\n`;
        }
    }

    msg += `Action needed before appointment.`;

    try {
        const sms = await twilioClient.messages.create({
            body: msg.slice(0, 1600),
            from: process.env.TWILIO_FROM_NUMBER,
            to
        });
        return { ok: true, twilioSid: sms.sid };
    } catch (err) {
        console.error(`[Jobs] Flag alert SMS failed:`, err.message);
        return { ok: false, error: err.message };
    }
});

// ============================================================
// PUBLIC JOB FUNCTIONS
// ============================================================

/**
 * Queue a batch verification for all upcoming appointments (48h window).
 */
async function runVerifyBatch(clientSlug) {
    const job = await queues.verifyBatch.add('batch', { clientSlug }, {
        jobId: `batch-${clientSlug}-${dayjs().format('YYYY-MM-DD')}`
    });
    return { queued: true, jobId: job.id };
}

/**
 * Verify a single appointment.
 */
async function runSingleVerification(clientSlug, appointmentId) {
    const job = await queues.singleVerify.add('verify', {
        clientSlug,
        appointmentId
    }, { priority: 1 });
    return { queued: true, jobId: job.id };
}

/**
 * Send cost estimate texts to all of tomorrow's patients.
 */
async function runSendCostEstimates(clientSlug) {
    const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');

    const { data: verifications } = await supabase
        .from('iv_verifications')
        .select('appointment_id, patient_phone')
        .eq('client_slug', clientSlug)
        .eq('appointment_date', tomorrow)
        .in('status', ['verified', 'flagged'])
        .is('cost_estimate_sent_at', null);

    if (!verifications || verifications.length === 0) {
        return { queued: 0, message: 'No unsent estimates for tomorrow' };
    }

    let queued = 0;
    for (const ver of verifications) {
        if (ver.patient_phone) {
            await queues.costEstimate.add('estimate', {
                clientSlug,
                appointmentId: ver.appointment_id
            }, {
                delay: queued * 1500 // Stagger sends
            });
            queued++;
        }
    }

    return { queued };
}

/**
 * Alert staff about all unresolved flagged verifications.
 */
async function runFlagAlert(clientSlug) {
    const { data: conn } = await supabase
        .from('iv_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();

    if (!conn) return { error: 'Connection not found' };

    const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');
    const threeDaysOut = dayjs().add(3, 'day').format('YYYY-MM-DD');

    const { data: flagged } = await supabase
        .from('iv_verifications')
        .select('*')
        .eq('client_slug', clientSlug)
        .in('status', ['flagged', 'inactive', 'error'])
        .gte('appointment_date', tomorrow)
        .lte('appointment_date', threeDaysOut);

    if (!flagged || flagged.length === 0) {
        return { ok: true, message: 'No flagged verifications in next 3 days' };
    }

    await sendVerificationToStaff(conn, flagged.map(v => ({
        patientName: v.patient_name,
        patientId: v.patient_id,
        appointmentDate: v.appointment_date,
        eligible: v.eligible,
        flags: v.flags || []
    })));

    return { ok: true, flaggedCount: flagged.length };
}

/**
 * Run a job function for every connected practice.
 */
async function runForAllClients(jobFn) {
    const { data: connections } = await supabase
        .from('iv_connections')
        .select('client_slug');

    const results = [];
    for (const conn of connections || []) {
        try {
            const result = await jobFn(conn.client_slug);
            results.push({ clientSlug: conn.client_slug, ...result });
        } catch (err) {
            results.push({ clientSlug: conn.client_slug, error: err.message });
        }
    }

    return results;
}

// ============================================================
// CRON JOBS
// ============================================================

function startCronJobs() {
    // 6am daily — verify all appointments in next 48 hours for every practice
    cron.schedule('0 6 * * *', async () => {
        console.log('[Jobs] Running morning eligibility verification batch...');
        await runForAllClients(runVerifyBatch);
    });

    // 5pm daily — send cost estimate texts to tomorrow's patients
    cron.schedule('0 17 * * *', async () => {
        console.log('[Jobs] Sending cost estimate texts for tomorrow...');
        await runForAllClients(runSendCostEstimates);
    });

    console.log('[Jobs] Insurance Verifier cron jobs started.');
}

// ============================================================
// QUEUE ERROR HANDLERS
// ============================================================

for (const [name, queue] of Object.entries(queues)) {
    queue.on('failed', (job, err) => {
        console.error(
            `[Jobs] Queue "${name}" job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts}):`,
            err.message
        );
    });

    queue.on('error', (err) => {
        console.error(`[Jobs] Queue "${name}" error:`, err.message);
    });
}

// ============================================================
// QUEUE HEALTH
// ============================================================

async function getQueueStats() {
    const stats = {};
    for (const [name, queue] of Object.entries(queues)) {
        const [waiting, active, completed, failed] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount()
        ]);
        stats[name] = { waiting, active, completed, failed };
    }
    return stats;
}

module.exports = {
    queues,
    runVerifyBatch,
    runSingleVerification,
    runSendCostEstimates,
    runFlagAlert,
    runForAllClients,
    startCronJobs,
    getQueueStats
};
