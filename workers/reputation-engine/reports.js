/**
 * GRIDHAND Reputation Engine — Message Formatters + Response Templates
 *
 * Pure formatting functions — no DB or API calls.
 */

'use strict';

const dayjs = require('dayjs');

// ─── Negative Review SMS Alert (to manager) ───────────────────────────────────

function generateNegativeAlertSMS({ review, businessName }) {
    const stars  = '⭐'.repeat(review.star_rating);
    const source = capitalize(review.platform);
    const excerpt = review.review_text
        ? `"${review.review_text.substring(0, 120)}${review.review_text.length > 120 ? '…' : ''}"`
        : '(no text)';

    return [
        `🚨 ${businessName} — ${review.star_rating}-star review on ${source}`,
        `By: ${review.reviewer_name || 'Anonymous'} | ${dayjs(review.review_date).format('M/D h:mma')}`,
        excerpt,
        `Reply now on ${source} to protect your reputation.`,
    ].join('\n');
}

// ─── Auto-Response Templates ──────────────────────────────────────────────────

function generateAutoResponse({ review, businessName, signature, tone = 'professional' }) {
    const firstName = (review.reviewer_name || '').split(' ')[0] || 'there';
    const sig = signature || `— The ${businessName} Team`;

    if (review.star_rating >= 4) {
        return generatePositiveResponse(firstName, businessName, sig, tone);
    }
    return generateNegativeResponse(firstName, businessName, sig, tone);
}

function generatePositiveResponse(firstName, businessName, sig, tone) {
    const responses = {
        professional: [
            `Thank you so much for the kind words, ${firstName}! We're thrilled to hear you had a great experience at ${businessName}. Your feedback means a great deal to our team. We look forward to serving you again! ${sig}`,
            `Hi ${firstName}, thank you for taking the time to leave us a review! It's wonderful to hear that we met your expectations. We truly appreciate your support and hope to see you again soon. ${sig}`,
            `We really appreciate your positive feedback, ${firstName}! Reviews like yours remind us why we do what we do. Thank you for choosing ${businessName} — we look forward to your next visit! ${sig}`,
        ],
        friendly: [
            `Wow, thank you ${firstName}! 🙏 We're so happy to hear that! Our team works hard every day and reviews like yours make it all worth it. Can't wait to see you again! ${sig}`,
            `Thanks so much, ${firstName}! You made our day! 😊 We love what we do and it's amazing to hear it shows. See you next time! ${sig}`,
        ],
        formal: [
            `Dear ${firstName}, thank you for your positive review of ${businessName}. We are pleased to hear that you had a satisfactory experience. We value your patronage and look forward to serving you in the future. ${sig}`,
        ],
    };

    const options = responses[tone] || responses.professional;
    return options[Math.floor(Math.random() * options.length)];
}

function generateNegativeResponse(firstName, businessName, sig, tone) {
    const responses = {
        professional: [
            `Hi ${firstName}, thank you for bringing this to our attention. We sincerely apologize that your experience did not meet your expectations. We take all feedback seriously and would love the opportunity to make things right. Please reach out to us directly so we can address your concerns personally. ${sig}`,
            `${firstName}, we're truly sorry to hear about your experience. This is not the standard we hold ourselves to at ${businessName}. We would greatly appreciate the chance to speak with you directly and resolve this. Please contact us at your earliest convenience. ${sig}`,
        ],
        friendly: [
            `Hi ${firstName}, we're so sorry to hear this! 😔 This is definitely not the experience we want for our customers. Please reach out to us directly — we'd love to make it right for you. ${sig}`,
        ],
        formal: [
            `Dear ${firstName}, we regret to learn that your experience at ${businessName} was unsatisfactory. We take all customer concerns seriously and would appreciate the opportunity to address your specific situation. Please contact our management team directly at your earliest convenience. ${sig}`,
        ],
    };

    const options = responses[tone] || responses.professional;
    return options[Math.floor(Math.random() * options.length)];
}

// ─── Weekly Reputation Digest (to manager) ────────────────────────────────────

function generateWeeklyDigest({ googleStats, yelpStats, businessName }) {
    const lines = [`📊 ${businessName} — Weekly Reputation Summary:`];

    if (googleStats) {
        lines.push(`\n🔍 Google: ${googleStats.avgRating}⭐ avg (${googleStats.total} total)`);
        lines.push(`  Last 7d: ${googleStats.newLast7d} new | ${googleStats.positive7d} positive | ${googleStats.negative7d} negative`);
        lines.push(`  Response rate: ${googleStats.responseRate7d}%`);
    }

    if (yelpStats) {
        lines.push(`\n⭐ Yelp: ${yelpStats.avgRating}⭐ avg (${yelpStats.total} total)`);
        lines.push(`  Last 7d: ${yelpStats.newLast7d} new | ${yelpStats.positive7d} positive | ${yelpStats.negative7d} negative`);
    }

    const totalNeg = (googleStats?.negative7d || 0) + (yelpStats?.negative7d || 0);
    if (totalNeg > 0) {
        lines.push(`\n⚠️ ${totalNeg} negative review${totalNeg > 1 ? 's' : ''} this week — check your dashboard.`);
    } else {
        lines.push(`\n✅ No negative reviews this week — great work!`);
    }

    return lines.join('\n');
}

function capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

module.exports = {
    generateNegativeAlertSMS,
    generateAutoResponse,
    generateWeeklyDigest,
};
