/**
 * GRIDHAND Intake Accelerator — Core Business Logic
 *
 * Responsibilities:
 *  - processNewInquiry: save inquiry, fire off first questionnaire question
 *  - handleSmsReply:    route incoming SMS to correct questionnaire step
 *  - buildQuestionnaire: define questions per practice area
 *  - sendNextQuestion:  send one question via Twilio, record it in DB
 *  - completeIntake:    create Clio contact + matter after all answers collected
 *  - scheduleConsultation: book Clio calendar entry, SMS confirmation
 */

'use strict';

require('dotenv').config();

const twilio = require('twilio');
const dayjs  = require('dayjs');
const { createClient } = require('@supabase/supabase-js');
const clio   = require('./clio');

// ─── Supabase ─────────────────────────────────────────────────────────────────

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Twilio ───────────────────────────────────────────────────────────────────

function getTwilioClient() {
    return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendSms(to, body, clientSlug, alertType) {
    const client = getTwilioClient();

    await client.messages.create({
        to,
        from: process.env.TWILIO_FROM_NUMBER,
        body,
    });

    // Log every outbound message
    await supabase.from('intake_alerts').insert({
        client_slug:  clientSlug,
        alert_type:   alertType,
        recipient:    to,
        message_body: body,
    });

    console.log(`[SMS] Sent "${alertType}" to ${to} (${clientSlug})`);
}

// ─── Questionnaire Definitions ────────────────────────────────────────────────

/**
 * Returns an ordered array of question strings for the given practice area.
 * These are sent one at a time via SMS — each reply advances the step counter.
 */
function buildQuestionnaire(practiceArea) {
    const area = (practiceArea || '').toLowerCase().replace(/\s+/g, '_');

    const questionnaires = {
        personal_injury: [
            'How were you injured? (e.g. car accident, slip and fall, workplace injury)',
            'When did the injury occur? (date or approximate month/year)',
            'Can you briefly describe what happened?',
            'Were police or emergency services called to the scene? (yes/no)',
            'Have you received any medical treatment? (yes/no)',
            'Do you have the other party\'s insurance information? (yes/no)',
        ],
        family_law: [
            'Are you currently married, or is this about a divorce already in progress?',
            'Are children involved in this matter? (yes/no)',
            'Are there significant assets to divide — home, business, retirement accounts? (yes/no)',
            'Can you describe your current living situation in one or two sentences?',
        ],
        criminal: [
            'What are you charged with, or what is the nature of the investigation?',
            'When is your next court date, if you have one? (date or "not yet scheduled")',
            'Are you currently in custody, or have you been released? (in custody / released)',
        ],
        business: [
            'What type of legal issue are you facing? (e.g. contract dispute, partnership problem, collections)',
            'Is there a written contract involved in this matter? (yes/no)',
            'Are there other parties — individuals or businesses — on the opposing side?',
        ],
        estate: [
            'Are you looking to create a new will or trust, or update existing documents?',
            'Do you already have estate planning documents in place? (yes/no)',
            'What is the approximate total value of the assets involved? (a rough estimate is fine)',
        ],
    };

    // Default to a general set if practice area is unknown
    return questionnaires[area] || [
        'Can you briefly describe the legal matter you need help with?',
        'How urgent is your situation? (e.g. court date soon, ongoing dispute, planning ahead)',
        'Have you worked with an attorney on this matter before? (yes/no)',
    ];
}

// ─── DB Helpers ───────────────────────────────────────────────────────────────

async function getInquiryById(inquiryId) {
    const { data, error } = await supabase
        .from('inquiries')
        .select('*')
        .eq('id', inquiryId)
        .single();

    if (error) throw error;
    return data;
}

async function getActiveInquiryByPhone(clientSlug, phone) {
    // Find the most recent non-terminal inquiry for this phone number
    const { data, error } = await supabase
        .from('inquiries')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('contact_phone', phone)
        .in('status', ['new', 'in_progress'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    return data || null;
}

async function updateInquiry(inquiryId, fields) {
    const { error } = await supabase
        .from('inquiries')
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq('id', inquiryId);

    if (error) throw error;
}

async function saveQuestionnaireStep(inquiryId, step, questionText, answerText) {
    const { error } = await supabase
        .from('questionnaire_sessions')
        .upsert({
            inquiry_id:    inquiryId,
            step,
            question_text: questionText,
            answer_text:   answerText,
            answered_at:   new Date().toISOString(),
        }, { onConflict: 'inquiry_id,step' });

    if (error) throw error;
}

// ─── Core Functions ───────────────────────────────────────────────────────────

/**
 * Entry point for all new client inquiries (web form, phone capture, etc.)
 *
 * inquiryData: { contactName, contactPhone, contactEmail, practiceArea,
 *                inquirySource, inquiryText }
 */
async function processNewInquiry(clientSlug, inquiryData) {
    const {
        contactName,
        contactPhone,
        contactEmail,
        practiceArea,
        inquirySource = 'web_form',
        inquiryText,
    } = inquiryData;

    if (!contactPhone) throw new Error('contactPhone is required to process an inquiry');

    // Save inquiry record
    const { data: inquiry, error } = await supabase
        .from('inquiries')
        .insert({
            client_slug:           clientSlug,
            contact_name:          contactName || null,
            contact_phone:         contactPhone,
            contact_email:         contactEmail || null,
            practice_area:         practiceArea || null,
            inquiry_source:        inquirySource,
            inquiry_text:          inquiryText || null,
            status:                'new',
            questionnaire_step:    0,
            questionnaire_answers: [],
        })
        .select('*')
        .single();

    if (error) throw error;

    console.log(`[Intake] New inquiry ${inquiry.id} from ${contactPhone} (${clientSlug})`);

    // Alert the attorney phone about the new lead
    const conn = await clio.getConnection(clientSlug);
    const alertTarget = conn?.attorney_phone || conn?.owner_phone;
    if (alertTarget) {
        const alertMsg = [
            `New intake lead — ${contactName || contactPhone}`,
            `Practice area: ${practiceArea || 'unknown'}`,
            `Source: ${inquirySource}`,
            inquiryText ? `Message: "${inquiryText.slice(0, 80)}"` : null,
        ].filter(Boolean).join('\n');

        await sendSms(alertTarget, alertMsg, clientSlug, 'new_inquiry');
    }

    // Send the welcome + first question
    const questions = buildQuestionnaire(practiceArea);
    if (questions.length > 0) {
        const practiceName = conn?.practice_name || 'our law firm';
        const greeting = `Hi${contactName ? ` ${contactName.split(' ')[0]}` : ''}, thank you for reaching out to ${practiceName}. To get started, we have a few quick questions so we can best prepare for your consultation.\n\nReply STOP to opt out or HUMAN to speak with someone now.\n\n${questions[0]}`;

        await sendSms(contactPhone, greeting, clientSlug, 'questionnaire_step');

        // Record question step 0 in the session log
        await saveQuestionnaireStep(inquiry.id, 0, questions[0], null);

        await updateInquiry(inquiry.id, {
            status:             'in_progress',
            questionnaire_step: 0,
        });
    }

    return inquiry;
}

/**
 * Route an inbound SMS reply to the correct questionnaire step.
 * Called by the Twilio webhook handler in index.js.
 */
async function handleSmsReply(clientSlug, from, body) {
    const text = (body || '').trim();

    // Find the active intake for this phone number
    const inquiry = await getActiveInquiryByPhone(clientSlug, from);

    if (!inquiry) {
        console.log(`[Intake] No active inquiry for ${from} (${clientSlug}) — ignoring SMS`);
        return;
    }

    const conn = await clio.getConnection(clientSlug);

    // ── Opt-out ───────────────────────────────────────────────────────────────
    if (/^STOP$/i.test(text)) {
        await updateInquiry(inquiry.id, { status: 'declined' });
        console.log(`[Intake] ${from} opted out — inquiry ${inquiry.id} marked declined`);
        return;
    }

    // ── Human escalation ──────────────────────────────────────────────────────
    if (/^(HUMAN|HELP)$/i.test(text)) {
        const alertTarget = conn?.attorney_phone || conn?.owner_phone;
        if (alertTarget) {
            const escalationMsg = [
                `URGENT — Client requested human contact`,
                `Name: ${inquiry.contact_name || 'Unknown'}`,
                `Phone: ${from}`,
                `Practice area: ${inquiry.practice_area || 'unknown'}`,
                `Intake step: ${inquiry.questionnaire_step} of ${buildQuestionnaire(inquiry.practice_area).length}`,
            ].join('\n');

            await sendSms(alertTarget, escalationMsg, clientSlug, 'human_escalation');
        }

        await sendSms(
            from,
            `Got it — someone from our team will call you shortly. Thank you for your patience.`,
            clientSlug,
            'questionnaire_step'
        );
        return;
    }

    // ── Normal questionnaire flow ─────────────────────────────────────────────
    const questions     = buildQuestionnaire(inquiry.practice_area);
    const currentStep   = inquiry.questionnaire_step;

    // Save the answer for the question that was just asked
    if (currentStep < questions.length) {
        await saveQuestionnaireStep(inquiry.id, currentStep, questions[currentStep], text);

        // Append answer to the JSONB array
        const updatedAnswers = [
            ...(inquiry.questionnaire_answers || []),
            { step: currentStep, question: questions[currentStep], answer: text },
        ];

        const nextStep = currentStep + 1;

        if (nextStep < questions.length) {
            // More questions remain
            await updateInquiry(inquiry.id, {
                questionnaire_step:    nextStep,
                questionnaire_answers: updatedAnswers,
            });

            await sendNextQuestion(inquiry.id, nextStep, questions[nextStep], from, clientSlug);
        } else {
            // All questions answered — complete the intake
            await updateInquiry(inquiry.id, {
                questionnaire_step:    nextStep,
                questionnaire_answers: updatedAnswers,
            });

            await completeIntake(inquiry.id);
        }
    }
}

/**
 * Send a single questionnaire question via SMS.
 */
async function sendNextQuestion(inquiryId, step, questionText, toPhone, clientSlug) {
    await sendSms(toPhone, questionText, clientSlug, 'questionnaire_step');
    await saveQuestionnaireStep(inquiryId, step, questionText, null);
    console.log(`[Intake] Sent question step ${step} to ${toPhone} (inquiry ${inquiryId})`);
}

/**
 * Finalize the intake: create Clio contact + matter, send confirmation SMS.
 * Called automatically once all questionnaire questions are answered.
 */
async function completeIntake(inquiryId) {
    const inquiry = await getInquiryById(inquiryId);
    if (!inquiry) throw new Error(`Inquiry ${inquiryId} not found`);

    const { client_slug: clientSlug } = inquiry;
    const conn = await clio.getConnection(clientSlug);

    // Build a matter description from collected answers
    const answers = inquiry.questionnaire_answers || [];
    const answerSummary = answers
        .map(a => `${a.question}: ${a.answer}`)
        .join(' | ');

    let clioContactId = null;
    let clioMatterId  = null;

    try {
        // Create Clio contact
        const contact = await clio.createContact(clientSlug, {
            name:  inquiry.contact_name || inquiry.contact_phone,
            phone: inquiry.contact_phone,
            email: inquiry.contact_email,
        });
        clioContactId = String(contact.id);

        // Attempt to resolve practice area → Clio practice area ID
        let practiceAreaId = null;
        try {
            const areas = await clio.getPracticeAreas(clientSlug);
            const areaList = Array.isArray(areas) ? areas : (areas?.data || []);
            const matched = areaList.find(a =>
                a.name?.toLowerCase().includes((inquiry.practice_area || '').replace(/_/g, ' '))
            );
            practiceAreaId = matched?.id || null;
        } catch {
            // practice area lookup is best-effort
        }

        // Create Clio matter
        const matter = await clio.createMatter(clientSlug, {
            clientId:       contact.id,
            description:    `${(inquiry.practice_area || 'General').replace(/_/g, ' ')} — ${inquiry.contact_name || inquiry.contact_phone}`,
            practiceAreaId,
            status:         'Pending',
        });
        clioMatterId = String(matter.id);

        console.log(`[Intake] Clio records created — contact ${clioContactId}, matter ${clioMatterId} (${clientSlug})`);
    } catch (err) {
        console.error(`[Intake] Clio record creation failed for inquiry ${inquiryId}: ${err.message}`);
        // Continue — still mark intake complete and confirm with client
    }

    await updateInquiry(inquiryId, {
        status:           'completed',
        clio_contact_id:  clioContactId,
        clio_matter_id:   clioMatterId,
    });

    // Notify attorney that intake is done
    const alertTarget = conn?.attorney_phone || conn?.owner_phone;
    if (alertTarget) {
        const attorneyMsg = [
            `Intake complete — ${inquiry.contact_name || inquiry.contact_phone}`,
            `Practice area: ${inquiry.practice_area || 'unknown'}`,
            clioContactId ? `Clio contact: ${clioContactId}` : null,
            clioMatterId  ? `Clio matter: ${clioMatterId}` : null,
            `Answers: ${answerSummary.slice(0, 200)}`,
        ].filter(Boolean).join('\n');

        await sendSms(alertTarget, attorneyMsg, clientSlug, 'intake_complete');
    }

    // Confirm with prospective client
    const practiceName = conn?.practice_name || 'our firm';
    const confirmMsg = `Thank you — we have all the information we need. Someone from ${practiceName} will reach out within 1 business day to schedule your consultation. We look forward to speaking with you.`;
    await sendSms(inquiry.contact_phone, confirmMsg, clientSlug, 'intake_complete');

    return { clioContactId, clioMatterId };
}

/**
 * Create a Clio calendar entry for a consultation and notify both parties.
 *
 * preferredTime: ISO 8601 string — e.g. '2026-03-25T14:00:00-05:00'
 */
async function scheduleConsultation(clientSlug, inquiryId, preferredTime) {
    const inquiry = await getInquiryById(inquiryId);
    if (!inquiry) throw new Error(`Inquiry ${inquiryId} not found`);

    const conn = await clio.getConnection(clientSlug);

    const startAt = dayjs(preferredTime);
    const endAt   = startAt.add(30, 'minute'); // Default 30-minute consultation slot

    const calendarEntry = await clio.createCalendarEntry(clientSlug, {
        summary:     `Initial Consultation — ${inquiry.contact_name || inquiry.contact_phone}`,
        startAt:     startAt.toISOString(),
        endAt:       endAt.toISOString(),
        matterId:    inquiry.clio_matter_id ? parseInt(inquiry.clio_matter_id, 10) : null,
        location:    conn?.practice_name || null,
        description: `Practice area: ${inquiry.practice_area || 'General'}. Intake completed via GRIDHAND AI.`,
    });

    await updateInquiry(inquiryId, {
        status:                    'scheduled',
        consultation_scheduled_at: startAt.toISOString(),
    });

    const practiceNm = conn?.practice_name || 'our firm';
    const dateLabel  = startAt.format('dddd, MMMM D [at] h:mm A');

    // SMS confirmation to client
    await sendSms(
        inquiry.contact_phone,
        `Your consultation with ${practiceNm} is confirmed for ${dateLabel}. If you need to reschedule, please call us directly. We look forward to meeting with you.`,
        clientSlug,
        'consultation_scheduled'
    );

    // SMS notification to attorney
    const alertTarget = conn?.attorney_phone || conn?.owner_phone;
    if (alertTarget) {
        await sendSms(
            alertTarget,
            `Consultation scheduled:\nClient: ${inquiry.contact_name || inquiry.contact_phone}\nTime: ${dateLabel}\nMatter: ${inquiry.clio_matter_id || 'pending'}\nClio entry: ${calendarEntry.id}`,
            clientSlug,
            'consultation_scheduled'
        );
    }

    console.log(`[Intake] Consultation scheduled for inquiry ${inquiryId} at ${startAt.toISOString()}`);
    return calendarEntry;
}

// ─── Reporting Helpers ────────────────────────────────────────────────────────

/**
 * Generate the daily morning intake summary for an attorney.
 * Returns a formatted SMS string.
 */
async function buildDailySummary(clientSlug) {
    const today     = dayjs().startOf('day').toISOString();
    const yesterday = dayjs().subtract(1, 'day').startOf('day').toISOString();

    const { data: rows, error } = await supabase
        .from('inquiries')
        .select('status, created_at')
        .eq('client_slug', clientSlug)
        .gte('created_at', yesterday);

    if (error) throw error;

    const newCount        = rows.filter(r => r.created_at >= today).length;
    const completedCount  = rows.filter(r => r.status === 'completed').length;
    const scheduledCount  = rows.filter(r => r.status === 'scheduled').length;
    const pendingCount    = rows.filter(r => r.status === 'in_progress').length;

    const dateLabel = dayjs().format('ddd MMM D');

    return [
        `Intake Summary — ${dateLabel}`,
        `New inquiries: ${newCount}`,
        `Completed intakes: ${completedCount}`,
        `Consultations scheduled: ${scheduledCount}`,
        `Pending follow-ups: ${pendingCount}`,
        `Reply DETAIL for breakdown`,
    ].join('\n');
}

/**
 * Get incomplete intakes older than `olderThanHours` hours with no SMS reply.
 * Used by the follow-up cron to nudge stalled prospects.
 */
async function getStalledInquiries(clientSlug, olderThanHours = 4) {
    const cutoff = dayjs().subtract(olderThanHours, 'hour').toISOString();

    const { data, error } = await supabase
        .from('inquiries')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'in_progress')
        .lt('updated_at', cutoff);

    if (error) throw error;
    return data || [];
}

module.exports = {
    processNewInquiry,
    handleSmsReply,
    buildQuestionnaire,
    sendNextQuestion,
    completeIntake,
    scheduleConsultation,
    buildDailySummary,
    getStalledInquiries,
    sendSms,
};
