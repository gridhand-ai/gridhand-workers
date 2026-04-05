'use strict';

const tekmetric = require('../integrations/tekmetric');
const db = require('../db/supabase');
const { scheduleReviewRequest } = require('../services/review-request');

/**
 * Handle a Tekmetric "repair_order.completed" webhook event.
 *
 * Flow:
 *  1. Validate the shop exists in our DB (it must be onboarded)
 *  2. Extract customer + vehicle + service info from the webhook payload
 *  3. If the payload is thin, fetch full details from Tekmetric API
 *  4. Schedule the review request SMS via Bull (delayed 2h by default)
 *
 * @param {object} payload  The parsed JSON body from Tekmetric webhook
 * @returns {Promise<{ status: string, message: string }>}
 */
async function handleRepairOrderCompleted(payload) {
  // ── 1. Extract IDs ──────────────────────────────────────────────────────────
  const roId = payload.id || payload.repairOrderId || payload.data?.id;
  const tekmetricShopId = payload.shopId || payload.data?.shopId || payload.shop_id;

  if (!roId) {
    return { status: 'error', message: 'Missing repair order ID in webhook payload' };
  }

  // ── 2. Look up shop ─────────────────────────────────────────────────────────
  const shop = tekmetricShopId ? await db.getShopByTekmetricId(tekmetricShopId) : null;

  if (!shop) {
    console.warn(`[ReviewCloser] No active shop found for tekmetric_shop_id=${tekmetricShopId} — ignoring RO ${roId}`);
    return { status: 'skipped', message: `Shop ${tekmetricShopId} not onboarded` };
  }

  // ── 3. Extract RO details (from payload first, then API fallback) ────────────
  let roData;

  try {
    // Try to parse all needed fields from the webhook payload itself
    roData = extractFromPayload(payload);

    // If phone or vehicle is missing, hydrate from the Tekmetric API
    const needsHydration = !roData.customerPhone || !roData.vehicle;
    if (needsHydration) {
      console.log(`[ReviewCloser] Hydrating RO ${roId} from Tekmetric API`);
      const fullRo = await tekmetric.getRepairOrder(roId);
      roData = mergeRoData(roData, fullRo);

      // If customer phone still missing, try fetching customer directly
      if (!roData.customerPhone && roData.customerId) {
        const customer = await tekmetric.getCustomer(roData.customerId);
        roData.customerPhone = customer.phone;
        if (!roData.customerName) roData.customerName = customer.name;
      }
    }
  } catch (err) {
    console.error(`[ReviewCloser] Failed to retrieve RO ${roId}: ${err.message}`);
    return { status: 'error', message: `Could not retrieve RO data: ${err.message}` };
  }

  // ── 4. Schedule SMS ─────────────────────────────────────────────────────────
  try {
    await scheduleReviewRequest(shop, {
      roId: String(roId),
      customerName: roData.customerName,
      customerPhone: roData.customerPhone,
      vehicle: roData.vehicle,
      serviceSummary: roData.serviceSummary,
    });

    return {
      status: 'scheduled',
      message: `Review request SMS queued for RO ${roId}`,
      roId,
      customerPhone: roData.customerPhone,
    };
  } catch (err) {
    console.error(`[ReviewCloser] Failed to schedule SMS for RO ${roId}: ${err.message}`);
    return { status: 'error', message: err.message };
  }
}

// ── Payload Parsing Helpers ───────────────────────────────────────────────────

/**
 * Extract RO fields from various Tekmetric webhook payload shapes.
 * Tekmetric webhooks may nest data differently depending on event type.
 */
function extractFromPayload(payload) {
  // Tekmetric wraps event data under payload.data for newer webhook versions
  const data = payload.data || payload;
  const customer = data.customer || {};
  const vehicle = data.vehicle || data.car || {};
  const jobs = data.jobs || data.repairOrderItems || data.services || [];

  const year = vehicle.year || vehicle.modelYear || '';
  const make = vehicle.make || vehicle.makeName || '';
  const model = vehicle.model || vehicle.modelName || '';
  const vehicleStr = [year, make, model].filter(Boolean).join(' ') || null;

  const serviceSummary = jobs
    .map((j) => j.name || j.serviceType || j.description || '')
    .filter(Boolean)
    .slice(0, 5)
    .join(', ') || null;

  const rawPhone = customer.phone || customer.mobilePhone || customer.cellPhone || data.customerPhone;
  const firstName = customer.firstName || customer.first_name || '';
  const lastName = customer.lastName || customer.last_name || '';
  const fullName = firstName
    ? `${firstName} ${lastName}`.trim()
    : customer.name || data.customerName || null;

  return {
    id: data.id,
    customerId: customer.id || data.customerId,
    customerName: fullName,
    customerPhone: tekmetric.normalizePhone(rawPhone),
    vehicle: vehicleStr,
    serviceSummary,
  };
}

function mergeRoData(local, api) {
  return {
    id: local.id || api.id,
    customerId: local.customerId || api.customerId,
    customerName: local.customerName || api.customerName,
    customerPhone: local.customerPhone || api.customerPhone,
    vehicle: local.vehicle || api.vehicle,
    serviceSummary: local.serviceSummary || api.serviceSummary,
  };
}

module.exports = { handleRepairOrderCompleted };
