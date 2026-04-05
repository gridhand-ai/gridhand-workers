/**
 * GRIDHAND AI — Prior Auth Bot
 * Authorization Workflow Orchestration
 *
 * Handles the full lifecycle:
 *   new order → check auth required → fetch coverage → submit → track → appeal
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const dayjs = require('dayjs');

const ehr = require('./ehr');
const payers = require('./payers');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// ============================================================
// HELPERS
// ============================================================

async function loadConnection(clientSlug) {
    const { data } = await supabase
        .from('pab_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    return data;
}

async function logTimeline(clientSlug, authId, eventType, eventData) {
    await supabase.from('pab_timeline').insert({
        client_slug: clientSlug,
        auth_id: authId,
        event_type: eventType,
        event_data: eventData || {}
    });
}

async function updateAuthRecord(authId, updates) {
    const { data, error } = await supabase
        .from('pab_auths')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', authId)
        .select()
        .single();
    return { ok: !error, data, error: error?.message };
}

// ============================================================
// PROCESS NEW ORDER
// ============================================================

/**
 * processNewOrder(clientSlug, order)
 *
 * End-to-end workflow for a new EHR order:
 *  1. Check if auth required for the procedure code(s)
 *  2. Fetch patient coverage and conditions
 *  3. Build auth request
 *  4. Submit to payer
 *  5. Persist to DB
 *  6. Alert staff
 */
async function processNewOrder(clientSlug, order) {
    const conn = await loadConnection(clientSlug);
    if (!conn) throw new Error(`No connection found for ${clientSlug}`);

    // 1. Check if any procedure code requires auth
    const procedureCodes = order.procedureCode ? [order.procedureCode] : [];
    const authNeeded = procedureCodes.some(code => payers.isAuthRequired(code));

    if (!authNeeded) {
        console.log(`[Workflow] Order ${order.id} — no auth required for codes: ${procedureCodes.join(', ')}`);
        return { ok: true, skipped: true, reason: 'Auth not required for these procedure codes' };
    }

    // Check for existing auth to avoid duplicates
    const { data: existing } = await supabase
        .from('pab_auths')
        .select('id, status')
        .eq('client_slug', clientSlug)
        .eq('order_id', order.id)
        .not('status', 'in', '("cancelled","expired")')
        .maybeSingle();

    if (existing) {
        return { ok: true, skipped: true, reason: 'Auth already exists', authId: existing.id };
    }

    // 2. Fetch patient data in parallel
    let patient, coverage, conditions;
    try {
        [patient, coverage, conditions] = await Promise.all([
            ehr.getPatient(clientSlug, order.patientId),
            ehr.getCoverage(clientSlug, order.patientId),
            ehr.getConditions(clientSlug, order.patientId)
        ]);
    } catch (err) {
        console.error(`[Workflow] EHR data fetch failed for order ${order.id}:`, err.message);
        return { ok: false, error: `EHR fetch failed: ${err.message}` };
    }

    if (!coverage) {
        return { ok: false, error: 'No active coverage found for patient' };
    }

    // Determine payer ID — map payer name to registry
    const payerId = resolvePayer(coverage.payerName);
    if (!payerId) {
        console.warn(`[Workflow] Unknown payer: ${coverage.payerName} — falling back to X12`);
    }

    // Build clinical notes from conditions
    const diagnosisCodes = conditions.map(c => c.code).filter(Boolean);
    const clinicalNoteLines = [
        order.notes || '',
        conditions.length > 0
            ? `Active diagnoses: ${conditions.map(c => `${c.code} (${c.display})`).join(', ')}`
            : ''
    ].filter(Boolean);

    // 3. Build auth request
    const authRequest = {
        patientDOB: patient.dob,
        memberId: coverage.memberId,
        groupNumber: coverage.groupNumber,
        npi: conn.npi,
        procedureCodes,
        diagnosisCodes,
        requestDate: dayjs().format('YYYY-MM-DD'),
        urgency: order.priority === 'stat' ? 'urgent' : (conn.default_urgency || 'routine'),
        clinicalNotes: clinicalNoteLines.join('\n'),
        payerName: coverage.payerName,
        payerId: payerId || 'UNKNOWN',
        coverageFhirId: coverage.fhirId,
        patientGender: patient.gender,
        patientFirstName: patient.name.split(' ')[0],
        patientLastName: patient.name.split(' ').slice(1).join(' ') || patient.name
    };

    // 4. Submit to payer
    const submitResult = await payers.submitAuthRequest(clientSlug, payerId || 'MEDICAID', authRequest);

    // 5. Persist to DB
    const urgency = authRequest.urgency;
    const { data: authRecord, error: insertError } = await supabase
        .from('pab_auths')
        .insert({
            client_slug: clientSlug,
            order_id: order.id,
            patient_id: order.patientId,
            patient_name: patient.name,
            payer_id: payerId || 'UNKNOWN',
            payer_name: coverage.payerName,
            member_id: coverage.memberId,
            group_number: coverage.groupNumber,
            procedure_codes: procedureCodes,
            diagnosis_codes: diagnosisCodes,
            clinical_notes: authRequest.clinicalNotes,
            urgency,
            status: submitResult.ok ? 'submitted' : 'draft',
            reference_number: submitResult.referenceNumber || null,
            submitted_at: submitResult.ok ? new Date().toISOString() : null
        })
        .select()
        .single();

    if (insertError) {
        console.error('[Workflow] DB insert failed:', insertError.message);
        return { ok: false, error: insertError.message };
    }

    await logTimeline(clientSlug, authRecord.id, 'auth_created', {
        orderId: order.id,
        payerId,
        procedureCodes,
        urgency
    });

    if (submitResult.ok) {
        await logTimeline(clientSlug, authRecord.id, 'submitted_to_payer', {
            method: submitResult.method,
            referenceNumber: submitResult.referenceNumber,
            estimatedDecisionDate: submitResult.estimatedDecisionDate
        });
    }

    // 6. Alert staff
    const alertMsg = submitResult.ok
        ? `GRIDHAND Prior Auth: Submitted for ${patient.name} | ${procedureCodes.join(', ')} | Ref: ${submitResult.referenceNumber || 'pending'} | Est decision: ${submitResult.estimatedDecisionDate || 'TBD'}`
        : `GRIDHAND Prior Auth: Submission FAILED for ${patient.name} | ${procedureCodes.join(', ')} | Error: ${submitResult.error} — manual action needed`;

    await sendStaffAlert(conn, 'Prior Auth Submitted', alertMsg);

    return {
        ok: true,
        authId: authRecord.id,
        referenceNumber: submitResult.referenceNumber,
        status: submitResult.ok ? 'submitted' : 'draft',
        estimatedDecisionDate: submitResult.estimatedDecisionDate
    };
}

