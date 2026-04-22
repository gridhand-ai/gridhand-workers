'use strict';

/**
 * GRIDHAND Scenario Templates
 * Pre-built automation blueprints for each target industry vertical.
 *
 * Each scenario defines the webhook payload contract that GRIDHAND's integration
 * layer sends/receives, which GRIDHAND worker handles it, and what automation
 * it performs for the client.
 *
 * These templates are consumed by:
 *   - Portal /api/make/scenarios route (client-facing scenario catalog)
 *   - Integration layer webhook dispatch (outbound to automation platform)
 *   - Workers trigger routes (inbound from automation platform)
 *
 * Internal implementation detail: these scenarios are executed via our
 * integration layer. Never surface the underlying platform name in client UI.
 *
 * Exports:
 *   getScenariosForIndustry(industry)
 *   getAllScenarios()
 *   getScenarioById(id)
 *   SCENARIO_WEBHOOK_SCHEMA
 *   INDUSTRY_LABELS
 */

// ── Webhook schema ─────────────────────────────────────────────────────────────
// The canonical envelope shape GRIDHAND receives from the integration platform.
// All inbound webhooks must match this structure.
const SCENARIO_WEBHOOK_SCHEMA = {
  // Required on all inbound webhooks
  client_id:      'string — GRIDHAND client UUID',
  scenario_type:  'string — must match a scenario id in this file',
  trigger_source: 'string — "live" | "test" | "retry"',
  trigger_data:   'object — scenario-specific payload (see webhookPayload per scenario)',

  // Authentication — verified in /api/make/webhook before any processing
  make_secret:    'string — must match MAKE_WEBHOOK_SECRET env var',

  // Optional idempotency key — if present, duplicate events are skipped
  event_id:       'string? — unique event ID; store + check before processing',
};

// ── Industry labels ────────────────────────────────────────────────────────────
const INDUSTRY_LABELS = {
  restaurant:  'Restaurant',
  auto:        'Auto Shop',
  salon:       'Salon / Barber',
  gym:         'Gym / Fitness',
  dental:      'Dental',
  realestate:  'Real Estate',
  trades:      'Trades',
};

