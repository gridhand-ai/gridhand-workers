/**
 * GRIDHAND Transaction Tracker — Core Business Logic
 *
 * Handles milestone definitions, deadline checking, missing document detection,
 * status message generation, and transaction risk assessment.
 * Pure functions only — no DB calls, no HTTP requests.
 */

'use strict';

const dayjs = require('dayjs');

// ─── Milestone Definitions ────────────────────────────────────────────────────

/**
 * Standard real estate transaction milestones.
 * daysBeforeClosing: how many days before closing this milestone is typically due.
 * Negative values = this many days AFTER contract date (e.g. offer acceptance).
 */
const MILESTONE_DEFINITIONS = [
    {
        name:             'Offer Accepted',
        daysBeforeClosing: 45,
        required:          true,
        category:          'contract',
        description:       'Purchase agreement signed by all parties',
    },
    {
        name:             'Inspection Period',
        daysBeforeClosing: 38,
        required:          true,
        category:          'inspection',
        description:       'Inspection period deadline — buyer must request repairs or terminate',
    },
    {
        name:             'Inspection Response',
        daysBeforeClosing: 35,
        required:          false,
        category:          'inspection',
        description:       'Seller response to inspection repair requests',
    },
    {
        name:             'Loan Application',
        daysBeforeClosing: 40,
        required:          true,
        category:          'financing',
        description:       'Buyer submits formal mortgage application',
    },
    {
        name:             'Appraisal Ordered',
        daysBeforeClosing: 30,
        required:          false,
        category:          'financing',
        description:       'Lender orders property appraisal',
    },
    {
        name:             'Appraisal Received',
        daysBeforeClosing: 20,
        required:          false,
        category:          'financing',
        description:       'Appraisal report received and reviewed',
    },
    {
        name:             'Loan Approval',
        daysBeforeClosing: 14,
        required:          true,
        category:          'financing',
        description:       'Full loan commitment / clear to fund from lender',
    },
    {
        name:             'Title Search',
        daysBeforeClosing: 21,
        required:          true,
        category:          'title',
        description:       'Title search ordered and clear title confirmed',
    },
    {
        name:             'Clear to Close',
        daysBeforeClosing: 3,
        required:          true,
        category:          'closing',
        description:       'All conditions satisfied, lender issues clear to close',
    },
    {
        name:             'Final Walkthrough',
        daysBeforeClosing: 1,
        required:          false,
        category:          'closing',
        description:       'Buyer final walkthrough of property',
    },
    {
        name:             'Closing',
        daysBeforeClosing: 0,
        required:          true,
        category:          'closing',
        description:       'Closing day — deed transfer and funds disbursement',
    },
];

// Required documents by transaction type
const REQUIRED_DOCUMENTS = {
    buy: [
        'Purchase Agreement',
        'Buyer Pre-Approval Letter',
        'Inspection Report',
        'Appraisal Report',
        'Loan Commitment Letter',
        'Title Commitment',
        'Closing Disclosure',
        'Final Walkthrough Acknowledgment',
    ],
    sell: [
        'Listing Agreement',
        'Seller Disclosure',
        'Purchase Agreement',
        'Inspection Response',
        'Title Commitment',
        'Settlement Statement',
    ],
    lease: [
        'Lease Agreement',
        'Tenant Application',
        'Credit Check Authorization',
        'Move-In Inspection Form',
    ],
};

// ─── Deadline Checking ────────────────────────────────────────────────────────

/**
 * Compare milestone due dates against today.
 * Returns { overdue: [], dueToday: [], dueSoon: [] }
 * dueSoon = milestones due within 3 days (not yet overdue).
 */
