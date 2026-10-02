/**
 * The single outbound path for chat turns.
 *
 * Both "send now" and "flush the queue" go through here, so a turn can never be
 * transmitted twice and a durable record always exists before the network is
 * touched. Pure logic: no DOM, no Obsidian APIs, injectable store + sender.
 *
 * Guarantees
 * ----------
 * 1. Save first, then send. `submit()` refuses to send before the record is
 *    durably `queued`.
 * 2. One in-flight submission per session; the rest wait their turn.
 * 3. A turn is marked `sending` before its payload reaches the network, so a
 *    crash mid-flight leaves `unknown` (never re-sent), not `queued`.
 * 4. Acknowledged turns move to `sent` (payload cleared, tombstone kept).
 */

/** A missing/expired credential is not going to fix itself by retrying. */
export function isRetryable(error) {
  const code = error?.code || '';
  if (code === 'CONNECTION_REPLACED' || code === 'NOT_CONNECTED' || code === 'CONNECTION_LOST') return true;
  if (code === 'TIMEOUT' || code === 'IDLE_TIMEOUT') return true;
  const message = error?.message || '';
  if (/gateway .*timed out/i.test(message)) return true;
  if (/连接已更换|未连接|socket closed|not open|连接超时|无法连接/i.test(message)) return true;
  return false;
}

/**
 * @param {{
 *   store: any,
 *   send: (turn: any) => Promise<{ text?: string, runId?: string, ok?: boolean } | void>,
 *   onTurn?: (event: {
 *     kind: 'start'|'sent'|'unknown'|'error'|'skip',
 *     turn: any, error?: Error, result?: any,
 *   }) => void,
 *   isConnected?: () => boolean,
 * }} deps
 */