// ── Scenario definitions ───────────────────────────────────────────────────────
const SCENARIOS = [

  // ──────────────────────────────────────────────────────────────────────────
  // RESTAURANT (4 scenarios)
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'restaurant-reservation-confirm',
    name: 'New Reservation Confirmation',
    industry: 'restaurant',
    trigger: 'new_booking',
    worker: 'appointment_reminder',
    description: 'When a new reservation is booked, instantly texts the guest a confirmation with party size, date/time, and any special notes.',
    webhookPayload: {
      customer_name:    'string — guest full name',
      phone:            'string — E.164 format, e.g. +14145551234',
      reservation_time: 'string — ISO 8601, e.g. 2026-05-01T19:00:00',
      party_size:       'number — number of guests',
      special_requests: 'string? — dietary notes, occasion, etc.',
      restaurant_name:  'string — client business name',
      reservation_id:   'string? — booking system reference ID (idempotency)',
    },
  },
  {
    id: 'restaurant-missed-call',
    name: 'Missed Call Recovery',
    industry: 'restaurant',
    trigger: 'missed_call',
    worker: 'missed_call',
    description: 'When the restaurant misses a call, texts back within 60 seconds to recover the lead and offer a reservation link.',
    webhookPayload: {
      caller_number:  'string — E.164 caller phone number',
      call_duration:  'number — seconds (0 = never answered)',
      timestamp:      'string — ISO 8601 when the call came in',
      restaurant_name: 'string — client business name',
      booking_url:    'string? — online reservation link',
    },
  },
  {
    id: 'restaurant-review-request',
    name: 'Post-Visit Review Request',
    industry: 'restaurant',
    trigger: 'visit_complete',
    worker: 'review_pipeline',
    description: 'After a customer checks out, sends a warm review request via SMS. Negative sentiment is routed to the owner, not Google.',
    webhookPayload: {
      customer_name:   'string',
      phone:           'string — E.164',
      visit_date:      'string — ISO 8601',
      amount_spent:    'number? — check total in USD',
      service:         'string? — e.g. "dinner for 2"',
      restaurant_name: 'string',
      google_review_url: 'string? — direct Google review link',
    },
  },
  {
    id: 'restaurant-slow-night-blast',
    name: 'Slow Night Reactivation Blast',
    industry: 'restaurant',
    trigger: 'manual_campaign',
    worker: 'reactivation',
    description: 'Weekly or on-demand campaign targeting past guests who haven\'t visited in 45+ days. Sends a personalized offer to fill tables on a slow night.',
    webhookPayload: {
      customer_name:       'string',
      phone:               'string — E.164',
      last_visit_date:     'string — ISO 8601',
      offer_text:          'string — e.g. "20% off your next visit"',
      offer_expires:       'string? — ISO 8601',
      restaurant_name:     'string',
      booking_url:         'string?',
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // AUTO SHOP (4 scenarios)
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'auto-vehicle-ready',
    name: 'Vehicle Ready for Pickup',
    industry: 'auto',
    trigger: 'repair_complete',
    worker: 'repair_ready',
    description: 'When a repair order is marked complete, immediately texts the customer that their vehicle is ready with shop hours and total cost.',
    webhookPayload: {
      customer_name:   'string',
      phone:           'string — E.164',
      vehicle_year:    'string — e.g. "2019"',
      vehicle_make:    'string — e.g. "Toyota"',
      vehicle_model:   'string — e.g. "Camry"',
      repair_summary:  'string — brief description of work done',
      total_cost:      'number — USD amount due',
      shop_name:       'string',
      shop_phone:      'string — E.164',
      closing_time:    'string — e.g. "6:00 PM"',
    },
  },
  {
    id: 'auto-appointment-reminder',
    name: 'Service Appointment Reminder',
    industry: 'auto',
    trigger: 'appointment_reminder',
    worker: 'appointment_reminder',
    description: 'Sends a reminder 24 hours before a scheduled service appointment. Includes the vehicle, service type, and a confirm/reschedule link.',
    webhookPayload: {
      customer_name:     'string',
      phone:             'string — E.164',
      appointment_time:  'string — ISO 8601',
      vehicle_year:      'string',
      vehicle_make:      'string',
      vehicle_model:     'string',
      service_type:      'string — e.g. "Oil Change + Rotation"',
      shop_name:         'string',
      shop_phone:        'string — E.164',
      confirm_url:       'string?',
    },
  },
  {
    id: 'auto-no-show-reschedule',
    name: 'No-Show Reschedule',
    industry: 'auto',
    trigger: 'no_show',
    worker: 'no_show',
    description: 'When a customer misses their service appointment, texts within 30 minutes to offer easy rescheduling.',
    webhookPayload: {
      customer_name:     'string',
      phone:             'string — E.164',
      appointment_time:  'string — ISO 8601 (the missed appointment)',
      service_type:      'string',
      shop_name:         'string',
      booking_link:      'string?',
    },
  },
  {
    id: 'auto-review-request',
    name: 'Post-Service Review Request',
    industry: 'auto',
    trigger: 'payment_complete',
    worker: 'review_pipeline',
    description: 'After a customer pays, sends a review request. Gauges satisfaction first — only routes happy customers to Google.',
    webhookPayload: {
      customer_name:      'string',
      phone:              'string — E.164',
      vehicle_year:       'string',
      vehicle_make:       'string',
      vehicle_model:      'string',
      service_performed:  'string',
      amount_paid:        'number',
      shop_name:          'string',
      google_review_url:  'string?',
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // SALON / BARBER (4 scenarios)
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'salon-booking-confirmation',
    name: 'Appointment Booking Confirmation',
    industry: 'salon',
    trigger: 'new_booking',
    worker: 'appointment_reminder',
    description: 'Instantly confirms a new salon or barber appointment with stylist name, service, and date/time.',
    webhookPayload: {
      customer_name:     'string',
      phone:             'string — E.164',
      appointment_time:  'string — ISO 8601',
      service:           'string — e.g. "Haircut + Blowout"',
      stylist_name:      'string?',
      salon_name:        'string',
      address:           'string?',
      booking_id:        'string? — for idempotency',
    },
  },
  {
    id: 'salon-day-before-reminder',
    name: 'Day-Before Appointment Reminder',
    industry: 'salon',
    trigger: 'appointment_reminder',
    worker: 'appointment_reminder',
    description: 'Reminds the client 24 hours before their appointment. Includes a simple confirm/cancel reply option.',
    webhookPayload: {
      customer_name:     'string',
      phone:             'string — E.164',
      appointment_time:  'string — ISO 8601',
      service:           'string',
      stylist_name:      'string?',
      salon_name:        'string',
      salon_phone:       'string — E.164',
    },
  },
  {
    id: 'salon-no-show-rebook',
    name: 'No-Show Rebooking Offer',
    industry: 'salon',
    trigger: 'no_show',
    worker: 'no_show',
    description: 'When a client misses their appointment, texts within 30 minutes with a friendly message and a rebook link.',
    webhookPayload: {
      customer_name:     'string',
      phone:             'string — E.164',
      appointment_time:  'string — ISO 8601',
      service:           'string',
      salon_name:        'string',
      booking_link:      'string?',
    },
  },
  {
    id: 'salon-review-request',
    name: 'Post-Visit Review Request',
    industry: 'salon',
    trigger: 'visit_complete',
    worker: 'review_pipeline',
    description: 'After a visit, sends a review request. Happy clients get routed to Google; unsatisfied clients get routed to the owner.',
    webhookPayload: {
      customer_name:      'string',
      phone:              'string — E.164',
      service:            'string',
      stylist_name:       'string?',
      salon_name:         'string',
      google_review_url:  'string?',
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // GYM / FITNESS (4 scenarios)
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'gym-new-member-onboarding',
    name: 'New Member Onboarding',
    industry: 'gym',
    trigger: 'new_member_signup',
    worker: 'onboarding',
    description: 'When a new member signs up, sends a welcome SMS series: immediate welcome, class schedule link, and a 3-day check-in.',
    webhookPayload: {
      customer_name:  'string',
      phone:          'string — E.164',
      membership_type: 'string — e.g. "Monthly Unlimited"',
      start_date:     'string — ISO 8601',
      gym_name:       'string',
      schedule_url:   'string?',
      app_url:        'string?',
    },
  },
  {
    id: 'gym-class-reminder',
    name: 'Class Reminder (2 Hours Before)',
    industry: 'gym',
    trigger: 'appointment_reminder',
    worker: 'appointment_reminder',
    description: 'Texts a class reminder 2 hours before the scheduled start. Includes class name, instructor, and location.',
    webhookPayload: {
      customer_name:   'string',
      phone:           'string — E.164',
      class_name:      'string — e.g. "HIIT Bootcamp"',
      class_time:      'string — ISO 8601',
      instructor_name: 'string?',
      gym_name:        'string',
      gym_address:     'string?',
    },
  },
  {
    id: 'gym-lapsed-member-reactivation',
    name: 'Lapsed Member Reactivation',
    industry: 'gym',
    trigger: 'member_inactive',
    worker: 'reactivation',
    description: 'When a member hasn\'t checked in for 30+ days, sends a personalized win-back message. Optionally includes a limited-time offer.',
    webhookPayload: {
      customer_name:    'string',
      phone:            'string — E.164',
      last_checkin_date: 'string — ISO 8601',
      days_inactive:    'number',
      membership_type:  'string',
      gym_name:         'string',
      offer_text:       'string? — e.g. "1 free personal training session"',
      offer_expires:    'string? — ISO 8601',
    },
  },
  {
    id: 'gym-trial-expiring-upsell',
    name: 'Trial Expiring — Membership Upsell',
    industry: 'gym',
    trigger: 'trial_expiring',
    worker: 'upsell',
    description: 'When a trial membership expires in 3 days, sends a personalized upsell to convert to a paid membership.',
    webhookPayload: {
      customer_name:        'string',
      phone:                'string — E.164',
      trial_end_date:       'string — ISO 8601',
      recommended_plan:     'string — e.g. "Monthly Unlimited - $49/mo"',
      signup_url:           'string?',
      gym_name:             'string',
      offer_text:           'string? — e.g. "First month 50% off if you sign up today"',
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // DENTAL (4 scenarios)
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'dental-appointment-confirmation',
    name: 'Appointment Scheduled Confirmation',
    industry: 'dental',
    trigger: 'new_booking',
    worker: 'appointment_reminder',
    description: 'Confirms a newly scheduled dental appointment with date, time, provider name, and any pre-visit instructions.',
    webhookPayload: {
      patient_name:      'string',
      phone:             'string — E.164',
      appointment_time:  'string — ISO 8601',
      provider_name:     'string — dentist or hygienist name',
      service_type:      'string — e.g. "Routine Cleaning", "Crown Prep"',
      practice_name:     'string',
      practice_phone:    'string — E.164',
      appointment_id:    'string? — for idempotency',
    },
  },
  {
    id: 'dental-48hr-reminder',
    name: '48-Hour Appointment Reminder',
    industry: 'dental',
    trigger: 'appointment_reminder',
    worker: 'appointment_reminder',
    description: 'Sends a reminder 48 hours before the appointment. Includes confirm/cancel reply, pre-visit prep (e.g., no eating before sedation).',
    webhookPayload: {
      patient_name:      'string',
      phone:             'string — E.164',
      appointment_time:  'string — ISO 8601',
      provider_name:     'string',
      service_type:      'string',
      pre_visit_notes:   'string? — e.g. "Please arrive 10 min early to complete paperwork"',
      practice_name:     'string',
      practice_phone:    'string — E.164',
    },
  },
  {
    id: 'dental-post-visit-care',
    name: 'Post-Visit Care Instructions',
    industry: 'dental',
    trigger: 'visit_complete',
    worker: 'review_pipeline',
    description: 'After a procedure, texts care instructions relevant to the service performed. Also includes a review request for positive experiences.',
    webhookPayload: {
      patient_name:     'string',
      phone:            'string — E.164',
      service_performed: 'string — e.g. "Tooth Extraction"',
      care_instructions: 'string? — override default care notes',
      practice_name:    'string',
      google_review_url: 'string?',
    },
  },
  {
    id: 'dental-recall-reminder',
    name: '6-Month Recall Reminder',
    industry: 'dental',
    trigger: 'recall_due',
    worker: 'reactivation',
    description: 'When a patient is due for their 6-month checkup, sends a recall reminder with a booking link.',
    webhookPayload: {
      patient_name:    'string',
      phone:           'string — E.164',
      last_visit_date: 'string — ISO 8601',
      due_date:        'string — ISO 8601 (6 months after last visit)',
      provider_name:   'string?',
      practice_name:   'string',
      booking_url:     'string?',
      practice_phone:  'string — E.164',
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // REAL ESTATE (4 scenarios)
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'realestate-new-listing-alert',
    name: 'New Listing — Notify Matched Leads',
    industry: 'realestate',
    trigger: 'new_listing',
    worker: 'lead_nurture',
    description: 'When a new listing goes live, texts matched leads who previously expressed interest in that price range, neighborhood, or property type.',
    webhookPayload: {
      lead_name:          'string',
      phone:              'string — E.164',
      property_address:   'string',
      listing_price:      'number — USD',
      bedrooms:           'number',
      bathrooms:          'number',
      property_type:      'string — e.g. "Single Family", "Condo"',
      listing_url:        'string',
      agent_name:         'string',
      agent_phone:        'string — E.164',
    },
  },
  {
    id: 'realestate-open-house-invite',
    name: 'Open House Invite',
    industry: 'realestate',
    trigger: 'open_house_scheduled',
    worker: 'lead_nurture',
    description: 'Invites matched leads to an upcoming open house via SMS with date, time, and property address.',
    webhookPayload: {
      lead_name:        'string',
      phone:            'string — E.164',
      property_address: 'string',
      open_house_start: 'string — ISO 8601',
      open_house_end:   'string — ISO 8601',
      listing_price:    'number',
      listing_url:      'string?',
      agent_name:       'string',
      agent_phone:      'string — E.164',
    },
  },
  {
    id: 'realestate-offer-received',
    name: 'Offer Received — Agent Alert',
    industry: 'realestate',
    trigger: 'offer_received',
    worker: 'missed_call',
    description: 'When an offer is submitted on a listing, immediately alerts the listing agent via SMS so they can respond quickly.',
    webhookPayload: {
      agent_name:       'string',
      agent_phone:      'string — E.164',
      property_address: 'string',
      offer_amount:     'number — USD',
      offer_expiry:     'string — ISO 8601 (when the offer expires)',
      buyer_agent:      'string?',
      listing_id:       'string?',
    },
  },
  {
    id: 'realestate-closing-congratulations',
    name: 'Closing Day Congratulations',
    industry: 'realestate',
    trigger: 'closing_complete',
    worker: 'review_pipeline',
    description: 'On closing day, texts a heartfelt congratulations to the buyer/seller and requests a Google/Zillow review.',
    webhookPayload: {
      client_name:        'string',
      phone:              'string — E.164',
      property_address:   'string',
      closing_date:       'string — ISO 8601',
      transaction_type:   'string — "buy" | "sell"',
      agent_name:         'string',
      review_url:         'string? — Google or Zillow review link',
      referral_offer:     'string? — e.g. "$250 gift card for referrals"',
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // TRADES — Plumber / HVAC / Electrical (5 scenarios)
  // ──────────────────────────────────────────────────────────────────────────
  {
    id: 'trades-estimate-followup',
    name: 'Estimate Sent — Follow-Up',
    industry: 'trades',
    trigger: 'estimate_sent',
    worker: 'lead_nurture',
    description: 'After an estimate is sent, follows up 24 hours later if the customer hasn\'t responded. Keeps the job warm without being pushy.',
    webhookPayload: {
      customer_name:   'string',
      phone:           'string — E.164',
      estimate_amount: 'number — USD',
      service_type:    'string — e.g. "Water Heater Replacement"',
      estimate_date:   'string — ISO 8601',
      estimate_url:    'string?',
      company_name:    'string',
      company_phone:   'string — E.164',
    },
  },
  {
    id: 'trades-job-complete-invoice',
    name: 'Job Complete — Invoice + Review Request',
    industry: 'trades',
    trigger: 'job_complete',
    worker: 'review_pipeline',
    description: 'When a job is marked complete, sends the invoice link and a review request in a single message sequence.',
    webhookPayload: {
      customer_name:    'string',
      phone:            'string — E.164',
      job_description:  'string — e.g. "Replaced HVAC unit"',
      invoice_amount:   'number — USD',
      invoice_url:      'string',
      company_name:     'string',
      google_review_url: 'string?',
    },
  },
  {
    id: 'trades-seasonal-checkup',
    name: 'Seasonal Maintenance Reminder',
    industry: 'trades',
    trigger: 'seasonal_campaign',
    worker: 'reactivation',
    description: 'Seasonal outreach to past customers for annual service reminders (furnace tune-up before winter, AC before summer, etc.).',
    webhookPayload: {
      customer_name:     'string',
      phone:             'string — E.164',
      last_service_date: 'string — ISO 8601',
      service_type:      'string — e.g. "Annual Furnace Tune-Up"',
      season:            'string — "spring" | "summer" | "fall" | "winter"',
      offer_text:        'string? — e.g. "10% off for returning customers"',
      company_name:      'string',
      booking_phone:     'string — E.164',
    },
  },
  {
    id: 'trades-emergency-callback',
    name: 'Emergency Inquiry — Immediate Callback SMS',
    industry: 'trades',
    trigger: 'emergency_inquiry',
    worker: 'missed_call',
    description: 'When a customer submits an emergency service request or calls after hours, sends an immediate callback SMS within 60 seconds.',
    webhookPayload: {
      customer_name:    'string',
      phone:            'string — E.164',
      issue_description: 'string — e.g. "Burst pipe in basement"',
      inquiry_time:     'string — ISO 8601',
      is_after_hours:   'boolean',
      company_name:     'string',
      on_call_tech:     'string? — tech on call name',
      eta_minutes:      'number? — estimated callback time',
    },
  },
  {
    id: 'trades-no-show-reschedule',
    name: 'Missed Appointment Reschedule',
    industry: 'trades',
    trigger: 'no_show',
    worker: 'no_show',
    description: 'When a customer misses a scheduled service visit, texts to reschedule and optionally surfaces the next available slot.',
    webhookPayload: {
      customer_name:       'string',
      phone:               'string — E.164',
      appointment_time:    'string — ISO 8601',
      service_type:        'string',
      company_name:        'string',
      next_available_slot: 'string? — ISO 8601',
      booking_phone:       'string — E.164',
    },
  },
];

// ── Index for fast lookups ─────────────────────────────────────────────────────
const _byId       = new Map(SCENARIOS.map(s => [s.id, s]));
const _byIndustry = SCENARIOS.reduce((acc, s) => {
  if (!acc[s.industry]) acc[s.industry] = [];
  acc[s.industry].push(s);
  return acc;
}, {});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getScenariosForIndustry(industry)
 * @param {string} industry - Industry slug (e.g. 'restaurant', 'dental')
 * @returns {Array} All scenarios for that industry
 */
function getScenariosForIndustry(industry) {
  return _byIndustry[industry] || [];
}

/**
 * getAllScenarios()
 * @returns {Array} Full scenario catalog
 */
function getAllScenarios() {
  return SCENARIOS;
}

/**
 * getScenarioById(id)
 * @param {string} id - Scenario slug (e.g. 'restaurant-missed-call')
 * @returns {object|null}
 */
function getScenarioById(id) {
  return _byId.get(id) || null;
}

/**
 * getScenarioCount()
 * @returns {{ total: number, byIndustry: object }}
 */
function getScenarioCount() {
  const byIndustry = {};
  for (const [industry, scenarios] of Object.entries(_byIndustry)) {
    byIndustry[industry] = scenarios.length;
  }
  return { total: SCENARIOS.length, byIndustry };
}

module.exports = {
  getScenariosForIndustry,
  getAllScenarios,
  getScenarioById,
  getScenarioCount,
  SCENARIO_WEBHOOK_SCHEMA,
  INDUSTRY_LABELS,
};
