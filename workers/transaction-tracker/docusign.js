/**
 * GRIDHAND Transaction Tracker — DocuSign Integration
 *
 * Handles all communication with the DocuSign eSignature API v2.1.
 * JWT auth token is stored per-client in tt_clients settings.
 * Supports both sandbox (demo) and production base URLs.
 * All functions return { ok, data, error } format.
 */

'use strict';

const axios  = require('axios');
const crypto = require('crypto');
const db     = require('./db');

// ─── Core Request Handler ─────────────────────────────────────────────────────

/**
 * Make an authenticated request to the DocuSign eSignature API.
 * Base URL and access token are read from client settings per call.
 */
async function docusignRequest(clientSlug, method, path, data = null) {
    const settings = await db.getClientSettings(clientSlug);
    if (!settings || !settings.docusign_access_token) {
        return { ok: false, data: null, error: `No DocuSign token configured for ${clientSlug}` };
    }
    if (!settings.docusign_account_id) {
        return { ok: false, data: null, error: `No DocuSign account ID configured for ${clientSlug}` };
    }

    const baseUrl = settings.docusign_base_url || 'https://demo.docusign.net/restapi/v2.1';
    const url     = `${baseUrl}/accounts/${settings.docusign_account_id}${path}`;

    try {
        const response = await axios({
            method,
            url,
            data:    data || undefined,
            headers: {
                Authorization:  `Bearer ${settings.docusign_access_token}`,
                'Content-Type': 'application/json',
                Accept:         'application/json',
            },
            timeout: 15000,
        });

        return { ok: true, data: response.data, error: null };
    } catch (err) {
        const status  = err.response?.status;
        const message = err.response?.data?.message || err.message;
        console.error(`[DocuSign] ${method} ${path} failed (${status}): ${message}`);
        return { ok: false, data: null, error: message };
    }
}

// ─── Envelope Operations ──────────────────────────────────────────────────────

/**
 * Get envelope status and full details.
 */
async function getEnvelope(clientSlug, envelopeId) {
    return docusignRequest(clientSlug, 'GET', `/envelopes/${envelopeId}`);
}

/**
 * List all documents in an envelope.
 */
async function getEnvelopeDocuments(clientSlug, envelopeId) {
    return docusignRequest(clientSlug, 'GET', `/envelopes/${envelopeId}/documents`);
}

/**
 * Get all recipients and their signing statuses.
 */
async function getEnvelopeRecipients(clientSlug, envelopeId) {
    return docusignRequest(clientSlug, 'GET', `/envelopes/${envelopeId}/recipients`);
}

/**
 * List envelopes created or modified since a given date.
 * @param {string} fromDate — ISO date string, e.g. '2024-01-01'
 */
async function listEnvelopes(clientSlug, fromDate) {
    const from  = fromDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const query = `?from_date=${encodeURIComponent(from)}&status=sent,delivered,completed,declined,voided`;
    return docusignRequest(clientSlug, 'GET', `/envelopes${query}`);
}

/**
 * Void an envelope with a reason message.
 */
async function voidEnvelope(clientSlug, envelopeId, reason) {
    return docusignRequest(clientSlug, 'PUT', `/envelopes/${envelopeId}`, {
        status:       'voided',
        voidedReason: reason || 'Voided by Transaction Tracker',
    });
}

// ─── Webhook Signature Verification ──────────────────────────────────────────

/**
 * Verify DocuSign Connect webhook signature.
 * DocuSign can use HMAC-SHA256 (X-DocuSign-Signature-1 header).
 * @param {string|Buffer} body — raw request body
 * @param {string} sig — value of X-DocuSign-Signature-1 header
 * @param {string} key — HMAC key from DocuSign Connect configuration
 */
function verifyWebhookSignature(body, sig, key) {
    if (!key || !sig) return false;

    try {
        const rawBody  = typeof body === 'string' ? body : body.toString('utf8');
        const expected = crypto
            .createHmac('sha256', key)
            .update(rawBody)
            .digest('base64');

        const expectedBuf = Buffer.from(expected, 'base64');
        const sigBuf      = Buffer.from(sig, 'base64');

        if (expectedBuf.length !== sigBuf.length) return false;
        return crypto.timingSafeEqual(expectedBuf, sigBuf);
    } catch (err) {
        console.error('[DocuSign] Signature verification error:', err.message);
        return false;
    }
}

// ─── Status Normalization ─────────────────────────────────────────────────────

/**
 * Normalize a DocuSign envelope response to a clean internal format.
 * Returns { envelopeId, status, completedAt, recipients: [{name, email, status, signedAt}] }
 */
function parseEnvelopeStatus(envelope) {
    if (!envelope) return null;

    const recipients = [];

    // DocuSign returns recipients grouped by type (signers, ccRecipients, etc.)
    const allRecipients = [
        ...(envelope.recipients?.signers            || []),
        ...(envelope.recipients?.carbonCopies       || []),
        ...(envelope.recipients?.certifiedDeliveries || []),
        ...(envelope.recipients?.agents             || []),
    ];

    for (const r of allRecipients) {
        recipients.push({
            name:     r.name || null,
            email:    r.email || null,
            status:   r.status || 'sent',
            signedAt: r.signedDateTime || r.deliveredDateTime || null,
            role:     r.roleName || r.recipientType || null,
        });
    }

    return {
        envelopeId:  envelope.envelopeId,
        status:      envelope.status || 'sent',
        completedAt: envelope.completedDateTime || null,
        sentAt:      envelope.sentDateTime || null,
        expiresAt:   envelope.expireDateTime || null,
        subject:     envelope.emailSubject || null,
        recipients,
    };
}

module.exports = {
    docusignRequest,
    getEnvelope,
    getEnvelopeDocuments,
    getEnvelopeRecipients,
    listEnvelopes,
    voidEnvelope,
    verifyWebhookSignature,
    parseEnvelopeStatus,
};