export function createOutboxRunner(deps) {
  const store = deps.store;
  const send = deps.send;
  const notify = (event) => {
    try {
      deps.onTurn?.(event);
    } catch {
      /* a UI callback must never break the queue */
    }
  };

  /** @type {Map<string, Promise<any>>} */
  const inFlight = new Map();
  /** @type {Promise<any> | null} */
  let drainTask = null;

  const connected = () => (deps.isConnected ? !!deps.isConnected() : true);

  /**
   * Persist a brand-new turn and hand it to the queue.
   * @returns {{ ok: boolean, error?: Error, turnId?: string }}
   */
  function submit({ sessionKey, messages, text, prompt, turnId, ts, thinking, model }) {
    const record = {
      turnId,
      sessionKey,
      message: String(text ?? ''),
      prompt: String(prompt ?? text ?? ''),
      ts: ts || Date.now(),
      ...(thinking ? { thinking: String(thinking) } : {}),
      ...(model ? { model: String(model) } : {}),
    };
    const written = store.saveTurnWithPending(sessionKey, messages || [], record);
    if (!written.ok) return { ok: false, error: written.error || new Error('无法保存消息') };
    if (!connected()) return { ok: true, turnId };
    flush().catch(() => {});
    return { ok: true, turnId };
  }

  /** Deliver one queued turn. Never throws. */
  async function deliver(turn) {
    if (!turn?.turnId) return { ok: false, error: new Error('missing turnId') };
    if (inFlight.has(turn.turnId)) return { ok: false, error: new Error('already sending') };
    // Freeze the transition to `sending` before any network work happens.
    store.markSending(turn.turnId);
    const task = (async () => {
      const result = await send(turn);
      store.markSent(turn.turnId, { runId: result?.runId || '' });
      notify({ kind: 'sent', turn, result });
      return { ok: true, result };
    })();
    inFlight.set(turn.turnId, task);
    try {
      return await task;
    } catch (error) {
      try {
        if (isRetryable(error)) {
          store.markUnknown(turn.turnId, error?.message || '');
          notify({ kind: 'unknown', turn, error });
        } else if (typeof store.markFailed === 'function') {
          store.markFailed(turn.turnId, error?.message || '');
          notify({ kind: 'error', turn, error });
        } else {
          notify({
            kind: 'error',
            turn,
            error: Object.assign(new Error(error?.message || '发送失败，本地状态没能记下'), {
              code: 'STATUS_WRITE_FAILED',
            }),
          });
        }
      } catch (nested) {
        notify({
          kind: 'error',
          turn,
          error: Object.assign(new Error(nested?.message || '发送失败，本地状态没能记下'), {
            code: 'STATUS_WRITE_FAILED',
          }),
        });
      }
      return { ok: false, error };
    } finally {
      inFlight.delete(turn.turnId);
    }
  }

  /** One chain per session, so a long run does not hold up other sessions. */
  const lanes = new Map();

  function pumpSession(sessionKey) {
    const existing = lanes.get(sessionKey);
    if (existing) {
      return existing.catch(() => {}).then(() => pumpSession(sessionKey));
    }
    let sent = 0;
    const run = (async () => {
      for (;;) {
        if (!connected()) return sent;
        const next = store
          .listPending()
          .filter((row) => row.status === 'queued' && (row.sessionKey || '') === sessionKey && !inFlight.has(row.turnId))
          .sort((a, b) => (a.ts || 0) - (b.ts || 0))[0];
        if (!next) return sent;
        const outcome = await deliver(next);
        if (outcome?.ok) sent += 1;
      }
    })();
    const tracked = run.finally(() => {
      if (lanes.get(sessionKey) === tracked) lanes.delete(sessionKey);
    });
    lanes.set(sessionKey, tracked);
    return tracked;
  }

  /**
   * Send every `queued` turn. Sessions run side by side; one session stays in order.
   * A message that arrives while a session is already sending is picked up by that
   * session's loop, or by the next pump chained behind it.
   */
  function flush() {
    if (!connected()) return Promise.resolve({ sent: 0, offline: true });
    const queued = store.listPending().filter((row) => row.status === 'queued');
    const keys = new Set(queued.map((row) => row.sessionKey || ''));
    for (const key of lanes.keys()) keys.add(key);
    if (!keys.size) return Promise.resolve({ sent: 0 });
    const task = Promise.all([...keys].map((key) => pumpSession(key)))
      .then((counts) => ({ sent: counts.reduce((sum, count) => sum + count, 0) }))
      .finally(() => {
        if (drainTask === task) drainTask = null;
      });
    drainTask = task;
    return task;
  }

  /**
   * Turns the user must decide about: the delivery outcome is unknown.
   */
  function needsAttention(sessionKey = '') {
    return store.listPending(sessionKey).filter((row) => row.status === 'unknown');
  }

  /** The user explicitly asks for another attempt. */
  async function retry(turnId) {
    const turn = store.pendingFor(turnId);
    if (!turn) return { ok: false, error: new Error('找不到这条消息') };
    if (turn.status === 'sending') return { ok: false, error: new Error('正在发送中') };
    store.markQueuedForRetry(turnId);
    return flush();
  }

  /** Only ever valid for a turn the gateway never received. */
  function discard(turnId) {
    const turn = store.pendingFor(turnId);
    if (!turn) return { ok: true };
    if (turn.status === 'sending') return { ok: false, error: new Error('正在发送中') };
    if (turn.status === 'sent') return { ok: false, error: new Error('这条消息已经送达') };
    store.dropTurn(turnId);
    return { ok: true };
  }

  return {
    submit,
    deliver,
    flush,
    retry,
    discard,
    needsAttention,
    /** Record a delivery confirmed outside this runner (e.g. resumed polling). */
    markSent(turnId, extra = {}) {
      return store.markSent(turnId, extra);
    },
    /** Record an unknown outcome discovered outside this runner. */
    markUnknown(turnId, reason = '') {
      return store.markUnknown(turnId, reason);
    },
    isDraining: () => !!drainTask,
    inFlightCount: () => inFlight.size,
  };
}
