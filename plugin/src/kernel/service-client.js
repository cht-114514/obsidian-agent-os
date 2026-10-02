/**
 * HTTPS client for the Mac service.
 *
 * This is the phone's only outbound path in "service mode": short requests
 * instead of a long-lived WebSocket. Nothing here holds a socket open, so a
 * locked screen, a Wi-Fi/cellular switch, or a killed WebView costs at most one
 * in-flight request — the turn itself lives in the Mac's database.
 *
 * Everything the phone needs is addressed by `clientTurnId`, so a retry after a
 * lost response resumes the same turn instead of starting a second one.
 */

import { applyTurnEvent, emptyActivity } from './activity.js';

export const TERMINAL_STATUSES = ['completed', 'failed', 'aborted'];
/** Statuses where there is nothing left to poll (a review still needs a human). */
export const SETTLED_STATUSES = [...TERMINAL_STATUSES, 'needs_verification'];

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

export function isSettledStatus(status) {
  return SETTLED_STATUSES.includes(status);
}

export function normalizeServiceUrl(input) {
  const raw = String(input || '').trim().replace(/\/+$/, '');
  if (!raw) return 'https://agent.chenhaotong.one';
  if (!/^https?:\/\//i.test(raw)) return `https://${raw}`;
  return raw.replace(/^http:\/\//i, 'https://');
}

function pollDelay(failures, baseMs) {
  if (!failures) return baseMs;
  const steps = [2000, 4000, 8000, 15000, 30000];
  const base = steps[Math.min(failures - 1, steps.length - 1)];
  return base + Math.floor(Math.random() * Math.min(400, Math.round(base * 0.1)));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(Object.assign(new Error('已取消'), { code: 'ABORTED' }));
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('已取消'), { code: 'ABORTED' }));
      },
      { once: true }
    );
  });
}

/** Polling stopped because the app went to the background; the turn is kept. */
function backgrounded(turnId, cursor) {
  return Object.assign(new Error('已转入后台，稍后继续核对'), {
    code: 'BACKGROUNDED',
    retryable: true,
    turnId,
    cursor,
  });
}

