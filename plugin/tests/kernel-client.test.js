import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeviceAuthPayloadV3,
  createDeviceIdentity,
  createMemoryStore,
  loadOrCreateIdentity,
  signDevicePayload,
  verifyDeviceSignature,
} from '../src/kernel/device-identity.js';
import { GatewaySocket } from '../src/kernel/transport.js';
import { KernelClient, normalizeGatewayUrl, resolveThinking, pairingFromError } from '../src/kernel/kernel-client.js';

class MockSocket {
  static latest = null;
  constructor() {
    this.listeners = {};
    this.sent = [];
    MockSocket.latest = this;
    queueMicrotask(() => this.emit('open'));
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  emit(type, event) {
    for (const fn of this.listeners[type] || []) fn(event);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.emit('close', { code: 1000, reason: '' });
  }
}

describe('device identity', () => {
  it('signs the v3 payload and round-trips', () => {
    const identity = createDeviceIdentity();
    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: 'gateway-client',
      clientMode: 'backend',
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      signedAtMs: 1737264000000,
      token: 'shared',
      nonce: 'abc',
      platform: 'MacOS',
      deviceFamily: 'Mac',
    });
    assert.equal(
      payload,
      `v3|${identity.deviceId}|gateway-client|backend|operator|operator.read,operator.write|1737264000000|shared|abc|macos|mac`
    );
    const signature = signDevicePayload(identity, payload);
    assert.equal(verifyDeviceSignature(identity.publicKey, payload, signature), true);
    assert.equal(identity.deviceId.length, 64);
  });

  it('keeps one identity in the device store', () => {
    const store = createMemoryStore();
    const first = loadOrCreateIdentity(store);
    const second = loadOrCreateIdentity(store);
    assert.equal(second.deviceId, first.deviceId);
    assert.equal(second.privateKey, first.privateKey);
  });
});

describe('gateway url and pairing', () => {
  it('keeps a thinking preference only when the model allows it', () => {
    const deepseek = {
      thinkingDefault: 'ultra',
      thinkingLevels: [{ id: 'off' }, { id: 'ultra' }],
    };
    const grok = {
      thinkingDefault: 'high',
      thinkingLevels: ['off', 'low', 'medium', 'high'],
    };
    assert.equal(resolveThinking('high', deepseek), 'ultra');
    assert.equal(resolveThinking('off', deepseek), 'off');
    assert.equal(resolveThinking('high', grok), 'high');
    assert.equal(resolveThinking('', grok), 'high');
    assert.equal(resolveThinking('high', null), '');
  });

  it('normalizes http and https', () => {
    assert.equal(normalizeGatewayUrl('http://127.0.0.1:18789/'), 'ws://127.0.0.1:18789');
    assert.equal(normalizeGatewayUrl('https://mac-mini.tail3b2ec3.ts.net'), 'wss://mac-mini.tail3b2ec3.ts.net');
  });

  it('describes a pairing approval command', () => {
    const pairing = pairingFromError({
      message: 'pairing required',
      details: { code: 'PAIRING_REQUIRED', requestId: 'req-1', requestedRole: 'node' },
    });
    assert.equal(pairing.approveCommand, 'openclaw nodes approve req-1');
  });
});

describe('gateway socket', () => {
  it('correlates responses and notices sequence gaps', async () => {
    let gap = 0;
    const socket = new GatewaySocket({
      WebSocketImpl: MockSocket,
      onSeqGap: () => {
        gap += 1;
      },
    });
    await socket.open('ws://example');
    const pending = socket.request('health', {});
    const req = MockSocket.latest.sent[0];
    MockSocket.latest.emit('message', {
      data: JSON.stringify({ type: 'res', id: req.id, ok: true, payload: { ok: true } }),
    });
    assert.deepEqual(await pending, { ok: true });
    MockSocket.latest.emit('message', {
      data: JSON.stringify({ type: 'event', event: 'tick', seq: 1, payload: {} }),
    });
    MockSocket.latest.emit('message', {
      data: JSON.stringify({ type: 'event', event: 'tick', seq: 4, payload: {} }),
    });
    assert.equal(gap, 1);
    socket.close();
  });
});