function checkDeadlines(transaction) {
    const today     = dayjs().startOf('day');
    const overdue   = [];
    const dueToday  = [];
    const dueSoon   = [];

    const milestones = transaction.milestones || [];

    for (const m of milestones) {
        if (!m.due_date || m.completed_at) continue;

        const due      = dayjs(m.due_date).startOf('day');
        const diffDays = due.diff(today, 'day');

        if (diffDays < 0) {
            overdue.push({
                name:     m.name,
                dueDate:  m.due_date,
                daysLate: Math.abs(diffDays),
                required: m.required,
                category: m.category,
            });
        } else if (diffDays === 0) {
            dueToday.push({
                name:     m.name,
                dueDate:  m.due_date,
                required: m.required,
                category: m.category,
            });
        } else if (diffDays <= 3) {
            dueSoon.push({
                name:     m.name,
                dueDate:  m.due_date,
                daysOut:  diffDays,
                required: m.required,
                category: m.category,
            });
        }
    }

    return { overdue, dueToday, dueSoon };
}

// ─── Missing Document Detection ───────────────────────────────────────────────

/**
 * Compare required documents against uploaded/signed documents.
 * @param {object} transaction — includes type (buy/sell/lease)
 * @param {Array}  documents   — array of tt_documents rows
 * Returns array of missing document names (strings).
 */
function findMissingDocuments(transaction, documents) {
    const txType   = transaction.type || 'buy';
    const required = REQUIRED_DOCUMENTS[txType] || REQUIRED_DOCUMENTS.buy;

    // Build a set of names that have been uploaded or signed
    const uploaded = new Set();
    for (const doc of documents) {
        if (doc.uploaded_at || doc.docusign_status === 'completed') {
            uploaded.add(doc.name.trim().toLowerCase());
        }
    }

    const missing = [];
    for (const reqName of required) {
        if (!uploaded.has(reqName.trim().toLowerCase())) {
            missing.push(reqName);
        }
    }

    return missing;
}

// ─── Status Update Generation ─────────────────────────────────────────────────

/**
 * Generate a human-readable SMS status update for a buyer or seller.
 * Kept under 300 characters per SMS segment limit.
 * @param {object} transaction — full transaction record
 * @param {string} recipient   — 'buyer' or 'seller'
 */
function generateStatusUpdate(transaction, recipient) {
    const address = transaction.address ? shortenAddress(transaction.address) : 'your property';
    const closing = transaction.closing_date
        ? dayjs(transaction.closing_date).format('MMM D')
        : 'TBD';

    const milestones = transaction.milestones || [];
    const completed  = milestones.filter(m => m.completed_at).length;
    const total      = milestones.length;

    const nextMilestone = milestones
        .filter(m => !m.completed_at && m.due_date)
        .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))[0];

    let message = '';

    if (recipient === 'buyer') {
        message = `Hi ${transaction.buyer_name || 'there'}! Update on ${address}: `;
        message += `${completed}/${total} milestones complete. `;
        if (nextMilestone) {
            message += `Next: ${nextMilestone.name} by ${dayjs(nextMilestone.due_date).format('MMM D')}. `;
        }
        message += `Closing: ${closing}.`;
    } else {
        message = `Hi ${transaction.seller_name || 'there'}! Update on ${address}: `;
        message += `Transaction is on track (${completed}/${total} steps done). `;
        if (nextMilestone) {
            message += `Next step: ${nextMilestone.name}. `;
        }
        message += `Expected closing: ${closing}.`;
    }

    // Truncate hard at 300 chars
    if (message.length > 300) {
        message = message.substring(0, 297) + '...';
    }

    return message;
}

// ─── Closing Checklist Generation ────────────────────────────────────────────

/**
 * Generate a formatted closing checklist string.
 * Completed milestones get a check mark, pending ones get an open box.
 */
