/**
 * Integration Event Dispatcher
 *
 * Receives inbound events from Make.com scenarios (Calendly, Stripe, Shopify,
 * Square, HubSpot, Facebook, Mailchimp, etc.) and routes each event to the
 * correct GRIDHAND worker so real action is taken — SMS sent, review requested,
 * lead followed up, etc.
 *
 * All platform-specific event routing lives here. Adding a new platform =
 * add a case to dispatchEvent() below.
 *
 * Called by: POST /events/integration in server.js
 */

const reviewRequesterWorker = require('./review-requester');
const reminderWorker        = require('./reminder');
const reactivationWorker    = require('./reactivation');
const leadFollowupWorker    = require('./lead-followup');
const invoiceChaserWorker   = require('./invoice-chaser');
const onboardingWorker      = require('./onboarding');

/**
 * Extract customer phone number from event data.
 * Each platform buries the phone differently.
 */
function extractPhone(platform, event, data) {
    try {
        switch (platform) {
            case 'calendly':
                // Calendly webhook: payload.invitee.text_reminder_number OR questions_and_answers
                return data?.payload?.invitee?.text_reminder_number
                    || data?.payload?.questions_and_answers?.find(q =>
                        /phone/i.test(q.question)
                    )?.answer
                    || null;

            case 'stripe':
                return data?.data?.object?.shipping?.phone
                    || data?.data?.object?.customer_details?.phone
                    || data?.customer?.phone
                    || null;

            case 'shopify':
                return data?.customer?.phone
                    || data?.billing_address?.phone
                    || data?.shipping_address?.phone
                    || null;

            case 'square':
                return data?.payment?.buyer_email_address
                    ? null // Square doesn't always include phone — skip if not present
                    : data?.customer?.phone_number || null;

            case 'hubspot':
                return data?.properties?.phone?.value
                    || data?.phone
                    || null;

            case 'facebook':
                // Lead Ads: field_data array contains phone if asked in form
                return data?.field_data?.find(f => f.name === 'phone_number')?.values?.[0]
                    || data?.field_data?.find(f => f.name === 'phone')?.values?.[0]
                    || null;

            case 'mailchimp':
                // Mailchimp merge fields
                return data?.merges?.PHONE || data?.merges?.SMS || null;

            default:
                return data?.phone || data?.customerPhone || data?.customer_phone || null;
        }
    } catch {
        return null;
    }
}

/**
 * Extract customer name from event data.
 */
function extractName(platform, data) {
    try {
        switch (platform) {
            case 'calendly':
                return data?.payload?.invitee?.name || null;
            case 'stripe':
                return data?.data?.object?.shipping?.name
                    || data?.data?.object?.customer_details?.name
                    || null;
            case 'shopify':
                return `${data?.customer?.first_name || ''} ${data?.customer?.last_name || ''}`.trim() || null;
            case 'square':
                return `${data?.customer?.given_name || ''} ${data?.customer?.family_name || ''}`.trim() || null;
            case 'hubspot':
                return `${data?.properties?.firstname?.value || ''} ${data?.properties?.lastname?.value || ''}`.trim() || null;
            case 'facebook':
                return data?.field_data?.find(f => f.name === 'full_name')?.values?.[0]
                    || data?.field_data?.find(f => f.name === 'first_name')?.values?.[0]
                    || null;
            case 'mailchimp':
                return `${data?.merges?.FNAME || ''} ${data?.merges?.LNAME || ''}`.trim() || null;
            default:
                return data?.name || data?.customerName || null;
        }
    } catch {
        return null;
    }
}

/**
 * Extract appointment time for reminder worker.
 */
