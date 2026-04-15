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

// ── Platform → category map ───────────────────────────────────────────────────
// Every slug in the catalog maps to one of these categories.
// New platforms: add the slug here with the right category — no other changes needed.
const PLATFORM_CATEGORY = {
  // Appointments
  calendly: 'appointment', acuity_scheduling: 'appointment', mindbody: 'appointment',
  vagaro: 'appointment', booksy: 'appointment', glossgenius: 'appointment',
  fresha: 'appointment', setmore: 'appointment', simplybook: 'appointment',
  zenoti: 'appointment', phorest: 'appointment', jane_app: 'appointment',
  styleseat: 'appointment', schedulicity: 'appointment', appointy: 'appointment',
  square_appointments: 'appointment', timely: 'appointment', bookedby: 'appointment',

  // Payments
  stripe: 'payment', square: 'payment', paypal: 'payment', clover: 'payment',
  lightspeed: 'payment', zettle: 'payment', sumup: 'payment',
  heartland: 'payment', payanywhere: 'payment', quickbooks_payments: 'payment',

  // E-commerce
  shopify: 'ecommerce', woocommerce: 'ecommerce', bigcommerce: 'ecommerce',
  etsy: 'ecommerce', wix: 'ecommerce', squarespace: 'ecommerce',
  ecwid: 'ecommerce', prestashop: 'ecommerce',

  // CRM
  hubspot: 'crm', salesforce: 'crm', zoho_crm: 'crm', pipedrive: 'crm',
  gohighlevel: 'crm', keap: 'crm', close: 'crm', monday: 'crm',
  freshsales: 'crm', nimble: 'crm', activecampaign_crm: 'crm',

  // Email marketing
  mailchimp: 'marketing', klaviyo: 'marketing', activecampaign: 'marketing',
  constantcontact: 'marketing', convertkit: 'marketing', drip: 'marketing',
  brevo: 'marketing', omnisend: 'marketing', moosend: 'marketing', aweber: 'marketing',

  // Field service
  jobber: 'fieldservice', housecall_pro: 'fieldservice', servicetitan: 'fieldservice',
  workiz: 'fieldservice', fieldedge: 'fieldservice', service_fusion: 'fieldservice',
  mhelpdesk: 'fieldservice',

  // Restaurant
  toast: 'restaurant', opentable: 'restaurant', resy: 'restaurant',
  sevenrooms: 'restaurant', olo: 'restaurant', tock: 'restaurant',

  // Lead gen
  facebook: 'leadgen', facebook_ads: 'leadgen', instagram: 'leadgen',
  google_ads: 'leadgen', linkedin: 'leadgen', typeform: 'leadgen',
  tiktok_ads: 'leadgen',

  // Reviews
  google: 'review', yelp: 'review', trustpilot: 'review',
  birdeye: 'review', podium: 'review',

  // Accounting
  quickbooks: 'accounting', xero: 'accounting', freshbooks: 'accounting',
  wave: 'accounting', zoho_books: 'accounting',

  // Helpdesk
  intercom: 'helpdesk', zendesk: 'helpdesk', freshdesk: 'helpdesk',
  gorgias: 'helpdesk',
};

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

    const platformLower = (platform || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
    const eventLower    = (eventType || '').toLowerCase();

    console.log(`[Dispatcher] ${platformLower}/${eventLower} → ${customerPhone} (${customerName || 'unknown'})`);

    // Resolve category — specific platform checks first, then catalog lookup
    const category = PLATFORM_CATEGORY[platformLower] || null;

    // ── Calendly (specific event handling) ────────────────────────────────────
    if (platformLower === 'calendly') {
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

    // ── Category-based fallback routing (covers all 100 catalog platforms) ────
    // Platforms without a specific handler above route here based on category.
    if (category) {
        switch (category) {
            case 'appointment': {
                const isCancel = eventLower.includes('cancel') || eventLower.includes('declined');
                const isComplete = eventLower.includes('complete') || eventLower.includes('checked_out') || eventLower.includes('checkout');
                if (isCancel) {
                    await reactivationWorker.send({ client, customerNumber: customerPhone, customerName, reason: 'appointment_canceled' });
                    return { dispatched: true, worker: 'reactivation', action: 'appointment_cancel_recovery' };
                }
                if (isComplete) {
                    await reviewRequesterWorker.send({ client, customerNumber: customerPhone, customerName, serviceName: data?.service_name || data?.event_type?.name || null });
                    return { dispatched: true, worker: 'review-requester', action: 'post_appointment_review' };
                }
                // Default: new booking → reminder
                const apptTime = extractAppointmentTime(platformLower, data);
                await reminderWorker.send({ client, customerNumber: customerPhone, customerName, appointmentTime: apptTime || 'your upcoming appointment', serviceName: data?.service_name || null, reminderType: '24hr' });
                return { dispatched: true, worker: 'reminder', action: 'appointment_reminder' };
            }

            case 'payment': {
                const isFailed = eventLower.includes('fail') || eventLower.includes('declined') || eventLower.includes('dispute');
                const isCanceled = eventLower.includes('cancel') || eventLower.includes('refund') || eventLower.includes('chargeback');
                if (isFailed) {
                    await invoiceChaserWorker.send({ client, customerNumber: customerPhone, customerName, amount: data?.amount ? `$${(Number(data.amount) / 100).toFixed(2)}` : null });
                    return { dispatched: true, worker: 'invoice-chaser', action: 'payment_failure_followup' };
                }
                if (isCanceled) {
                    await reactivationWorker.send({ client, customerNumber: customerPhone, customerName, reason: 'subscription_canceled' });
                    return { dispatched: true, worker: 'reactivation', action: 'churn_recovery' };
                }
                await reviewRequesterWorker.send({ client, customerNumber: customerPhone, customerName, serviceName: data?.description || null });
                return { dispatched: true, worker: 'review-requester', action: 'post_payment_review' };
            }

            case 'ecommerce': {
                const isAbandoned = eventLower.includes('checkout') || eventLower.includes('cart') || eventLower.includes('abandon');
                const isNewCustomer = eventLower.includes('customer') && eventLower.includes('creat');
                if (isAbandoned) {
                    await leadFollowupWorker.send({ client, customerNumber: customerPhone, customerName, context: 'abandoned_cart', productName: data?.line_items?.[0]?.title || null });
                    return { dispatched: true, worker: 'lead-followup', action: 'abandoned_cart' };
                }
                if (isNewCustomer) {
                    await onboardingWorker.send({ client, customerNumber: customerPhone, customerName });
                    return { dispatched: true, worker: 'onboarding', action: 'new_customer_welcome' };
                }
                await reviewRequesterWorker.send({ client, customerNumber: customerPhone, customerName, serviceName: data?.line_items?.[0]?.name || null });
                return { dispatched: true, worker: 'review-requester', action: 'post_order_review' };
            }

            case 'crm': {
                const isDeal = eventLower.includes('deal') || eventLower.includes('opportunity');
                await leadFollowupWorker.send({ client, customerNumber: customerPhone, customerName, context: isDeal ? 'new_deal' : 'new_crm_contact', dealName: data?.properties?.dealname?.value || data?.title || null });
                return { dispatched: true, worker: 'lead-followup', action: isDeal ? 'new_deal_followup' : 'new_contact_followup' };
            }

            case 'marketing': {
                const isUnsub = eventLower.includes('unsub') || eventLower === 'unsubscribe';
                if (isUnsub) {
                    await reactivationWorker.send({ client, customerNumber: customerPhone, customerName, reason: 'email_unsubscribed' });
                    return { dispatched: true, worker: 'reactivation', action: 'unsubscribe_recovery' };
                }
                await onboardingWorker.send({ client, customerNumber: customerPhone, customerName });
                return { dispatched: true, worker: 'onboarding', action: 'subscriber_welcome' };
            }

            case 'fieldservice': {
                const isInvoice = eventLower.includes('invoice') || eventLower.includes('payment');
                const isComplete = eventLower.includes('complete') || eventLower.includes('finished') || eventLower.includes('closed');
                if (isInvoice && !isComplete) {
                    await invoiceChaserWorker.send({ client, customerNumber: customerPhone, customerName, amount: data?.total || null });
                    return { dispatched: true, worker: 'invoice-chaser', action: 'invoice_followup' };
                }
                await reviewRequesterWorker.send({ client, customerNumber: customerPhone, customerName, serviceName: data?.job_type || data?.title || null });
                return { dispatched: true, worker: 'review-requester', action: 'post_job_review' };
            }

            case 'restaurant': {
                const isCancel = eventLower.includes('cancel') || eventLower.includes('noshow');
                const isSeated = eventLower.includes('seat') || eventLower.includes('complet') || eventLower.includes('check');
                if (isCancel) {
                    await reactivationWorker.send({ client, customerNumber: customerPhone, customerName, reason: 'reservation_canceled' });
                    return { dispatched: true, worker: 'reactivation', action: 'reservation_cancel_recovery' };
                }
                if (isSeated) {
                    await reviewRequesterWorker.send({ client, customerNumber: customerPhone, customerName, serviceName: null });
                    return { dispatched: true, worker: 'review-requester', action: 'post_dining_review' };
                }
                // Confirmation: send reminder
                await reminderWorker.send({ client, customerNumber: customerPhone, customerName, appointmentTime: data?.reservation_time || data?.date || 'your reservation', serviceName: null, reminderType: '24hr' });
                return { dispatched: true, worker: 'reminder', action: 'reservation_reminder' };
            }

            case 'leadgen': {
                const email = data?.field_data?.find(f => f.name === 'email')?.values?.[0]
                    || data?.email || null;
                await leadFollowupWorker.send({ client, customerNumber: customerPhone, customerName, context: `${platformLower}_lead`, email });
                return { dispatched: true, worker: 'lead-followup', action: `${platformLower}_lead_followup` };
            }

            case 'review': {
                await reviewRequesterWorker.send({ client, customerNumber: customerPhone, customerName, serviceName: null });
                return { dispatched: true, worker: 'review-requester', action: 'review_platform_followup' };
            }

            case 'accounting': {
                const isPaid = eventLower.includes('paid') || eventLower.includes('payment');
                if (isPaid) {
                    await reviewRequesterWorker.send({ client, customerNumber: customerPhone, customerName, serviceName: null });
                    return { dispatched: true, worker: 'review-requester', action: 'post_payment_review' };
                }
                await invoiceChaserWorker.send({ client, customerNumber: customerPhone, customerName, amount: data?.total || data?.amount_due || null });
                return { dispatched: true, worker: 'invoice-chaser', action: 'invoice_followup' };
            }

            case 'helpdesk': {
                const isSolved = eventLower.includes('solved') || eventLower.includes('resolved') || eventLower.includes('closed');
                if (isSolved) {
                    await reviewRequesterWorker.send({ client, customerNumber: customerPhone, customerName, serviceName: null });
                    return { dispatched: true, worker: 'review-requester', action: 'post_support_review' };
                }
                await leadFollowupWorker.send({ client, customerNumber: customerPhone, customerName, context: 'support_ticket' });
                return { dispatched: true, worker: 'lead-followup', action: 'support_ticket_followup' };
            }
        }
    }

    // Unrecognized event — log but don't error
    console.log(`[Dispatcher] No handler for ${platformLower}/${eventLower} — event received but not acted on`);
    return { dispatched: false, worker: null, action: 'unhandled_event' };
}

module.exports = { dispatchEvent };
