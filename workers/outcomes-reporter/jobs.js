/**
 * GRIDHAND Outcomes Reporter — Bull Queue Job Definitions
 *
 * Jobs:
 *  - eval-sync          → 6am daily: pull latest evaluations from EHR
 *  - eval-due-check     → 9am daily: alert provider on patients due for eval
 *  - generate-reports   → 7am Mon/Thu: generate progress reports for insurance
 *  - milestone-check    → After eval-sync: flag patients hitting improvement milestones
 *
 * All jobs are registered here. index.js schedules them via node-cron.
 */

'use strict';

const Bull    = require('bull');
const dayjs   = require('dayjs');
const ehr     = require('./webpt');
const reports = require('./reports');
const db      = require('./db');
const sms     = require('./sms');

// ─── Queue Setup ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const evalSyncQueue      = new Bull('outcomes:eval-sync',      REDIS_URL);
const evalDueQueue       = new Bull('outcomes:eval-due-check', REDIS_URL);
const generateReportQueue = new Bull('outcomes:generate-reports', REDIS_URL);
const milestoneQueue     = new Bull('outcomes:milestone-check', REDIS_URL);

// ─── Job: Eval Sync ───────────────────────────────────────────────────────────

evalSyncQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[EvalSync] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const patients = await ehr.getPatientsWithEvals(clientSlug, conn, 30);
    let synced = 0;

    for (const patient of patients) {
        await db.upsertPatientOutcome(clientSlug, patient);

        // Sync score history
        const history = await ehr.getPatientScoreHistory(clientSlug, conn, patient.ehrPatientId);
        for (const score of history) {
            await db.upsertFunctionalScore(clientSlug, score);
        }
        synced++;
    }

    console.log(`[EvalSync] Done for ${clientSlug} — ${synced} patients synced`);
    return { clientSlug, synced };
});

// ─── Job: Eval Due Check ──────────────────────────────────────────────────────

evalDueQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[EvalDueCheck] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const duePatients = await db.getPatientsWithEvalDue(clientSlug);

    if (duePatients.length === 0) {
        console.log(`[EvalDueCheck] No evals due for ${clientSlug}`);
        return { clientSlug, dueCount: 0 };
    }

    const alertMsg = reports.generateEvalDueAlert({
        patients:  duePatients,
        clinicName: conn.clinic_name || clientSlug,
    });

    if (alertMsg) {
        await sms.sendToProvider(conn, alertMsg, 'eval_due');
    }

    console.log(`[EvalDueCheck] Done for ${clientSlug} — ${duePatients.length} evals due`);
    return { clientSlug, dueCount: duePatients.length };
});

// ─── Job: Generate Reports ────────────────────────────────────────────────────

generateReportQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[GenerateReports] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const allPatients = await db.getAllPatientOutcomes(clientSlug);
    let generated = 0;

    for (const patient of allPatients) {
        const history = await db.getScoreHistory(clientSlug, patient.ehr_patient_id);
        if (history.length < 2) continue; // Need at least 2 evals to generate progress report

        const reportType = patient.discharge_ready ? 'discharge_summary' : 'progress_report';
        const reportDate = dayjs().format('YYYY-MM-DD');

        const reportBody = patient.discharge_ready
            ? reports.generateDischargeSummary({
                patient,
                history,
                clinicName: conn.clinic_name || clientSlug,
            })
            : reports.generateProgressReport({
                patient,
                history,
                clinicName:   conn.clinic_name || clientSlug,
                providerName: null,
            });

        await db.saveReport(clientSlug, {
            ehrPatientId:   patient.ehr_patient_id,
            reportDate,
            reportType,
            insuranceCompany: patient.insurance_company,
            claimNumber:     patient.claim_number,
            reportBody,
            status:          'generated',
        });

        generated++;
        console.log(`[GenerateReports] Generated ${reportType} for ${patient.patient_name}`);
    }

    // Notify provider
    if (generated > 0) {
        await sms.sendToProvider(
            conn,
            `📄 ${conn.clinic_name || clientSlug}: ${generated} outcome report${generated > 1 ? 's' : ''} generated and ready for review/submission.`,
            'report_generated'
        );
    }

    console.log(`[GenerateReports] Done for ${clientSlug} — ${generated} reports generated`);
    return { clientSlug, generated };
});

