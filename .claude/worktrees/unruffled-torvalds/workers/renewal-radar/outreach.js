// ============================================================
// Client & Agent Outreach — Renewal Radar
// Handles all communication: SMS via Twilio, email via Nodemailer
//
// Env vars:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM
// ============================================================

'use strict';

const twilio     = require('twilio');
const nodemailer = require('nodemailer');

// ─── Twilio Setup ─────────────────────────────────────────────

function getTwilioClient(config = {}) {
    const sid   = config.twilio?.accountSid || process.env.TWILIO_ACCOUNT_SID;
    const token = config.twilio?.authToken  || process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error('[Outreach] Twilio credentials missing');
    return twilio(sid, token);
}

function getTwilioFrom(config = {}) {
    return config.twilio?.fromNumber || process.env.TWILIO_FROM_NUMBER;
}

// ─── SMTP Setup ──────────────────────────────────────────────

function getMailTransport(config = {}) {
    return nodemailer.createTransport({
        host: config.smtp?.host || process.env.SMTP_HOST,
        port: config.smtp?.port || process.env.SMTP_PORT || 587,
        secure: false,
        auth: {
            user: config.smtp?.user || process.env.SMTP_USER,
            pass: config.smtp?.pass || process.env.SMTP_PASS,
        },
    });
}

function getEmailFrom(config = {}) {
    return config.smtp?.from || process.env.EMAIL_FROM || 'renewals@gridhand.ai';
}

// ─── SMS Templates ────────────────────────────────────────────

const SMS_TEMPLATES = {
    // 60 days out — friendly early heads-up
    renewal_60_days: (data) =>
        `Hi ${data.firstName}! Just a heads-up — your ${data.lob} policy with ${data.carrier} renews on ${formatDate(data.renewalDate)}. We're already shopping rates for you. Reply RATES to see your options. — ${data.agencyName}`,

    // 30 days out — comparison ready
    renewal_30_days_with_savings: (data) =>
        `${data.firstName}, your policy renews in 30 days ($${formatPremium(data.currentPremium)}/yr). We found a better rate — ${data.bestCarrier} at $${formatPremium(data.bestPremium)}/yr, saving you $${formatPremium(data.savings)}/yr. Want details? Reply YES. — ${data.agencyName}`,

    renewal_30_days_no_savings: (data) =>
        `${data.firstName}, your ${data.carrier} policy renews ${formatDate(data.renewalDate)}. We compared rates — your current plan is competitive. Reply REVIEW to confirm renewal or ask questions. — ${data.agencyName}`,

    // 15 days out — urgency
    renewal_15_days: (data) =>
        `${data.firstName} — 15 days until your policy expires (${formatDate(data.renewalDate)}). Don't let coverage lapse. Reply RENEW to confirm, or call ${data.agencyPhone}. — ${data.agencyName}`,

    // 7 days — final notice
    renewal_7_days: (data) =>
        `FINAL NOTICE: Your ${data.carrier} policy expires in 7 days. Reply RENEW now or call ${data.agencyPhone} immediately to avoid a lapse. — ${data.agencyName}`,

    // Agent alert
    agent_alert: (data) =>
        `[Renewal Radar] ${data.policyNumber} — ${data.insuredName}\nRenews: ${formatDate(data.renewalDate)} (${data.daysLeft} days)\nCurrent: ${data.carrier} $${formatPremium(data.currentPremium)}/yr\n${data.bestCarrier ? `Best option: ${data.bestCarrier} $${formatPremium(data.bestPremium)}/yr (save $${formatPremium(data.savings)}/yr)` : 'Running quote comparison...'}\nStage: ${data.stage}`,

    // Agent weekly pipeline report
    agent_weekly_summary: (data) =>
        `[Renewal Radar] Weekly Pipeline — ${data.weekOf}\n${data.totalPolicies} renewals in 60 days\nAt-risk premium: $${formatPremium(data.totalPremium)}/yr\nTop renewal:\n• ${data.topPolicy.insuredName} — ${data.topPolicy.carrier} $${formatPremium(data.topPolicy.premium)}/yr (${data.topPolicy.daysLeft} days)\nSee full report: ${data.reportUrl}`,
};

// ─── Email Templates ─────────────────────────────────────────

