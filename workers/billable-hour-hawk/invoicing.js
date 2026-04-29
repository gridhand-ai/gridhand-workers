/**
 * GRIDHAND Billable Hour Hawk — Invoicing & SMS Alerts
 *
 * Handles invoice draft generation and all outbound SMS messages.
 *
 * Public surface:
 *   generateInvoiceDraft(clientSlug, matterId)
 *   formatInvoiceDetails(entries)
 *   sendInvoiceDraftAlert(clientSlug, matterId, draftDetails)
 *   sendRetainerAlert(clientSlug, matter)
 *   sendWeeklySummary(clientSlug)
 *   sendUnbilledFlagAlert(clientSlug, entry)
 *   sendAttorneyReminder(clientSlug, attorney)
 */

'use strict';

require('dotenv').config();

const dayjs  = require('dayjs');
const { createClient } = require('@supabase/supabase-js');
const billingApi = require('./billing-api');
const tracker    = require('./tracker');
const { sendSMS: twilioSendSMS } = require('../../lib/twilio-client');

// ─── Supabase ─────────────────────────────────────────────────────────────────

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Internal: SMS sender ─────────────────────────────────────────────────────

/**
 * Send an SMS via lib/twilio-client.js (TCPA + opt-out compliant) and log it to billing_alerts.
 */
async function sendSMS(clientSlug, toPhone, body, alertType) {
    if (!toPhone) {
        console.warn(`[Invoicing] No phone configured for ${clientSlug} — alert_type: ${alertType}`);
        return null;
    }

    let messageSid = null;

    try {
        const { sid } = await twilioSendSMS({
            to:             toPhone,
            body,
            clientSlug,
            clientTimezone: undefined,
        });
        messageSid = sid;
        console.log(`[Invoicing] SMS sent to ${toPhone} (${alertType}) — SID: ${sid}`);
    } catch (err) {
        console.error(`[Invoicing] SMS failed to ${toPhone}: ${err.message}`);
    }

    // Always log attempt
    await supabase.from('billing_alerts').insert({
        client_slug:  clientSlug,
        alert_type:   alertType,
        recipient:    toPhone,
        message_body: body,
    });

    return messageSid;
}

// ─── formatInvoiceDetails ─────────────────────────────────────────────────────

/**
 * Group time entries by attorney, total hours and amounts.
 * Returns a structured breakdown for display in alerts.
 */
function formatInvoiceDetails(entries) {
    const byAttorney = {};

    for (const entry of entries) {
        const name = entry.attorney_name || 'Unknown';
        if (!byAttorney[name]) {
            byAttorney[name] = { attorney_name: name, hours: 0, amount: 0, entries: [] };
        }
        byAttorney[name].hours  += parseFloat(entry.hours || 0);
        byAttorney[name].amount += parseFloat(entry.amount || 0);
        byAttorney[name].entries.push(entry);
    }

    const lines = Object.values(byAttorney)
        .sort((a, b) => b.amount - a.amount)
        .map(a => ({
            attorney_name: a.attorney_name,
            hours:         Math.round(a.hours * 100) / 100,
            amount:        Math.round(a.amount * 100) / 100,
            entry_count:   a.entries.length,
        }));

    const totals = {
        total_hours:   Math.round(lines.reduce((s, l) => s + l.hours, 0) * 100) / 100,
        total_amount:  Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100,
        attorney_count: lines.length,
        entry_count:    entries.length,
    };

    return { lines, totals };
}

// ─── generateInvoiceDraft ─────────────────────────────────────────────────────

/**
 * Pull all unbilled entries for a matter, create an invoice draft in Clio/RM,
 * save the record to DB, and return the draft details.
 */
