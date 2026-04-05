'use strict';

const fetch = require('node-fetch');
const { config } = require('../config');

const BASE_URL = config.tekmetric.baseUrl;

// Simple retry wrapper — 2 attempts with 1s backoff
async function fetchWithRetry(url, options, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Tekmetric API error ${res.status}: ${body}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`[Tekmetric] Attempt ${attempt} failed, retrying... ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

function authHeaders() {
  return {
    Authorization: `Bearer ${config.tekmetric.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// ── Repair Order ──────────────────────────────────────────────────────────────

/**
 * Fetch a single Repair Order by ID.
 * Returns normalized RO data regardless of Tekmetric's exact shape.
 *
 * Tekmetric RO shape reference:
 *   https://sandbox.tekmetric.com/api/v1/repair-orders/{id}
 *
 * @param {string|number} roId
 * @returns {Promise<object>}
 */
async function getRepairOrder(roId) {
  const data = await fetchWithRetry(`${BASE_URL}/repair-orders/${roId}`, {
    headers: authHeaders(),
  });

  return normalizeRepairOrder(data);
}

function normalizeRepairOrder(ro) {
  // Tekmetric nests vehicle info under ro.vehicle or ro.car depending on API version
  const vehicle = ro.vehicle || ro.car || {};
  const customer = ro.customer || {};

  const year = vehicle.year || vehicle.modelYear || '';
  const make = vehicle.make || vehicle.makeName || '';
  const model = vehicle.model || vehicle.modelName || '';
  const vehicleStr = [year, make, model].filter(Boolean).join(' ');

  // Services/jobs may be under ro.jobs, ro.repairOrderItems, or ro.services
  const jobs = ro.jobs || ro.repairOrderItems || ro.services || [];
  const serviceSummary = jobs
    .map((j) => j.name || j.serviceType || j.description || '')
    .filter(Boolean)
    .slice(0, 5) // cap at 5 services for SMS
    .join(', ');

  return {
    id: ro.id,
    shopId: ro.shopId || ro.shop_id,
    status: ro.status || ro.repairOrderStatus,
    customerId: customer.id || ro.customerId || ro.customer_id,
    customerName: customer.firstName
      ? `${customer.firstName} ${customer.lastName || ''}`.trim()
      : customer.name || null,
    customerPhone: normalizePhone(customer.phone || customer.mobilePhone || customer.cellPhone),
    vehicle: vehicleStr || null,
    serviceSummary: serviceSummary || null,
    completedAt: ro.completedDate || ro.closedAt || ro.completedAt || null,
    raw: ro,
  };
}

// ── Customer ──────────────────────────────────────────────────────────────────

/**
 * Fetch customer details by customer ID.
 * Use when the webhook payload doesn't include full customer info.
 *
 * @param {string|number} customerId
 * @returns {Promise<object>}
 */
async function getCustomer(customerId) {
  const data = await fetchWithRetry(`${BASE_URL}/customers/${customerId}`, {
    headers: authHeaders(),
  });

  return normalizeCustomer(data);
}

function normalizeCustomer(c) {
  return {
    id: c.id,
    firstName: c.firstName || c.first_name || '',
    lastName: c.lastName || c.last_name || '',
    name: c.firstName
      ? `${c.firstName} ${c.lastName || ''}`.trim()
      : c.name || 'Customer',
    phone: normalizePhone(c.phone || c.mobilePhone || c.cellPhone || c.primaryPhone),
    email: c.email || null,
    raw: c,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalize a phone number to E.164 format (+1XXXXXXXXXX for US).
 * Returns null if the number looks invalid.
 */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 7) return `+${digits}`; // international fallback
  return null;
}

/**
 * Validate a Tekmetric webhook signature.
 * Tekmetric sends HMAC-SHA256 in the X-Tekmetric-Signature header.
 *
 * @param {string} rawBody  Raw request body string
 * @param {string} signature  Value of X-Tekmetric-Signature header
 * @returns {boolean}
 */
function validateWebhookSignature(rawBody, signature) {
  if (!config.tekmetric.webhookSecret) return true; // Skip if not configured
  const crypto = require('crypto');
  const expected = crypto
    .createHmac('sha256', config.tekmetric.webhookSecret)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || ''));
}

module.exports = {
  getRepairOrder,
  getCustomer,
  normalizePhone,
  validateWebhookSignature,
};