// ============================================================
// STATUS UPDATES
// ============================================================

/**
 * checkAndUpdateStatus(clientSlug, authRecord)
 *
 * Poll payer for updated decision.
 * On approval  → update DB, write back to EHR, alert staff
 * On denial    → update DB, trigger appeal if auto_appeal=true, alert staff
 * On more_info → alert staff with specifics
 */
async function checkAndUpdateStatus(clientSlug, authRecord) {
    if (!authRecord.reference_number) {
        return { skipped: true, reason: 'No reference number — cannot check status' };
    }

    const conn = await loadConnection(clientSlug);
    if (!conn) return { ok: false, error: 'Connection not found' };

    const statusResult = await payers.checkAuthStatus(
        clientSlug,
        authRecord.payer_id,
        authRecord.reference_number
    );

    if (!statusResult.ok) {
        console.error(`[Workflow] Status check failed for auth ${authRecord.id}:`, statusResult.error);
        return { ok: false, error: statusResult.error };
    }

    const prevStatus = authRecord.status;
    const newStatus = statusResult.status;

    // Always bump the check counter + timestamp
    const baseUpdates = {
        status_check_count: (authRecord.status_check_count || 0) + 1,
        last_status_check_at: new Date().toISOString()
    };

    if (newStatus === prevStatus) {
        await updateAuthRecord(authRecord.id, baseUpdates);
        return { ok: true, unchanged: true, status: newStatus };
    }

    // Status changed — build full update
    const updates = { ...baseUpdates, status: newStatus };

    if (newStatus === 'approved') {
        updates.auth_number = statusResult.authNumber;
        updates.decision_at = new Date().toISOString();
        updates.expiration_date = statusResult.expirationDate || null;
    } else if (newStatus === 'denied') {
        updates.denial_reason = statusResult.denialReason;
        updates.decision_at = new Date().toISOString();
    } else if (newStatus === 'expired') {
        updates.decision_at = new Date().toISOString();
    }

    await updateAuthRecord(authRecord.id, updates);
    await logTimeline(clientSlug, authRecord.id, 'status_changed', {
        from: prevStatus,
        to: newStatus,
        authNumber: statusResult.authNumber,
        denialReason: statusResult.denialReason,
        rawStatus: statusResult.rawStatus
    });

    // Post-decision actions
    if (newStatus === 'approved') {
        // Write auth number back to EHR
        if (authRecord.order_id) {
            try {
                await ehr.updateClaimResponse(
                    clientSlug,
                    authRecord.order_id,
                    statusResult.authNumber,
                    'approved'
                );
            } catch (err) {
                console.error(`[Workflow] EHR write-back failed for auth ${authRecord.id}:`, err.message);
            }
        }

        const expiresMsg = statusResult.expirationDate
            ? ` | Expires: ${statusResult.expirationDate}`
            : '';
        await sendStaffAlert(conn,
            'Prior Auth APPROVED',
            `GRIDHAND Prior Auth APPROVED: ${authRecord.patient_name} | ${(authRecord.procedure_codes || []).join(', ')} | Auth#: ${statusResult.authNumber || 'N/A'}${expiresMsg}`
        );
    }

    if (newStatus === 'denied') {
        await sendStaffAlert(conn,
            'Prior Auth DENIED',
            `GRIDHAND Prior Auth DENIED: ${authRecord.patient_name} | ${(authRecord.procedure_codes || []).join(', ')} | Reason: ${statusResult.denialReason || 'Not specified'} — review for appeal`
        );

        // Auto-appeal if configured
        if (conn.auto_appeal) {
            const { queues } = require('./jobs');
            await queues['pab:appeal'].add('appeal', {
                clientSlug,
                authId: authRecord.id
            }, { delay: 5 * 60 * 1000 }); // 5 min delay
        }
    }

    if (newStatus === 'more_info_needed') {
        await sendStaffAlert(conn,
            'Prior Auth — Additional Info Needed',
            `GRIDHAND Prior Auth: Additional info needed for ${authRecord.patient_name} | ${(authRecord.procedure_codes || []).join(', ')} | ${statusResult.additionalInfoRequested || 'See payer portal for details'}`
        );
    }

    return { ok: true, prevStatus, newStatus, authNumber: statusResult.authNumber };
}