function buildRenewalComparisonEmail(data) {
    const { policy, comparison, agencyName, agencyPhone, agencyEmail } = data;
    const topQuotes = (comparison.quotes || []).slice(0, 5);

    const tableRows = topQuotes.map(q => {
        const diff = policy.annualPremium - q.annualPremium;
        const diffText = diff > 0
            ? `<span style="color:#16a34a">Save $${Math.abs(diff).toFixed(2)}/yr</span>`
            : `<span style="color:#dc2626">+$${Math.abs(diff).toFixed(2)}/yr</span>`;
        return `
            <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${q.carrier}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">$${q.annualPremium.toFixed(2)}/yr</td>
                <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">$${(q.annualPremium / 12).toFixed(2)}/mo</td>
                <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${diffText}</td>
            </tr>`;
    }).join('');

    const subject = comparison.hasBetterRate
        ? `We found a better rate — save $${comparison.savingsPotential.toFixed(2)}/yr on your ${policy.lineOfBusiness} policy`
        : `Your ${policy.lineOfBusiness} policy renews ${formatDate(policy.expirationDate)} — rate comparison inside`;

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>${subject}</title>
    </head>
    <body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif">
      <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">

        <!-- Header -->
        <div style="background:#0f172a;padding:24px 32px">
          <p style="margin:0;color:#22d3ee;font-size:12px;letter-spacing:2px;text-transform:uppercase">GRIDHAND · ${agencyName}</p>
          <h1 style="margin:8px 0 0;color:#fff;font-size:22px">Your Policy Renewal Report</h1>
        </div>

        <!-- Body -->
        <div style="padding:32px">
          <p style="color:#374151;line-height:1.6">Hi ${policy.insuredName?.split(' ')[0] || 'there'},</p>
          <p style="color:#374151;line-height:1.6">
            Your <strong>${policy.lineOfBusiness}</strong> policy with <strong>${policy.carrier}</strong>
            renews on <strong>${formatDate(policy.expirationDate)}</strong>.
            We ran a full rate comparison across ${topQuotes.length + 1} carriers so you have options before renewal.
          </p>

          <!-- Current Policy Box -->
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:16px;margin:24px 0">
            <p style="margin:0 0 8px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1px">Current Policy</p>
            <p style="margin:0;font-size:18px;font-weight:bold;color:#111827">
              ${policy.carrier} — $${policy.annualPremium.toFixed(2)}/yr ($${(policy.annualPremium / 12).toFixed(2)}/mo)
            </p>
            <p style="margin:4px 0 0;color:#6b7280;font-size:14px">Policy #${policy.policyNumber}</p>
          </div>

          ${comparison.hasBetterRate ? `
          <!-- Savings Banner -->
          <div style="background:#dcfce7;border:1px solid #86efac;border-radius:6px;padding:16px;margin-bottom:24px">
            <p style="margin:0;color:#166534;font-weight:bold">
              ✓ We found a better rate — switch to ${comparison.bestQuote?.carrier} and save $${comparison.savingsPotential.toFixed(2)}/yr
            </p>
          </div>` : `
          <!-- No Better Rate Banner -->
          <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:16px;margin-bottom:24px">
            <p style="margin:0;color:#1e40af">Your current rate is competitive. We still recommend confirming your renewal to avoid any lapse.</p>
          </div>`}

          <!-- Quote Table -->
          <h3 style="color:#111827;margin:0 0 12px">Rate Comparison</h3>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <thead>
              <tr style="background:#f9fafb">
                <th style="padding:10px 12px;text-align:left;color:#6b7280;font-weight:600;border-bottom:2px solid #e5e7eb">Carrier</th>
                <th style="padding:10px 12px;text-align:left;color:#6b7280;font-weight:600;border-bottom:2px solid #e5e7eb">Annual</th>
                <th style="padding:10px 12px;text-align:left;color:#6b7280;font-weight:600;border-bottom:2px solid #e5e7eb">Monthly</th>
                <th style="padding:10px 12px;text-align:left;color:#6b7280;font-weight:600;border-bottom:2px solid #e5e7eb">vs. Current</th>
              </tr>
            </thead>
            <tbody>
              ${tableRows}
            </tbody>
          </table>

          <!-- CTA -->
          <div style="margin:32px 0;text-align:center">
            <p style="color:#374151;margin-bottom:16px">Ready to lock in the best rate? Call or reply to this email.</p>
            <a href="tel:${agencyPhone}" style="display:inline-block;background:#22d3ee;color:#0f172a;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:bold;margin-right:8px">
              Call Us: ${agencyPhone}
            </a>
            <a href="mailto:${agencyEmail}" style="display:inline-block;background:#f1f5f9;color:#334155;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:bold">
              Reply by Email
            </a>
          </div>

          <p style="color:#9ca3af;font-size:12px;line-height:1.5">
            Quotes are estimates based on current coverage. Final rates are subject to underwriting.
            Policy number: ${policy.policyNumber}. Coverage must not lapse — your renewal deadline is ${formatDate(policy.expirationDate)}.
          </p>
        </div>

        <!-- Footer -->
        <div style="background:#f9fafb;padding:20px 32px;border-top:1px solid #e5e7eb">
          <p style="margin:0;color:#6b7280;font-size:12px">${agencyName} · Powered by GRIDHAND AI</p>
          <p style="margin:4px 0 0;color:#9ca3af;font-size:11px">To opt out of renewal reminders, reply STOP to any text or email us at ${agencyEmail}</p>
        </div>
      </div>
    </body>
    </html>`;

    return { subject, html };
}

function buildWeeklyAgentReportEmail(data) {
    const { clientSlug, reportDate, pipeline, stats } = data;
    const agencyName = data.agencyName || clientSlug;

    const pipelineRows = pipeline.slice(0, 20).map(r => `
        <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px">${r.insuredName}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px">${r.carrier}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px">${formatDate(r.renewalDate)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px;font-weight:bold">$${formatPremium(r.currentPremium)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px">${r.stage}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px;color:${r.hasBetterRate ? '#16a34a' : '#6b7280'}">${r.hasBetterRate ? `Save $${formatPremium(r.savings)}` : '—'}</td>
        </tr>`).join('');

    const subject = `[Renewal Radar] Weekly Pipeline — ${pipeline.length} renewals, $${formatPremium(stats.totalPremium)} at risk`;

    const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>${subject}</title></head>
    <body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif">
      <div style="max-width:700px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">

        <div style="background:#0f172a;padding:24px 32px">
          <p style="margin:0;color:#4ade80;font-size:11px;letter-spacing:2px;text-transform:uppercase">GRIDHAND RENEWAL RADAR</p>
          <h1 style="margin:8px 0 0;color:#fff;font-size:20px">Weekly Pipeline Report</h1>
          <p style="margin:4px 0 0;color:#94a3b8;font-size:13px">Week of ${reportDate} · ${agencyName}</p>
        </div>

        <div style="padding:32px">

          <!-- Stats Row -->
          <div style="display:flex;gap:16px;margin-bottom:32px">
            ${[
              { label: 'Renewals in 60 Days', value: pipeline.length },
              { label: 'Premium at Risk', value: `$${formatPremium(stats.totalPremium)}` },
              { label: 'Retention Rate (YTD)', value: `${stats.retentionRate || '—'}%` },
              { label: 'Savings Found', value: `$${formatPremium(stats.totalSavings)}` },
            ].map(s => `
              <div style="flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:16px;text-align:center">
                <p style="margin:0 0 4px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px">${s.label}</p>
                <p style="margin:0;font-size:20px;font-weight:bold;color:#111827">${s.value}</p>
              </div>`).join('')}
          </div>

          <!-- Pipeline Table -->
          <h3 style="color:#111827;margin:0 0 12px">Upcoming Renewals (sorted by premium)</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="background:#f9fafb">
                <th style="padding:10px 12px;text-align:left;color:#6b7280;border-bottom:2px solid #e5e7eb">Insured</th>
                <th style="padding:10px 12px;text-align:left;color:#6b7280;border-bottom:2px solid #e5e7eb">Carrier</th>
                <th style="padding:10px 12px;text-align:left;color:#6b7280;border-bottom:2px solid #e5e7eb">Renews</th>
                <th style="padding:10px 12px;text-align:left;color:#6b7280;border-bottom:2px solid #e5e7eb">Premium</th>
                <th style="padding:10px 12px;text-align:left;color:#6b7280;border-bottom:2px solid #e5e7eb">Stage</th>
                <th style="padding:10px 12px;text-align:left;color:#6b7280;border-bottom:2px solid #e5e7eb">Opportunity</th>
              </tr>
            </thead>
            <tbody>${pipelineRows}</tbody>
          </table>
          ${pipeline.length > 20 ? `<p style="color:#6b7280;font-size:12px;margin-top:8px">Showing top 20 of ${pipeline.length} renewals.</p>` : ''}
        </div>

        <div style="background:#f9fafb;padding:20px 32px;border-top:1px solid #e5e7eb">
          <p style="margin:0;color:#9ca3af;font-size:11px">Generated by GRIDHAND Renewal Radar · ${agencyName}</p>
        </div>
      </div>
    </body>
    </html>`;

    return { subject, html };
}

// ─── Send Functions ───────────────────────────────────────────

/**
 * Send an SMS using a named template.
 */
async function sendSMS({ config = {}, to, template, data, body = null }) {
    const client = getTwilioClient(config);
    const from   = getTwilioFrom(config);
    const text   = body || (SMS_TEMPLATES[template] ? SMS_TEMPLATES[template](data) : null);

    if (!text) throw new Error(`[Outreach] Unknown SMS template: ${template}`);
    if (!to)   throw new Error('[Outreach] Missing recipient phone number');

    const msg = await client.messages.create({ from, to, body: text });
    console.log(`[Outreach] SMS sent to ${to} (template: ${template || 'custom'}) — SID: ${msg.sid}`);
    return { sid: msg.sid, to, body: text, channel: 'sms' };
}

/**
 * Send a renewal comparison email to the insured.
 */
async function sendRenewalEmail({ config = {}, to, toName, policy, comparison, agencyName, agencyPhone, agencyEmail }) {
    const transport = getMailTransport(config);
    const from      = getEmailFrom(config);
    const { subject, html } = buildRenewalComparisonEmail({
        policy, comparison, agencyName, agencyPhone, agencyEmail
    });

    const info = await transport.sendMail({ from, to, subject, html });
    console.log(`[Outreach] Renewal email sent to ${to} — MsgID: ${info.messageId}`);
    return { messageId: info.messageId, to, subject, channel: 'email' };
}

/**
 * Send weekly pipeline report email to agent.
 */
async function sendWeeklyReportEmail({ config = {}, to, clientSlug, reportDate, pipeline, stats, agencyName }) {
    const transport = getMailTransport(config);
    const from      = getEmailFrom(config);
    const { subject, html } = buildWeeklyAgentReportEmail({ clientSlug, reportDate, pipeline, stats, agencyName });

    const info = await transport.sendMail({ from, to, subject, html });
    console.log(`[Outreach] Weekly report sent to ${to} — MsgID: ${info.messageId}`);
    return { messageId: info.messageId, to, subject, channel: 'email' };
}

/**
 * Send agent alert SMS when a renewal needs attention.
 */
async function sendAgentAlert({ config = {}, agentPhone, renewalData }) {
    return sendSMS({
        config,
        to:       agentPhone,
        template: 'agent_alert',
        data:     renewalData,
    });
}

/**
 * Determine which SMS template to use based on days until renewal.
 */
function selectClientTemplate(daysLeft, hasSavings) {
    if (daysLeft >= 50) return 'renewal_60_days';
    if (daysLeft >= 20) return hasSavings ? 'renewal_30_days_with_savings' : 'renewal_30_days_no_savings';
    if (daysLeft >= 10) return 'renewal_15_days';
    return 'renewal_7_days';
}

// ─── Helpers ─────────────────────────────────────────────────

function formatDate(dateStr) {
    if (!dateStr) return 'Unknown';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatPremium(val) {
    if (!val && val !== 0) return '—';
    return parseFloat(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = {
    sendSMS,
    sendRenewalEmail,
    sendWeeklyReportEmail,
    sendAgentAlert,
    selectClientTemplate,
    SMS_TEMPLATES,
    buildRenewalComparisonEmail,
    buildWeeklyAgentReportEmail,
};
