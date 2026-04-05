// Customer Profiler — builds and maintains a full profile per customer per business
const store = require('../store');

function getKey(clientSlug, customerNumber) {
    return `${clientSlug}_${customerNumber.replace(/[^0-9]/g, '')}`;
}

function getProfile(clientSlug, customerNumber) {
    const key = getKey(clientSlug, customerNumber);
    return store.readJson('profiles', key) || {
        customerNumber,
        clientSlug,
        name: null,
        firstContact: new Date().toISOString(),
        lastContact: null,
        totalInteractions: 0,
        services: [],
        lastWorker: null,
        lastSentiment: null,
        lastEmotion: null,
        communicationStyle: null, // casual, formal, brief, detailed
        responseSpeed: null,      // fast (<5min), medium (<1hr), slow
        isVIP: false,
        vipReason: null,
        totalSpend: 0,
        invoicesPaid: 0,
        invoicesOverdue: 0,
        appointmentsKept: 0,
        appointmentsCancelled: 0,
        appointmentsNoShow: 0,
        referralCount: 0,
        reviewLeft: false,
        optedOut: false,
        optedOutAt: null,
        tags: [],
        notes: [],
        leadScore: null,
        leadTier: null,
    };
}

function updateProfile(clientSlug, customerNumber, updates) {
    const existing = getProfile(clientSlug, customerNumber);
    const updated = {
        ...existing,
        ...updates,
        lastContact: new Date().toISOString(),
        totalInteractions: (existing.totalInteractions || 0) + (updates._countInteraction ? 1 : 0),
    };
    delete updated._countInteraction;

    const key = getKey(clientSlug, customerNumber);
    store.writeJson('profiles', key, updated);

    // Update index for batch operations (lightweight summary)
    updateIndex(clientSlug, customerNumber, {
        lastContact: updated.lastContact,
        totalInteractions: updated.totalInteractions,
        lastSentiment: updated.lastSentiment,
        isVIP: updated.isVIP,
        optedOut: updated.optedOut,
        name: updated.name,
    });

    return updated;
}

function recordInteraction(clientSlug, customerNumber, { workerName, sentiment, emotion, extractedName }) {
    const updates = {
        _countInteraction: true,
        lastWorker: workerName || null,
        lastSentiment: sentiment || null,
        lastEmotion: emotion || null,
    };
    if (extractedName) updates.name = extractedName;
    return updateProfile(clientSlug, customerNumber, updates);
}

function recordService(clientSlug, customerNumber, serviceName) {
    const profile = getProfile(clientSlug, customerNumber);
    const services = profile.services || [];
    if (!services.includes(serviceName)) services.push(serviceName);
    return updateProfile(clientSlug, customerNumber, { services });
}

function addTag(clientSlug, customerNumber, tag) {
    const profile = getProfile(clientSlug, customerNumber);
    const tags = profile.tags || [];
    if (!tags.includes(tag)) tags.push(tag);
    return updateProfile(clientSlug, customerNumber, { tags });
}

function addNote(clientSlug, customerNumber, note) {
    const profile = getProfile(clientSlug, customerNumber);
    const notes = profile.notes || [];
    notes.push({ note, ts: new Date().toISOString() });
    return updateProfile(clientSlug, customerNumber, { notes: notes.slice(-50) });
}

function markOptedOut(clientSlug, customerNumber) {
    return updateProfile(clientSlug, customerNumber, {
        optedOut: true,
        optedOutAt: new Date().toISOString(),
    });
}

function updateIndex(clientSlug, customerNumber, summary) {
    const index = store.readGlobal('profiles', `${clientSlug}_index.json`) || {};
    index[customerNumber] = summary;
    store.writeGlobal('profiles', `${clientSlug}_index.json`, index);
}

function getAllCustomers(clientSlug) {
    return store.readGlobal('profiles', `${clientSlug}_index.json`) || {};
}

module.exports = {
    getProfile,
    updateProfile,
    recordInteraction,
    recordService,
    addTag,
    addNote,
    markOptedOut,
    getAllCustomers,
};
