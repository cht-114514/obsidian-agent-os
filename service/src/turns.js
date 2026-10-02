/**
 * Turn engine: the durable receive-and-execute loop.
 *
 * Rules that make "delivered" mean something
 * -----------------------------------------
 * 1. A turn is committed to SQLite before the HTTP response is written.
 * 2. The same `clientTurnId` always maps to the same turn — a retry can never
 *    start a second run.
 * 3. One running turn per session; queued turns run in arrival order.
 * 4. A run that did not settle (crash, socket loss) is never blindly re-run.
 *    It becomes `needs_verification`, and only the user can requeue it.
 * 5. Reconnecting is cheap: the phone polls `after=<seq>` for increments and
 *    reads the final result from SQLite, independent of the phone's uptime.
 */
import { randomUUID } from 'node:crypto';
import { isSettled, isTerminal } from './store.js';
import { classifyRun, progressPreview } from './turn-protocol.js';

/** Cap on stored streamed text per turn event, to keep the database small. */
const PROGRESS_CHUNK_MAX = 4000;

function errorKind(turn) {
  if (!turn) return '';
  if (turn.status === 'aborted') return 'stopped';
  if (turn.status === 'needs_verification') return 'unverified';
  if (turn.status !== 'failed') return '';
  const text = String(turn.error || '');
  if (/超时|时限/.test(text)) return 'timeout';
  if (/模型/.test(text)) return 'model';
  return 'failed';
}