async function generateInvoiceDraft(clientSlug, matterId) {
    console.log(`[Invoicing] Generating invoice draft for ${clientSlug} / matter ${matterId}`);

    // Get all unbilled entries for this matter
    const allUnbilled = await billingApi.getUnbilledEntries(clientSlug);
    const matterEntries = allUnbilled.filter(e => e.matter_id === String(matterId));

    if (!matterEntries.length) {
        console.log(`[Invoicing] No unbilled entries for matter ${matterId}`);
        return null;
    }

    // Create the draft in the billing system
    const draft = await billingApi.createInvoiceDraft(clientSlug, matterId, matterEntries);

    // Get matter name from entries
    const matterName = matterEntries[0]?.matter_name || '';

    // Save draft to DB
    const { error } = await supabase.from('invoice_drafts').insert({
        client_slug:       clientSlug,
        matter_id:         String(matterId),
        matter_name:       matterName,
        draft_external_id: draft.draft_external_id,
        total_hours:       draft.total_hours,
        total_amount:      draft.total_amount,
        entry_count:       draft.entry_count,
        status:            'draft',
    });

    if (error) {
        console.error(`[Invoicing] Failed to save draft record: ${error.message}`);
    }

    console.log(`[Invoicing] Draft created — matter: ${matterId}, hours: ${draft.total_hours}, amount: $${draft.total_amount}`);
    return { ...draft, matter_name: matterName, entries: matterEntries };
}

// ─── sendInvoiceDraftAlert ────────────────────────────────────────────────────

/**
 * SMS the billing contact to review a newly created invoice draft.
 */
async function sendInvoiceDraftAlert(clientSlug, matterId, draftDetails) {
    const conn = await tracker.getConnection(clientSlug);
    if (!conn?.billing_contact_phone) {
        console.warn(`[Invoicing] No billing_contact_phone for ${clientSlug}`);
        return null;
    }

    const firmName   = conn.firm_name || clientSlug;
    const matterName = draftDetails.matter_name || `Matter ${matterId}`;
    const { lines, totals } = formatInvoiceDetails(draftDetails.entries || []);

    const attorneyLines = lines
        .slice(0, 3)  // show top 3 attorneys max
        .map(l => `  ${l.attorney_name}: ${l.hours}h ($${l.amount.toLocaleString()})`)
        .join('\n');

    const body = [
        `📋 Invoice Draft Ready — ${firmName}`,
        `Matter: ${matterName}`,
        ``,
        `${totals.entry_count} time entries | ${totals.total_hours} hrs`,
        `Total: $${totals.total_amount.toLocaleString()}`,
        ``,
        `By Attorney:`,
        attorneyLines,
        ``,
        `Log into your billing system to review and approve.`,
    ].join('\n');

    return sendSMS(clientSlug, conn.billing_contact_phone, body, 'invoice_draft');
}

// ─── sendUnbilledFlagAlert ────────────────────────────────────────────────────

/**
 * SMS the billing contact about a specific unbilled time entry that's been
 * sitting too long. Uses the exact format from the spec.
 */
async function sendUnbilledFlagAlert(clientSlug, entry) {
    const conn = await tracker.getConnection(clientSlug);
    if (!conn?.billing_contact_phone) return null;

    const firmName    = conn.firm_name || clientSlug;
    const daysUnbilled = dayjs().diff(dayjs(entry.entry_date), 'day');
    const amount       = parseFloat(entry.amount || 0);
    const hours        = parseFloat(entry.hours || 0);

    const body = [
        `🕐 Unbilled Work Alert — ${firmName}`,
        `Attorney: ${entry.attorney_name}`,
        `Matter: ${entry.client_name || entry.matter_name}`,
        `${hours} hrs unbilled for ${daysUnbilled} days ($${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`,
        `Reply INVOICE to draft now`,
    ].join('\n');

    return sendSMS(clientSlug, conn.billing_contact_phone, body, 'unbilled_flag');
}

// ─── sendRetainerAlert ────────────────────────────────────────────────────────

/**
 * SMS the billing contact when a matter's retainer drops below 20%.
 * Uses the exact format from the spec.
 */
async function sendRetainerAlert(clientSlug, matter) {
    const conn = await tracker.getConnection(clientSlug);
    if (!conn?.billing_contact_phone) return null;

    const firmName   = conn.firm_name || clientSlug;
    const clientName = matter.client_name || matter.description || `Matter ${matter.id}`;
    const balance    = parseFloat(matter.retainer_balance || 0);
    const limit      = parseFloat(matter.retainer_limit || 0);
    const pct        = matter.balance_pct || Math.round((balance / limit) * 100);

    const body = [
        `💰 Retainer Low — ${firmName}`,
        `Matter: ${clientName}`,
        `Balance: $${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${pct}% of $${limit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`,
        `Action: Request replenishment`,
        `Reply IGNORE to snooze 7 days`,
    ].join('\n');

    return sendSMS(clientSlug, conn.billing_contact_phone, body, 'retainer_low');
}