describe('kernel client handshake', () => {
  it('connects and maps chat deltas', async () => {
    const identity = createDeviceIdentity();
    const client = new KernelClient({
      url: 'ws://127.0.0.1:18789',
      token: 'shared-token',
      identity,
      WebSocketImpl: MockSocket,
    });
    const connecting = client.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    MockSocket.latest.emit('message', {
      data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1', ts: 100 } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const connect = MockSocket.latest.sent.find((frame) => frame.method === 'connect');
    assert.equal(connect.params.client.id, 'gateway-client');
    assert.equal(connect.params.client.mode, 'backend');
    assert.equal(connect.params.device.signedAt, 100);
    assert.equal(connect.params.device.nonce, 'n1');
    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: 'gateway-client',
      clientMode: 'backend',
      role: 'operator',
      scopes: connect.params.scopes,
      signedAtMs: 100,
      token: 'shared-token',
      nonce: 'n1',
      platform: 'macos',
      deviceFamily: 'mac',
    });
    assert.equal(verifyDeviceSignature(identity.publicKey, payload, connect.params.device.signature), true);
    MockSocket.latest.emit('message', {
      data: JSON.stringify({
        type: 'res',
        id: connect.id,
        ok: true,
        payload: { type: 'hello-ok', protocol: 4, auth: { role: 'operator', scopes: connect.params.scopes, deviceToken: 'dev-1' } },
      }),
    });
    await connecting;
    assert.equal(client.status.state, 'live');
    assert.equal(client.deviceToken, 'dev-1');

    const chunks = [];
    const pending = client.prompt({
      sessionKey: 'agent:main:aos',
      message: 'hello',
      onText: (_chunk, full) => chunks.push(full),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const send = MockSocket.latest.sent.find((frame) => frame.method === 'chat.send');
    assert.equal(send.params.sessionKey, 'agent:main:aos');
    assert.equal(send.params.message, 'hello');
    assert.ok(send.params.idempotencyKey);
    MockSocket.latest.emit('message', {
      data: JSON.stringify({ type: 'res', id: send.id, ok: true, payload: { runId: 'run-1' } }),
    });
    MockSocket.latest.emit('message', {
      data: JSON.stringify({
        type: 'event',
        event: 'chat',
        payload: { sessionKey: 'agent:main:aos', runId: 'run-1', state: 'delta', deltaText: 'Hi' },
      }),
    });
    MockSocket.latest.emit('message', {
      data: JSON.stringify({
        type: 'event',
        event: 'chat',
        payload: { sessionKey: 'agent:main:aos', runId: 'run-1', state: 'final', message: { text: 'Hi there' }, stopReason: 'end_turn' },
      }),
    });
    const result = await pending;
    assert.equal(result.text, 'Hi there');
    assert.deepEqual(chunks, ['Hi']);
    client.disconnect();
  });

  it('surfaces pairing instead of reconnecting', async () => {
    const client = new KernelClient({
      url: 'ws://127.0.0.1:18789',
      token: 'shared-token',
      identity: createDeviceIdentity(),
      WebSocketImpl: MockSocket,
    });
    const connecting = client.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    MockSocket.latest.emit('message', {
      data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n2', ts: 200 } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const connect = MockSocket.latest.sent.find((frame) => frame.method === 'connect');
    MockSocket.latest.emit('message', {
      data: JSON.stringify({
        type: 'res',
        id: connect.id,
        ok: false,
        error: {
          code: 'NOT_PAIRED',
          message: 'pairing required',
          details: { code: 'PAIRING_REQUIRED', requestId: 'dev-req', requestedRole: 'operator' },
        },
      }),
    });
    await connecting;
    assert.equal(client.status.state, 'pairing');
    assert.equal(client.status.approveCommand, 'openclaw devices approve dev-req');
    client.disconnect();
  });

  it('joins concurrent connect attempts', async () => {
    const client = new KernelClient({
      url: 'ws://127.0.0.1:18789',
      token: 'shared-token',
      identity: createDeviceIdentity(),
      WebSocketImpl: MockSocket,
    });
    const a = client.connect();
    const b = client.connect({ force: true });
    assert.equal(a, b);
    await new Promise((resolve) => setTimeout(resolve, 0));
    MockSocket.latest.emit('message', {
      data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n3', ts: 300 } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const connect = MockSocket.latest.sent.find((frame) => frame.method === 'connect');
    MockSocket.latest.emit('message', {
      data: JSON.stringify({
        type: 'res',
        id: connect.id,
        ok: true,
        payload: { type: 'hello-ok', protocol: 4 },
      }),
    });
    await a;
    assert.equal(client.status.state, 'live');
    client.disconnect();
  });

  it('rejects pending RPC when the socket is replaced', async () => {
    const socket = new GatewaySocket({ WebSocketImpl: MockSocket });
    await socket.open('ws://example');
    const pending = socket.request('health', {});
    socket.rejectAllPending('连接已更换');
    await assert.rejects(pending, (error) => error.code === 'CONNECTION_REPLACED');
    socket.close();
  });

  it('never hangs the handshake when the challenge never arrives', async () => {
    const client = new KernelClient({
      url: 'ws://127.0.0.1:18789',
      token: 'shared-token',
      identity: createDeviceIdentity(),
      WebSocketImpl: MockSocket,
    });
    // Speed the challenge wait down so the test stays fast.
    client._handshake = async function handshakeWithoutChallenge(socket) {
      await socket.open(this.url, 100);
      return socket.nextEvent('connect.challenge', 30);
    };
    await assert.rejects(() => client.connect(), (error) => {
      assert.equal(error.code, 'TIMEOUT');
      return true;
    });
    assert.equal(client.status.state, 'offline');
    // The failed socket is released, so a later attempt starts from scratch.
    assert.equal(client.socket, null);
    assert.equal(client.handshakeReady, false);
    client.disconnect();
  });

  it('fails fast instead of joining a stuck handshake forever', async () => {
    const client = new KernelClient({
      url: 'ws://127.0.0.1:18789',
      token: 'shared-token',
      identity: createDeviceIdentity(),
      WebSocketImpl: MockSocket,
    });
    // A handshake that never settles (the classic permanent-freeze shape).
    client._handshake = () => new Promise(() => {});
    const live = await client.boundedConnect(25);
    assert.equal(live, false);
    assert.equal(client.connectPromise, null);
    client.disconnect();
  });
});
