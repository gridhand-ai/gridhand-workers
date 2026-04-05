'use strict';

require('dotenv').config();

const required = [
  'TEKMETRIC_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];

function validateConfig() {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

const config = {
  server: {
    port: parseInt(process.env.PORT || '3001', 10),
    env: process.env.NODE_ENV || 'development',
    apiKey: process.env.GRIDHAND_API_KEY,
  },

  tekmetric: {
    baseUrl: process.env.TEKMETRIC_BASE_URL || 'https://sandbox.tekmetric.com/api/v1',
    apiKey: process.env.TEKMETRIC_API_KEY,
    webhookSecret: process.env.TEKMETRIC_WEBHOOK_SECRET,
  },

  google: {
    serviceAccountKeyPath: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
    serviceAccountKeyJson: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON,
    defaultAccountId: process.env.GOOGLE_ACCOUNT_ID,
    defaultLocationId: process.env.GOOGLE_LOCATION_ID,
    scopes: ['https://www.googleapis.com/auth/business.manage'],
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    fromNumber: process.env.TWILIO_FROM_NUMBER,
  },

  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  settings: {
    reviewRequestDelayHours: parseInt(process.env.REVIEW_REQUEST_DELAY_HOURS || '2', 10),
    reviewMonitorIntervalMinutes: parseInt(process.env.REVIEW_MONITOR_INTERVAL_MINUTES || '15', 10),
    maxReviewRequestsPerDay: parseInt(process.env.MAX_REVIEW_REQUESTS_PER_DAY || '50', 10),
  },
};

module.exports = { config, validateConfig };