// ─── sendAttorneyReminder ─────────────────────────────────────────────────────

/**
 * SMS the managing partner / billing contact about an attorney
 * who hasn't logged time in 2+ days.
 */
async function sendAttorneyReminder(clientSlug, attorney) {
    const conn = await tracker.getConnection(clientSlug);
    if (!conn?.managing_partner_phone) return null;

    const firmName   = conn.firm_name || clientSlug;
    const daysSince  = attorney.days_since_entry;
    const lastDate   = attorney.last_entry_date
        ? dayjs(attorney.last_entry_date).format('MMM D')
        : 'unknown';

    const body = [
        `⚠️ Time Entry Reminder — ${firmName}`,
        `Attorney: ${attorney.attorney_name}`,
        `Last entry: ${lastDate} (${daysSince} days ago)`,
        `Reminder: Please log time entries for unbilled work.`,
    ].join('\n');

    return sendSMS(clientSlug, conn.managing_partner_phone, body, 'attorney_reminder');
}

// ─── sendWeeklySummary ────────────────────────────────────────────────────────

/**
 * Send the weekly billing performance summary to the managing partner.
 * Covers Mon–Fri of the current week.
 */
async function sendWeeklySummary(clientSlug) {
    const conn = await tracker.getConnection(clientSlug);
    if (!conn?.managing_partner_phone) {
        console.warn(`[Invoicing] No managing_partner_phone for ${clientSlug}`);
        return null;
    }

    const firmName = conn.firm_name || clientSlug;

    // Week window
    const weekEnd   = dayjs().format('YYYY-MM-DD');
    const weekStart = dayjs().subtract(6, 'day').format('YYYY-MM-DD');

    // Pull entries for the week
    const entries = await billingApi.getTimeEntries(clientSlug, weekStart, weekEnd);

    let hoursLogged = 0;
    let hoursBilled = 0;
    let totalBilled = 0;

    for (const e of entries) {
        const h = parseFloat(e.hours || 0);
        hoursLogged += h;
        if (e.billed) {
            hoursBilled += h;
            totalBilled += parseFloat(e.amount || 0);
        }
    }

    // Get drafted invoices this week
    const { data: drafts } = await supabase
        .from('invoice_drafts')
        .select('total_amount')
        .eq('client_slug', clientSlug)
        .gte('created_at', weekStart);

    const draftedTotal = (drafts || []).reduce((s, d) => s + parseFloat(d.total_amount || 0), 0);

    // Get realization rate for context
    const realizationData = await billingApi.getRealizationRate(clientSlug);
    const realizationPct  = Math.round(realizationData.realization_rate * 100);
    const collected       = realizationData.collected;
    const outstanding     = realizationData.billed - realizationData.collected;

    const weekLabel = `${dayjs(weekStart).format('MMM D')}–${dayjs(weekEnd).format('MMM D')}`;

    const body = [
        `📊 Weekly Billing Report — ${firmName}`,
        `Week of ${weekLabel}`,
        `Hours logged: ${Math.round(hoursLogged * 10) / 10} hrs`,
        `Hours billed: ${Math.round(hoursBilled * 10) / 10} hrs`,
        `Realization: ${realizationPct}%`,
        `Drafted invoices: $${Math.round(draftedTotal).toLocaleString()}`,
        `Collected: $${Math.round(collected).toLocaleString()}`,
        `Outstanding: $${Math.round(outstanding).toLocaleString()}`,
    ].join('\n');

    return sendSMS(clientSlug, conn.managing_partner_phone, body, 'weekly_summary');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    generateInvoiceDraft,
    formatInvoiceDetails,
    sendInvoiceDraftAlert,
    sendUnbilledFlagAlert,
    sendRetainerAlert,
    sendAttorneyReminder,
    sendWeeklySummary,
};
