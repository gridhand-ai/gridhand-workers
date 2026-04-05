'use strict';

// ── SMS Templates ─────────────────────────────────────────────────────────────

/**
 * Review request SMS sent to customer after RO completion.
 * @param {string} firstName
 * @param {string} vehicle  e.g. "2019 Toyota Camry"
 * @param {string} reviewUrl  Short review link
 * @returns {string}
 */
function reviewRequestSms(firstName, vehicle, reviewUrl) {
  const name = firstName || 'there';
  const vehiclePart = vehicle ? `the ${vehicle}` : 'your vehicle';
  return `Hey ${name}, hope ${vehiclePart} is running smooth! If we earned it, a quick Google review means a lot to our team → ${reviewUrl}`;
}

/**
 * SMS alert to shop owner when a low-star review comes in (1–3 stars).
 * @param {object} params
 * @param {string} params.ownerName
 * @param {string} params.reviewerName
 * @param {number} params.rating
 * @param {string} params.reviewText
 * @returns {string}
 */
function lowStarOwnerAlert({ ownerName, reviewerName, rating, reviewText }) {
  const name = ownerName || 'there';
  const reviewer = reviewerName || 'A customer';
  const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
  const preview = reviewText
    ? reviewText.length > 120
      ? reviewText.slice(0, 117) + '...'
      : reviewText
    : '(No comment left)';

  return `🚨 ${name}, new ${rating}-star review just came in.\n\n${stars}\n${reviewer}: "${preview}"\n\nReply quickly — a fast response can turn this around.`;
}

// ── Google Review Reply Templates ─────────────────────────────────────────────

/**
 * Auto-reply for 5-star reviews.
 * @param {string} reviewerName
 * @param {string} shopName
 * @returns {string}
 */
function fiveStarReply(reviewerName, shopName) {
  const name = reviewerName || 'you';
  const shop = shopName || 'our shop';
  const replies = [
    `Thank you so much, ${name}! We really appreciate you taking the time to share your experience. It means everything to the ${shop} team — we'll see you next time!`,
    `Wow, thank you ${name}! Reviews like yours are what keep us going. The whole team at ${shop} appreciates you — come back anytime!`,
    `${name}, this made our day! Thank you for the kind words and for trusting ${shop} with your vehicle. We look forward to seeing you again!`,
    `Thank you for the 5 stars, ${name}! We're so glad we could take care of you. The team at ${shop} truly appreciates your support.`,
  ];
  return replies[Math.floor(Math.random() * replies.length)];
}

/**
 * Auto-reply for 4-star reviews.
 * @param {string} reviewerName
 * @param {string} shopName
 * @returns {string}
 */
function fourStarReply(reviewerName, shopName) {
  const name = reviewerName || 'you';
  const shop = shopName || 'our shop';
  return `Thank you, ${name}! We're so glad you had a great experience at ${shop}. If there's anything we can do to earn that 5th star next time, we'd love to hear from you — just give us a call. See you soon!`;
}

/**
 * Select the right positive reply based on star rating (4 or 5).
 * @param {number} rating
 * @param {string} reviewerName
 * @param {string} shopName
 * @returns {string}
 */
function positiveReviewReply(rating, reviewerName, shopName) {
  if (rating >= 5) return fiveStarReply(reviewerName, shopName);
  return fourStarReply(reviewerName, shopName);
}

module.exports = {
  reviewRequestSms,
  lowStarOwnerAlert,
  positiveReviewReply,
  fiveStarReply,
  fourStarReply,
};
