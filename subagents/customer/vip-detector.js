// VIP Detector — identifies your client's highest-value customers
const customerProfiler = require('./customer-profiler');
const store = require('../store');

// Default VIP thresholds (clients can override via settings)
const DEFAULT_THRESHOLDS = {
    minInteractions: 10,
    minSpend: 500,
    minAppointmentsKept: 5,
    minReferrals: 2,
    minInvoicesPaid: 3,
};

function checkVIPStatus(profile, thresholds = {}) {
    const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
    const reasons = [];

    if ((profile.totalInteractions || 0) >= t.minInteractions) {
        reasons.push(`${profile.totalInteractions} total interactions`);
    }
    if ((profile.totalSpend || 0) >= t.minSpend) {
        reasons.push(`$${profile.totalSpend} total spend`);
    }
    if ((profile.appointmentsKept || 0) >= t.minAppointmentsKept) {
        reasons.push(`${profile.appointmentsKept} appointments kept`);
    }
    if ((profile.referralCount || 0) >= t.minReferrals) {
        reasons.push(`${profile.referralCount} referrals sent`);
    }
    if ((profile.invoicesPaid || 0) >= t.minInvoicesPaid) {
        reasons.push(`${profile.invoicesPaid} invoices paid on time`);
    }

    const isVIP = reasons.length >= 2; // Must meet at least 2 criteria
    return { isVIP, reasons };
}

async function evaluate(clientSlug, customerNumber, clientSettings = {}) {
    const profile = await customerProfiler.getProfile(clientSlug, customerNumber);
    const thresholds = clientSettings?.vip?.thresholds || {};
    const { isVIP, reasons } = checkVIPStatus(profile, thresholds);

    if (isVIP !== profile.isVIP) {
        const vipReason = isVIP ? reasons.join(', ') : null;
        await customerProfiler.updateProfile(clientSlug, customerNumber, { isVIP, vipReason });

        if (isVIP) {
            console.log(`[VIPDetector] ${customerNumber} is now VIP: ${reasons.join(', ')}`);
        }
    }

    return { isVIP, reasons, profile };
}

// Scan all customers and return VIP list
async function getVIPList(clientSlug, clientSettings = {}) {
    const allCustomers = await customerProfiler.getAllCustomers(clientSlug);
    const vips = [];

    for (const [customerNumber, summary] of Object.entries(allCustomers)) {
        if (summary.isVIP) {
            vips.push({ customerNumber, ...summary });
        }
    }

    console.log(`[VIPDetector] ${vips.length} VIPs found for ${clientSlug}`);
    return vips;
}

// Get a VIP-appropriate greeting addition for workers to use
async function getVIPContext(clientSlug, customerNumber) {
    const profile = await customerProfiler.getProfile(clientSlug, customerNumber);
    if (!profile.isVIP) return null;

    return {
        isVIP: true,
        instruction: 'This is a VIP customer. Be extra warm, use their name if known, and prioritize their needs.',
        name: profile.name,
        vipReason: profile.vipReason,
    };
}

module.exports = { evaluate, getVIPList, getVIPContext, checkVIPStatus };
