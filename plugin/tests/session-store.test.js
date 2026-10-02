import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemorySessionStore,
  createSessionStore,
  isTransportNoise,
} from '../src/kernel/session-store.js';

describe('session store', () => {
  it('round-trips sessions, transcript, and the pending queue', () => {
    const store = createMemorySessionStore();
    store.saveSessions([{ key: 'agent:main:main', label: '主会话' }]);
    store.saveActiveKey('agent:main:main');
    store.saveTranscript('agent:main:main', [{ id: 'u1', role: 'user', text: 'hi' }]);
    const written = store.saveTurnWithPending(
      'agent:main:main',
      [
        { id: 'u1', role: 'user', text: 'hi' },
        { id: 'u2', role: 'user', text: 'prompt', turnId: 't1' },
        { id: 'a1', role: 'assistant', text: '', turnId: 't1' },
      ],
      { turnId: 't1', sessionKey: 'agent:main:main', message: 'prompt', prompt: 'preamble', ts: 7 }
    );
    assert.equal(written.ok, true);
    assert.equal(store.loadSessions().length, 1);
    assert.equal(store.loadActiveKey(), 'agent:main:main');
    assert.equal(store.loadTranscript('agent:main:main').length, 3);
    const pending = store.pendingFor('t1');
    assert.equal(pending.status, 'queued');
    assert.equal(pending.attempts, 0);
    assert.equal(pending.sessionKey, 'agent:main:main');
  });

  it('transitions a turn through sending, sent, and a cleared payload', () => {
    const store = createMemorySessionStore();
    store.saveTurnWithPending('s', [], { turnId: 't1', sessionKey: 's', message: 'm', prompt: 'p', ts: 1 });
    store.markSending('t1');
    assert.equal(store.pendingFor('t1').status, 'sending');
    assert.equal(store.pendingFor('t1').attempts, 1);
    store.markSent('t1', { runId: 'run-9' });
    const sent = store.pendingFor('t1');
    assert.equal(sent.status, 'sent');
    assert.equal(sent.runId, 'run-9');
    assert.equal(sent.prompt, '');
    assert.equal(sent.message, '');
    // A sent turn is a tombstone: it must not be re-sent but must stay known.
    assert.equal(store.activePending('s').length, 0);
    assert.equal(store.listPending('s').filter((row) => row.status === 'queued').length, 0);
  });

  it('surfaces an unknown delivery instead of silently retrying it', () => {
    const store = createMemorySessionStore();
    store.saveTurnWithPending('s', [], { turnId: 't1', sessionKey: 's', message: 'm', prompt: 'p', ts: 1 });
    store.markSending('t1');
    store.markUnknown('t1', 'socket closed');
    assert.equal(store.pendingFor('t1').status, 'unknown');
    assert.equal(store.activePending('s').length, 1);
    store.markQueuedForRetry('t1');
    assert.equal(store.pendingFor('t1').status, 'queued');
  });

  it('orders pending turns chronologically', () => {
    const store = createMemorySessionStore();
    store.saveTurnWithPending('s', [], { turnId: 'b', sessionKey: 's', message: 'b', prompt: 'b', ts: 20 });
    store.saveTurnWithPending('s', [], { turnId: 'a', sessionKey: 's', message: 'a', prompt: 'a', ts: 10 });
    assert.deepEqual(
      store.listPending('s').map((row) => row.turnId),
      ['a', 'b']
    );
    assert.deepEqual(
      store.listPending('other').map((row) => row.turnId),
      []
    );
  });

  it('keeps the queue record when only the transcript write fails', () => {
    let failWrites = false;
    const map = new Map();
    const store = createSessionStore({
      get: (k) => map.get(k) ?? null,
      set: (k, v) => {
        if (failWrites && k.endsWith(':tx:s')) throw new Error('QuotaExceededError');
        map.set(k, v);
      },
      remove: (k) => map.delete(k),
    });
    store.saveTurnWithPending('s', [{ id: 'u1' }], { turnId: 't1', sessionKey: 's', message: 'm', prompt: 'p' });
    failWrites = true;
    const result = store.saveTurnWithPending('s', [{ id: 'u1' }, { id: 'u2' }], {
      turnId: 't2',
      sessionKey: 's',
      message: 'm2',
      prompt: 'p2',
    });
    // The queue record is what must never be lost, so the write still succeeds.
    assert.equal(result.ok, true);
    assert.equal(store.pendingFor('t2').status, 'queued');
    // The stale transcript is left alone rather than half-written.
    assert.equal(store.loadTranscript('s').length, 1);
  });

  it('reports a hard storage failure so the composer keeps the text', () => {
    const map = new Map();
    const store = createSessionStore({
      get: (k) => map.get(k) ?? null,
      set: () => {
        throw new Error('QuotaExceededError');
      },
      remove: (k) => map.delete(k),
    });
    const result = store.saveTurnWithPending('s', [], {
      turnId: 't1',
      sessionKey: 's',
      message: 'm',
      prompt: 'p',
    });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /Quota/);
    assert.equal(store.pendingFor('t1'), null);
  });
});

describe('isTransportNoise', () => {
  it('flags gateway timeouts and replacement', () => {
    assert.equal(isTransportNoise({ message: 'gateway chat.history timed out' }), true);
    assert.equal(isTransportNoise({ code: 'CONNECTION_REPLACED' }), true);
    assert.equal(isTransportNoise({ message: 'LLM request failed' }), false);
  });
});
