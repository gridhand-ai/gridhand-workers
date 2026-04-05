/**
 * GRIDHAND Lease Renewal Agent — Nodemailer Email Module
 */

'use strict';

const nodemailer = require('nodemailer');
const db         = require('./db');

async function getTransporter(conn) {
    return nodemailer.createTransport({
        host:   conn.smtp_host || process.env.SMTP_HOST,
        port:   conn.smtp_port || parseInt(process.env.SMTP_PORT || '587'),
        secure: (conn.smtp_port || parseInt(process.env.SMTP_PORT || '587')) === 465,
        auth: {
            user: conn.smtp_user || process.env.SMTP_USER,
            pass: conn.smtp_pass || process.env.SMTP_PASS,
        },
    });
}

async function sendRenewalOffer(conn, renewal) {
    const transporter = await getTransporter(conn);
    const from        = conn.from_email || process.env.FROM_EMAIL || conn.smtp_user;
    const fmt         = n => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

    const address = `${renewal.property_address || 'your unit'}${renewal.unit_number ? ` Unit ${renewal.unit_number}` : ''}`;
    const daysLeft = Math.max(0, renewal.days_until_expiry || 60);

    const subject = `Lease Renewal Offer — ${address}`;
    const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <h2 style="color: #1a1a2e;">Lease Renewal Offer</h2>
  <p>Hi ${renewal.tenant_name},</p>
  <p>Your current lease at <strong>${address}</strong> expires on <strong>${renewal.lease_end_date}</strong> — that's ${daysLeft} days from now.</p>
  <p>We'd love to have you continue as a resident! Here is your renewal offer:</p>
  <table style="border-collapse: collapse; width: 100%; margin: 20px 0;">
    <tr style="background: #f5f5f5;">
      <td style="padding: 12px; border: 1px solid #ddd;"><strong>Current Rent</strong></td>
      <td style="padding: 12px; border: 1px solid #ddd;">${fmt(renewal.current_rent)}/month</td>
    </tr>
    <tr>
      <td style="padding: 12px; border: 1px solid #ddd;"><strong>New Rent</strong></td>
      <td style="padding: 12px; border: 1px solid #ddd; color: #2d6a4f;">${fmt(renewal.offered_rent)}/month</td>
    </tr>
    <tr style="background: #f5f5f5;">
      <td style="padding: 12px; border: 1px solid #ddd;"><strong>New Term</strong></td>
      <td style="padding: 12px; border: 1px solid #ddd;">${renewal.offered_term_months || 12} months</td>
    </tr>
    ${renewal.new_lease_start ? `
    <tr>
      <td style="padding: 12px; border: 1px solid #ddd;"><strong>New Lease Period</strong></td>
      <td style="padding: 12px; border: 1px solid #ddd;">${renewal.new_lease_start} to ${renewal.new_lease_end}</td>
    </tr>` : ''}
  </table>
  <p>Please reply to this email to accept, decline, or discuss the terms. A DocuSign document will be sent once you accept.</p>
  <p>Please respond within 14 days. If we don't hear from you, we'll follow up.</p>
  <br>
  <p>Thank you,<br><strong>${conn.business_name || 'Property Management'}</strong></p>
</div>`;

    const info = await transporter.sendMail({
        from,
        to:      renewal.tenant_email,
        subject,
        html,
        text: `Lease Renewal Offer for ${address}\n\nHi ${renewal.tenant_name},\n\nYour lease expires ${renewal.lease_end_date}. We're offering renewal at ${fmt(renewal.offered_rent)}/month for ${renewal.offered_term_months || 12} months.\n\nPlease reply to accept or discuss. — ${conn.business_name || 'Property Management'}`,
    });

    return { messageId: info.messageId, subject };
}

async function sendOwnerRenewalSummary(conn, { expiringCount, offersSent, signed, pending }) {
    if (!conn.owner_email) return;

    const transporter = await getTransporter(conn);
    const from        = conn.from_email || conn.smtp_user;

    await transporter.sendMail({
        from,
        to:      conn.owner_email,
        subject: `Weekly Lease Renewal Pipeline — ${conn.business_name || 'Property'}`,
        text: [
            `Lease Renewal Summary`,
            ``,
            `Expiring in 60 days: ${expiringCount}`,
            `Offers sent:         ${offersSent}`,
            `Signed/Completed:    ${signed}`,
            `Awaiting response:   ${pending}`,
        ].join('\n'),
    });
}

module.exports = { sendRenewalOffer, sendOwnerRenewalSummary };
