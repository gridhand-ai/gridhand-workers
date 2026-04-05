/**
 * GRIDHAND Outcomes Reporter — Report & Message Formatters
 *
 * Generates structured outcome reports for insurance and SMS alerts.
 * Pure functions — no DB or API calls.
 */

'use strict';

const dayjs = require('dayjs');

// ─── Insurance Progress Report ────────────────────────────────────────────────

function generateProgressReport({ patient, history, clinicName, providerName }) {
    const latest   = history[history.length - 1];
    const initial  = history[0];
    const today    = dayjs().format('MMMM D, YYYY');

    const painImprovement = initial && latest && initial.pain_score != null && latest.pain_score != null
        ? ((initial.pain_score - latest.pain_score) / initial.pain_score * 100).toFixed(0)
        : 'N/A';

    const funcImprovement = latest?.percent_improvement != null
        ? `${Math.abs(latest.percent_improvement).toFixed(0)}%`
        : 'N/A';

    const evalCount   = history.length;
    const measureLabel = getMeasureLabel(patient.outcome_measure);

    return [
        `PROGRESS REPORT — ${today}`,
        `Clinic: ${clinicName}${providerName ? ` | Provider: ${providerName}` : ''}`,
        ``,
        `PATIENT INFORMATION`,
        `Name: ${patient.patient_name}`,
        patient.patient_dob ? `DOB: ${dayjs(patient.patient_dob).format('MM/DD/YYYY')}` : '',
        patient.diagnosis_label ? `Diagnosis: ${patient.diagnosis_label} (${patient.diagnosis_code})` : '',
        patient.insurance_company ? `Insurance: ${patient.insurance_company}` : '',
        patient.claim_number ? `Claim #: ${patient.claim_number}` : '',
        patient.injury_date ? `Date of Injury: ${dayjs(patient.injury_date).format('MM/DD/YYYY')}` : '',
        ``,
        `FUNCTIONAL OUTCOME SUMMARY`,
        `Outcome Measure: ${measureLabel}`,
        `Evaluations Completed: ${evalCount}`,
        `Initial Pain (VAS 0-10): ${initial?.pain_score ?? 'N/A'} → Current: ${latest?.pain_score ?? 'N/A'} (${painImprovement !== 'N/A' ? painImprovement + '% improvement' : 'N/A'})`,
        initial?.function_score != null ? `Initial ${measureLabel}: ${initial.function_score}% disability → Current: ${latest?.function_score ?? 'N/A'}% (${funcImprovement} improvement)` : '',
        `Visits Completed: ${latest?.visits_completed ?? patient.visits_at_eval ?? 'N/A'}`,
        ``,
        `PROGRESS HISTORY`,
        ...history.map((h, i) =>
            `  ${dayjs(h.eval_date).format('MM/DD/YYYY')}: Pain ${h.pain_score ?? '?'}/10, ${measureLabel} ${h.function_score ?? '?'}%${i > 0 && h.percent_improvement ? ` (↓${Math.abs(h.percent_improvement).toFixed(0)}% improvement)` : ''}`
        ),
        ``,
        `CLINICAL STATUS`,
        patient.discharge_ready
            ? `Patient is clinically ready for discharge. Goals met and functional status improved.'`
            : `Patient continues to demonstrate functional improvement. Continued care is medically necessary.`,
        ``,
        `--- End of Progress Report ---`,
    ].filter(Boolean).join('\n');
}

// ─── Discharge Summary ────────────────────────────────────────────────────────

function generateDischargeSummary({ patient, history, clinicName }) {
    const initial  = history[0];
    const final    = history[history.length - 1];
    const today    = dayjs().format('MMMM D, YYYY');
    const measure  = getMeasureLabel(patient.outcome_measure);

    return [
        `DISCHARGE SUMMARY — ${today}`,
        `Clinic: ${clinicName}`,
        ``,
        `Patient: ${patient.patient_name}`,
        patient.diagnosis_label ? `Diagnosis: ${patient.diagnosis_label} (${patient.diagnosis_code})` : '',
        patient.insurance_company ? `Insurance: ${patient.insurance_company} | Claim #: ${patient.claim_number}` : '',
        ``,
        `TREATMENT SUMMARY`,
        `Total Visits: ${final?.visits_completed ?? 'N/A'}`,
        `Treatment Duration: ${initial ? `${dayjs(patient.last_eval_date).diff(dayjs(initial.eval_date), 'week')} weeks` : 'N/A'}`,
        ``,
        `OUTCOMES AT DISCHARGE`,
        `Initial Pain: ${initial?.pain_score ?? 'N/A'}/10 → Final: ${final?.pain_score ?? 'N/A'}/10`,
        `Initial ${measure}: ${initial?.function_score ?? 'N/A'}% → Final: ${final?.function_score ?? 'N/A'}%`,
        `Overall Improvement: ${final?.percent_improvement != null ? Math.abs(final.percent_improvement).toFixed(0) + '%' : 'N/A'}`,
        ``,
        `Patient was discharged in improved functional status. Goals of care achieved.`,
        ``,
        `--- End of Discharge Summary ---`,
    ].filter(Boolean).join('\n');
}

// ─── Eval Due SMS Alert (to provider) ────────────────────────────────────────

function generateEvalDueAlert({ patients, clinicName }) {
    if (patients.length === 0) return null;

    const lines = patients.slice(0, 5).map(p =>
        `• ${p.patient_name} — eval due ${dayjs(p.next_eval_due).format('M/D')}`
    );

    const more = patients.length > 5 ? `\n+ ${patients.length - 5} more` : '';
    return `📋 ${clinicName}: ${patients.length} patient eval${patients.length > 1 ? 's' : ''} due:\n${lines.join('\n')}${more}`;
}

// ─── Improvement Milestone Alert ──────────────────────────────────────────────

function generateMilestoneSMS({ patientName, percentImprovement, outcomeMeasure, clinicName }) {
    const measure = getMeasureLabel(outcomeMeasure);
    return `🎉 ${clinicName}: ${patientName} reached ${Math.abs(percentImprovement).toFixed(0)}% improvement on ${measure}! Consider updating insurance with progress report.`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getMeasureLabel(measure) {
    const labels = {
        oswestry: 'Oswestry Disability Index',
        ndi:      'Neck Disability Index',
        dash:     'DASH Score',
        groc:     'GROC Score',
        psfs:     'PSFS',
    };
    return labels[measure] || (measure || 'Functional Score');
}

module.exports = {
    generateProgressReport,
    generateDischargeSummary,
    generateEvalDueAlert,
    generateMilestoneSMS,
};
