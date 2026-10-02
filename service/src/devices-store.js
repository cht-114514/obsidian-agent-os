/**
 * Device registry and admin credential.
 *
 * - Verifies bearer credentials against stored SHA-256 hashes.
 * - Issues one-time, short-lived pairing codes.
 * - Keeps an admin token on the local filesystem (never through the tunnel) so
 *   a leaked device credential cannot mint new devices.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  generateDeviceId,
  generatePairingCode,
  generateSecret,
  hashSecret,
  safeEqualHex,
} from './devices.js';

/**
 * Load the admin token, creating it on first run with owner-only permissions.
 * @param {string} path
 */
export function loadOrCreateAdminToken(path) {
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim();
    if (token) return token;
  }
  const token = generateSecret();
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

export function createDevices({ store, config, logger }) {
  const adminToken = loadOrCreateAdminToken(config.adminTokenPath);

  return {
    adminTokenPath: config.adminTokenPath,

    isAdminToken(token) {
      if (!token) return false;
      return safeEqualHex(hashSecret(token), hashSecret(adminToken));
    },

    /**
     * @param {string} token
     * @param {{ allowAdmin?: boolean }} [opts]
     * @returns {{ id: string, name: string } | null}
     */
    authenticate(token, opts = {}) {
      if (!token) return null;
      if (opts.allowAdmin && this.isAdminToken(token)) return { id: 'admin', name: 'admin', admin: true };
      const hash = hashSecret(token);
      for (const row of store.listDevices()) {
        if (row.revoked_at) continue;
        if (safeEqualHex(row.secret_hash, hash)) return { id: row.id, name: row.name };
      }
      return null;
    },

    /** Mint a fresh, single-use pairing code. */
    mintPairingCode() {
      store.prunePairingCodes();
      const code = generatePairingCode(8);
      const record = store.insertPairingCode(code, config.pairingCodeTtlMs);
      logger.info('pairing code minted', { expiresAt: new Date(record.expiresAt).toISOString() });
      return record;
    },

    /**
     * Consume a pairing code. The code only works once and only before it
     * expires; the returned credential is shown to the device exactly once.
     */
    claimPairingCode(code, meta = {}) {
      store.prunePairingCodes();
      const row = store.pairingCode(code);
      if (!row) return { ok: false, error: 'BAD_CODE', message: '配对码无效' };
      if (row.used_at) return { ok: false, error: 'CODE_USED', message: '配对码已经被使用过' };
      if (row.expires_at < Date.now()) return { ok: false, error: 'CODE_EXPIRED', message: '配对码已过期' };
      const credential = generateSecret();
      const device = {
        id: generateDeviceId(),
        name: meta.name || '未命名设备',
        platform: meta.platform || '',
        secretHash: hashSecret(credential),
        createdAt: Date.now(),
        lastSeenAt: 0,
        pairingCode: code,
      };
      const stored = store.insertDevice(device);
      if (!store.usePairingCode(code, stored.id)) {
        // Someone else consumed it between our read and write.
        return { ok: false, error: 'CODE_USED', message: '配对码已经被使用过' };
      }
      return {
        ok: true,
        credential,
        device: { id: stored.id, name: stored.name, platform: stored.platform },
      };
    },

    listDevices() {
      return store.listDevices().map((row) => ({
        id: row.id,
        name: row.name,
        platform: row.platform,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        revokedAt: row.revoked_at,
        revoked: !!row.revoked_at,
      }));
    },

    revokeDevice(id) {
      const row = store.deviceById(id);
      if (!row) return null;
      const revoked = store.revokeDevice(id);
      logger.info('device revoked', { deviceId: id });
      return { id, revoked: true, revokedAt: revoked?.revoked_at || Date.now() };
    },

    /** Issue a new credential for an existing device (old one stops working). */
    rotateDevice(id) {
      const row = store.deviceById(id);
      if (!row) return null;
      const credential = generateSecret();
      store.db
        .prepare('UPDATE devices SET secret_hash = ?, revoked_at = 0 WHERE id = ?')
        .run(hashSecret(credential), id);
      logger.info('device credential rotated', { deviceId: id });
      return { device: { id, name: row.name }, credential };
    },
  };
}
