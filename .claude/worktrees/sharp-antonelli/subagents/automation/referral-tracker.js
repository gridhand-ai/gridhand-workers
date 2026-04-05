// Referral Tracker — tracks who referred who, rewards top referrers
const store = require('../store');
const customerProfiler = require('../customer/customer-profiler');

function getKey(clientSlug) { return clientSlug; }

function getReferralData(clientSlug) {
    return store.readJson('referrals', getKey(clientSlug)) || {
        referrals: [],      // { referrerNumber, referredNumber, referredAt, status, reward }
        leaderboard: [],
        updatedAt: null,
    };
}

function saveReferralData(clientSlug, data) {
    data.updatedAt = new Date().toISOString();
    store.writeJson('referrals', getKey(clientSlug), data);
}

// Record a new referral
function recordReferral(clientSlug, referrerNumber, referredNumber, referredName = null) {
    const data = getReferralData(clientSlug);

    // Check for duplicate
    const existing = data.referrals.find(r =>
        r.referrerNumber === referrerNumber && r.referredNumber === referredNumber
    );
    if (existing) return existing;

    const referral = {
        id: `ref_${Date.now()}`,
        referrerNumber,
        referredNumber,
        referredName,
        referredAt: new Date().toISOString(),
        status: 'pending',    // pending | converted | rewarded
        rewardSentAt: null,
    };

    data.referrals.push(referral);
    data.leaderboard = computeLeaderboard(data.referrals);

    // Update referrer's profile
    const profile = customerProfiler.getProfile(clientSlug, referrerNumber);
    customerProfiler.updateProfile(clientSlug, referrerNumber, {
        referralCount: (profile.referralCount || 0) + 1
    });

    saveReferralData(clientSlug, data);
    console.log(`[ReferralTracker] Recorded referral: ${referrerNumber} → ${referredNumber}`);
    return referral;
}

// Mark a referral as converted (referred customer made a purchase)
function markConverted(clientSlug, referredNumber) {
    const data = getReferralData(clientSlug);
    const referral = data.referrals.find(r => r.referredNumber === referredNumber && r.status === 'pending');
    if (referral) {
        referral.status = 'converted';
        referral.convertedAt = new Date().toISOString();
        data.leaderboard = computeLeaderboard(data.referrals);
        saveReferralData(clientSlug, data);
        console.log(`[ReferralTracker] Referral converted: ${referral.referrerNumber} → ${referredNumber}`);
        return referral;
    }
    return null;
}

// Mark reward as sent
function markRewarded(clientSlug, referralId) {
    const data = getReferralData(clientSlug);
    const referral = data.referrals.find(r => r.id === referralId);
    if (referral) {
        referral.status = 'rewarded';
        referral.rewardSentAt = new Date().toISOString();
        saveReferralData(clientSlug, data);
    }
}

function computeLeaderboard(referrals) {
    const counts = {};
    for (const ref of referrals) {
        if (!counts[ref.referrerNumber]) counts[ref.referrerNumber] = { total: 0, converted: 0, rewarded: 0 };
        counts[ref.referrerNumber].total++;
        if (ref.status === 'converted' || ref.status === 'rewarded') counts[ref.referrerNumber].converted++;
        if (ref.status === 'rewarded') counts[ref.referrerNumber].rewarded++;
    }
    return Object.entries(counts)
        .sort((a, b) => b[1].converted - a[1].converted)
        .slice(0, 20)
        .map(([number, stats]) => ({ number, ...stats }));
}

function getLeaderboard(clientSlug) {
    return getReferralData(clientSlug).leaderboard || [];
}

function getPendingRewards(clientSlug) {
    const data = getReferralData(clientSlug);
    return data.referrals.filter(r => r.status === 'converted');
}

// Get all referrals made by a specific customer
function getReferralsByCustomer(clientSlug, customerNumber) {
    const data = getReferralData(clientSlug);
    return data.referrals.filter(r => r.referrerNumber === customerNumber);
}

module.exports = { recordReferral, markConverted, markRewarded, getLeaderboard, getPendingRewards, getReferralsByCustomer };
