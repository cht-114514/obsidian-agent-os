import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { createDevices } from '../src/devices-store.js';
import { bearerFromHeader, generatePairingCode, normalizePairingCode, safeEqualHex } from '../src/devices.js';
import { createLogger, redact } from '../src/logger.js';
import { createRateLimiter } from '../src/rate-limit.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeContext() {
  const dir = mkdtempSync(join(tmpdir(), 'aos-dev-'));
  const config = {
    dbPath: join(dir, 'd.sqlite'),
    adminTokenPath: join(dir, 'admin.token'),
    pairingCodeTtlMs: 60_000,
    publicUrl: 'https://agent.example.test',
  };
  const store = createStore(config.dbPath);
  const devices = createDevices({ store, config, logger: silentLogger });
  return { dir, config, store, devices };
}

describe('device credentials', { concurrency: 1 }, () => {
  let ctx;
  beforeEach(() => {
    ctx = makeContext();
  });
  afterEach(() => {
    ctx.store.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('creates an owner-only admin token on first run', () => {
    const mode = statSync(ctx.config.adminTokenPath).mode & 0o777;
    assert.equal(mode, 0o600);
    const token = readFileSync(ctx.config.adminTokenPath, 'utf8').trim();
    assert.ok(token.length >= 32);
    assert.equal(ctx.devices.isAdminToken(token), true);
    assert.equal(ctx.devices.isAdminToken('nope'), false);
  });

  it('issues a credential that only works for that device', () => {
    const record = ctx.devices.mintPairingCode();
    const claimed = ctx.devices.claimPairingCode(record.code, { name: 'iPhone', platform: 'ios' });
    assert.equal(claimed.ok, true);
    const auth = ctx.devices.authenticate(claimed.credential);
    assert.equal(auth.id, claimed.device.id);
    assert.equal(ctx.devices.authenticate('wrong-credential'), null);
    // The plaintext credential is never stored.
    const rows = ctx.store.listDevices();
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].secret_hash, claimed.credential);
  });

  it('expires and single-uses pairing codes', () => {
    // Insert a code that is already past its deadline.
    ctx.store.prunePairingCodes();
    const expired = ctx.store.insertPairingCode('EXPIRED1', -1000);
    const attempt = ctx.devices.claimPairingCode(expired.code, { name: 'late' });
    assert.equal(attempt.ok, false);
    assert.equal(attempt.error, 'CODE_EXPIRED');

    const fresh = ctx.devices.mintPairingCode();
    assert.equal(ctx.devices.claimPairingCode(fresh.code).ok, true);
    const second = ctx.devices.claimPairingCode(fresh.code);
    assert.equal(second.ok, false);
    assert.equal(second.error, 'CODE_USED');
  });

  it('rejects unknown codes without revealing anything', () => {
    const result = ctx.devices.claimPairingCode('NOPENOPE');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'BAD_CODE');
  });

  it('revokes one device without touching another', () => {
    const a = ctx.devices.claimPairingCode(ctx.devices.mintPairingCode().code, { name: 'a' });
    const b = ctx.devices.claimPairingCode(ctx.devices.mintPairingCode().code, { name: 'b' });
    assert.equal(ctx.devices.revokeDevice(a.device.id).revoked, true);
    assert.equal(ctx.devices.authenticate(a.credential), null);
    assert.ok(ctx.devices.authenticate(b.credential));
  });

  it('rotation invalidates the previous credential', () => {
    const a = ctx.devices.claimPairingCode(ctx.devices.mintPairingCode().code, { name: 'a' });
    const rotated = ctx.devices.rotateDevice(a.device.id);
    assert.equal(ctx.devices.authenticate(a.credential), null);
    assert.equal(ctx.devices.authenticate(rotated.credential).id, a.device.id);
  });

  it('accepts the admin token only where admin is allowed', () => {
    const token = readFileSync(ctx.config.adminTokenPath, 'utf8').trim();
    assert.equal(ctx.devices.authenticate(token), null);
    assert.equal(ctx.devices.authenticate(token, { allowAdmin: true }).admin, true);
  });
});

describe('pairing code helpers', () => {
  it('generates typable codes and normalizes user input', () => {
    const code = generatePairingCode();
    assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(normalizePairingCode(' ab-cd 12 '), 'ABCD12');
    assert.equal(normalizePairingCode(null), '');
  });

  it('compares digests in constant time without throwing on junk', () => {
    assert.equal(safeEqualHex('aa', 'aa'), true);
    assert.equal(safeEqualHex('aa', 'bb'), false);
    assert.equal(safeEqualHex('', ''), false);
    assert.equal(safeEqualHex('zz', 'zz'), false);
  });

  it('extracts a bearer token from a header', () => {
    assert.equal(bearerFromHeader('Bearer abc123'), 'abc123');
    assert.equal(bearerFromHeader('bearer  spaced '), 'spaced');
    assert.equal(bearerFromHeader(['Bearer from-array']), 'from-array');
    assert.equal(bearerFromHeader('Basic abc'), '');
    assert.equal(bearerFromHeader(undefined), '');
  });
});

describe('logger redaction', () => {
  it('never logs credential or note text', () => {
    const lines = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    logger.info('turn received', {
      turnId: 'turn-1',
      token: 'super-secret-token',
      message: 'the entire private note body',
      result: 'agent output',
      deviceToken: 'device-secret',
      bytes: 1234,
    });
    const out = lines.join('\n');
    assert.ok(!out.includes('super-secret-token'));
    assert.ok(!out.includes('the entire private note body'));
    assert.ok(!out.includes('agent output'));
    assert.ok(!out.includes('device-secret'));
    assert.ok(out.includes('turn-1'));
    assert.ok(out.includes('1234'));
    assert.ok(out.includes('redacted'));
  });

  it('truncates long non-secret strings and redacts sensitive fields', () => {
    const value = redact({ meta: { path: 'a/b.md', excerpt: 'x'.repeat(500) }, note: 'private' });
    assert.equal(value.meta.path, 'a/b.md');
    assert.match(value.meta.excerpt, /redacted/);
    assert.match(String(value.note), /redacted/);
  });

  it('respects the level filter', () => {
    const lines = [];
    const logger = createLogger({ level: 'warn', sink: (line) => lines.push(line) });
    logger.info('quiet');
    logger.warn('loud');
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('loud'));
  });
});

describe('rate limiter', () => {
  it('allows within budget and blocks beyond it', () => {
    const limiter = createRateLimiter({ windowMs: 50, max: 2 });
    assert.equal(limiter.check('k').allowed, true);
    assert.equal(limiter.check('k').allowed, true);
    const blocked = limiter.check('k');
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs > 0);
    // Another key has its own budget.
    assert.equal(limiter.check('other').allowed, true);
  });

  it('supports a tighter per-bucket budget', () => {
    const limiter = createRateLimiter({ windowMs: 50, max: 10 });
    assert.equal(limiter.check('pair:ip', 1, 1).allowed, true);
    assert.equal(limiter.check('pair:ip', 1, 1).allowed, false);
    assert.equal(limiter.check('api:ip', 1, 1).allowed, true);
  });
});
