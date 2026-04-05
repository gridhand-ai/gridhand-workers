/**
 * GRIDHAND Doc Chaser — Email Module (Nodemailer)
 *
 * Sends escalating document reminder emails to tax clients
 * and weekly outstanding-document reports to the firm owner.
 *
 * All outbound messages are logged to dc_reminders via db.logReminder.
 */

'use strict';

const nodemailer = require('nodemailer');
const dayjs      = require('dayjs');
const db         = require('./db');

// ─── Transporter Factory ──────────────────────────────────────────────────────

/**
 * Build a Nodemailer transporter from conn row credentials or env vars.
 */
function getTransporter(conn) {
    const host = conn?.email_host || process.env.EMAIL_HOST;
    const port = conn?.email_port || parseInt(process.env.EMAIL_PORT || '587');
    const user = conn?.email_user || process.env.EMAIL_USER;
    const pass = conn?.email_pass || process.env.EMAIL_PASS;

    if (!host || !user || !pass) {
        throw new Error('Email credentials not configured (email_host, email_user, email_pass)');
    }

    return nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
    });
}

function getFromAddress(conn) {
    return conn?.email_from || process.env.EMAIL_FROM || conn?.email_user || process.env.EMAIL_USER;
}

// ─── Document Reminder Email ──────────────────────────────────────────────────

/**
 * Send an escalating document reminder email to a tax client.
 *
 * @param {object} conn         - dc_clients row
 * @param {object} request      - dc_document_requests row
 * @param {number} reminderCount - 0-based count of prior reminders
 */
async function sendDocumentReminderEmail(conn, request, reminderCount) {
    if (!request.client_email) {
        console.warn(`[Email] No email for request ${request.id} (${request.client_name}) — skipping`);
        return { ok: false, error: 'No email address on file' };
    }

    const firmName   = conn.firm_name || 'Your accounting firm';
    const firstName  = request.client_name.split(' ')[0] || request.client_name;
    const docName    = request.document_name;
    const dueDate    = request.due_date ? dayjs(request.due_date).format('MMMM D, YYYY') : null;
    const dueLine    = dueDate ? `<p><strong>Deadline:</strong> ${dueDate}</p>` : '';
    const urgentTag  = reminderCount >= 2 ? 'URGENT: ' : '';

    let subject;
    let intro;
    let urgencyColor;

    if (reminderCount === 0) {
        subject       = `Action Required: ${docName} needed for your tax return`;
        intro         = `We hope this message finds you well. To complete your tax return, we need you to upload the document listed below at your earliest convenience.`;
        urgencyColor  = '#22d3ee';
    } else if (reminderCount === 1) {
        subject       = `Reminder: ${docName} still outstanding — ${firmName}`;
        intro         = `This is a friendly reminder that we are still waiting on the document below. Filing cannot proceed until it is received.`;
        urgencyColor  = '#fb923c';
    } else {
        subject       = `URGENT: Filing cannot proceed without ${docName}`;
        intro         = `We have reached out several times regarding this outstanding document. We cannot file your return until it is uploaded. Please act today to avoid delays or penalties.`;
        urgencyColor  = '#f472b6';
    }

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${urgentTag}${docName} — ${firmName}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:${urgencyColor};padding:24px 32px;">
              <p style="margin:0;color:#ffffff;font-size:13px;letter-spacing:1px;text-transform:uppercase;">${firmName}</p>
              <h1 style="margin:8px 0 0;color:#ffffff;font-size:22px;font-weight:700;">${urgentTag}Document Required</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px;color:#3f3f46;font-size:15px;">Hi ${firstName},</p>
              <p style="margin:0 0 24px;color:#3f3f46;font-size:15px;line-height:1.6;">${intro}</p>

              <!-- Document Card -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f8f9;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:24px;">
                <tr>
                  <td style="padding:20px;">
                    <p style="margin:0 0 4px;color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Document Needed</p>
                    <p style="margin:0 0 12px;color:#09090b;font-size:18px;font-weight:700;">${docName}</p>
                    ${request.document_type ? `<p style="margin:0 0 8px;color:#52525b;font-size:14px;">Type: ${request.document_type}</p>` : ''}
                    ${dueLine}
                  </td>
                </tr>
              </table>

              <!-- CTA -->
              <table cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                  <td style="background:${urgencyColor};border-radius:6px;padding:14px 28px;">
                    <a href="#" style="color:#09090b;font-weight:700;font-size:15px;text-decoration:none;">Upload to Client Portal</a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 8px;color:#71717a;font-size:14px;">If you have any questions or need help uploading, please don't hesitate to contact us.</p>
              <p style="margin:0;color:#71717a;font-size:14px;">Thank you for your prompt attention to this matter.</p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#fafafa;border-top:1px solid #e4e4e7;padding:20px 32px;">
              <p style="margin:0;color:#a1a1aa;font-size:12px;text-align:center;">${firmName} · Powered by GRIDHAND AI</p>
              <p style="margin:4px 0 0;color:#a1a1aa;font-size:12px;text-align:center;">To stop receiving these reminders, please contact your firm directly.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

    const transporter = getTransporter(conn);
    const from        = getFromAddress(conn);

    try {
        await transporter.sendMail({
            from,
            to:      request.client_email,
            subject,
            html,
            text: `${urgentTag}${docName} is needed by ${firmName} to proceed with your tax return. ${dueDate ? `Deadline: ${dueDate}.` : ''} Please upload it at your client portal or contact us for help.`,
        });

        console.log(`[Email] Reminder ${reminderCount + 1} → ${request.client_email} for "${docName}" (${request.client_name})`);

        await db.logReminder(conn.id, {
            requestId:  request.id,
            channel:    'email',
            recipient:  request.client_email,
            subject,
            body:       html,
            status:     'sent',
        });

        return { ok: true, subject };
    } catch (err) {
        console.error(`[Email] Failed to send reminder for request ${request.id}: ${err.message}`);

        await db.logReminder(conn.id, {
            requestId:    request.id,
            channel:      'email',
            recipient:    request.client_email,
            subject,
            body:         html,
            status:       'failed',
            errorMessage: err.message,
        });

        return { ok: false, error: err.message };
    }
}