function extractAppointmentTime(platform, data) {
    try {
        if (platform === 'calendly') {
            const start = data?.payload?.event?.start_time;
            if (!start) return null;
            return new Date(start).toLocaleString('en-US', {
                weekday: 'short', month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
            });
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Main dispatcher. Called with the full event payload from Make.com.
 *
 * @param {object} client    - Client config loaded by loadClientBySupabaseId
 * @param {string} platform  - e.g. 'calendly', 'stripe', 'shopify'
 * @param {string} eventType - e.g. 'invitee.created', 'payment_intent.succeeded'
 * @param {object} data      - Full event data from the platform
 * @returns {Promise<{ dispatched: boolean, worker: string, action: string }>}
 */
async function dispatchEvent(client, platform, eventType, data) {
    const customerPhone = extractPhone(platform, eventType, data);
    const customerName  = extractName(platform, data);

    // Can't send SMS without a phone number — log and return
    if (!customerPhone) {
        console.log(`[Dispatcher] No phone in ${platform}/${eventType} — skipping SMS`);
        return { dispatched: false, worker: null, action: 'no_phone' };
    }

    const platformLower = (platform || '').toLowerCase();
    const eventLower    = (eventType || '').toLowerCase();

    console.log(`[Dispatcher] ${platformLower}/${eventLower} → ${customerPhone} (${customerName || 'unknown'})`);

    // ── Calendly ──────────────────────────────────────────────────────────────
    if (platformLower === 'calendly') {
        if (eventLower === 'invitee.created') {
            // New booking: send appointment reminder
            const appointmentTime = extractAppointmentTime(platform, data);
            const serviceName = data?.payload?.event_type?.name || null;
            await reminderWorker.send({
                client,
                customerNumber:  customerPhone,
                customerName,
                appointmentTime: appointmentTime || 'your upcoming appointment',
                serviceName,
                reminderType:    '24hr',
            });
            return { dispatched: true, worker: 'reminder', action: 'appointment_reminder' };
        }

        if (eventLower === 'invitee.canceled') {
            // Cancellation: try to re-engage
            await reactivationWorker.send({
                client,
                customerNumber: customerPhone,
                customerName,
                reason: 'appointment_canceled',
            });
            return { dispatched: true, worker: 'reactivation', action: 'cancel_reengagement' };
        }

        if (eventLower === 'invitee.updated') {
            // Reschedule: send updated reminder
            const appointmentTime = extractAppointmentTime(platform, data);
            await reminderWorker.send({
                client,
                customerNumber:  customerPhone,
                customerName,
                appointmentTime: appointmentTime || 'your rescheduled appointment',
                serviceName:     data?.payload?.event_type?.name || null,
                reminderType:    '24hr',
            });
            return { dispatched: true, worker: 'reminder', action: 'reschedule_reminder' };
        }
    }

    // ── Stripe ────────────────────────────────────────────────────────────────
    if (platformLower === 'stripe') {
        if (eventLower === 'payment_intent.succeeded' || eventLower === 'checkout.session.completed') {
            const serviceName = data?.data?.object?.description
                || data?.data?.object?.metadata?.service
                || null;
            await reviewRequesterWorker.send({
                client,
                customerNumber: customerPhone,
                customerName,
                serviceName,
            });
            return { dispatched: true, worker: 'review-requester', action: 'post_payment_review' };
        }

        if (eventLower === 'payment_intent.payment_failed') {
            await invoiceChaserWorker.send({
                client,
                customerNumber: customerPhone,
                customerName,
                amount: data?.data?.object?.amount
                    ? `$${(data.data.object.amount / 100).toFixed(2)}`
                    : null,
            });
            return { dispatched: true, worker: 'invoice-chaser', action: 'payment_failure_followup' };
        }

        if (eventLower === 'customer.subscription.deleted') {
            await reactivationWorker.send({
                client,
                customerNumber: customerPhone,
                customerName,
                reason: 'subscription_canceled',
            });
            return { dispatched: true, worker: 'reactivation', action: 'churn_recovery' };
        }
    }

    // ── Shopify ───────────────────────────────────────────────────────────────
    if (platformLower === 'shopify') {
        if (eventLower === 'orders/create' || eventLower === 'orders/fulfilled') {
            const productName = data?.line_items?.[0]?.name || null;
            await reviewRequesterWorker.send({
                client,
                customerNumber: customerPhone,
                customerName,
                serviceName: productName,
            });
            return { dispatched: true, worker: 'review-requester', action: 'post_order_review' };
        }

        if (eventLower === 'checkouts/create' || eventLower === 'carts/create') {
            // Abandoned cart — follow up
            await leadFollowupWorker.send({
                client,
                customerNumber: customerPhone,
                customerName,
                context: 'abandoned_cart',
                productName: data?.line_items?.[0]?.title || null,
            });
            return { dispatched: true, worker: 'lead-followup', action: 'abandoned_cart' };
        }

        if (eventLower === 'customers/create') {
            await onboardingWorker.send({
                client,
                customerNumber: customerPhone,
                customerName,
            });
            return { dispatched: true, worker: 'onboarding', action: 'new_customer_welcome' };
        }
    }

    // ── Square ────────────────────────────────────────────────────────────────
    if (platformLower === 'square') {
        if (eventLower === 'payment.completed' || eventLower === 'payment.updated') {
            await reviewRequesterWorker.send({
                client,
                customerNumber: customerPhone,
                customerName,
                serviceName: null,
            });
            return { dispatched: true, worker: 'review-requester', action: 'post_payment_review' };
        }

        if (eventLower === 'customer.created') {
            await onboardingWorker.send({
                client,
                customerNumber: customerPhone,
                customerName,
            });
            return { dispatched: true, worker: 'onboarding', action: 'new_customer_welcome' };
        }
    }

    // ── HubSpot ───────────────────────────────────────────────────────────────
    if (platformLower === 'hubspot') {
        if (eventLower === 'contact.creation') {
            await leadFollowupWorker.send({
                client,
                customerNumber: customerPhone,
                customerName,
                context: 'new_crm_contact',
            });
            return { dispatched: true, worker: 'lead-followup', action: 'new_contact_followup' };
        }

        if (eventLower === 'deal.creation') {
            await leadFollowupWorker.send({
                client,
                customerNumber: customerPhone,
                customerName,
                context: 'new_deal',
                dealName: data?.properties?.dealname?.value || null,
            });
            return { dispatched: true, worker: 'lead-followup', action: 'new_deal_followup' };
        }
    }

    // ── Facebook Lead Ads ─────────────────────────────────────────────────────
    if (platformLower === 'facebook' || platformLower === 'facebook_ads') {
        if (eventLower.includes('lead') || eventLower === 'leadgen_feed') {
            const email = data?.field_data?.find(f => f.name === 'email')?.values?.[0] || null;
            await leadFollowupWorker.send({
                client,
                customerNumber: customerPhone,
                customerName,
                context: 'facebook_lead',
                email,
            });
            return { dispatched: true, worker: 'lead-followup', action: 'facebook_lead_followup' };
        }
    }

    // ── Mailchimp ─────────────────────────────────────────────────────────────
    if (platformLower === 'mailchimp') {
        if (eventLower === 'subscribe') {
            await onboardingWorker.send({
                client,
                customerNumber: customerPhone,
                customerName,
            });
            return { dispatched: true, worker: 'onboarding', action: 'subscriber_welcome' };
        }

        if (eventLower === 'unsubscribe') {
            await reactivationWorker.send({
                client,
                customerNumber: customerPhone,
                customerName,
                reason: 'email_unsubscribed',
            });
            return { dispatched: true, worker: 'reactivation', action: 'unsubscribe_recovery' };
        }
    }

    // ── Yelp ──────────────────────────────────────────────────────────────────
    if (platformLower === 'yelp') {
        if (eventLower.includes('review') || eventLower.includes('booking')) {
            await reviewRequesterWorker.send({
                client,
                customerNumber: customerPhone,
                customerName,
                serviceName: null,
            });
            return { dispatched: true, worker: 'review-requester', action: 'yelp_followup' };
        }
    }

    // Unrecognized event — log but don't error
    console.log(`[Dispatcher] No handler for ${platformLower}/${eventLower} — event received but not acted on`);
    return { dispatched: false, worker: null, action: 'unhandled_event' };
}

module.exports = { dispatchEvent };
