import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, isActive, isTerminal } from '../src/store.js';

let dir;
let store;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'aos-store-'));
  store = createStore(join(dir, 'test.sqlite'));
});

after(() => {
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('turn store', () => {
  it('accepts a turn durably and reports the same row for a repeat clientTurnId', () => {
    const first = store.receiveTurn({
      id: 'turn-1',
      clientTurnId: 'c-1',
      deviceId: 'dev-1',
      sessionKey: 'agent:main:main',
      message: 'hello',
    });
    assert.equal(first.created, true);
    assert.equal(first.turn.status, 'queued');
    const repeat = store.receiveTurn({
      id: 'turn-2',
      clientTurnId: 'c-1',
      deviceId: 'dev-1',
      sessionKey: 'agent:main:main',
      message: 'hello',
    });
    assert.equal(repeat.created, false);
    assert.equal(repeat.turn.id, 'turn-1');
    // No second row was created.
    assert.equal(store.turnsForSession('agent:main:main', 50).length, 1);
  });

  it('walks the lifecycle and clears nothing a reader needs', () => {
    store.receiveTurn({
      id: 'turn-2',
      clientTurnId: 'c-2',
      sessionKey: 's-2',
      message: 'm2',
    });
    assert.ok(isActive('queued'));
    const running = store.markRunning('turn-2', 'run-2');
    assert.equal(running.status, 'running');
    assert.equal(running.runId, 'run-2');
    assert.equal(running.attempts, 1);
    // A second markRunning must not restart an already-running turn.
    assert.equal(store.markRunning('turn-2', 'run-other'), null);
    const done = store.markCompleted('turn-2', 'the answer');
    assert.equal(done.status, 'completed');
    assert.equal(done.result, 'the answer');
    assert.ok(isTerminal('completed'));
    assert.equal(store.markRunning('turn-2', 'again'), null);
  });

  it('records streamed events in order and supports after=<seq>', () => {
    store.receiveTurn({ id: 'turn-3', clientTurnId: 'c-3', sessionKey: 's-3', message: 'm3' });
    store.markRunning('turn-3', 'turn-3');
    const a = store.appendEvent('turn-3', 'status', 'start');
    const b = store.appendEvent('turn-3', 'progress', 'partial');
    const c = store.appendEvent('turn-3', 'result', 'final');
    assert.deepEqual([a, b, c], [1, 2, 3]);
    assert.deepEqual(
      store.eventsAfter('turn-3', 0, 10).map((row) => row.text),
      ['start', 'partial', 'final']
    );
    assert.deepEqual(
      store.eventsAfter('turn-3', 1, 10).map((row) => row.text),
      ['partial', 'final']
    );
    assert.deepEqual(store.eventsAfter('turn-3', 3, 10), []);
  });

  it('only requeues turns the user asked to redo', () => {
    store.receiveTurn({ id: 'turn-4', clientTurnId: 'c-4', sessionKey: 's-4', message: 'm4' });
    store.markRunning('turn-4', 'turn-4');
    store.markNeedsVerification('turn-4', 'unknown');
    const row = store.turnById('turn-4');
    assert.equal(row.status, 'needs_verification');
    assert.equal(row.needsAttention, true);
    // It must not be picked up as normal queued work.
    assert.equal(store.nextQueued('s-4'), null);
    const requeued = store.requeue('turn-4');
    assert.equal(requeued.status, 'queued');
    assert.equal(requeued.needsAttention, false);
    assert.equal(store.nextQueued('s-4').id, 'turn-4');
  });

  it('keeps one running turn per session visible to the scheduler', () => {
    store.receiveTurn({ id: 'turn-5', clientTurnId: 'c-5', sessionKey: 's-5', message: 'a' });
    store.receiveTurn({ id: 'turn-6', clientTurnId: 'c-6', sessionKey: 's-5', message: 'b' });
    assert.equal(store.sessionBusy('s-5'), false);
    assert.equal(store.nextQueued('s-5').id, 'turn-5');
    store.markRunning('turn-5', 'turn-5');
    assert.equal(store.sessionBusy('s-5'), true);
    // The next queued turn for the session is still the second one.
    assert.equal(store.nextQueued('s-5').id, 'turn-6');
  });

  it('marks an interrupted run instead of silently replaying it', () => {
    store.receiveTurn({ id: 'turn-7', clientTurnId: 'c-7', sessionKey: 's-7', message: 'm' });
    store.markRunning('turn-7', 'turn-7');
    const interrupted = store.markInterrupted('turn-7', 'service restarted');
    assert.equal(interrupted.status, 'interrupted');
    // Interrupted is still active, so the scheduler can look at it again.
    assert.ok(isActive('interrupted'));
    assert.ok(store.listActiveTurns().some((row) => row.id === 'turn-7'));
  });

  it('tracks sessions separately from turns', () => {
    const sessions = store.listSessions(50);
    assert.ok(sessions.some((row) => row.key === 'agent:main:main'));
    store.upsertSession('agent:main:other', 'main', '另一个会话');
    const row = store.listSessions(50).find((item) => item.key === 'agent:main:other');
    assert.equal(row.label, '另一个会话');
    assert.equal(store.deleteSession('agent:main:other'), true);
    assert.equal(store.listSessions(50).some((item) => item.key === 'agent:main:other'), false);
  });

  it('survives a reopen with every turn intact', () => {
    const path = join(dir, 'reopen.sqlite');
    const first = createStore(path);
    first.receiveTurn({ id: 'p-1', clientTurnId: 'pc-1', sessionKey: 'ps', message: 'persist me' });
    first.markRunning('p-1', 'p-1');
    first.close();
    const second = createStore(path);
    const row = second.turnById('p-1');
    assert.equal(row.status, 'running');
    assert.equal(row.message, 'persist me');
    second.close();
  });
});
