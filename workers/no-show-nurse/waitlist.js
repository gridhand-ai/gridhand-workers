/**
 * GRIDHAND No-Show Nurse — Waitlist Management
 *
 * Functions:
 *   getWaitlist(clientSlug, filters)                       — query waitlist
 *   addToWaitlist(clientSlug, patientData)                 — add patient entry
 *   removeFromWaitlist(clientSlug, waitlistId)             — remove entry
 *   findMatchingWaitlistPatients(clientSlug, slot)         — match slot → top 3 patients
 *   offerSlotToPatient(clientSlug, waitlistEntry, slot)    — SMS offer to patient
 *   handleSlotResponse(clientSlug, patientPhone, body, slot) — YES/NO reply handler
 *   expireOldOffers(clientSlug)                            — expire 2hr unanswered offers
 *   getWaitlistStats(clientSlug)                           — counts + avg wait time
 */

'use strict';

const dayjs  = require('dayjs');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Lazy twilio init
let twilioClient = null;
function getTwilio() {
    if (!twilioClient) {
        twilioClient = twilio(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_AUTH_TOKEN
        );
    }
    return twilioClient;
}

const FROM = process.env.TWILIO_FROM_NUMBER;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getConnection(clientSlug) {
    const { data, error } = await supabase
        .from('nsn_connections')
        .select('*')
        .eq('client_slug', clientSlug)
        .single();
    if (error && error.code !== 'PGRST116') throw error;
    if (!data) throw new Error(`No NSN connection for ${clientSlug}`);
    return data;
}

async function logSms(clientSlug, { patientId, appointmentId, direction, body, sid, status }) {
    await supabase.from('nsn_sms_log').insert({
        client_slug:    clientSlug,
        patient_id:     patientId || null,
        appointment_id: appointmentId || null,
        direction,
        message_body:   body,
        twilio_sid:     sid || null,
        status:         status || null,
    });
}

async function sendSms(clientSlug, to, body, meta = {}) {
    const msg = await getTwilio().messages.create({ from: FROM, to, body });
    await logSms(clientSlug, {
        patientId:     meta.patientId,
        appointmentId: meta.appointmentId,
        direction:     'outbound',
        body,
        sid:    msg.sid,
        status: msg.status,
    });
    return msg;
}

// ─── getWaitlist ──────────────────────────────────────────────────────────────

/**
 * @param {string} clientSlug
 * @param {{ status?: string, appointmentType?: string }} [filters]
 */
