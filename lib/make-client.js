// ─── Make.com Integration Bridge ─────────────────────────────────────────────
// Fires outbound webhooks to Make.com when workers complete actions.
// Make.com handles actual integrations: CRM updates, calendar events,
// email sequences, review platform submissions, invoice status syncs, etc.
//
// Workers call fire() with structured data — they don't need to know
// which apps a client has connected. Make.com figures that out via clientSlug.
//
// Standard event types:
//   new_lead_captured        — customer first contact, intake complete
//   review_requested         — sent a review ask after job completion
//   appointment_reminder_sent — reminder sent before upcoming appointment
//   appointment_booked       — customer confirmed/requested an appointment
//   invoice_reminder_sent    — chased an overdue invoice
//   lead_followup_sent       — followed up on a sales lead
//   reactivation_sent        — reached out to a dormant customer
//   upsell_sent              — sent an upsell offer after service
//   referral_requested       — asked for a referral
//   status_updated           — job status change sent to customer
//   after_hours_lead         — lead captured during closed hours
//   weekly_report_sent       — weekly performance summary sent
//   task_completed           — generic fallback for any other worker task

const WEBHOOK_SECRET = process.env.MAKE_WEBHOOK_SECRET;

// ─── Per-event webhook routing ────────────────────────────────────────────────
// Each event type routes to its own Make.com scenario hook.
// Falls back to MAKE_OUTBOUND_WEBHOOK_URL (Worker Events catch-all) if no
// specific hook is configured for that event.
const HOOK_MAP = {
    review_requested:          () => process.env.MAKE_HOOK_REVIEW_PIPELINE,
    new_lead_captured:         () => process.env.MAKE_HOOK_LEAD_SPEED,
    invoice_reminder_sent:     () => process.env.MAKE_HOOK_INVOICE_CHASER,
    appointment_reminder_sent: () => process.env.MAKE_HOOK_APPOINTMENT_REMINDER,
    appointment_booked:        () => process.env.MAKE_HOOK_APPOINTMENT_BOOKED,
    lead_followup_sent:        () => process.env.MAKE_HOOK_LEAD_NURTURE,
    after_hours_lead:          () => process.env.MAKE_HOOK_MISSED_CALL,
    reactivation_sent:         () => process.env.MAKE_HOOK_REACTIVATION,
    dunning_recovery:          () => process.env.MAKE_HOOK_DUNNING_RECOVERY,
    no_show:                   () => process.env.MAKE_HOOK_NO_SHOW,
    review_response:           () => process.env.MAKE_HOOK_REVIEW_RESPONSE,
    upsell_sent:               () => process.env.MAKE_HOOK_UPSELL,
    repair_ready:              () => process.env.MAKE_HOOK_REPAIR_READY,
    // Referral + status route to Worker Events catch-all until dedicated hooks exist
    referral_requested:        () => process.env.MAKE_HOOK_REFERRAL       || process.env.MAKE_OUTBOUND_WEBHOOK_URL,
    status_updated:            () => process.env.MAKE_HOOK_STATUS_UPDATED || process.env.MAKE_OUTBOUND_WEBHOOK_URL,
};

function getHookUrl(event) {
    const resolver = HOOK_MAP[event];
    const specific = resolver ? resolver() : null;
    return specific || process.env.MAKE_OUTBOUND_WEBHOOK_URL || null;
}

// ─── fire ─────────────────────────────────────────────────────────────────────
// event      — snake_case event name from list above
// clientSlug — business slug (Make.com uses this to look up the client's connected apps)
// workerName — which worker fired this (e.g. "review-requester")
// payload    — event-specific data: { customer: { phone, name }, data: {...} }
//
// Routes to the event-specific Make.com scenario hook if configured,
// otherwise falls back to the generic Worker Events catch-all hook.
// Never throws — if Make.com is unreachable or misconfigured, the worker still succeeds.
// Returns true on success, false on failure (non-fatal either way).

