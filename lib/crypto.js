'use strict';
/**
 * Field-level AES-256-GCM encryption/decryption — mirrors portal lib/crypto.ts exactly.
 * Required env var: FIELD_ENCRYPTION_KEY (64 hex chars / 32 bytes)
 *
 * Format: "enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 * Values not prefixed with "enc:v1:" are treated as legacy plaintext.
 */

const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');

const ALGO       = 'aes-256-gcm';
const ENC_PREFIX = 'enc:v1:';

function getKey() {
    const hex = process.env.FIELD_ENCRYPTION_KEY || '';
    if (!hex || hex.length !== 64) {
        throw new Error(
            'FIELD_ENCRYPTION_KEY is missing or invalid (must be 64 hex chars / 32 bytes).'
        );
    }
    return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
    const key    = getKey();
    const iv     = randomBytes(12);
    const cipher = createCipheriv(ALGO, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag   = cipher.getAuthTag();
    return `${ENC_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(value) {
    if (!value || !value.startsWith(ENC_PREFIX)) {
        return value; // legacy plaintext — pass through
    }
    const parts = value.slice(ENC_PREFIX.length).split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted value format');
    const [ivHex, authTagHex, cipherHex] = parts;
    const key        = getKey();
    const iv         = Buffer.from(ivHex, 'hex');
    const authTag    = Buffer.from(authTagHex, 'hex');
    const ciphertext = Buffer.from(cipherHex, 'hex');
    const decipher   = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