// ============================================================
// APPEAL WORKFLOW
// ============================================================

/**
 * runAppealWorkflow(clientSlug, authId)
 *
 * Generate appeal letter via Claude, submit to payer.
 */
async function runAppealWorkflow(clientSlug, authId) {
    const conn = await loadConnection(clientSlug);
    if (!conn) throw new Error(`Connection not found for ${clientSlug}`);

    const { data: authRecord } = await supabase
        .from('pab_auths')
        .select('*')
        .eq('id', authId)
        .single();

    if (!authRecord) return { ok: false, error: 'Auth record not found' };

    if (!['denied', 'appeal_denied'].includes(authRecord.status)) {
        return { ok: false, error: `Cannot appeal auth in status: ${authRecord.status}` };
    }

    // Build appeal letter using Claude
    const anthropicKey = conn.anthropic_key || process.env.ANTHROPIC_API_KEY;
    const anthropic = new Anthropic({ apiKey: anthropicKey });

    const appealPrompt = [
        `Write a professional medical prior authorization appeal letter for the following denial:`,
        ``,
        `Patient: ${authRecord.patient_name}`,
        `Procedure Codes: ${(authRecord.procedure_codes || []).join(', ')}`,
        `Diagnosis Codes: ${(authRecord.diagnosis_codes || []).join(', ')}`,
        `Payer: ${authRecord.payer_name}`,
        `Denial Reason: ${authRecord.denial_reason || 'Not specified'}`,
        ``,
        `Clinical Notes:`,
        authRecord.clinical_notes || 'Not provided',
        ``,
        `Write a concise, medically-grounded appeal that:`,
        `1. Cites medical necessity based on the diagnosis codes`,
        `2. References relevant clinical guidelines (e.g., USPSTF, AHA, ACR)`,
        `3. Directly addresses the denial reason`,
        `4. Uses professional clinical language`,
        `5. Is formatted as a formal letter (no placeholders — use "Treating Physician" and practice details)`,
        ``,
        `Keep it under 500 words. Output only the letter text.`
    ].join('\n');

    let appealLetter = '';
    try {
        const message = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 800,
            messages: [{ role: 'user', content: appealPrompt }]
        });
        appealLetter = message.content[0]?.text || '';
    } catch (err) {
        console.error('[Workflow] Claude appeal generation failed:', err.message);
        return { ok: false, error: `Appeal letter generation failed: ${err.message}` };
    }

    // Submit appeal to payer
    const appealResult = await payers.submitAppeal(
        clientSlug,
        authRecord.payer_id,
        authRecord.reference_number,
        appealLetter
    );

    const newStatus = appealResult.ok ? 'appealing' : authRecord.status;
    await updateAuthRecord(authId, {
        status: newStatus,
        appeal_letter: appealLetter,
        appeal_submitted_at: appealResult.ok ? new Date().toISOString() : null
    });

    await logTimeline(clientSlug, authId, 'appeal_submitted', {
        method: appealResult.method,
        appealReferenceNumber: appealResult.appealReferenceNumber,
        manualRequired: appealResult.method === 'manual'
    });

    const alertMsg = appealResult.method === 'manual' || appealResult.method === 'manual_x12'
        ? `GRIDHAND Prior Auth Appeal: Letter generated for ${authRecord.patient_name} — MANUAL submission required to ${authRecord.payer_name}`
        : `GRIDHAND Prior Auth Appeal: Submitted for ${authRecord.patient_name} | ${authRecord.payer_name} | Ref: ${appealResult.appealReferenceNumber || 'pending'}`;

    await sendStaffAlert(conn, 'Appeal Submitted', alertMsg);

    return {
        ok: true,
        appealLetter,
        method: appealResult.method,
        appealReferenceNumber: appealResult.appealReferenceNumber,
        status: newStatus
    };
}

