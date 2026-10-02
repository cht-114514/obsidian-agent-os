/**
 * Device credentials and one-time pairing codes.
 *
 * A device holds an opaque bearer token; the service stores only its SHA-256.
 * Device credentials are revocable individually and never leave the device.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** Unambiguous alphabet: no O/0, I/1/L. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function hashSecret(secret) {
  return createHash('sha256').update(String(secret || ''), 'utf8').digest('hex');
}

export function generateSecret() {
  return randomBytes(32).toString('base64url');
}

export function generateDeviceId() {
  return `dev_${randomUUID()}`;
}

/** Human-typable, single-use pairing code. */
export function generatePairingCode(length = 8) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function normalizePairingCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Constant-time compare of two hex digests. */
export function safeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Extract a bearer token from an Authorization header.
 * @param {string | string[] | undefined} header
 */
export function bearerFromHeader(header) {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}
