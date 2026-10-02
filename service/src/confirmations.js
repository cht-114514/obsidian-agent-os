/**
 * One-time confirmation tokens for writes into human-owned zones.
 *
 * A confirmation is issued only after the service refused a write and told the
 * phone exactly which content it would replace. The token is:
 *  - single use,
 *  - bound to one device and one path,
 *  - bound to the content fingerprint the user was shown,
 *  - short lived.
 *
 * Because the final write re-checks the fingerprint, approving a card for text
 * that has since changed fails instead of overwriting newer text.
 */
import { randomUUID } from 'node:crypto';

export function createConfirmations({ ttlMs = 10 * 60 * 1000 } = {}) {
  /** @type {Map<string, { deviceId: string, path: string, fingerprint: string|null, expiresAt: number, usedAt: number }>} */
  const tokens = new Map();

  function sweep() {
    const now = Date.now();
    for (const [token, row] of tokens) {
      if (row.expiresAt < now || row.usedAt) tokens.delete(token);
    }
  }

  return {
    issue({ deviceId, path, fingerprint }) {
      sweep();
      const token = randomUUID();
      tokens.set(token, {
        deviceId: deviceId || '',
        path,
        fingerprint: fingerprint ?? null,
        expiresAt: Date.now() + ttlMs,
        usedAt: 0,
      });
      return token;
    },

    /** Look without consuming (safe to poll while the user reads the diff). */
    peek(token, deviceId) {
      sweep();
      const row = tokens.get(String(token || ''));
      if (!row) return null;
      if (row.deviceId && deviceId && row.deviceId !== deviceId) return null;
      return { path: row.path, fingerprint: row.fingerprint, expiresAt: row.expiresAt };
    },

    /** Consume once. Returns null when unknown, expired, reused, or mismatched. */
    consume(token, { deviceId, path, fingerprint } = {}) {
      sweep();
      const key = String(token || '');
      const row = tokens.get(key);
      if (!row) return null;
      if (row.deviceId && deviceId && row.deviceId !== deviceId) return null;
      if (path && row.path !== path) return null;
      // If the phone sends the fingerprint it based its decision on, it must
      // match what we showed it.
      if (fingerprint !== undefined && fingerprint !== null && row.fingerprint && fingerprint !== row.fingerprint) {
        return null;
      }
      row.usedAt = Date.now();
      tokens.delete(key);
      return { path: row.path, fingerprint: row.fingerprint };
    },

    size() {
      return tokens.size;
    },
  };
}
