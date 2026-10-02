import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { createTurnEngine } from '../src/turns.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * A scriptable gateway double.
 * - `behaviour` decides what `streamTurn` does for each call.
 * - history results are set per run id for reconciliation tests.
 */
function createFakeGateway(opts = {}) {
  const calls = [];
  const aborts = [];
  const history = opts.history || [];
  const self = {
    calls,
    aborts,
    /** A test may set this to control what the gateway "remembers". */
    historyFor: opts.historyFor || null,
    /** A test may set this to control how a run settles. */
    behaviour: opts.behaviour || null,
    offline: !!opts.offline,
    async ensureLive() {
      if (self.offline) {
        const error = new Error('OpenClaw 未连接');
        error.code = 'GATEWAY_UNAVAILABLE';
        throw error;
      }
      return self;
    },
    isLive: () => !self.offline,
    status: () => ({ state: self.offline ? 'offline' : 'live', message: '' }),
    async streamTurn(turn) {
      calls.push(turn);
      const behave = self.behaviour || (async () => ({ ok: true, text: 'ok', runId: turn.runId }));
      return behave(turn);
    },
    async abort(sessionKey, runId) {
      aborts.push({ sessionKey, runId });
    },
    async history() {
      return { messages: self.historyFor ? self.historyFor() : history };
    },
    findRunInHistory(payload, runId) {
      const rows = (payload?.messages || []).filter((row) => row?.__openclaw?.runId === runId);
      const assistant = rows.filter((row) => row.role === 'assistant');
      return {
        found: rows.length > 0,
        finished: assistant.length > 0,
        text: assistant.map((row) => row.text || '').join('\n'),
      };
    },
  };
  return self;
}