export function createTurnEngine(deps) {
  const store = deps.store;
  const gateway = deps.gateway;
  const logger = deps.logger;
  const config = deps.config || {};
  const agentId = config.agentId || 'main';
  const turnTimeoutMs = config.turnTimeoutMs || 15 * 60 * 1000;

  /** @type {Map<string, { controller: AbortController, promise: Promise<any> }>} */
  const running = new Map();
  let pumpScheduled = false;
  let stopped = false;
  /** Automatic scheduling can be paused (tests, maintenance). */
  let autoPump = true;
  const idleWaiters = [];

  function notifyIdle() {
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  /**
   * Accept a turn. Commits before returning; safe to call concurrently with the
   * same `clientTurnId`.
   */
  function receiveTurn({ clientTurnId, sessionKey, message, deviceId, agentId: turnAgent, thinking, model }) {
    if (!clientTurnId || typeof clientTurnId !== 'string') {
      return { error: 'clientTurnId is required' };
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
      return { error: 'message is required' };
    }
    const key = sessionKey || config.defaultSessionKey || `agent:${turnAgent || agentId}:main`;
    const id = randomUUID();
    const existing = store.turnByClientId(clientTurnId);
    if (existing) return { turn: existing, created: false };
    const received = store.receiveTurn({
      id,
      clientTurnId,
      deviceId: deviceId || '',
      sessionKey: key,
      message,
      agentId: turnAgent || agentId,
      thinking: thinking || '',
      model: model || '',
    });
    if (received.created) {
      logger.info('turn received', {
        turnId: received.turn.id,
        sessionKey: key,
        clientTurnId,
        bytes: message.length,
      });
      schedulePump();
    }
    return received;
  }

  /** Snapshot used by `GET /v1/turns/{id}`. */
  function describeTurn(turn, afterSeq = 0) {
    const events = store.eventsAfter(turn.id, afterSeq, 400);
    return {
      id: turn.id,
      clientTurnId: turn.clientTurnId,
      sessionKey: turn.sessionKey,
      status: turn.status,
      runId: turn.runId,
      result: turn.result,
      error: turn.error,
      needsAttention: turn.needsAttention,
      attempts: turn.attempts,
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      events,
      cursor: events.length ? events[events.length - 1].seq : afterSeq,
      hasMore: events.length >= 400,
      terminal: isSettled(turn.status),
      model: turn.model || '',
      thinking: turn.thinking || '',
      progressAt: turn.updatedAt,
      errorKind: errorKind(turn),
    };
  }

  async function inspectTurn(turn) {
    const live = await gateway.ensureLive();
    if (!live) throw Object.assign(new Error('gateway unavailable'), { code: 'GATEWAY_UNAVAILABLE' });
    const history = await gateway.history(turn.sessionKey, { limit: 80 });
    const probe = classifyRun(history?.messages || [], turn.id);
    if (probe.finished) {
      store.markCompleted(turn.id, probe.text || '');
      store.appendEvent(turn.id, 'result', (probe.text || '').slice(0, PROGRESS_CHUNK_MAX));
      logger.info('reconciled finished run', { turnId: turn.id });
      return 'recovered';
    }
    store.markNeedsVerification(
      turn.id,
      probe.found
        ? '这条消息已经开始执行，但还没有最终结果。请核对后再决定。'
        : '历史里没有这条记录，不能确定它有没有执行。请核对后再决定。'
    );
    logger.warn('run not settled after restart', { turnId: turn.id, sessionKey: turn.sessionKey });
    return 'awaiting';
  }

  /**
   * Reconcile after a restart: never guess, always ask the gateway.
   * @returns {Promise<{ checked: number, recovered: number, awaiting: number }>}
   */
  async function reconcile() {
    const active = store.listActiveTurns();
    let recovered = 0;
    let awaiting = 0;
    for (const turn of active) {
      if (stopped) break;
      if (turn.status === 'queued') continue;
      try {
        const outcome = await inspectTurn(turn);
        if (outcome === 'recovered') recovered += 1;
        else awaiting += 1;
      } catch (error) {
        store.markNeedsVerification(
          turn.id,
          `无法向 OpenClaw 核对这条消息（${error?.message || 'unknown'}）。`
        );
        logger.warn('reconcile failed', { turnId: turn.id, err: error?.message });
        awaiting += 1;
      }
    }
    return { checked: active.length, recovered, awaiting };
  }

  /** Re-check one existing run. Never starts a second execution. */
  async function reconcileTurn(turnId) {
    const turn = store.turnById(turnId);
    if (!turn) return { error: 'not found' };
    if (isSettled(turn.status) || turn.status === 'queued') return { turn };
    try {
      await inspectTurn(turn);
    } catch (error) {
      store.markNeedsVerification(
        turn.id,
        `无法向 OpenClaw 核对这条消息（${error?.message || 'unknown'}）。`
      );
    }
    return { turn: store.turnById(turnId) };
  }

  function schedulePump() {
    if (pumpScheduled || stopped || !autoPump) return;
    pumpScheduled = true;
    setTimeout(() => {
      pumpScheduled = false;
      pump().catch((error) => logger.error('pump failed', { err: error?.message }));
    }, 0);
  }

  /** Start every queued turn whose session is not already busy. */
  async function pump() {
    if (stopped || !autoPump) return;
    const queued = store.listActiveTurns().filter((turn) => turn.status === 'queued');
    const claimed = new Set();
    for (const turn of queued) {
      if (stopped) break;
      if (claimed.has(turn.sessionKey)) continue;
      if (store.sessionBusy(turn.sessionKey)) continue;
      // Oldest queued turn for this session only, to keep arrival order.
      const next = store.nextQueued(turn.sessionKey);
      if (!next || next.id !== turn.id) continue;
      claimed.add(turn.sessionKey);
      runTurn(next).catch((error) => logger.error('run failed', { turnId: next.id, err: error?.message }));
    }
  }

  function progressSink(turn) {
    let lastFlush = 0;
    let lastText = '';
    return (event) => {
      try {
        if (event.kind === 'text') {
          const now = Date.now();
          // Coalesce streamed deltas so the events table stays small.
          if (now - lastFlush < 750) return;
          lastFlush = now;
          const text = String(event.text || '');
          const preview = progressPreview(text, PROGRESS_CHUNK_MAX);
          if (preview === lastText) return;
          lastText = preview;
          store.appendEvent(turn.id, 'progress', preview);
          return;
        }
        if (event.kind === 'thinking') {
          store.appendEvent(turn.id, 'thinking', String(event.text || '').slice(0, PROGRESS_CHUNK_MAX));
          return;
        }
        if (event.kind === 'tool') {
          const payload =
            event.text ||
            JSON.stringify({
              id: event.tool?.id,
              name: event.tool?.name,
              phase: event.tool?.phase,
              title: event.tool?.title,
            });
          store.appendEvent(turn.id, 'tool', String(payload || '').slice(0, 2000));
          return;
        }
        if (event.kind === 'status' && event.text) {
          store.appendEvent(turn.id, 'status', String(event.text).slice(0, 200));
        }
      } catch (error) {
        logger.warn('progress write failed', { turnId: turn.id, err: error?.message });
      }
    };
  }

  /** Execute one claimed turn. Never throws; always leaves a terminal state. */
  async function runTurn(turn) {
    if (stopped) return null;
    const controller = new AbortController();
    const claim = store.markRunning(turn.id, turn.id);
    if (!claim) return store.turnById(turn.id);
    store.appendEvent(turn.id, 'status', '已送达 Mac，开始执行');
    running.set(turn.id, { controller, promise: null });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, turnTimeoutMs);
    let live = null;
    try {
      live = await gateway.ensureLive();
      const result = await gateway.streamTurn({
        sessionKey: turn.sessionKey,
        message: turn.message,
        runId: turn.id,
        thinking: turn.thinking,
        model: turn.model,
        signal: controller.signal,
        timeoutMs: turnTimeoutMs,
        onProgress: progressSink(turn),
      });
      clearTimeout(timer);
      if (result?.aborted) {
        store.markAborted(turn.id);
        store.appendEvent(turn.id, 'status', '已终止');
        running.delete(turn.id);
        notifyIdle();
        return store.turnById(turn.id);
      }
      const text = String(result?.text || '');
      store.markCompleted(turn.id, text);
      store.appendEvent(turn.id, 'result', text.slice(0, PROGRESS_CHUNK_MAX));
      store.upsertSession(turn.sessionKey, agentId);
      logger.info('turn completed', { turnId: turn.id, bytes: text.length });
      running.delete(turn.id);
      notifyIdle();
      return store.turnById(turn.id);
    } catch (error) {
      clearTimeout(timer);
      running.delete(turn.id);
      const code = error?.code || '';
      if (code === 'TURN_TIMEOUT' || (code === 'ABORTED' && timedOut)) {
        store.markFailed(turn.id, '执行超过时限，已停止等待');
        store.appendEvent(turn.id, 'status', '执行超时');
        notifyIdle();
        return store.turnById(turn.id);
      }
      if (code === 'ABORTED') {
        store.markAborted(turn.id);
        store.appendEvent(turn.id, 'status', '已停止');
        notifyIdle();
        return store.turnById(turn.id);
      }
      if (code === 'GATEWAY_UNAVAILABLE' || code === 'NO_TOKEN' || code === 'CONNECTION_LOST') {
        // Still unknown whether the Mac-side run started: never blind-retry.
        store.markNeedsVerification(
          turn.id,
          '执行过程中与 OpenClaw 断开，无法确认这条消息是否已经执行。'
        );
        store.appendEvent(turn.id, 'status', '连接中断，需要核对');
        logger.warn('turn unresolved', { turnId: turn.id, code });
        notifyIdle();
        return store.turnById(turn.id);
      }
      store.markFailed(turn.id, error?.message || String(error));
      store.appendEvent(turn.id, 'status', `执行失败：${error?.message || 'unknown'}`);
      logger.error('turn failed', { turnId: turn.id, code, err: error?.message });
      notifyIdle();
      return store.turnById(turn.id);
    } finally {
      clearTimeout(timer);
      // Someone queued behind us: keep the session moving.
      schedulePump();
    }
  }

  /** User-initiated cancel. */
  async function cancelTurn(turnId) {
    const turn = store.turnById(turnId);
    if (!turn) return { error: 'not found' };
    if (isTerminal(turn.status)) return { turn };
    const active = running.get(turnId);
    if (active) active.controller.abort();
    try {
      await gateway.abort(turn.sessionKey, turn.id);
    } catch (error) {
      logger.warn('abort failed', { turnId, err: error?.message });
    }
    // A queued turn can be aborted locally without touching the gateway.
    if (turn.status === 'queued' || turn.status === 'interrupted') {
      store.markAborted(turnId);
      store.appendEvent(turnId, 'status', '已被用户取消');
    }
    return { turn: store.turnById(turnId) };
  }

  /**
   * The user explicitly asks for another attempt on a turn that needs review.
   * This is the only path that can re-run a non-queued turn.
   */
  function retryTurn(turnId) {
    const turn = store.turnById(turnId);
    if (!turn) return { error: 'not found' };
    if (turn.status === 'running') return { error: 'already running' };
    if (turn.status === 'completed') return { error: 'already completed' };
    const requeued = store.requeue(turnId);
    if (!requeued) return { error: `cannot retry from ${turn.status}` };
    store.appendEvent(turnId, 'status', '用户要求重发');
    schedulePump();
    return { turn: store.turnById(turnId) };
  }

  async function waitForIdle(timeoutMs = 30000) {
    if (running.size === 0 && !store.listActiveTurns().some((turn) => turn.status === 'running')) {
      return true;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      idleWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  function stop() {
    stopped = true;
    for (const { controller } of running.values()) {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }
  }

  return {
    receiveTurn,
    describeTurn,
    reconcile,
    reconcileTurn,
    pump,
    schedulePump,
    runTurn,
    cancelTurn,
    retryTurn,
    waitForIdle,
    stop,
    /** Stop (or resume) automatic scheduling; already-queued work is kept. */
    pauseScheduler() {
      autoPump = false;
    },
    resumeScheduler() {
      autoPump = true;
      schedulePump();
    },
    runningCount: () => running.size,
    isStopped: () => stopped,
  };
}
