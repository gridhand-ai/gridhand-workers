/**
 * GRIDHAND Parts Prophet — SMS Message Formatters
 *
 * Pure formatting functions — no DB or API calls.
 */

'use strict';

// ─── Parts Recommendation SMS ─────────────────────────────────────────────────

function generatePartsRecommendation({ jobs, shopName, targetDate }) {
    if (jobs.length === 0) return null;

    const totalParts = jobs.reduce((sum, j) => sum + j.parts.length, 0);
    const lines = [];

    for (const job of jobs.slice(0, 4)) {
        const vehicle = [job.vehicleYear, job.vehicleMake, job.vehicleModel].filter(Boolean).join(' ');
        const bestParts = job.parts.slice(0, 2).map(p => {
            const supplier = p.bestSupplier ? ` → ${p.bestSupplier} $${p.bestPrice?.toFixed(2)}` : '';
            return `  • ${p.partDescription}${supplier}`;
        }).join('\n');
        lines.push(`RO #${job.roNumber} — ${vehicle || 'Vehicle'}\n${bestParts}`);
    }

    const more = jobs.length > 4 ? `\n+ ${jobs.length - 4} more jobs` : '';

    return [
        `🔧 ${shopName} — Parts for Tomorrow (${targetDate}):`,
        `${totalParts} parts across ${jobs.length} jobs`,
        '',
        lines.join('\n\n'),
        more,
        '',
        'Reply ORDER to auto-place or check your dashboard.',
    ].join('\n').trim();
}

// ─── Order Placed Confirmation ────────────────────────────────────────────────

function generateOrderConfirmation({ supplier, orderId, totalParts, totalCost, deliveryDate, shopName }) {
    const cost = totalCost ? ` | Total: $${totalCost.toFixed(2)}` : '';
    return `✅ ${shopName}: Parts order placed with ${capitalize(supplier)}! ${totalParts} part${totalParts > 1 ? 's' : ''}${cost}. Expected delivery: ${deliveryDate}. Order #${orderId || 'pending'}`;
}

// ─── Savings Summary ──────────────────────────────────────────────────────────

function generateSavingsSummary({ totalSavings, partsCompared, shopName }) {
    if (!totalSavings || totalSavings < 0.50) return null;
    return `💰 ${shopName}: Saved $${totalSavings.toFixed(2)} by comparing prices across ${partsCompared} parts (WorldPac vs AutoZone).`;
}

// ─── No Parts Needed ─────────────────────────────────────────────────────────

function generateNoPartsMessage({ targetDate, shopName, appointmentCount }) {
    return `📋 ${shopName}: ${appointmentCount} appointment${appointmentCount > 1 ? 's' : ''} scheduled for ${targetDate} — no pre-orderable parts identified.`;
}

function capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

module.exports = {
    generatePartsRecommendation,
    generateOrderConfirmation,
    generateSavingsSummary,
    generateNoPartsMessage,
};
