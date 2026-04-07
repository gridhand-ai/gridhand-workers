// Sequence Orchestrator — runs multi-step outreach campaigns automatically
// Example: Send message → wait 3 days → if no reply, send follow-up → wait 7 days → final message
const store = require('../store');
const optoutManager = require('../compliance/optout-manager');
const tcpaChecker = require('../compliance/tcpa-checker');

const MAX_RETRIES = 5;

function getAllSequences() {
    return store.readGlobal('sequences', 'all.json') || [];
}

function saveAllSequences(sequences) {
    store.writeGlobal('sequences', 'all.json', sequences);
}

// Create a new sequence for a customer
function createSequence({ clientSlug, customerNumber, workerName, steps, twilioNumber, clientApiKeys = {} }) {
    // Each step: { delayMs, message, workerTrigger, condition }
    // condition: 'always' | 'no-reply' | 'no-conversion'
    const sequences = getAllSequences();

    // Cancel any existing sequence for this customer+worker
    cancelSequence(clientSlug, customerNumber, workerName);

    const sequence = {
        id: `seq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        clientSlug,
        customerNumber,
        workerName,
        twilioNumber,
        clientApiKeys,
        steps,
        currentStep: 0,
        status: 'active',        // active | paused | completed | cancelled
        lastReply: null,
        lastReplyAt: null,
        createdAt: new Date().toISOString(),
        nextRunAt: Date.now() + (steps[0]?.delayMs || 0),
    };

    sequences.push(sequence);
    saveAllSequences(sequences);
    console.log(`[SequenceOrchestrator] Created sequence ${sequence.id} for ${customerNumber} (${workerName})`);
    return sequence;
}

// Mark that the customer replied (may pause/cancel sequence based on condition)
function recordReply(clientSlug, customerNumber, workerName) {
    const sequences = getAllSequences();
    let updated = false;

    for (const seq of sequences) {
        if (seq.clientSlug === clientSlug && seq.customerNumber === customerNumber &&
            seq.workerName === workerName && seq.status === 'active') {

            seq.lastReply = 'replied';
            seq.lastReplyAt = new Date().toISOString();

            // If next step requires 'no-reply' condition, skip it
            const nextStep = seq.steps[seq.currentStep];
            if (nextStep?.condition === 'no-reply') {
                seq.currentStep++;
                if (seq.currentStep >= seq.steps.length) {
                    seq.status = 'completed';
                } else {
                    seq.nextRunAt = Date.now() + (seq.steps[seq.currentStep]?.delayMs || 86400000);
                }
            }
            updated = true;
        }
    }

    if (updated) saveAllSequences(sequences);
    return updated;
}

function cancelSequence(clientSlug, customerNumber, workerName = null) {
    const sequences = getAllSequences();
    let changed = false;

    for (const seq of sequences) {
        if (seq.clientSlug === clientSlug && seq.customerNumber === customerNumber &&
            seq.status === 'active' && (!workerName || seq.workerName === workerName)) {
            seq.status = 'cancelled';
            changed = true;
        }
    }

    if (changed) saveAllSequences(sequences);
}

// Get sequences that are ready to run now
function getDueSequences() {
    const sequences = getAllSequences();
    const now = Date.now();
    return sequences.filter(s => s.status === 'active' && s.nextRunAt <= now);
}

// Advance a sequence to the next step (called by the runner)
function advanceSequence(sequenceId) {
    const sequences = getAllSequences();
    const seq = sequences.find(s => s.id === sequenceId);
    if (!seq) return null;

    seq.currentStep++;
    if (seq.currentStep >= seq.steps.length) {
        seq.status = 'completed';
        console.log(`[SequenceOrchestrator] Sequence ${sequenceId} completed`);
    } else {
        seq.nextRunAt = Date.now() + (seq.steps[seq.currentStep].delayMs || 86400000);
        console.log(`[SequenceOrchestrator] Sequence ${sequenceId} advanced to step ${seq.currentStep}`);
    }

    saveAllSequences(sequences);
    return seq;
}

// Runner — call this on a timer (every minute) from server.js
// `loadClientBySlug` is optional; when supplied, worker-triggered steps can
// hydrate the full client config (needed by workers[].send({ client, ... })).
async function runDueSequences(workerModules, twilioSender, loadClientBySlug = null) {
    const due = getDueSequences();
    if (due.length === 0) return;

    console.log(`[SequenceOrchestrator] Running ${due.length} due sequences`);

    for (const seq of due) {
        try {
            // Check opt-out
            if (optoutManager.isOptedOut(seq.clientSlug, seq.customerNumber)) {
                cancelSequence(seq.clientSlug, seq.customerNumber);
                continue;
            }

            const step = seq.steps[seq.currentStep];
            if (!step) { advanceSequence(seq.id); continue; }

            // Execute the step
            if (step.message) {
                await twilioSender.sendSMS({
                    from: seq.twilioNumber,
                    to: seq.customerNumber,
                    body: step.message,
                    clientSlug: seq.clientSlug,
                    clientApiKeys: seq.clientApiKeys || {},
                });
            } else if (step.workerTrigger && workerModules[step.workerTrigger]) {
                const mod = workerModules[step.workerTrigger];
                if (typeof mod.send !== 'function') {
                    throw new Error(`Worker "${step.workerTrigger}" has no send()`);
                }
                // Hydrate the client config so the worker gets { client, customerNumber, ... }
                let client = null;
                if (typeof loadClientBySlug === 'function') {
                    try { client = loadClientBySlug(seq.clientSlug); } catch {}
                }
                if (!client) {
                    // Minimal fallback so workers that only need twilioNumber/apiKeys still run
                    client = {
                        slug:         seq.clientSlug,
                        twilioNumber: seq.twilioNumber,
                        apiKeys:      seq.clientApiKeys || {},
                        business:     {},
                    };
                }
                await mod.send({
                    client,
                    customerNumber: seq.customerNumber,
                    ...(step.params || {}),
                });
            }

            // Success — reset retry counter and advance
            if (seq.retryCount) {
                const sequences = getAllSequences();
                const record = sequences.find(s => s.id === seq.id);
                if (record) { record.retryCount = 0; saveAllSequences(sequences); }
            }
            advanceSequence(seq.id);
        } catch (e) {
            console.error(`[SequenceOrchestrator] Step failed for ${seq.clientSlug} (${seq.id}): ${e.message}`);
            const sequences = getAllSequences();
            const record = sequences.find(s => s.id === seq.id);
            if (!record) continue;

            record.retryCount = (record.retryCount || 0) + 1;
            record.lastError  = e.message;

            if (/TCPA/i.test(e.message)) {
                // TCPA quiet hours — defer to next-send-time in the client's own timezone
                try {
                    const tz = record.timezone || 'America/Chicago';
                    const nextIso = tcpaChecker.getNextSendTime(tz);
                    record.nextRunAt = new Date(nextIso).getTime();
                    console.log(`[SequenceOrchestrator] ${seq.id} deferred to ${nextIso} (TCPA, tz=${tz})`);
                } catch {
                    record.nextRunAt = Date.now() + 4 * 60 * 60 * 1000;
                }
                // TCPA deferrals don't count against retry limit — reset
                record.retryCount = 0;
            } else if (record.retryCount >= MAX_RETRIES) {
                record.status = 'failed';
                record.failedAt = new Date().toISOString();
                console.error(`[SequenceOrchestrator] ${seq.id} permanently FAILED after ${record.retryCount} retries: ${e.message}`);
            } else {
                // Exponential backoff: 15m * 2^(retry-1) capped at 4h
                const backoffMs = Math.min(15 * 60 * 1000 * Math.pow(2, record.retryCount - 1), 4 * 60 * 60 * 1000);
                record.nextRunAt = Date.now() + backoffMs;
            }
            saveAllSequences(sequences);
        }
    }
}

// Built-in sequence templates
// workerTrigger MUST match a key in server.js `workerModules` — the runner calls
// `workerModules[workerTrigger].send({ client, customerNumber, ...step.params })`.
const TEMPLATES = {
    reviewRequest: (twilioNumber, customerNumber, clientSlug, reviewLink, customerName = '', serviceName = '') => ({
        clientSlug, customerNumber, twilioNumber,
        workerName: 'review-requester',
        steps: [
            { delayMs: 0, message: null, workerTrigger: 'review-requester', params: { customerName, serviceName } },
            { delayMs: 3 * 86400000, condition: 'no-reply', message: `Just wanted to follow up — would you have 30 seconds to leave us a quick review? ${reviewLink} We really appreciate it!` },
        ]
    }),

    leadFollowUp: (twilioNumber, customerNumber, clientSlug, businessName, phone, customerName = '', inquiryAbout = '') => ({
        clientSlug, customerNumber, twilioNumber,
        workerName: 'lead-followup',
        steps: [
            { delayMs: 0, message: null, workerTrigger: 'lead-followup', params: { customerName, inquiryAbout, followUpNumber: 1 } },
            { delayMs: 3 * 86400000, condition: 'no-reply', message: `Hi! Just a quick follow-up from ${businessName}. Still happy to help — no pressure at all! Call us at ${phone} when you're ready.` },
            { delayMs: 7 * 86400000, condition: 'no-reply', message: `Last follow-up from ${businessName} — we don't want to bother you. Our door is always open at ${phone}. Take care!` },
        ]
    }),

    invoiceChase: (twilioNumber, customerNumber, clientSlug, invoiceData = {}) => ({
        clientSlug, customerNumber, twilioNumber,
        workerName: 'invoice-chaser',
        steps: [
            { delayMs: 0,             message: null, workerTrigger: 'invoice-chaser', params: { ...invoiceData, chaseNumber: 1 } },
            { delayMs: 7 * 86400000,  condition: 'no-reply', message: null, workerTrigger: 'invoice-chaser', params: { ...invoiceData, chaseNumber: 2 } },
            { delayMs: 7 * 86400000,  condition: 'no-reply', message: null, workerTrigger: 'invoice-chaser', params: { ...invoiceData, chaseNumber: 3 } },
        ]
    }),
};

module.exports = { createSequence, recordReply, cancelSequence, getDueSequences, advanceSequence, runDueSequences, TEMPLATES };