// ============================================================
// DAILY DIGEST
// ============================================================

/**
 * sendDailyDigest(conn)
 * Morning summary of all in-flight authorizations.
 */
async function sendDailyDigest(conn) {
    const { data: auths } = await supabase
        .from('pab_auths')
        .select('status, payer_name, patient_name, urgency, submitted_at')
        .eq('client_slug', conn.client_slug)
        .not('status', 'in', '("cancelled","expired","appeal_denied")');

    const allAuths = auths || [];

    const pending = allAuths.filter(a => ['submitted', 'pending'].includes(a.status));
    const approved = allAuths.filter(a => ['approved', 'appeal_approved'].includes(a.status));
    const denied = allAuths.filter(a => a.status === 'denied');
    const appealing = allAuths.filter(a => a.status === 'appealing');
    const needAttention = allAuths.filter(a => a.status === 'more_info_needed');

    // Urgent pending (> 24h old without decision)
    const urgentStale = pending.filter(a => {
        if (!a.submitted_at) return false;
        const hrs = (Date.now() - new Date(a.submitted_at).getTime()) / 3_600_000;
        return a.urgency === 'urgent' && hrs > 24;
    });

    const lines = [
        `GRIDHAND Prior Auth — Daily Digest ${dayjs().format('MM/DD/YYYY')}`,
        `Pending: ${pending.length} | Approved: ${approved.length} | Denied: ${denied.length}`,
        `Appealing: ${appealing.length} | Need Info: ${needAttention.length}`
    ];

    if (urgentStale.length > 0) {
        lines.push(`⚠ ${urgentStale.length} URGENT auth(s) pending >24h — follow up immediately`);
    }
    if (needAttention.length > 0) {
        lines.push(`Action needed: ${needAttention.map(a => a.patient_name).join(', ')}`);
    }

    const message = lines.join('\n');
    await sendStaffAlert(conn, 'Daily Prior Auth Digest', message);

    return { ok: true, summary: { pending: pending.length, approved: approved.length, denied: denied.length, appealing: appealing.length, needAttention: needAttention.length } };
}

// ============================================================
// STAFF ALERTS
// ============================================================

/**
 * sendStaffAlert(conn, subject, message)
 * Send SMS to clinical/billing staff phone.
 */
async function sendStaffAlert(conn, subject, message) {
    const phone = conn.staff_phone || conn.billing_phone;
    if (!phone) {
        console.log(`[Workflow] No staff phone for ${conn.client_slug} — alert: ${subject}`);
        return { ok: false, reason: 'No staff phone configured' };
    }

    const body = message.length > 1600 ? message.slice(0, 1597) + '...' : message;

    try {
        const msg = await twilioClient.messages.create({
            body,
            from: process.env.TWILIO_FROM_NUMBER,
            to: phone
        });

        await supabase.from('pab_sms_log').insert({
            client_slug: conn.client_slug,
            direction: 'outbound',
            recipient_phone: phone,
            message_body: body,
            twilio_sid: msg.sid,
            status: 'sent'
        });

        return { ok: true, sid: msg.sid };
    } catch (err) {
        console.error(`[Workflow] SMS send error for ${conn.client_slug}:`, err.message);
        return { ok: false, error: err.message };
    }
}

// ============================================================
// UTILITIES
// ============================================================

/**
 * resolvePayer(payerName)
 * Map a free-form payer name to a registry ID.
 */
function resolvePayer(payerName) {
    if (!payerName) return null;
    const name = payerName.toUpperCase();

    if (name.includes('UNITED') || name.includes('UHC') || name.includes('OPTUM')) return 'UHC';
    if (name.includes('AETNA')) return 'AETNA';
    if (name.includes('CIGNA') || name.includes('EVERNORTH')) return 'CIGNA';
    if (name.includes('HUMANA')) return 'HUMANA';
    if (name.includes('BLUE CROSS') || name.includes('BCBS') || name.includes('ANTHEM')) return 'BCBS_AVAILITY';
    if (name.includes('KAISER')) return 'KAISER';
    if (name.includes('MOLINA')) return 'MOLINA';
    if (name.includes('MEDICARE')) return 'MEDICARE';
    if (name.includes('MEDICAID')) return 'MEDICAID';

    return null;
}

module.exports = {
    processNewOrder,
    checkAndUpdateStatus,
    runAppealWorkflow,
    sendDailyDigest,
    sendStaffAlert,
    resolvePayer
};