function makeEngine(gatewayOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aos-engine-'));
  const store = createStore(join(dir, 'engine.sqlite'));
  const gateway = createFakeGateway(gatewayOpts);
  const engine = createTurnEngine({
    store,
    gateway,
    logger: silentLogger,
    config: { agentId: 'main', defaultSessionKey: 'agent:main:main', turnTimeoutMs: 5000 },
  });
  // Reconciliation tests set up a crashed state by hand, and a live scheduler
  // would race them. Everything else keeps the automatic nudge.
  if (gatewayOpts.noNudge) engine.pauseScheduler();
  return {
    dir,
    store,
    gateway,
    engine,
    cleanup() {
      engine.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('turn engine', { concurrency: 1 }, () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  it('claims a queued turn and records the result', async () => {
    ctx = makeEngine();
    const { engine, store, gateway } = ctx;
    const { turn } = engine.receiveTurn({
      clientTurnId: 'c-1',
      sessionKey: 'agent:main:main',
      message: 'hi',
    });
    assert.equal(turn.status, 'queued');
    await engine.pump();
    await engine.waitForIdle(3000);
    const done = store.turnById(turn.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.result, 'ok');
    assert.equal(gateway.calls.length, 1);
    // The gateway is called with our own turn id, so a retry is deduplicated.
    assert.equal(gateway.calls[0].runId, turn.id);
    const events = store.eventsAfter(turn.id, 0, 20).map((row) => row.kind);
    assert.ok(events.includes('status'));
    assert.ok(events.includes('result'));
  });

  it('runs one turn at a time per session, in arrival order', async () => {
    const order = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    ctx = makeEngine({
      behaviour: async (turn) => {
        order.push(turn.message);
        if (order.length === 1) await gate;
        return { ok: true, text: turn.message, runId: turn.runId };
      },
    });
    const { engine, store } = ctx;
    const first = engine.receiveTurn({ clientTurnId: 'c-1', sessionKey: 's', message: 'one' }).turn;
    const second = engine.receiveTurn({ clientTurnId: 'c-2', sessionKey: 's', message: 'two' }).turn;
    engine.schedulePump();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(order, ['one']);
    assert.equal(store.turnById(first.id).status, 'running');
    assert.equal(store.turnById(second.id).status, 'queued');
    release();
    await engine.waitForIdle(3000);
    await engine.pump();
    await engine.waitForIdle(3000);
    assert.deepEqual(order, ['one', 'two']);
    assert.equal(store.turnById(second.id).status, 'completed');
  });

  it('never re-runs a turn whose outcome is unknown', async () => {
    let attempts = 0;
    ctx = makeEngine({
      offline: true,
      behaviour: async () => {
        attempts += 1;
        return { ok: true, text: 'should not happen' };
      },
    });
    const { engine, store } = ctx;
    const { turn } = engine.receiveTurn({ clientTurnId: 'c-1', sessionKey: 's', message: 'x' });
    await engine.pump();
    await engine.waitForIdle(3000);
    const row = store.turnById(turn.id);
    assert.equal(row.status, 'needs_verification');
    assert.equal(row.needsAttention, true);
    assert.equal(attempts, 0);
    // Further pumps must not touch it.
    await engine.pump();
    await engine.waitForIdle(1000);
    assert.equal(store.turnById(turn.id).status, 'needs_verification');
    assert.equal(store.nextQueued('s'), null);
  });

  it('re-runs a needs_verification turn only when the user asks', async () => {
    ctx = makeEngine({ offline: true });
    const { engine, store } = ctx;
    const { turn } = engine.receiveTurn({ clientTurnId: 'c-1', sessionKey: 's', message: 'x' });
    await engine.pump();
    await engine.waitForIdle(3000);
    assert.equal(store.turnById(turn.id).status, 'needs_verification');

    // The user explicitly retries.
    const listed = engine.retryTurn(turn.id);
    assert.equal(listed.turn.status, 'queued');
    await engine.pump();
    await engine.waitForIdle(3000);
    assert.equal(store.turnById(turn.id).status, 'needs_verification');
  });

  it('marks a completed turn completed after a restart reconciliation', async () => {
    ctx = makeEngine({ noNudge: true });
    const { engine, store, gateway } = ctx;
    const { turn } = engine.receiveTurn({ clientTurnId: 'c-1', sessionKey: 's', message: 'x' });
    ctx.gateway.historyFor = () => [
      { role: 'assistant', text: 'finished while we were away', __openclaw: { runId: turn.id } },
    ];
    // Simulate a crash: the row is left running, the gateway actually finished.
    store.markRunning(turn.id, turn.id);
    const result = await engine.reconcile();
    assert.equal(result.checked, 1);
    assert.equal(result.recovered, 1);
    const row = store.turnById(turn.id);
    assert.equal(row.status, 'completed');
    assert.equal(row.result, 'finished while we were away');
    assert.equal(gateway.calls.length, 0);
  });

  it('does not treat a tool-use assistant row as a finished run', async () => {
    ctx = makeEngine({ noNudge: true });
    const { engine, store } = ctx;
    const { turn } = engine.receiveTurn({ clientTurnId: 'c-1', sessionKey: 's', message: 'x' });
    ctx.gateway.historyFor = () => [
      {
        role: 'assistant',
        text: 'calling a tool',
        stopReason: 'toolUse',
        __openclaw: { runId: turn.id },
      },
    ];
    store.markRunning(turn.id, turn.id);
    await engine.reconcile();
    assert.equal(store.turnById(turn.id).status, 'needs_verification');
  });

  it('asks for review when the gateway holds the run but no result', async () => {
    ctx = makeEngine({ noNudge: true });
    const { engine, store } = ctx;
    const { turn } = engine.receiveTurn({ clientTurnId: 'c-1', sessionKey: 's', message: 'x' });
    ctx.gateway.historyFor = () => [{ role: 'user', text: 'x', __openclaw: { runId: turn.id } }];
    store.markRunning(turn.id, turn.id);
    await engine.reconcile();
    const row = store.turnById(turn.id);
    assert.equal(row.status, 'needs_verification');
    assert.equal(row.needsAttention, true);
    assert.match(row.error, /核对|确认/);
  });

  it('keeps an unseen run for review instead of requeueing it', async () => {
    ctx = makeEngine({ noNudge: true });
    const { engine, store } = ctx;
    const { turn } = engine.receiveTurn({ clientTurnId: 'c-1', sessionKey: 's', message: 'x' });
    ctx.gateway.historyFor = () => [];
    store.markRunning(turn.id, turn.id);
    const result = await engine.reconcile();
    assert.equal(result.checked, 1);
    assert.equal(store.turnById(turn.id).status, 'needs_verification');
    assert.match(store.turnById(turn.id).error, /不能确定/);
    assert.equal(ctx.gateway.calls.length, 0);
  });

  it('does not guess when reconciliation itself fails', async () => {
    ctx = makeEngine({ offline: true });
    const { engine, store } = ctx;
    const { turn } = engine.receiveTurn({ clientTurnId: 'c-1', sessionKey: 's', message: 'x' });
    store.markRunning(turn.id, turn.id);
    await engine.reconcile();
    const row = store.turnById(turn.id);
    assert.equal(row.status, 'needs_verification');
    assert.match(row.error, /无法向 OpenClaw 核对/);
  });

  it('treats reconnect loss mid-run as unknown, not as a failure to retry', async () => {
    ctx = makeEngine({
      behaviour: async () => {
        const error = new Error('连接中断');
        error.code = 'CONNECTION_LOST';
        throw error;
      },
    });
    const { engine, store } = ctx;
    const { turn } = engine.receiveTurn({ clientTurnId: 'c-1', sessionKey: 's', message: 'x' });
    await engine.pump();
    await engine.waitForIdle(3000);
    const row = store.turnById(turn.id);
    assert.equal(row.status, 'needs_verification');
    assert.match(row.error, /无法确认/);
  });

  it('records a hard execution failure as failed', async () => {
    ctx = makeEngine({
      behaviour: async () => {
        throw new Error('LLM request failed');
      },
    });
    const { engine, store } = ctx;
    const { turn } = engine.receiveTurn({ clientTurnId: 'c-1', sessionKey: 's', message: 'x' });
    await engine.pump();
    await engine.waitForIdle(3000);
    const row = store.turnById(turn.id);
    assert.equal(row.status, 'failed');
    assert.match(row.error, /LLM request failed/);
  });

  it('cancels a queued turn without ever calling the gateway', async () => {
    ctx = makeEngine();
    const { engine, store, gateway } = ctx;
    const { turn } = engine.receiveTurn({ clientTurnId: 'c-1', sessionKey: 's', message: 'x' });
    const result = await engine.cancelTurn(turn.id);
    assert.equal(result.turn.status, 'aborted');
    assert.equal(gateway.calls.length, 0);
    assert.equal(store.nextQueued('s'), null);
  });

  it('reports progress increments the phone can poll', async () => {
    ctx = makeEngine({
      behaviour: async (turn) => {
        turn.onProgress({ kind: 'status', text: 'thinking' });
        turn.onProgress({ kind: 'text', text: 'half an answer' });
        await new Promise((resolve) => setTimeout(resolve, 800));
        turn.onProgress({ kind: 'text', text: 'full answer' });
        return { ok: true, text: 'full answer', runId: turn.runId };
      },
    });
    const { engine, store } = ctx;
    const { turn } = engine.receiveTurn({ clientTurnId: 'c-1', sessionKey: 's', message: 'x' });
    await engine.pump();
    await engine.waitForIdle(4000);
    const described = engine.describeTurn(store.turnById(turn.id), 0);
    const kinds = described.events.map((row) => row.kind);
    assert.ok(kinds.includes('status'));
    assert.equal(described.terminal, true);
    assert.equal(described.result, 'full answer');
    // `after` returns only what is new.
    const cursor = described.events[0].seq;
    const incremental = engine.describeTurn(store.turnById(turn.id), cursor);
    assert.ok(incremental.events.every((row) => row.seq > cursor));
  });
});
