/**
 * GRIDHAND Refill Runner — Bull Queue Job Definitions
 * VERTICAL: Veterinary practices (animal patients only — NOT human healthcare)
 *
 * Jobs:
 *  - refill-check      → Tue+Fri 9am: scan Rx, find those due within 14 days, send reminder SMS
 *  - process-refills   → 10am daily: submit approved refills to Vetsource, SMS tracking info
 *
 * All jobs are registered here. index.js schedules them via node-cron.
 */

'use strict';

const Bull  = require('bull');
const dayjs = require('dayjs');
const pms   = require('./pms');
const vetsource = require('./vetsource');
const db    = require('./db');

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const refillCheckQueue    = new Bull('refill-runner:refill-check',    REDIS_URL);
const processRefillsQueue = new Bull('refill-runner:process-refills', REDIS_URL);

// ─── Job: Refill Check ────────────────────────────────────────────────────────

refillCheckQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[RefillCheck] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No refill connection for ${clientSlug}`);

    // Pull all active prescriptions from eVetPractice
    const prescriptions = await pms.getActivePrescriptions(conn);
    console.log(`[RefillCheck] ${prescriptions.length} active prescriptions loaded for ${clientSlug}`);

    const today         = dayjs();
    const REMIND_DAYS   = 14; // send reminder when refill is needed within this window
    const THROTTLE_DAYS = 7;  // only send one reminder per prescription per 7 days
    let   remindersSent = 0;

    for (const rx of prescriptions) {
        if (!rx.lastFillDate || !rx.daysSupply) continue;

        const lastFill         = dayjs(rx.lastFillDate);
        const refillNeededDate = lastFill.add(rx.daysSupply, 'day');
        const daysUntilRefill  = refillNeededDate.diff(today, 'day');

        // Only remind if within the window and supply isn't expired yet
        if (daysUntilRefill > REMIND_DAYS || daysUntilRefill < -30) continue;

        const ownerPhone = rx.ownerPhone;
        if (!ownerPhone) {
            console.log(`[RefillCheck] No phone for Rx ${rx.id} (${rx.patientName}) — skipping`);
            continue;
        }

        if (!rx.refillsRemaining || rx.refillsRemaining <= 0) {
            console.log(`[RefillCheck] No refills remaining for Rx ${rx.id} (${rx.patientName}/${rx.medicationName}) — skipping`);
            continue;
        }

        // Check throttle
        const existing = await db.getPrescription(clientSlug, rx.id);
        if (existing?.reminder_sent_at) {
            const daysSinceLast = today.diff(dayjs(existing.reminder_sent_at), 'day');
            if (daysSinceLast < THROTTLE_DAYS) {
                console.log(`[RefillCheck] Throttled — Rx ${rx.id} last reminded ${daysSinceLast}d ago`);
                continue;
            }
        }

        // Don't remind if already approved or processing
        if (existing?.status === 'approved' || existing?.status === 'processing') {
            console.log(`[RefillCheck] Rx ${rx.id} already in status=${existing.status} — skipping reminder`);
            continue;
        }

        // Build SMS
        const daysDisplay = daysUntilRefill >= 0
            ? `in ${daysUntilRefill} day${daysUntilRefill !== 1 ? 's' : ''}`
            : `${Math.abs(daysUntilRefill)} day${Math.abs(daysUntilRefill) !== 1 ? 's' : ''} ago`;

        const message = buildRefillReminderMessage({
            ownerName:     rx.ownerName,
            petName:       rx.patientName,
            medication:    rx.medicationName,
            daysDisplay,
            practiceName:  conn.practice_name,
            practicePhone: conn.owner_phone,
        });

        // Send SMS
        const twilioClient = getTwilioClient();
        const from = process.env.TWILIO_FROM_NUMBER;
        if (!from) throw new Error('TWILIO_FROM_NUMBER must be set');

        await twilioClient.messages.create({ from, to: ownerPhone, body: message });

        await db.logAlert(clientSlug, {
            alertType:      'refill_reminder',
            recipient:      ownerPhone,
            messageBody:    message,
            prescriptionId: rx.id,
        });

        // Upsert prescription tracker record
        await db.upsertPrescription(clientSlug, {
            prescriptionId:  rx.id,
            patientId:       rx.patientId,
            patientName:     rx.patientName,
            medicationName:  rx.medicationName,
            ownerPhone,
            lastFillDate:    rx.lastFillDate,
            daysSupply:      rx.daysSupply,
            refillsRemaining: rx.refillsRemaining,
            status:          'pending_reminder',
            reminderSentAt:  today.toISOString(),
        });

        remindersSent++;
        console.log(`[RefillCheck] Sent refill reminder for ${rx.patientName}/${rx.medicationName} to ${ownerPhone}`);
    }

    console.log(`[RefillCheck] Done for ${clientSlug} — ${remindersSent} reminders sent`);
    return { clientSlug, prescriptionsScanned: prescriptions.length, remindersSent };
});

// ─── Job: Process Approved Refills ────────────────────────────────────────────

processRefillsQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[ProcessRefills] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No refill connection for ${clientSlug}`);

    // Get all refills in 'approved' status
    const approved = await db.getApprovedRefills(clientSlug);
    console.log(`[ProcessRefills] ${approved.length} approved refills to process for ${clientSlug}`);

    const from = process.env.TWILIO_FROM_NUMBER;
    if (!from) throw new Error('TWILIO_FROM_NUMBER must be set');
    const twilioClient = getTwilioClient();

    let processed = 0;
    let failed    = 0;

    for (const rx of approved) {
        try {
            // Submit order to Vetsource
            const order = await vetsource.submitRefillOrder(conn, {
                patientId:      rx.patient_id,
                prescriptionId: rx.prescription_id,
                quantity:       rx.days_supply || 30,
            });

            // Update status to processing
            await db.updatePrescriptionStatus(clientSlug, rx.prescription_id, 'processing', {
                processedAt: new Date().toISOString(),
                trackingUrl: order.trackingUrl || null,
            });

            // SMS owner with confirmation + tracking
            const confirmMsg = order.trackingUrl
                ? `Great news! ${rx.patient_name}'s ${rx.medication_name} refill has been submitted. Track your order: ${order.trackingUrl}`
                : `Great news! ${rx.patient_name}'s ${rx.medication_name} refill has been submitted to our online pharmacy. Estimated delivery: ${order.estimatedDelivery || '3-5 business days'}.`;

            await twilioClient.messages.create({ from, to: rx.owner_phone, body: confirmMsg });

            await db.logAlert(clientSlug, {
                alertType:      'refill_submitted',
                recipient:      rx.owner_phone,
                messageBody:    confirmMsg,
                prescriptionId: rx.prescription_id,
            });

            processed++;
            console.log(`[ProcessRefills] Submitted Vetsource order for Rx ${rx.prescription_id} — orderId=${order.orderId}`);

        } catch (err) {
            console.error(`[ProcessRefills] Failed to process Rx ${rx.prescription_id}: ${err.message}`);

            // SMS owner about failure
            const failMsg = `We had trouble processing ${rx.patient_name}'s ${rx.medication_name} refill. Please call us at ${conn.owner_phone} and we'll get it sorted out.`;
            try {
                await twilioClient.messages.create({ from, to: rx.owner_phone, body: failMsg });
                await db.logAlert(clientSlug, {
                    alertType:      'refill_failed',
                    recipient:      rx.owner_phone,
                    messageBody:    failMsg,
                    prescriptionId: rx.prescription_id,
                });
            } catch (smsErr) {
                console.error(`[ProcessRefills] Failed to send failure SMS: ${smsErr.message}`);
            }

            await db.updatePrescriptionStatus(clientSlug, rx.prescription_id, 'failed', {});
            failed++;
        }
    }

    console.log(`[ProcessRefills] Done for ${clientSlug} — ${processed} submitted, ${failed} failed`);
    return { clientSlug, processed, failed };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['refill-check',    refillCheckQueue],
    ['process-refills', processRefillsQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} job failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} job completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runRefillCheck(clientSlug) {
    return refillCheckQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runProcessRefills(clientSlug) {
    return processRefillsQueue.add({ clientSlug }, { attempts: 3, backoff: 30000 });
}

/**
 * Run a job for every connected client.
 * Called by cron triggers in index.js.
 */
async function runForAllClients(jobFn) {
    const clients = await db.getAllConnectedClients();
    const results = [];
    for (const { client_slug } of clients) {
        try {
            const job = await jobFn(client_slug);
            results.push({ clientSlug: client_slug, jobId: job.id });
        } catch (err) {
            console.error(`[Jobs] Failed to queue job for ${client_slug}: ${err.message}`);
        }
    }
    return results;
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function getTwilioClient() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
        throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
    }
    const twilio = require('twilio');
    return twilio(accountSid, authToken);
}

function buildRefillReminderMessage({ ownerName, petName, medication, daysDisplay, practiceName, practicePhone }) {
    const name     = ownerName ? `Hi ${ownerName.split(' ')[0]}!` : 'Hi!';
    const practice = practiceName || 'our clinic';
    const phone    = practicePhone ? ` or call ${practicePhone}` : '';
    return `${name} ${petName}'s ${medication} refill is due ${daysDisplay}. Reply YES to auto-refill through our online pharmacy${phone}. Reply STOP to opt out.`;
}

module.exports = {
    runRefillCheck,
    runProcessRefills,
    runForAllClients,
    refillCheckQueue,
    processRefillsQueue,
};