// ─── Weekly Outstanding Report Email (Firm Owner) ─────────────────────────────

/**
 * Send a detailed weekly outstanding-document report to the firm owner.
 *
 * @param {object} conn       - dc_clients row (has email_from as the owner's address too)
 * @param {object} reportData - {
 *   totalRequests, receivedCount, pendingCount, overdueCount,
 *   outstandingItems: [{ clientName, documentName, dueDate, reminderCount }]
 * }
 */
async function sendWeeklyOutstandingReport(conn, reportData) {
    const ownerEmail = conn.email_from || conn.email_user || process.env.EMAIL_FROM || process.env.EMAIL_USER;

    if (!ownerEmail) {
        console.warn(`[Email] No owner email configured for ${conn.client_slug} — skipping weekly report`);
        return { ok: false, error: 'No owner email configured' };
    }

    const firmName = conn.firm_name || 'Your firm';
    const { totalRequests, receivedCount, pendingCount, overdueCount, outstandingItems = [] } = reportData;
    const reportDate = dayjs().format('MMMM D, YYYY');

    const itemRows = outstandingItems.map(item => {
        const due     = item.dueDate ? dayjs(item.dueDate).format('MMM D') : '—';
        const remSent = item.reminderCount || 0;
        const badgeColor = item.status === 'overdue' ? '#f472b6' : '#fb923c';
        const badgeText  = item.status === 'overdue' ? 'OVERDUE' : 'PENDING';
        return `
          <tr>
            <td style="padding:10px 12px;border-bottom:1px solid #e4e4e7;color:#09090b;font-size:14px;">${item.clientName}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e4e4e7;color:#3f3f46;font-size:14px;">${item.documentName}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e4e4e7;color:#71717a;font-size:13px;text-align:center;">${due}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e4e4e7;text-align:center;">
              <span style="background:${badgeColor};color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;">${badgeText}</span>
            </td>
            <td style="padding:10px 12px;border-bottom:1px solid #e4e4e7;color:#71717a;font-size:13px;text-align:center;">${remSent}</td>
          </tr>`;
    }).join('');

    const subject = `${firmName} — Weekly Outstanding Documents Report (${reportDate})`;

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Weekly Outstanding Docs — ${firmName}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="700" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:#09090b;padding:24px 32px;">
              <p style="margin:0;color:#a1a1aa;font-size:12px;letter-spacing:1px;text-transform:uppercase;">${firmName} — GRIDHAND Doc Chaser</p>
              <h1 style="margin:8px 0 0;color:#ffffff;font-size:22px;font-weight:700;">Weekly Outstanding Documents</h1>
              <p style="margin:6px 0 0;color:#71717a;font-size:14px;">${reportDate}</p>
            </td>
          </tr>

          <!-- Stats Row -->
          <tr>
            <td style="padding:24px 32px;background:#fafafa;border-bottom:1px solid #e4e4e7;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding:0 8px;">
                    <p style="margin:0;color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Total</p>
                    <p style="margin:4px 0 0;color:#09090b;font-size:28px;font-weight:700;">${totalRequests}</p>
                  </td>
                  <td align="center" style="padding:0 8px;">
                    <p style="margin:0;color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Received</p>
                    <p style="margin:4px 0 0;color:#4ade80;font-size:28px;font-weight:700;">${receivedCount}</p>
                  </td>
                  <td align="center" style="padding:0 8px;">
                    <p style="margin:0;color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Pending</p>
                    <p style="margin:4px 0 0;color:#fb923c;font-size:28px;font-weight:700;">${pendingCount}</p>
                  </td>
                  <td align="center" style="padding:0 8px;">
                    <p style="margin:0;color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Overdue</p>
                    <p style="margin:4px 0 0;color:#f472b6;font-size:28px;font-weight:700;">${overdueCount}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Outstanding Items Table -->
          <tr>
            <td style="padding:24px 32px;">
              ${outstandingItems.length > 0 ? `
              <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e4e7;border-radius:6px;overflow:hidden;">
                <thead>
                  <tr style="background:#f4f4f5;">
                    <th style="padding:10px 12px;text-align:left;color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Client</th>
                    <th style="padding:10px 12px;text-align:left;color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Document</th>
                    <th style="padding:10px 12px;text-align:center;color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Due</th>
                    <th style="padding:10px 12px;text-align:center;color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Status</th>
                    <th style="padding:10px 12px;text-align:center;color:#71717a;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Reminders Sent</th>
                  </tr>
                </thead>
                <tbody>${itemRows}</tbody>
              </table>` : `<p style="color:#71717a;text-align:center;font-size:15px;">All documents received. No outstanding items.</p>`}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#fafafa;border-top:1px solid #e4e4e7;padding:20px 32px;">
              <p style="margin:0;color:#a1a1aa;font-size:12px;text-align:center;">${firmName} · Powered by GRIDHAND AI Doc Chaser</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

    const transporter = getTransporter(conn);
    const from        = getFromAddress(conn);

    try {
        await transporter.sendMail({
            from,
            to:      ownerEmail,
            subject,
            html,
            text: `${firmName} Weekly Outstanding Docs (${reportDate}): ${totalRequests} total — ${receivedCount} received, ${pendingCount} pending, ${overdueCount} overdue.`,
        });

        console.log(`[Email] Weekly report → ${ownerEmail} for ${conn.client_slug}`);
        return { ok: true, subject };
    } catch (err) {
        console.error(`[Email] Failed to send weekly report for ${conn.client_slug}: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    getTransporter,
    sendDocumentReminderEmail,
    sendWeeklyOutstandingReport,
};