function generateClosingChecklist(transaction) {
    const milestones = transaction.milestones || [];
    const address    = transaction.address || 'Transaction';
    const closing    = transaction.closing_date
        ? dayjs(transaction.closing_date).format('MMMM D, YYYY')
        : 'TBD';

    let checklist = `CLOSING CHECKLIST\n`;
    checklist    += `${address}\n`;
    checklist    += `Closing: ${closing}\n`;
    checklist    += `─────────────────────\n`;

    // Group by category
    const categories = ['contract', 'inspection', 'financing', 'title', 'closing'];
    const categoryLabels = {
        contract:   'CONTRACT',
        inspection: 'INSPECTION',
        financing:  'FINANCING',
        title:      'TITLE',
        closing:    'CLOSING',
    };

    for (const cat of categories) {
        const catMilestones = milestones.filter(m => m.category === cat);
        if (catMilestones.length === 0) continue;

        checklist += `\n${categoryLabels[cat]}\n`;

        for (const m of catMilestones) {
            const check = m.completed_at ? '✓' : '☐';
            const date  = m.due_date
                ? ` (${dayjs(m.due_date).format('M/D')})`
                : '';
            const overdue = !m.completed_at && m.due_date && dayjs(m.due_date).isBefore(dayjs(), 'day')
                ? ' ⚠ OVERDUE'
                : '';
            checklist += `${check} ${m.name}${date}${overdue}\n`;
        }
    }

    const completedCount = milestones.filter(m => m.completed_at).length;
    const totalCount     = milestones.length;
    checklist += `\n${completedCount}/${totalCount} complete`;

    return checklist;
}

// ─── Risk Assessment ──────────────────────────────────────────────────────────

/**
 * Assess transaction risk level based on overdue items, missing docs, and time to closing.
 * Returns { level: 'low'|'medium'|'high', reasons: [] }
 */
function assessRisk(transaction) {
    const reasons  = [];
    let score      = 0;

    const milestones = transaction.milestones || [];
    const documents  = transaction.documents  || [];

    // Check overdue milestones
    const deadlines = checkDeadlines(transaction);

    const overdueRequired = deadlines.overdue.filter(m => m.required);
    if (overdueRequired.length >= 2) {
        score += 3;
        reasons.push(`${overdueRequired.length} required milestones overdue`);
    } else if (overdueRequired.length === 1) {
        score += 2;
        reasons.push(`"${overdueRequired[0].name}" is overdue by ${overdueRequired[0].daysLate} days`);
    }

    const overdueAny = deadlines.overdue.length;
    if (overdueAny > 0 && !overdueRequired.length) {
        score += 1;
        reasons.push(`${overdueAny} milestone(s) past due date`);
    }

    // Check missing required documents
    const missing = findMissingDocuments(transaction, documents);
    if (missing.length >= 3) {
        score += 2;
        reasons.push(`${missing.length} required documents missing`);
    } else if (missing.length > 0) {
        score += 1;
        reasons.push(`Missing: ${missing.slice(0, 2).join(', ')}${missing.length > 2 ? '...' : ''}`);
    }

    // Check days to closing
    if (transaction.closing_date) {
        const daysToClose = dayjs(transaction.closing_date).diff(dayjs(), 'day');
        if (daysToClose < 0) {
            score += 3;
            reasons.push(`Closing date passed ${Math.abs(daysToClose)} day(s) ago`);
        } else if (daysToClose <= 3) {
            score += 2;
            if (!reasons.some(r => r.includes('closing'))) {
                reasons.push(`Closing in ${daysToClose} day(s)`);
            }
        } else if (daysToClose <= 7 && deadlines.overdue.length > 0) {
            score += 1;
            reasons.push(`Closing in ${daysToClose} days with open items`);
        }
    }

    // No loan approval + closing in 14 days = red flag
    const loanApproval = milestones.find(m => m.name === 'Loan Approval');
    if (loanApproval && !loanApproval.completed_at && transaction.closing_date) {
        const daysToClose = dayjs(transaction.closing_date).diff(dayjs(), 'day');
        if (daysToClose <= 14) {
            score += 2;
            reasons.push('Loan approval not yet received, closing approaching');
        }
    }

    let level = 'low';
    if (score >= 4) level = 'high';
    else if (score >= 2) level = 'medium';

    return { level, reasons, score };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortenAddress(address) {
    // Return just the street number + name, drop city/state/zip for SMS brevity
    const parts = address.split(',');
    return parts[0].trim();
}

module.exports = {
    MILESTONE_DEFINITIONS,
    REQUIRED_DOCUMENTS,
    checkDeadlines,
    findMissingDocuments,
    generateStatusUpdate,
    generateClosingChecklist,
    assessRisk,
};