async function getWaitlist(clientSlug, filters = {}) {
    let query = supabase
        .from('nsn_waitlist')
        .select('*')
        .eq('client_slug', clientSlug)
        .order('priority', { ascending: false })
        .order('added_at',  { ascending: true });

    if (filters.status) {
        query = query.eq('status', filters.status);
    }
    if (filters.appointmentType) {
        query = query.ilike('appointment_type', `%${filters.appointmentType}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

// ─── addToWaitlist ────────────────────────────────────────────────────────────

async function addToWaitlist(clientSlug, patientData) {
    const {
        patientId, patientName, patientPhone,
        preferredDays = [], preferredTimes = [],
        appointmentType, notes,
    } = patientData;

    const { data, error } = await supabase
        .from('nsn_waitlist')
        .insert({
            client_slug:      clientSlug,
            patient_id:       patientId || null,
            patient_name:     patientName,
            patient_phone:    patientPhone,
            appointment_type: appointmentType,
            preferred_days:   preferredDays,
            preferred_times:  preferredTimes,
            notes:            notes || null,
            status:           'waiting',
        })
        .select()
        .single();

    if (error) throw error;
    console.log(`[Waitlist] Added ${patientName} (${appointmentType}) to waitlist for ${clientSlug}`);
    return data;
}

// ─── removeFromWaitlist ───────────────────────────────────────────────────────

async function removeFromWaitlist(clientSlug, waitlistId) {
    const { error } = await supabase
        .from('nsn_waitlist')
        .delete()
        .eq('client_slug', clientSlug)
        .eq('id', waitlistId);

    if (error) throw error;
    console.log(`[Waitlist] Removed waitlist entry ${waitlistId} for ${clientSlug}`);
    return true;
}

// ─── findMatchingWaitlistPatients ─────────────────────────────────────────────

/**
 * Match an open slot to the top 3 eligible waitlist patients.
 *
 * Matching criteria (in priority order):
 *  1. Must be status 'waiting' (not already offered/booked)
 *  2. Appointment type must match (case-insensitive partial)
 *  3. Preferred days must include the slot's day of week (if patient specified days)
 *  4. Preferred times must include the slot's time of day (if patient specified times)
 *  5. Tie-break: highest priority first, then FIFO by added_at
 *
 * @param {string} clientSlug
 * @param {{ id: string, start: string, appointmentType: string }} slot
 * @returns {Array} top 3 waitlist entries
 */
async function findMatchingWaitlistPatients(clientSlug, slot) {
    const slotDate  = dayjs(slot.start);
    const slotDay   = slotDate.format('dddd');          // e.g. "Monday"
    const slotHour  = slotDate.hour();
    const slotTime  = slotHour < 12 ? 'morning' : slotHour < 17 ? 'afternoon' : 'evening';

    const candidates = await getWaitlist(clientSlug, {
        status:          'waiting',
        appointmentType: slot.appointmentType || undefined,
    });

    const scored = candidates.map(entry => {
        let score = entry.priority || 0;

        const preferredDays  = entry.preferred_days  || [];
        const preferredTimes = entry.preferred_times || [];

        // Bonus if day matches (or no preference given)
        if (preferredDays.length === 0 || preferredDays.includes(slotDay)) score += 10;
        // Bonus if time matches (or no preference given)
        if (preferredTimes.length === 0 || preferredTimes.includes(slotTime)) score += 5;

        return { ...entry, _score: score };
    });

    // Highest score first, then oldest added_at
    scored.sort((a, b) => {
        if (b._score !== a._score) return b._score - a._score;
        return dayjs(a.added_at).diff(dayjs(b.added_at));
    });

    return scored.slice(0, 3);
}

// ─── offerSlotToPatient ───────────────────────────────────────────────────────

/**
 * Text a waitlist patient about an open slot.
 * Updates their waitlist record to 'offered' with an expiry timestamp.
 *
 * @param {string} clientSlug
 * @param {object} waitlistEntry  — row from nsn_waitlist
 * @param {object} slot           — { id, start, appointmentType }
 */
async function offerSlotToPatient(clientSlug, waitlistEntry, slot) {
    const conn       = await getConnection(clientSlug);
    const expiry     = conn.slot_offer_expiry_minutes || 120;
    const slotTime   = dayjs(slot.start).format('ddd MMM D [at] h:mma');
    const apptType   = slot.appointmentType || 'appointment';

    const body = `Great news ${waitlistEntry.patient_name}! We have an opening at ${conn.practice_name} on ${slotTime} for a ${apptType}. Reply YES to grab it or NO to pass. You have ${expiry / 60} hours to respond!`;

    // Mark patient as 'offered' and set expiry
    const offerExpiresAt = dayjs().add(expiry, 'minute').toISOString();
    const { error } = await supabase
        .from('nsn_waitlist')
        .update({
            status:           'offered',
            offer_sent_at:    new Date().toISOString(),
            offer_expires_at: offerExpiresAt,
            slot_id:          slot.id,
            updated_at:       new Date().toISOString(),
        })
        .eq('id', waitlistEntry.id);

    if (error) throw error;

    await sendSms(clientSlug, waitlistEntry.patient_phone, body, {
        patientId: waitlistEntry.patient_id,
    });

    console.log(`[Waitlist] Offered slot ${slot.id} to ${waitlistEntry.patient_name} (${waitlistEntry.patient_phone}) for ${clientSlug}`);
    return { waitlistEntry, slot, offerExpiresAt };
}

// ─── handleSlotResponse ───────────────────────────────────────────────────────

/**
 * Handle YES/NO response from a patient about a slot offer.
 *
 * YES → book the appointment via scheduling module, mark waitlist entry booked,
 *       record a slot fill, alert front desk.
 * NO  → reset patient to 'waiting', try next match on waitlist.
 *
 * @param {string} clientSlug
 * @param {string} patientPhone
 * @param {string} body              — raw SMS body
 * @param {object} slot              — { id, start, appointmentType }
 */
async function handleSlotResponse(clientSlug, patientPhone, body, slot) {
    const upper = body.trim().toUpperCase();
    const conn  = await getConnection(clientSlug);

    // Find the offered waitlist entry for this phone
    const { data: entries, error } = await supabase
        .from('nsn_waitlist')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('patient_phone', patientPhone)
        .eq('status', 'offered')
        .order('offer_sent_at', { ascending: false })
        .limit(1);

    if (error) throw error;
    const entry = entries?.[0];
    if (!entry) {
        console.warn(`[Waitlist] handleSlotResponse: no offered entry for ${patientPhone} in ${clientSlug}`);
        return null;
    }

    if (upper === 'YES') {
        // Book via scheduling
        const scheduling = require('./scheduling');
        let bookedAppt = null;
        try {
            bookedAppt = await scheduling.bookAppointment(
                clientSlug,
                entry.slot_id || slot.id,
                entry.patient_id,
                entry.appointment_type
            );
        } catch (err) {
            console.error(`[Waitlist] Booking failed for ${patientPhone}: ${err.message}`);
            // Fallback: mark as booked in our system even if EHR call fails — staff can confirm
        }

        await supabase
            .from('nsn_waitlist')
            .update({
                status:     'booked',
                booked_at:  new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', entry.id);

        // Record slot fill
        const fillStart = entry.offer_sent_at ? dayjs() : null;
        const minutesToFill = fillStart ? dayjs().diff(dayjs(entry.offer_sent_at), 'minute') : null;

        await supabase.from('nsn_slot_fills').insert({
            client_slug:           clientSlug,
            slot_id:               entry.slot_id || slot?.id,
            appointment_date:      slot?.start || null,
            appointment_type:      entry.appointment_type,
            waitlist_id:           entry.id,
            patient_id:            entry.patient_id,
            patient_name:          entry.patient_name,
            offers_sent:           1,
            time_to_fill_minutes:  minutesToFill,
        });

        // Confirm to patient
        const confirmTime = slot?.start ? dayjs(slot.start).format('ddd MMM D [at] h:mma') : 'your requested time';
        const confirmMsg  = `You're confirmed at ${conn.practice_name} on ${confirmTime}. See you then! - ${conn.practice_name}`;
        await sendSms(clientSlug, patientPhone, confirmMsg, { patientId: entry.patient_id });

        // Alert front desk
        if (conn.front_desk_phone) {
            const alertMsg = `[No-Show Nurse] Waitlist fill: ${entry.patient_name} booked for ${entry.appointment_type}${slot?.start ? ' on ' + dayjs(slot.start).format('MMM D [at] h:mma') : ''}.`;
            await sendSms(clientSlug, conn.front_desk_phone, alertMsg);
        }

        console.log(`[Waitlist] ${entry.patient_name} said YES — slot filled for ${clientSlug}`);
        return { action: 'booked', entry, appointment: bookedAppt };

    } else if (upper === 'NO') {
        // Reset to waiting, try next candidate
        await supabase
            .from('nsn_waitlist')
            .update({
                status:           'waiting',
                offer_sent_at:    null,
                offer_expires_at: null,
                slot_id:          null,
                updated_at:       new Date().toISOString(),
            })
            .eq('id', entry.id);

        console.log(`[Waitlist] ${entry.patient_name} passed — trying next candidate for ${clientSlug}`);

        // Try next patient on waitlist for this slot
        const next = await findMatchingWaitlistPatients(clientSlug, slot);
        const nextCandidate = next.find(n => n.id !== entry.id);
        if (nextCandidate) {
            await offerSlotToPatient(clientSlug, nextCandidate, slot);
        } else {
            console.log(`[Waitlist] No more waitlist candidates for slot ${slot?.id} in ${clientSlug}`);
        }

        return { action: 'passed', entry };
    }

    // Non-YES/NO reply — pass back to outreach handler
    return null;
}

// ─── expireOldOffers ──────────────────────────────────────────────────────────

/**
 * Find offered waitlist entries past their expiry time and try the next candidate.
 */
async function expireOldOffers(clientSlug) {
    const now = new Date().toISOString();

    const { data: expired, error } = await supabase
        .from('nsn_waitlist')
        .select('*')
        .eq('client_slug', clientSlug)
        .eq('status', 'offered')
        .lt('offer_expires_at', now);

    if (error) throw error;
    if (!expired?.length) return 0;

    for (const entry of expired) {
        console.log(`[Waitlist] Offer expired for ${entry.patient_name} (${entry.id}) in ${clientSlug}`);

        // Mark expired
        await supabase
            .from('nsn_waitlist')
            .update({
                status:     'expired',
                updated_at: new Date().toISOString(),
            })
            .eq('id', entry.id);

        // Try next waitlist candidate for the same slot type
        if (entry.slot_id) {
            const fakeSlot = {
                id:              entry.slot_id,
                start:           null,
                appointmentType: entry.appointment_type,
            };
            const next = await findMatchingWaitlistPatients(clientSlug, fakeSlot);
            const nextCandidate = next.find(n => n.id !== entry.id);
            if (nextCandidate && entry.slot_id) {
                await offerSlotToPatient(clientSlug, nextCandidate, fakeSlot);
            }
        }
    }

    console.log(`[Waitlist] Expired ${expired.length} stale offers for ${clientSlug}`);
    return expired.length;
}

// ─── getWaitlistStats ─────────────────────────────────────────────────────────

async function getWaitlistStats(clientSlug) {
    const { data: all, error } = await supabase
        .from('nsn_waitlist')
        .select('*')
        .eq('client_slug', clientSlug);

    if (error) throw error;
    if (!all?.length) return { total: 0, byType: {}, avgWaitDays: 0 };

    const byType = {};
    let totalWaitDays = 0;
    let waitingCount  = 0;

    for (const entry of all) {
        if (!byType[entry.appointment_type]) byType[entry.appointment_type] = 0;
        byType[entry.appointment_type]++;

        if (entry.status === 'waiting') {
            const days = dayjs().diff(dayjs(entry.added_at), 'day');
            totalWaitDays += days;
            waitingCount++;
        }
    }

    return {
        total:        all.length,
        waiting:      all.filter(e => e.status === 'waiting').length,
        offered:      all.filter(e => e.status === 'offered').length,
        booked:       all.filter(e => e.status === 'booked').length,
        byType,
        avgWaitDays:  waitingCount > 0 ? Math.round(totalWaitDays / waitingCount) : 0,
    };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    getWaitlist,
    addToWaitlist,
    removeFromWaitlist,
    findMatchingWaitlistPatients,
    offerSlotToPatient,
    handleSlotResponse,
    expireOldOffers,
    getWaitlistStats,
};