async function fire(event, clientSlug, workerName, payload = {}) {
    const webhookUrl = getHookUrl(event);

    if (!webhookUrl) {
        // Not configured — silent no-op. Workers still work without Make.com.
        return null;
    }

    const body = {
        event,
        clientSlug,
        workerName,
        timestamp: new Date().toISOString(),
        customer:  payload.customer  || null,
        data:      payload.data      || null,
        meta:      payload.meta      || null,
    };

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (WEBHOOK_SECRET) {
            headers['X-Make-Secret'] = WEBHOOK_SECRET;
        }

        const res = await fetch(webhookUrl, {
            method:  'POST',
            headers,
            body:    JSON.stringify(body),
            signal:  AbortSignal.timeout(8000), // 8s max — don't block worker
        });

        if (!res.ok) {
            console.error(`[make-client] webhook returned ${res.status} for event "${event}" (client: ${clientSlug})`);
            return false;
        }

        return true;
    } catch (e) {
        // Timeout, network error, misconfiguration — non-fatal
        console.error(`[make-client] webhook failed for event "${event}": ${e.message}`);
        return false;
    }
}

// ─── Convenience builders — pre-structured payloads for common events ─────────

function reviewRequested({ clientSlug, customerPhone, customerName, reviewLink, serviceType, rating }) {
    return fire('review_requested', clientSlug, 'review-requester', {
        customer: { phone: customerPhone, name: customerName },
        data:     { reviewLink, serviceType, requestedRating: rating || 5 },
    });
}

function newLeadCaptured({ clientSlug, customerPhone, customerName, message, workerName = 'receptionist' }) {
    return fire('new_lead_captured', clientSlug, workerName, {
        customer: { phone: customerPhone, name: customerName },
        data:     { firstMessage: message },
    });
}

function invoiceReminderSent({ clientSlug, customerPhone, customerName, invoiceAmount, invoiceId, daysOverdue }) {
    return fire('invoice_reminder_sent', clientSlug, 'invoice-chaser', {
        customer: { phone: customerPhone, name: customerName },
        data:     { invoiceAmount, invoiceId, daysOverdue },
    });
}

function appointmentReminderSent({ clientSlug, customerPhone, customerName, appointmentTime, serviceType }) {
    return fire('appointment_reminder_sent', clientSlug, 'reminder', {
        customer: { phone: customerPhone, name: customerName },
        data:     { appointmentTime, serviceType },
    });
}

function appointmentBooked({ clientSlug, customerPhone, customerName, requestedTime, serviceType }) {
    return fire('appointment_booked', clientSlug, 'booking', {
        customer: { phone: customerPhone, name: customerName },
        data:     { requestedTime, serviceType },
    });
}

function leadFollowupSent({ clientSlug, customerPhone, customerName, followupNumber, source }) {
    return fire('lead_followup_sent', clientSlug, 'lead-followup', {
        customer: { phone: customerPhone, name: customerName },
        data:     { followupNumber, source },
    });
}

function reactivationSent({ clientSlug, customerPhone, customerName, daysDormant, offerText }) {
    return fire('reactivation_sent', clientSlug, 'reactivation', {
        customer: { phone: customerPhone, name: customerName },
        data:     { daysDormant, offerText },
    });
}

function upsellSent({ clientSlug, customerPhone, customerName, serviceCompleted, upsellOffer }) {
    return fire('upsell_sent', clientSlug, 'upsell', {
        customer: { phone: customerPhone, name: customerName },
        data:     { serviceCompleted, upsellOffer },
    });
}

function referralRequested({ clientSlug, customerPhone, customerName, incentiveText }) {
    return fire('referral_requested', clientSlug, 'referral', {
        customer: { phone: customerPhone, name: customerName },
        data:     { incentiveText },
    });
}

function statusUpdated({ clientSlug, customerPhone, customerName, status, serviceType }) {
    return fire('status_updated', clientSlug, 'status-updater', {
        customer: { phone: customerPhone, name: customerName },
        data:     { status, serviceType },
    });
}

function afterHoursLead({ clientSlug, customerPhone, customerName, message }) {
    return fire('after_hours_lead', clientSlug, 'after-hours', {
        customer: { phone: customerPhone, name: customerName },
        data:     { message },
    });
}

module.exports = {
    fire,
    getHookUrl,
    reviewRequested,
    newLeadCaptured,
    invoiceReminderSent,
    appointmentReminderSent,
    appointmentBooked,
    leadFollowupSent,
    reactivationSent,
    upsellSent,
    referralRequested,
    statusUpdated,
    afterHoursLead,
};
