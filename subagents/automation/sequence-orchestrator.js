// Sequence Orchestrator — runs multi-step outreach campaigns automatically
// Example: Send message → wait 3 days → if no reply, send follow-up → wait 7 days → final message
const store = require('../store');
const optoutManager = require('../compliance/optout-manager');

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
async function runDueSequences(workerModules, twilioSender) {
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
                // Trigger a worker's send function
                await workerModules[step.workerTrigger](seq);
            }

            advanceSequence(seq.id);
        } catch (e) {
            console.error(`[SequenceOrchestrator] Step failed for ${seq.clientSlug} (${seq.id}): ${e.message}`);
            // Defer the step by 4 hours to prevent hammering on repeated errors
            const sequences = getAllSequences();
            const record = sequences.find(s => s.id === seq.id);
            if (record) {
                record.nextRunAt = Date.now() + 4 * 60 * 60 * 1000;
                saveAllSequences(sequences);
            }
        }
    }
}

// Built-in sequence templates
const TEMPLATES = {
    reviewRequest: (twilioNumber, customerNumber, clientSlug, reviewLink) => ({
        clientSlug, customerNumber, twilioNumber,
        workerName: 'review-requester',
        steps: [
            { delayMs: 0, message: null, workerTrigger: 'sendReview' },
            { delayMs: 3 * 86400000, condition: 'no-reply', message: `Just wanted to follow up — would you have 30 seconds to leave us a quick review? ${reviewLink} We really appreciate it!` },
        ]
    }),

    leadFollowUp: (twilioNumber, customerNumber, clientSlug, businessName, phone) => ({
        clientSlug, customerNumber, twilioNumber,
        workerName: 'lead-followup',
        steps: [
            { delayMs: 0, message: null, workerTrigger: 'sendLeadFollowup' },
            { delayMs: 3 * 86400000, condition: 'no-reply', message: `Hi! Just a quick follow-up from ${businessName}. Still happy to help — no pressure at all! Call us at ${phone} when you're ready.` },
            { delayMs: 7 * 86400000, condition: 'no-reply', message: `Last follow-up from ${businessName} — we don't want to bother you. Our door is always open at ${phone}. Take care!` },
        ]
    }),

    invoiceChase: (twilioNumber, customerNumber, clientSlug, invoiceData) => ({
        clientSlug, customerNumber, twilioNumber,
        workerName: 'invoice-chaser',
        steps: [
            { delayMs: 0, message: null, workerTrigger: 'sendInvoice1' },
            { delayMs: 7 * 86400000, condition: 'no-reply', message: null, workerTrigger: 'sendInvoice2' },
            { delayMs: 7 * 86400000, condition: 'no-reply', message: null, workerTrigger: 'sendInvoice3' },
        ]
    }),
};

module.exports = { createSequence, recordReply, cancelSequence, getDueSequences, advanceSequence, runDueSequences, TEMPLATES };
