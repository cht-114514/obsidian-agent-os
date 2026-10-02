import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GatewaySocket } from '../src/kernel/transport.js';

/** A WebSocket that never opens and never closes by itself. */
class HangingSocket {
  static latest = null;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.closeCalls = 0;
    HangingSocket.latest = this;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
  emit(type, event) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
  }
  send(data) {
    this.sentFrames ||= [];
    this.sentFrames.push(JSON.parse(data));
  }
  close() {
    this.closeCalls += 1;
  }
}

/** Opens immediately, then answers nothing. */
class SilentSocket extends HangingSocket {
  constructor(url) {
    super(url);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open', {});
    });
  }
}

describe('GatewaySocket open', () => {
  it('rejects with a retryable timeout so a handshake cannot hang forever', async () => {
    const socket = new GatewaySocket({ WebSocketImpl: HangingSocket });
    await assert.rejects(() => socket.open('ws://example.test', 30), (error) => {
      assert.equal(error.code, 'TIMEOUT');
      assert.equal(error.retryable, true);
      return true;
    });
    // The dead socket is closed and its listeners are released.
    assert.equal(HangingSocket.latest.closeCalls, 1);
    assert.equal(HangingSocket.latest.listenerCount('open'), 0);
    assert.equal(HangingSocket.latest.listenerCount('message'), 0);
    assert.equal(HangingSocket.latest.listenerCount('close'), 0);
    assert.equal(socket.isOpen(), false);
  });

  it('resolves when the socket opens and then reports live', async () => {
    const socket = new GatewaySocket({ WebSocketImpl: SilentSocket });
    await socket.open('ws://example.test', 200);
    assert.equal(socket.isOpen(), true);
  });

  it('keeps receiving frames after the socket opens', async () => {
    // Regression: releasing the message listener on a successful open meant no
    // frame ever reached the client, so every handshake timed out.
    const frames = [];
    const socket = new GatewaySocket({
      WebSocketImpl: SilentSocket,
      onFrame: (frame) => frames.push(frame),
    });
    await socket.open('ws://example.test', 200);
    SilentSocket.latest.emit('message', {
      data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n', ts: 1 } }),
    });
    assert.equal(frames.length, 1);
    const challenge = await socket.nextEvent('connect.challenge', 50);
    assert.equal(challenge.payload.nonce, 'n');
  });

  it('keeps correlating responses after the socket opens', async () => {
    const socket = new GatewaySocket({ WebSocketImpl: SilentSocket });
    await socket.open('ws://example.test', 200);
    const pending = socket.request('health', {}, 200);
    const sent = SilentSocket.latest.sentFrames?.at(-1);
    assert.ok(sent, 'request frame was written to the socket');
    SilentSocket.latest.emit('message', {
      data: JSON.stringify({ type: 'res', id: sent.id, ok: true, payload: { ok: true } }),
    });
    assert.deepEqual(await pending, { ok: true });
  });
});

describe('GatewaySocket event waits', () => {
  it('bounded wait for an event that never arrives', async () => {
    const socket = new GatewaySocket({ WebSocketImpl: SilentSocket });
    await socket.open('ws://example.test', 200);
    await assert.rejects(() => socket.nextEvent('connect.challenge', 25), (error) => {
      assert.equal(error.code, 'TIMEOUT');
      return true;
    });
  });

  it('resolves immediately when the event already arrived', async () => {
    const socket = new GatewaySocket({ WebSocketImpl: SilentSocket });
    await socket.open('ws://example.test', 200);
    socket._accept({ type: 'event', event: 'connect.challenge', seq: 1, payload: { nonce: 'n', ts: 1 } });
    const frame = await socket.nextEvent('connect.challenge', 50);
    assert.equal(frame.payload.nonce, 'n');
    // The buffered frame is consumed, not replayed.
    await assert.rejects(() => socket.nextEvent('connect.challenge', 20));
  });

  it('fails an outstanding waiter as soon as the socket is replaced', async () => {
    const socket = new GatewaySocket({ WebSocketImpl: SilentSocket });
    await socket.open('ws://example.test', 200);
    const waiting = socket.nextEvent('connect.challenge', 5000);
    socket.close();
    await assert.rejects(() => waiting, (error) => {
      assert.equal(error.code, 'CONNECTION_REPLACED');
      return true;
    });
  });

  it('aborts in-flight requests when the socket closes', async () => {
    const socket = new GatewaySocket({ WebSocketImpl: SilentSocket });
    await socket.open('ws://example.test', 200);
    const pending = socket.request('health', {}, 5000);
    socket.close();
    await assert.rejects(() => pending, (error) => {
      assert.equal(error.code, 'CONNECTION_REPLACED');
      return true;
    });
  });

  it('rejects requests on a socket that was never opened', async () => {
    const socket = new GatewaySocket({ WebSocketImpl: SilentSocket });
    await assert.rejects(() => socket.request('health', {}, 50), (error) => {
      assert.equal(error.code, 'NOT_CONNECTED');
      return true;
    });
  });
});
