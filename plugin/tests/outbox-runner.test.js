import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySessionStore } from '../src/kernel/session-store.js';
import { createOutboxRunner, isRetryable } from '../src/kernel/outbox-runner.js';

function makeRunner(opts = {}) {
  const store = createMemorySessionStore();
  const sent = [];
  let connected = opts.connected !== false;
  const runner = createOutboxRunner({
    store,
    isConnected: () => connected,
    send: async (turn) => {
      sent.push(turn);
      if (opts.send) return opts.send(turn);
      return { text: 'ok', runId: 'run-1' };
    },
    onTurn: opts.onTurn,
  });
  return {
    store,
    runner,
    sent,
    setConnected: (value) => {
      connected = value;
    },
  };
}

const turn = {
  sessionKey: 'agent:main:main',
  messages: [{ id: 'u1', role: 'user', text: '你好', ts: 1, turnId: 't1' }],
  text: '你好',
  prompt: 'preamble\n## 用户本轮消息\n你好',
  turnId: 't1',
  ts: 1,
};

describe('outbox runner', () => {
  it('saves before sending and marks the turn sent', async () => {
    const { runner, store, sent } = makeRunner();
    // Observe the durable record at the instant it is written: it must already
    // be a `queued` payload, before the sender is ever called.
    const writes = [];
    const original = store.saveTurnWithPending.bind(store);
    store.saveTurnWithPending = (...args) => {
      const written = original(...args);
      writes.push(written.record.status);
      return written;
    };
    const result = runner.submit(turn);
    assert.equal(result.ok, true);
    assert.deepEqual(writes, ['queued']);
    await runner.flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].turnId, 't1');
    assert.equal(store.pendingFor('t1').status, 'sent');
    // The payload is cleared from the tombstone.
    assert.equal(store.pendingFor('t1').prompt, '');
  });

  it('keeps a queued turn and sends it once the connection returns', async () => {
    const { runner, store, sent, setConnected } = makeRunner({ connected: false });
    runner.submit(turn);
    await runner.flush();
    assert.equal(sent.length, 0);
    assert.equal(store.pendingFor('t1').status, 'queued');
    setConnected(true);
    await runner.flush();
    assert.equal(sent.length, 1);
    assert.equal(store.pendingFor('t1').status, 'sent');
  });

  it('never re-sends a turn whose delivery outcome is unknown', async () => {
    let attempts = 0;
    const { runner, store } = makeRunner({
      send: async () => {
        attempts += 1;
        const error = new Error('gateway socket closed');
        error.code = 'CONNECTION_LOST';
        throw error;
      },
    });
    runner.submit(turn);
    await runner.flush();
    assert.equal(attempts, 1);
    assert.equal(store.pendingFor('t1').status, 'unknown');
    // A later flush (app restart, reconnect) must not replay it.
    await runner.flush();
    await runner.flush();
    assert.equal(attempts, 1);
    assert.equal(runner.needsAttention().length, 1);
  });

  it('only marks queued turns as sending right before the network call', async () => {
    const seen = [];
    const store = createMemorySessionStore();
    const runner = createOutboxRunner({
      store,
      isConnected: () => true,
      send: async () => {
        seen.push(store.pendingFor('t1').status);
        return { text: 'ok' };
      },
    });
    runner.submit(turn);
    await runner.flush();
    assert.deepEqual(seen, ['sending']);
  });

  it('retries only when the user asks', async () => {
    let attempts = 0;
    const store = createMemorySessionStore();
    const runner = createOutboxRunner({
      store,
      isConnected: () => true,
      send: async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('gateway chat.send timed out');
          error.code = 'TIMEOUT';
          throw error;
        }
        return { text: 'ok' };
      },
    });
    runner.submit(turn);
    await runner.flush();
    assert.equal(store.pendingFor('t1').status, 'unknown');
    const retried = await runner.retry('t1');
    assert.equal(retried.sent, 1);
    assert.equal(attempts, 2);
    // Same client turn id on the retry, so the gateway can deduplicate.
    assert.equal(store.pendingFor('t1').status, 'sent');
  });

  it('cannot discard a turn that is mid-flight', async () => {
    const store = createMemorySessionStore();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const runner = createOutboxRunner({
      store,
      isConnected: () => true,
      send: async () => {
        await gate;
        return { text: 'ok' };
      },
    });
    runner.submit(turn);
    const flush = runner.flush();
    assert.equal(store.pendingFor('t1').status, 'sending');
    const discarded = runner.discard('t1');
    assert.equal(discarded.ok, false);
    release();
    await flush;
    assert.equal(store.pendingFor('t1').status, 'sent');
  });

  it('keeps a hard failure recorded without sending it again', async () => {
    const store = createMemorySessionStore();
    let sends = 0;
    const runner = createOutboxRunner({
      store,
      isConnected: () => true,
      send: async () => {
        sends += 1;
        throw new Error('LLM request failed');
      },
    });
    runner.submit(turn);
    await runner.flush();
    await runner.flush();
    assert.equal(store.pendingFor('t1').status, 'failed');
    assert.equal(store.pendingFor('t1').prompt, turn.prompt);
    assert.equal(sends, 1);
  });

  it('reports a storage failure instead of pretending the turn was saved', () => {
    const store = createMemorySessionStore();
    store.saveTurnWithPending = () => ({ ok: false, error: new Error('QuotaExceededError') });
    const runner = createOutboxRunner({
      store,
      isConnected: () => true,
      send: async () => ({ text: 'ok' }),
    });
    const result = runner.submit(turn);
    assert.equal(result.ok, false);
    assert.match(result.error.message, /Quota/);
  });

  it('releases the send lock when recording the failure throws', async () => {
    const store = createMemorySessionStore();
    store.markFailed = () => {
      throw new Error('store broke');
    };
    let noticed = 0;
    const runner = createOutboxRunner({
      store,
      isConnected: () => true,
      send: async () => {
        throw new Error('LLM request failed');
      },
      onTurn: () => {
        noticed += 1;
      },
    });
    runner.submit({ ...turn, turnId: 't-broken' });
    await runner.flush();
    assert.equal(runner.inFlightCount(), 0);
    assert.ok(noticed >= 1);
  });

  it('does not let one session block another', async () => {
    const store = createMemorySessionStore();
    const order = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const runner = createOutboxRunner({
      store,
      isConnected: () => true,
      send: async (item) => {
        order.push(`start:${item.sessionKey}`);
        if (item.sessionKey === 'slow') await gate;
        order.push(`end:${item.sessionKey}`);
        return { text: 'ok' };
      },
    });
    store.saveTurnWithPending('slow', [], { turnId: 'slow-1', sessionKey: 'slow', message: 'a', prompt: 'a', ts: 1 });
    store.saveTurnWithPending('fast', [], { turnId: 'fast-1', sessionKey: 'fast', message: 'b', prompt: 'b', ts: 2 });
    const flush = runner.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(order.includes('end:fast'));
    assert.ok(!order.includes('end:slow'));
    release();
    await flush;
    assert.ok(order.includes('end:slow'));
  });
});

describe('isRetryable', () => {
  it('classifies transport failures as retryable and replies as not', () => {
    assert.equal(isRetryable({ code: 'CONNECTION_LOST' }), true);
    assert.equal(isRetryable({ message: 'gateway chat.send timed out' }), true);
    assert.equal(isRetryable({ message: 'LLM request failed' }), false);
    assert.equal(isRetryable({ code: 'PAIRING_REQUIRED', message: 'pairing required' }), false);
  });
});
