/**
 * GRIDHAND Lease Renewal Agent — DocuSign Integration
 *
 * Sends lease renewal documents for e-signature via DocuSign eSign API.
 * Uses OAuth JWT or Authorization Code flow.
 * Docs: https://developers.docusign.com/
 */

'use strict';

const axios = require('axios');
const db    = require('./db');

const DS_BASE     = 'https://na4.docusign.net/restapi/v2.1';
const DS_AUTH_URL = 'https://account.docusign.com/oauth/auth';
const DS_TOKEN    = 'https://account.docusign.com/oauth/token';

// ─── OAuth ────────────────────────────────────────────────────────────────────

function getAuthorizationUrl(state) {
    const params = new URLSearchParams({
        response_type: 'code',
        scope:         'signature impersonation',
        client_id:     process.env.DOCUSIGN_CLIENT_ID,
        redirect_uri:  process.env.DOCUSIGN_REDIRECT_URI,
        state,
    });
    return `${DS_AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(clientSlug, { code, accountId }) {
    const creds = Buffer.from(`${process.env.DOCUSIGN_CLIENT_ID}:${process.env.DOCUSIGN_CLIENT_SECRET}`).toString('base64');

    const resp = await axios.post(DS_TOKEN,
        `grant_type=authorization_code&code=${encodeURIComponent(code)}`,
        { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = resp.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    await db.updateDocuSignTokens(clientSlug, {
        accessToken:  access_token,
        refreshToken: refresh_token,
        expiresAt,
    });

    if (accountId) {
        await db.upsertConnection({ client_slug: clientSlug, docusign_account_id: accountId });
    }

    return access_token;
}

async function refreshDSToken(clientSlug) {
    const conn  = await db.getConnection(clientSlug);
    const creds = Buffer.from(`${process.env.DOCUSIGN_CLIENT_ID}:${process.env.DOCUSIGN_CLIENT_SECRET}`).toString('base64');

    const resp = await axios.post(DS_TOKEN,
        `grant_type=refresh_token&refresh_token=${encodeURIComponent(conn.docusign_refresh_token)}`,
        { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = resp.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
    await db.updateDocuSignTokens(clientSlug, { accessToken: access_token, refreshToken: refresh_token, expiresAt });
    return access_token;
}

async function getValidToken(clientSlug) {
    const conn = await db.getConnection(clientSlug);
    if (!conn?.docusign_access_token) throw new Error(`No DocuSign connection for ${clientSlug}`);
    if (Date.now() < new Date(conn.docusign_expires_at).getTime() - 60000) return conn.docusign_access_token;
    return refreshDSToken(clientSlug);
}

// ─── Send Envelope ────────────────────────────────────────────────────────────

/**
 * Send a lease renewal document via DocuSign envelope.
 * Uses a pre-configured template in DocuSign.
 *
 * @returns {string} envelopeId
 */
async function sendLeaseRenewalEnvelope(clientSlug, { renewal, templateId }) {
    const token = await getValidToken(clientSlug);
    const conn  = await db.getConnection(clientSlug);
    const accountId = conn.docusign_account_id;

    if (!accountId) throw new Error('DocuSign account ID not configured');
    if (!templateId && !conn.docusign_template_id) throw new Error('DocuSign template ID not configured');

    const tid = templateId || conn.docusign_template_id;

    const fmt = n => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

    const envelope = {
        templateId: tid,
        status:     'sent',
        templateRoles: [{
            roleName:    'Tenant',
            name:        renewal.tenant_name,
            email:       renewal.tenant_email,
            tabs: {
                textTabs: [
                    { tabLabel: 'current_rent',   value: fmt(renewal.current_rent) },
                    { tabLabel: 'offered_rent',   value: fmt(renewal.offered_rent) },
                    { tabLabel: 'lease_end',      value: renewal.lease_end_date },
                    { tabLabel: 'new_lease_start', value: renewal.new_lease_start || '' },
                    { tabLabel: 'new_lease_end',   value: renewal.new_lease_end || '' },
                    { tabLabel: 'property',        value: `${renewal.property_address || ''}${renewal.unit_number ? ` Unit ${renewal.unit_number}` : ''}` },
                ],
            },
        }],
        emailSubject: `Lease Renewal — ${renewal.property_address || 'Your Unit'}`,
        emailBlurb:   `Please review and sign your lease renewal document. Current rent: ${fmt(renewal.current_rent)} → New rent: ${fmt(renewal.offered_rent)}.`,
    };

    const resp = await axios.post(
        `${DS_BASE}/accounts/${accountId}/envelopes`,
        envelope,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    return resp.data?.envelopeId || null;
}

/**
 * Check status of a DocuSign envelope.
 */
async function getEnvelopeStatus(clientSlug, envelopeId) {
    const token     = await getValidToken(clientSlug);
    const conn      = await db.getConnection(clientSlug);
    const accountId = conn.docusign_account_id;

    const resp = await axios.get(
        `${DS_BASE}/accounts/${accountId}/envelopes/${envelopeId}`,
        { headers: { Authorization: `Bearer ${token}` } }
    );

    return {
        status:    resp.data?.status,       // sent | delivered | completed | declined | voided
        completedAt: resp.data?.completedDateTime || null,
    };
}

module.exports = {
    getAuthorizationUrl,
    exchangeCode,
    sendLeaseRenewalEnvelope,
    getEnvelopeStatus,
};