export function createServiceClient(opts) {
  const baseUrl = normalizeServiceUrl(opts.url);
  const getCredential = opts.getCredential || (() => opts.credential || '');
  const fetchImpl = opts.fetch || ((...args) => fetch(...args));
  const timeoutMs = opts.timeoutMs || 20000;

  /** POST/GET with a hard timeout that a slow tunnel cannot stretch. */
  async function request(path, { method = 'GET', body, credential, timeout = timeoutMs, signal } = {}) {
    const token = credential !== undefined ? credential : getCredential();
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = null;
    const abortExternal = () => controller?.abort();
    if (signal && controller) {
      if (signal.aborted) abortExternal();
      else signal.addEventListener('abort', abortExternal, { once: true });
    }
    if (controller) timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      const aborted = !!controller?.signal?.aborted;
      const detail = error?.message || String(error || 'network');
      const wrapped = new Error(
        aborted
          ? `请求超时（${Math.round(timeout / 1000)} 秒没有回应）：${baseUrl}`
          : `连不上 Mac 服务：${baseUrl}（${detail}）`
      );
      wrapped.code = aborted ? 'TIMEOUT' : 'NETWORK';
      wrapped.retryable = true;
      wrapped.url = baseUrl;
      wrapped.path = path;
      wrapped.cause = detail;
      throw wrapped;
    } finally {
      clearTimeout(timer);
      if (signal && controller) signal.removeEventListener('abort', abortExternal);
    }

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (response.ok) return { status: response.status, json };
    const error = new Error(json?.error?.message || `服务返回 ${response.status}`);
    error.code = json?.error?.code || `HTTP_${response.status}`;
    error.status = response.status;
    error.details = json;
    // 5xx and 429 are worth another attempt; 4xx policy answers are not.
    error.retryable = response.status >= 500 || response.status === 429;
    throw error;
  }

  return {
    baseUrl,
    hasCredential: () => !!getCredential(),

    health: () => request('/v1/health', { timeout: 8000 }),

    /** Exchange a one-time code for this device's own credential. */
    async pair(code, device = {}) {
      const result = await request('/v1/pair/claim', {
        method: 'POST',
        credential: '',
        body: { code, name: device.name || '', platform: device.platform || '' },
      });
      return result.json;
    },

    submitTurn({ clientTurnId, sessionKey, message, agentId, thinking, model, signal }) {
      return request('/v1/turns', {
        method: 'POST',
        body: {
          clientTurnId,
          sessionKey,
          message,
          ...(agentId ? { agentId } : {}),
          ...(thinking ? { thinking: String(thinking) } : {}),
          ...(model ? { model: String(model) } : {}),
        },
        signal,
      });
    },

    fetchCatalog() {
      return request('/v1/catalog');
    },

    /**
     * Step-by-step reachability report for the settings panel.
     *
     * Distinguishes the three failures that look identical on a phone:
     * DNS/network cannot reach the domain, the tunnel reaches the Mac but the
     * service is down, or the service is fine and this device is simply not
     * paired.
     */
    async diagnose(opts = {}) {
      const probeTimeout = opts.timeoutMs || 10000;
      const report = {
        url: baseUrl,
        paired: !!getCredential(),
        reachable: false,
        authenticated: false,
        serviceVersion: '',
        kernel: '',
        error: null,
      };
      // Step 1: can we reach the public entry point at all (no credential)?
      try {
        const health = await request('/v1/health', { credential: '', timeout: probeTimeout });
        report.reachable = true;
        report.serviceVersion = health.json?.service?.version || '';
        report.kernel = health.json?.kernel?.state || '';
        report.entryOk = true;
      } catch (error) {
        report.error = {
          step: 'entry',
          code: error.code,
          message: error.message,
          // Both a timeout and an immediate network error usually mean this
          // device cannot resolve or reach the domain, not that the Mac is off.
          hint:
            error.code === 'TIMEOUT' || error.code === 'NETWORK'
              ? '这台设备到域名的网络/DNS 被拦截了（VPN、公司网络、私人中继、或运营商 DNS）。先换蜂窝网络试一次；仍不行就检查服务地址拼写。'
              : '连不上域名。检查服务地址是否拼写正确，以及 Cloudflare Tunnel 是否在运行。',
        };
        return report;
      }
      // Step 2: does this device's credential still work?
      if (report.paired) {
        try {
          const health = await request('/v1/health', { timeout: probeTimeout });
          report.authenticated = true;
          report.serviceVersion = health.json?.service?.version || report.serviceVersion;
          report.kernel = health.json?.kernel?.state || report.kernel;
          report.diagnosis = health.json?.diagnosis || null;
          report.queue = health.json?.queue || null;
        } catch (error) {
          report.error = {
            step: 'auth',
            code: error.code,
            message: error.message,
            hint:
              error.code === 'UNAUTHORIZED'
                ? '设备凭据已失效或被撤销。请在 Mac 上重新生成配对码并重新配对。'
                : '服务可达，但这个请求失败了。稍后重试。',
          };
        }
      } else {
        report.error = {
          step: 'pairing',
          code: 'NOT_PAIRED',
          message: '这台设备还没有配对',
          hint: '在 Mac 上运行 agent-os pair，然后在这里填入配对码。',
        };
      }
      return report;
    },

    getTurn(turnId, after = 0, { signal } = {}) {
      return request(`/v1/turns/${encodeURIComponent(turnId)}?after=${Number(after) || 0}`, {
        timeout: 12000,
        signal,
      });
    },

    /** Read-only lookup when the submit receipt was lost. Null means the server has no row. */
    async lookupClientTurn(clientTurnId) {
      try {
        const result = await request(`/v1/turns/by-client/${encodeURIComponent(clientTurnId)}`);
        return result.json?.turn || null;
      } catch (error) {
        if (error.status === 404 || error.code === 'NOT_FOUND') return null;
        throw error;
      }
    },

    verifyTurn(turnId) {
      return request(`/v1/turns/${encodeURIComponent(turnId)}/verify`, { method: 'POST', timeout: 20000 });
    },

    cancelTurn(turnId) {
      return request(`/v1/turns/${encodeURIComponent(turnId)}/cancel`, { method: 'POST', timeout: 12000 });
    },

    retryTurn(turnId) {
      return request(`/v1/turns/${encodeURIComponent(turnId)}/retry`, { method: 'POST', timeout: 12000 });
    },

    listSessions: () => request('/v1/sessions', { timeout: 15000 }),

    history(sessionKey, limit = 60) {
      return request(`/v1/sessions/${encodeURIComponent(sessionKey)}/history?limit=${limit}`, {
        timeout: 20000,
      });
    },

    searchNotes(query, limit = 12) {
      return request(`/v1/notes/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    },

    readNote(path) {
      return request(`/v1/note?path=${encodeURIComponent(path)}`);
    },

    /**
     * Write a note. Returns the applied write, or throws with
     * `code === 'CONFIRMATION_REQUIRED'` and `details.confirm`, which the UI
     * turns into a confirmation card.
     */
    writeNote({ path, content, confirmationToken, expectFingerprint, requireExisting }) {
      return request('/v1/notes/write', {
        method: 'POST',
        body: {
          path,
          content,
          ...(confirmationToken ? { confirmationToken } : {}),
          ...(expectFingerprint ? { expectFingerprint } : {}),
          ...(requireExisting ? { requireExisting: true } : {}),
        },
      });
    },

    /** Re-read the current text behind a confirmation card (detects drift). */
    peekConfirmation(token) {
      return request(`/v1/notes/confirm/${encodeURIComponent(token)}`);
    },

    /**
     * Drive one submitted turn to completion by polling.
     *
     * Poll cadence is the plan's "every 2 s while running, stop in background".
     * The caller keeps the turn id, so a killed app resumes by polling again —
     * no result is ever only in memory.
     *
     * @param {{
     *   clientTurnId: string,
     *   sessionKey: string,
     *   message: string,
     *   signal?: AbortSignal,
     *   pollMs?: number,
     *   shouldContinue?: () => boolean,
     *   onProgress?: (event: { text?: string, status?: string, cursor: number }) => void,
     * }} turn
     */
    async runTurn(turn) {
      const pollMs = turn.pollMs || 2000;
      const shouldContinue = turn.shouldContinue || (() => true);
      const settled = (state) => state?.terminal === true || isSettledStatus(state?.status);
      const submitted = await this.submitTurn({
        clientTurnId: turn.clientTurnId,
        sessionKey: turn.sessionKey,
        message: turn.message,
        thinking: turn.thinking,
        model: turn.model,
        signal: turn.signal,
      });
      let state = submitted.json?.turn;
      if (!state?.id) {
        const error = new Error('服务没有返回任务 id');
        error.code = 'BAD_RESPONSE';
        throw error;
      }
      let cursor = state.cursor || 0;
      let text = state.result || '';
      let activity = emptyActivity();

      const pushProgress = (patch = {}) => {
        turn.onProgress?.({
          text,
          cursor,
          activity: {
            reasoning: activity.reasoning,
            status: activity.status,
            tools: activity.tools.map((tool) => ({ ...tool })),
          },
          ...patch,
        });
      };

      /**
       * Fold one turn snapshot into the local view. The server's `cursor` is
       * authoritative (it advances even when no new event is produced), and
       * individual events move it forward too.
       */
      const applyEvents = (snapshot) => {
        const events = Array.isArray(snapshot) ? snapshot : snapshot?.events;
        if (!Array.isArray(snapshot) && Number(snapshot?.cursor) > cursor) {
          cursor = Number(snapshot.cursor);
        }
        for (const event of events || []) {
          cursor = Math.max(cursor, event.seq || 0);
          if (event.kind === 'progress' || event.kind === 'result') {
            text = event.text || text;
            pushProgress();
            continue;
          }
          if (event.kind === 'thinking' || event.kind === 'tool' || event.kind === 'status') {
            activity = applyTurnEvent(activity, event);
            pushProgress({ status: activity.status || undefined });
            continue;
          }
          pushProgress({ status: event.text || '' });
        }
      };
      applyEvents(state);
      turn.onAccepted?.({
        serverTurnId: state.id,
        clientTurnId: turn.clientTurnId,
        runId: state.runId || '',
        cursor,
        model: state.model || turn.model || '',
        thinking: state.thinking || turn.thinking || '',
      });

      if (settled(state)) return this._finish(state, state.result || text);

      let stoppedInBackground = !shouldContinue();
      let failures = 0;
      for (;;) {
        if (turn.signal?.aborted) {
          throw Object.assign(new Error('已取消'), { code: 'ABORTED' });
        }
        await sleep(pollDelay(failures, pollMs), turn.signal);
        try {
          let guard = 0;
          do {
            const polled = await this.getTurn(state.id, cursor, { signal: turn.signal });
            state = polled.json?.turn || state;
            applyEvents(state);
            if (state.result) text = state.result;
            guard += 1;
          } while (state?.hasMore && guard < 20);
          failures = 0;
        } catch (error) {
          if (error?.code === 'ABORTED' || turn.signal?.aborted) {
            throw Object.assign(new Error('已取消'), { code: 'ABORTED' });
          }
          if (!error?.retryable) throw error;
          failures += 1;
          if (stoppedInBackground || !shouldContinue()) throw backgrounded(state.id, cursor);
          continue;
        }
        if (settled(state)) return this._finish(state, state.result || text);
        if (stoppedInBackground || !shouldContinue()) {
          throw backgrounded(state.id, cursor);
        }
        stoppedInBackground = false;
      }
    },

    _finish(state, text) {
      if (state.status === 'completed') {
        return { ok: true, text: state.result || text, runId: state.runId, turnId: state.id };
      }
      if (state.status === 'aborted') {
        return { ok: false, aborted: true, text, turnId: state.id };
      }
      if (state.status === 'failed') {
        const error = new Error(state.error || '执行失败');
        error.code = 'RUN_FAILED';
        error.turnId = state.id;
        throw error;
      }
      if (state.status === 'needs_verification') {
        const error = new Error(state.error || '状态未知，需要核对');
        error.code = 'NEEDS_VERIFICATION';
        error.turnId = state.id;
        throw error;
      }
      const error = new Error(`未知状态：${state.status}`);
      error.code = 'UNKNOWN_STATUS';
      throw error;
    },

    /**
     * Resume polling for a turn that was already submitted (app restart,
     * connection loss, backgrounding). Never re-submits.
     */
    async resumeTurn(turnId, { after = 0, onProgress, signal, pollMs = 2000, shouldContinue } = {}) {
      let cursor = after;
      let failures = 0;
      let activity = emptyActivity();
      for (;;) {
        let state = null;
        try {
          let guard = 0;
          do {
            const polled = await this.getTurn(turnId, cursor, { signal });
            state = polled.json?.turn;
            if (!state) {
              const error = new Error('找不到这个任务');
              error.code = 'NOT_FOUND';
              throw error;
            }
            if (Number(state.cursor) > cursor) cursor = Number(state.cursor);
            for (const event of state.events || []) {
              cursor = Math.max(cursor, event.seq || 0);
              if (event.kind === 'progress' || event.kind === 'result') {
                onProgress?.({ text: state.result || event.text || '', cursor, model: state.model, thinking: state.thinking });
              } else if (event.kind === 'thinking' || event.kind === 'tool' || event.kind === 'status') {
                activity = applyTurnEvent(activity, event);
                onProgress?.({
                  text: state.result || '',
                  status: activity.status || undefined,
                  cursor,
                  model: state.model,
                  thinking: state.thinking,
                  activity: {
                    reasoning: activity.reasoning,
                    status: activity.status,
                    tools: activity.tools.map((tool) => ({ ...tool })),
                  },
                });
              }
            }
            guard += 1;
          } while (state?.hasMore && guard < 20);
          failures = 0;
        } catch (error) {
          if (error?.code === 'ABORTED' || signal?.aborted) {
            throw Object.assign(new Error('已取消'), { code: 'ABORTED' });
          }
          if (error?.code === 'NOT_FOUND' || !error?.retryable) throw error;
          failures += 1;
          if (shouldContinue && !shouldContinue()) throw backgrounded(turnId, cursor);
          await sleep(pollDelay(failures, pollMs), signal);
          continue;
        }
        if (state?.terminal || isSettledStatus(state?.status)) {
          return this._finish(state, state.result || '');
        }
        if (signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'ABORTED' });
        if (shouldContinue && !shouldContinue()) throw backgrounded(turnId, cursor);
        await sleep(pollDelay(0, pollMs), signal);
      }
    },
  };
}

/**
 * Migrate a credential out of a synced config blob.
 * The plan requires per-device credentials that are not shared through the
 * vault, so callers use this to strip the legacy shared token once paired.
 */
export function planCredentialMigration(settings) {
  const legacy = [];
  if (settings?.gatewayToken) legacy.push('gatewayToken');
  if (settings?.serviceToken) legacy.push('serviceToken');
  return {
    legacyFields: legacy,
    shouldClear: legacy.length > 0,
  };
}