// ─── Job: Milestone Check ─────────────────────────────────────────────────────

milestoneQueue.process(async (job) => {
    const { clientSlug } = job.data;
    console.log(`[MilestoneCheck] Running for ${clientSlug}`);

    const conn = await db.getConnection(clientSlug);
    if (!conn) throw new Error(`No connection for ${clientSlug}`);

    const allPatients = await db.getAllPatientOutcomes(clientSlug);
    let flagged = 0;

    const MILESTONES = [25, 50, 75]; // Percent improvement thresholds

    for (const patient of allPatients) {
        const history = await db.getScoreHistory(clientSlug, patient.ehr_patient_id);
        if (history.length < 2) continue;

        const latest = history[history.length - 1];
        if (!latest.percent_improvement) continue;

        const pct = Math.abs(latest.percent_improvement);

        // Check if this improvement crosses a milestone we haven't alerted on
        for (const milestone of MILESTONES) {
            if (pct >= milestone) {
                // Only alert once per milestone — check if we've already sent it
                const prevAlerts = await db.getAlertHistory(clientSlug, 'improvement_milestone', 100);
                const alreadySent = prevAlerts.some(a =>
                    a.ehr_patient_id === patient.ehr_patient_id && a.message_body.includes(`${milestone}%`)
                );

                if (!alreadySent) {
                    const msg = reports.generateMilestoneSMS({
                        patientName:       patient.patient_name,
                        percentImprovement: pct,
                        outcomeMeasure:    patient.outcome_measure,
                        clinicName:        conn.clinic_name || clientSlug,
                    });
                    await sms.sendToProvider(conn, msg, 'improvement_milestone', patient.ehr_patient_id);
                    flagged++;
                }
                break; // Only alert on the highest milestone crossed
            }
        }
    }

    console.log(`[MilestoneCheck] Done for ${clientSlug} — ${flagged} milestones alerted`);
    return { clientSlug, flagged };
});

// ─── Queue Error Handlers ─────────────────────────────────────────────────────

for (const [name, queue] of [
    ['eval-sync',       evalSyncQueue],
    ['eval-due-check',  evalDueQueue],
    ['generate-reports', generateReportQueue],
    ['milestone-check', milestoneQueue],
]) {
    queue.on('failed', (job, err) => {
        console.error(`[Jobs] ${name} job failed for ${job.data.clientSlug}: ${err.message}`);
    });
    queue.on('completed', (job) => {
        console.log(`[Jobs] ${name} job completed for ${job.data.clientSlug}`);
    });
}

// ─── Job Dispatchers ──────────────────────────────────────────────────────────

async function runEvalSync(clientSlug) {
    return evalSyncQueue.add({ clientSlug }, { attempts: 3, backoff: 60000 });
}

async function runEvalDueCheck(clientSlug) {
    return evalDueQueue.add({ clientSlug }, { attempts: 2, backoff: 30000 });
}

async function runGenerateReports(clientSlug) {
    return generateReportQueue.add({ clientSlug }, { attempts: 2, backoff: 60000 });
}

async function runMilestoneCheck(clientSlug) {
    return milestoneQueue.add({ clientSlug }, { attempts: 2, backoff: 30000 });
}

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

module.exports = {
    runEvalSync,
    runEvalDueCheck,
    runGenerateReports,
    runMilestoneCheck,
    runForAllClients,
    evalSyncQueue,
    evalDueQueue,
    generateReportQueue,
    milestoneQueue,
};
