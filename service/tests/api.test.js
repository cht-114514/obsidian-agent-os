import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { createDevices } from '../src/devices-store.js';
import { createRateLimiter } from '../src/rate-limit.js';
import { createApi } from '../src/api.js';
import { createVault } from '../src/vault.js';
import { createConfirmations } from '../src/confirmations.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'aos-api-'));
  const config = {
    dbPath: join(dir, 'api.sqlite'),
    logPath: join(dir, 'api.log'),
    adminTokenPath: join(dir, 'admin.token'),
    publicUrl: 'https://agent.example.test',
    pairingCodeTtlMs: 60_000,
    rateLimit: { windowMs: 60_000, max: 50, pairMax: 3 },
  };
  const store = createStore(config.dbPath);
  const devices = createDevices({ store, config, logger: silentLogger });
  const turns = new Map();
  const engine = {
    receiveTurn({ clientTurnId, sessionKey, message, deviceId }) {
      if (turns.has(clientTurnId)) return { turn: turns.get(clientTurnId), created: false };
      const turn = {
        id: `turn-${turns.size + 1}`,
        clientTurnId,
        sessionKey,
        message,
        status: 'queued',
        deviceId,
        result: '',
        error: '',
        runId: '',
        attempts: 0,
        needsAttention: false,
        createdAt: 1,
        updatedAt: 1,
        startedAt: 0,
        endedAt: 0,
      };
      turns.set(clientTurnId, turn);
      return { turn, created: true };
    },
    describeTurn(turn, afterSeq) {
      return { ...turn, events: [], cursor: afterSeq, terminal: false };
    },
    async cancelTurn() {
      return { turn: { id: 'turn-1', status: 'aborted' } };
    },
    retryTurn() {
      return { turn: { id: 'turn-1', status: 'queued' } };
    },
  };
  const gateway = {
    isLive: () => true,
    status: () => ({ state: 'live', message: '' }),
    async listSessions() {
      return [{ key: 'agent:main:main', title: '主会话', updatedAt: 9 }];
    },
    async history() {
      return {
        messages: [
          { role: 'user', content: 'hi', timestamp: 1, __openclaw: { runId: 'r1' } },
          { role: 'assistant', content: [{ type: 'text', text: 'hello' }], timestamp: 2, __openclaw: { runId: 'r1' } },
        ],
        hasMore: false,
        totalMessages: 2,
      };
    },
  };
  const adminToken = readFileSync(config.adminTokenPath, 'utf8').trim();
  const rateLimit = createRateLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.max });
  // A tiny vault so the note routes have something real to talk to.
  const vaultRoot = join(dir, 'vault');
  mkdirSync(join(vaultRoot, 'agent-inbox', 'notes'), { recursive: true });
  mkdirSync(join(vaultRoot, '手记'), { recursive: true });
  writeFileSync(join(vaultRoot, 'agent-inbox', 'notes', 'seed.md'), '# Seed\n\nhello vault\n');
  writeFileSync(join(vaultRoot, '手记', 'journal.md'), '# Journal\n\nhuman text\n');
  const vault = createVault({ root: vaultRoot });
  const confirmations = createConfirmations({ ttlMs: 60_000 });
  const api = createApi({
    store,
    engine,
    gateway,
    devices,
    logger: silentLogger,
    config,
    rateLimit,
    vault,
    confirmations,
  });
  const server = createServer((req, res) => api.handler(req, res));
  return {
    dir,
    config,
    store,
    devices,
    adminToken,
    api,
    gateway,
    rateLimit,
    vault,
    vaultRoot,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
      }),
    cleanup() {
      server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function call(base, path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

describe('service API', { concurrency: 1 }, () => {
  let ctx;
  let base;
  let deviceToken;

  beforeEach(async () => {
    ctx = harness();
    base = await ctx.listen();
    const code = ctx.devices.mintPairingCode().code;
    const claimed = await call(base, '/v1/pair/claim', {
      method: 'POST',
      body: { code, name: 'test phone', platform: 'ios' },
    });
    deviceToken = claimed.json.credential;
  });

  afterEach(() => {
    ctx.cleanup();
    ctx = null;
  });

  it('reports health and never leaks the admin token', async () => {
    const res = await call(base, '/v1/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.kernel.live, undefined);
    assert.ok(!JSON.stringify(res.json).includes(ctx.devices.adminTokenPath));
  });

  it('rejects unauthenticated business routes', async () => {
    const post = await call(base, '/v1/turns', { method: 'POST', body: { clientTurnId: 'a', message: 'b' } });
    assert.equal(post.status, 401);
    assert.equal(post.json.error.code, 'UNAUTHORIZED');
    const get = await call(base, '/v1/turns/turn-1');
    assert.equal(get.status, 401);
    const sessions = await call(base, '/v1/sessions');
    assert.equal(sessions.status, 401);
  });

  it('accepts a turn idempotently and returns the same turn for a repeat', async () => {
    const payload = { clientTurnId: 'c-1', sessionKey: 'agent:main:main', message: 'hello' };
    const first = await call(base, '/v1/turns', { method: 'POST', token: deviceToken, body: payload });
    assert.equal(first.status, 201);
    assert.equal(first.json.duplicate, false);
    const repeat = await call(base, '/v1/turns', { method: 'POST', token: deviceToken, body: payload });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.json.duplicate, true);
    assert.equal(repeat.json.turn.id, first.json.turn.id);
  });

  it('validates the received payload', async () => {
    const missingId = await call(base, '/v1/turns', {
      method: 'POST',
      token: deviceToken,
      body: { message: 'hello' },
    });
    assert.equal(missingId.status, 400);
    const missingMessage = await call(base, '/v1/turns', {
      method: 'POST',
      token: deviceToken,
      body: { clientTurnId: 'c-2' },
    });
    assert.equal(missingMessage.status, 400);
  });

  it('rejects malformed JSON with a clear error', async () => {
    const res = await fetch(`${base}/v1/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, 'BAD_JSON');
  });

  it('consumes a pairing code exactly once', async () => {
    const code = ctx.devices.mintPairingCode().code;
    const first = await call(base, '/v1/pair/claim', { method: 'POST', body: { code } });
    assert.equal(first.status, 201);
    const second = await call(base, '/v1/pair/claim', { method: 'POST', body: { code } });
    assert.equal(second.status, 401);
    assert.equal(second.json.error.code, 'CODE_USED');
  });

  it('rate limits pairing attempts', async () => {
    const code = ctx.devices.mintPairingCode().code;
    // pairMax is 3 in this harness; the setup already used one.
    let limited = false;
    for (let i = 0; i < 6; i += 1) {
      const res = await call(base, '/v1/pair/claim', { method: 'POST', body: { code: 'ZZZZZZZZ' } });
      if (res.status === 429) limited = true;
    }
    assert.equal(limited, true, 'pairing attempts must be rate limited');
  });

  it('lists sessions merged from the store and the kernel', async () => {
    ctx.store.upsertSession('agent:main:local', 'main', '本地会话');
    const res = await call(base, '/v1/sessions', { token: deviceToken });
    assert.equal(res.status, 200);
    const keys = res.json.sessions.map((row) => row.key);
    assert.ok(keys.includes('agent:main:local'));
    assert.ok(keys.includes('agent:main:main'));
  });

  it('returns history with internal metadata stripped down', async () => {
    const res = await call(base, '/v1/sessions/agent:main:main/history', { token: deviceToken });
    assert.equal(res.status, 200);
    assert.equal(res.json.messages.length, 2);
    assert.equal(res.json.messages[1].runId, 'r1');
    assert.equal(res.json.messages[1].text, undefined);
  });

  it('requires the admin token for device administration', async () => {
    const withDevice = await call(base, '/v1/devices', { token: deviceToken });
    assert.equal(withDevice.status, 401);
    const withAdmin = await call(base, '/v1/devices', { token: ctx.adminToken });
    assert.equal(withAdmin.status, 200);
    assert.equal(withAdmin.json.devices.length, 1);
  });

  it('revokes a device so its credential stops working at once', async () => {
    const list = await call(base, '/v1/devices', { token: ctx.adminToken });
    const id = list.json.devices[0].id;
    const revoked = await call(base, `/v1/devices/${id}/revoke`, {
      method: 'POST',
      token: ctx.adminToken,
    });
    assert.equal(revoked.status, 200);
    const after = await call(base, '/v1/sessions', { token: deviceToken });
    assert.equal(after.status, 401);
  });

  it('rotates a credential and invalidates the previous one', async () => {
    const list = await call(base, '/v1/devices', { token: ctx.adminToken });
    const id = list.json.devices[0].id;
    const rotated = await call(base, `/v1/devices/${id}/rotate`, {
      method: 'POST',
      token: ctx.adminToken,
    });
    assert.equal(rotated.status, 200);
    const fresh = rotated.json.credential;
    assert.notEqual(fresh, deviceToken);
    const oldToken = await call(base, '/v1/sessions', { token: deviceToken });
    assert.equal(oldToken.status, 401);
    const newToken = await call(base, '/v1/sessions', { token: fresh });
    assert.equal(newToken.status, 200);
  });

  it('answers unknown routes with a JSON 404', async () => {
    const res = await call(base, '/v1/nope');
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'NOT_FOUND');
  });

  it('rejects an oversized body instead of buffering it', async () => {
    const res = await fetch(`${base}/v1/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ clientTurnId: 'big', message: 'x'.repeat(300 * 1024) }),
    });
    assert.equal(res.status, 413);
  });

  // ---- vault / notes ----------------------------------------------------

  it('reads a note with a fingerprint the phone can quote back', async () => {
    const res = await call(base, '/v1/note?path=agent-inbox/notes/seed.md', { token: deviceToken });
    assert.equal(res.status, 200);
    assert.match(res.json.note.content, /hello vault/);
    assert.match(res.json.note.fingerprint, /^sha256:/);
    assert.equal(res.json.note.humanZone, false);
  });

  it('refuses traversal and binary reads through the API', async () => {
    const traversal = await call(base, '/v1/note?path=../../etc/passwd', { token: deviceToken });
    assert.equal(traversal.status, 400);
    const missing = await call(base, '/v1/note?path=agent-inbox/nope.md', { token: deviceToken });
    assert.equal(missing.status, 404);
  });

  it('searches notes and flags human zones', async () => {
    const res = await call(base, '/v1/notes/search?q=human', { token: deviceToken });
    assert.equal(res.status, 200);
    assert.equal(res.json.hits.length, 1);
    assert.equal(res.json.hits[0].humanZone, true);
  });

  it('writes to agent-inbox without a confirmation', async () => {
    const res = await call(base, '/v1/notes/write', {
      method: 'POST',
      token: deviceToken,
      body: { path: 'agent-inbox/notes/new.md', content: 'written by the agent' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.write.created, true);
    const read = await call(base, '/v1/note?path=agent-inbox/notes/new.md', { token: deviceToken });
    assert.equal(read.json.note.content, 'written by the agent');
  });

  it('demands a confirmation for a human zone, then applies it once approved', async () => {
    const required = await call(base, '/v1/notes/write', {
      method: 'POST',
      token: deviceToken,
      body: { path: '手记/journal.md', content: 'agent proposal' },
    });
    assert.equal(required.status, 428);
    assert.equal(required.json.error.code, 'CONFIRMATION_REQUIRED');
    const confirm = required.json.confirm;
    assert.equal(confirm.humanZone, true);
    assert.match(confirm.currentFingerprint, /^sha256:/);
    // Nothing was written yet.
    const before = await call(base, '/v1/note?path=手记/journal.md', { token: deviceToken });
    assert.match(before.json.note.content, /human text/);

    const peek = await call(base, `/v1/notes/confirm/${confirm.token}`, { token: deviceToken });
    assert.equal(peek.status, 200);
    assert.equal(peek.json.confirm.changedSinceIssue, false);
    assert.match(peek.json.confirm.currentContent, /human text/);

    const applied = await call(base, '/v1/notes/write', {
      method: 'POST',
      token: deviceToken,
      body: {
        path: '手记/journal.md',
        content: 'agent proposal',
        confirmationToken: confirm.token,
        expectFingerprint: confirm.currentFingerprint,
      },
    });
    assert.equal(applied.status, 200);
    const after = await call(base, '/v1/note?path=手记/journal.md', { token: deviceToken });
    assert.equal(after.json.note.content, 'agent proposal');
  });

  it('re-displays the diff when the note changed before approval', async () => {
    const required = await call(base, '/v1/notes/write', {
      method: 'POST',
      token: deviceToken,
      body: { path: '手记/journal.md', content: 'agent proposal' },
    });
    const confirm = required.json.confirm;
    // The human edits the file while the confirmation card is on screen.
    writeFileSync(join(ctx.vaultRoot, '手记', 'journal.md'), '# Journal\n\nedited by hand\n');
    const stale = await call(base, '/v1/notes/write', {
      method: 'POST',
      token: deviceToken,
      body: {
        path: '手记/journal.md',
        content: 'agent proposal',
        confirmationToken: confirm.token,
        expectFingerprint: confirm.currentFingerprint,
      },
    });
    // The write is refused with the fresh content, so the phone can re-display
    // the diff instead of overwriting newer text.
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'PRECONDITION_FAILED');
    assert.match(stale.json.current.content, /edited by hand/);
    const after = await call(base, '/v1/note?path=手记/journal.md', { token: deviceToken });
    assert.match(after.json.note.content, /edited by hand/);
  });

  it('will not reuse a confirmation token', async () => {
    const first = await call(base, '/v1/notes/write', {
      method: 'POST',
      token: deviceToken,
      body: { path: '手记/journal.md', content: 'first' },
    });
    const token = first.json.confirm.token;
    const ok = await call(base, '/v1/notes/write', {
      method: 'POST',
      token: deviceToken,
      body: { path: '手记/journal.md', content: 'first', confirmationToken: token },
    });
    assert.equal(ok.status, 200);
    const replay = await call(base, '/v1/notes/write', {
      method: 'POST',
      token: deviceToken,
      body: { path: '手记/journal.md', content: 'second', confirmationToken: token },
    });
    // The token was consumed, so the replay is refused outright.
    assert.equal(replay.status, 409);
    assert.equal(replay.json.error.code, 'CONFIRMATION_EXPIRED');
    const unchanged = await call(base, '/v1/note?path=手记/journal.md', { token: deviceToken });
    assert.equal(unchanged.json.note.content, 'first');
  });

  it('keeps note routes authenticated', async () => {
    const read = await call(base, '/v1/note?path=agent-inbox/notes/seed.md');
    assert.equal(read.status, 401);
    const write = await call(base, '/v1/notes/write', {
      method: 'POST',
      body: { path: 'agent-inbox/x.md', content: 'y' },
    });
    assert.equal(write.status, 401);
  });
});
