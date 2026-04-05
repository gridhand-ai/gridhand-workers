/**
 * GRIDHAND Outcomes Reporter — WebPT / PROMPT EMR API Integration
 *
 * Fetches patient evaluation data, functional outcome measures, and clinical
 * notes from WebPT (REST v1) or PROMPT EMR.
 *
 * WebPT docs:   https://webpt.com/api
 * PROMPT docs:  https://www.promptemr.com/api
 */

'use strict';

const axios = require('axios');
const dayjs = require('dayjs');

const WEBPT_BASE  = 'https://api.webpt.com/v1';
const PROMPT_BASE = 'https://api.promptemr.com/v1';

// ─── Auth Headers ─────────────────────────────────────────────────────────────

function buildHeaders(conn) {
    if (conn.ehr_type === 'prompt') {
        return {
            'Authorization': `Bearer ${conn.access_token}`,
            'Content-Type':  'application/json',
            'Accept':        'application/json',
        };
    }
    return {
        'X-API-Key':     conn.api_key,
        'X-Location-ID': conn.location_id,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
    };
}

// ─── Fetch Patients with Recent Evaluations ───────────────────────────────────

async function getPatientsWithEvals(clientSlug, conn, daysBack = 30) {
    const startDate = dayjs().subtract(daysBack, 'day').format('YYYY-MM-DD');
    const endDate   = dayjs().format('YYYY-MM-DD');

    try {
        if (conn.ehr_type === 'prompt') {
            return await getPromptPatientEvals(conn, startDate, endDate);
        }
        return await getWebPTPatientEvals(conn, startDate, endDate);
    } catch (err) {
        console.error(`[WebPT] getPatientsWithEvals error for ${clientSlug}: ${err.message}`);
        throw err;
    }
}

async function getWebPTPatientEvals(conn, startDate, endDate) {
    const { data } = await axios.get(`${WEBPT_BASE}/evaluations`, {
        headers: buildHeaders(conn),
        params: {
            start_date: startDate,
            end_date:   endDate,
            per_page:   500,
        },
    });

    return (data.evaluations || []).map(ev => ({
        ehrPatientId:         String(ev.patient_id),
        patientName:          `${ev.patient?.first_name || ''} ${ev.patient?.last_name || ''}`.trim(),
        patientDob:           ev.patient?.date_of_birth || null,
        insuranceCompany:     ev.insurance?.company_name || null,
        claimNumber:          ev.insurance?.claim_number || null,
        injuryDate:           ev.injury_date || null,
        diagnosisCode:        ev.primary_diagnosis_code || null,
        diagnosisLabel:       ev.primary_diagnosis_description || null,
        initialPainScore:     ev.initial_pain_score ?? null,
        currentPainScore:     ev.current_pain_score ?? null,
        initialFunctionScore: ev.initial_function_score ?? null,
        currentFunctionScore: ev.current_function_score ?? null,
        outcomeMeasure:       ev.outcome_measure || 'oswestry',
        visitsAtEval:         ev.visit_count || null,
        dischargeReady:       ev.discharge_recommended || false,
        lastEvalDate:         ev.evaluation_date || null,
        nextEvalDue:          ev.next_evaluation_due || null,
        goals:                ev.goals || [],
    }));
}

async function getPromptPatientEvals(conn, startDate, endDate) {
    const { data } = await axios.get(`${PROMPT_BASE}/patient-outcomes`, {
        headers: buildHeaders(conn),
        params: {
            from_date: startDate,
            to_date:   endDate,
            limit:     500,
        },
    });

    return (data.outcomes || []).map(o => ({
        ehrPatientId:         String(o.patient_id),
        patientName:          o.patient_name || 'Unknown',
        patientDob:           o.patient?.dob || null,
        insuranceCompany:     o.primary_insurance || null,
        claimNumber:          o.claim_number || null,
        injuryDate:           o.injury_date || null,
        diagnosisCode:        o.icd_code || null,
        diagnosisLabel:       o.icd_description || null,
        initialPainScore:     o.initial_vas ?? null,
        currentPainScore:     o.current_vas ?? null,
        initialFunctionScore: o.initial_odi ?? null,
        currentFunctionScore: o.current_odi ?? null,
        outcomeMeasure:       o.measure_type || 'oswestry',
        visitsAtEval:         o.total_visits || null,
        dischargeReady:       o.ready_for_discharge || false,
        lastEvalDate:         o.eval_date || null,
        nextEvalDue:          o.next_eval_date || null,
        goals:                o.treatment_goals || [],
    }));
}

// ─── Fetch Functional Score History for One Patient ───────────────────────────

async function getPatientScoreHistory(clientSlug, conn, ehrPatientId) {
    try {
        const base    = conn.ehr_type === 'prompt' ? PROMPT_BASE : WEBPT_BASE;
        const endpoint = conn.ehr_type === 'prompt'
            ? `${base}/patients/${ehrPatientId}/outcome-history`
            : `${base}/patients/${ehrPatientId}/evaluations`;

        const { data } = await axios.get(endpoint, { headers: buildHeaders(conn) });

        const records = conn.ehr_type === 'prompt' ? (data.history || []) : (data.evaluations || []);

        return records.map((r, i) => {
            const painScore     = conn.ehr_type === 'prompt' ? r.vas_score : r.current_pain_score;
            const functionScore = conn.ehr_type === 'prompt' ? r.odi_score : r.current_function_score;
            const initialFn     = records[0];
            const initialScore  = conn.ehr_type === 'prompt' ? initialFn.odi_score : initialFn.current_function_score;
            const pctImprove    = (initialScore && functionScore && i > 0)
                ? ((initialScore - functionScore) / initialScore) * 100
                : 0;

            return {
                ehrPatientId:      ehrPatientId,
                evalDate:          r.evaluation_date || r.eval_date,
                visitsCompleted:   r.visit_count || r.total_visits || null,
                painScore:         painScore ?? null,
                functionScore:     functionScore ?? null,
                outcomeMeasure:    r.outcome_measure || r.measure_type || 'oswestry',
                percentImprovement: parseFloat(pctImprove.toFixed(2)),
                notes:             r.notes || null,
            };
        });
    } catch (err) {
        console.error(`[WebPT] getPatientScoreHistory error for ${clientSlug}/${ehrPatientId}: ${err.message}`);
        throw err;
    }
}

module.exports = {
    getPatientsWithEvals,
    getPatientScoreHistory,
};
