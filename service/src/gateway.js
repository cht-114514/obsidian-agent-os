/**
 * Node-side OpenClaw gateway client for the Mac service.
 *
 * Reuses the plugin's tested transport/handshake (`transport.js`,
 * `kernel-client.js`, `device-identity.js`) so there is exactly one
 * implementation of the gateway protocol in this project.
 *
 * Additions over the plugin client:
 *  - `streamTurn()` drives one `chat.send` to completion and can be cancelled,
 *    reusing the caller's run id so a retry is deduplicated by the gateway.
 *  - `findRun()` reconciles an existing run after a service restart.
 *  - No DOM assumptions.
 */
import WebSocket from 'ws';
import { KernelClient } from '../../plugin/src/kernel/kernel-client.js';
import { createMemoryStore, loadOrCreateIdentity } from '../../plugin/src/kernel/device-identity.js';
import { emptyActivity, reduceActivity } from '../../plugin/src/kernel/activity.js';
import { chatSendParams, classifyRun, sessionPatchForTurn } from './turn-protocol.js';

const SCOPES = ['operator.read', 'operator.write', 'operator.approvals'];
const CAPS = ['tool-events', 'chat-only-assistant-text'];

/** Flatten an OpenClaw message content array into plain text. */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && (part.type === 'text' || typeof part.text === 'string'))
    .map((part) => part.text || '')
    .join('');
}

export function createGateway(opts) {
  const identityStore = opts.identityStore || createMemoryStore();
  const client = new KernelClient({
    url: opts.url,
    token: opts.token,
    identity: loadOrCreateIdentity(identityStore),
    role: 'operator',
    clientId: 'gateway-client',
    clientMode: 'backend',
    platform: 'macos',
    deviceFamily: 'mac',
    displayName: opts.displayName || 'Agent OS Mac service',
    scopes: SCOPES,
    caps: CAPS,
    deviceToken: opts.deviceToken || '',
    WebSocketImpl: opts.WebSocketImpl || WebSocket,
  });

  const listeners = new Set();
  client.onEvent((frame) => {
    for (const listener of listeners) {
      try {
        listener(frame);
      } catch {
        /* a listener must never break the socket */
      }
    }
  });

  const logger = opts.logger || { info() {}, warn() {}, debug() {}, error() {} };
  /** One patch+send at a time per session, so a queued message cannot overwrite the model. */
  const lanes = new Map();

  function withSessionLane(sessionKey, fn) {
    const key = sessionKey || '';
    const prev = lanes.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tracked = run.finally(() => {
      if (lanes.get(key) === tracked) lanes.delete(key);
    });
    lanes.set(key, tracked);
    return run;
  }

  async function applySessionSettings(turn) {
    const patch = sessionPatchForTurn(turn);
    if (!patch) return;
    try {
      await request('sessions.patch', patch, 15000);
    } catch (error) {
      const model = String(turn.model || '').trim();
      const wrapped = new Error(
        model
          ? `没能切换到模型 ${model}：${error?.message || 'OpenClaw 拒绝了这次设置'}`
          : `没能设置思考强度：${error?.message || 'OpenClaw 拒绝了这次设置'}`
      );
      wrapped.code = 'MODEL_REJECTED';
      throw wrapped;
    }
  }

  async function ensureLive() {
    if (opts.token == null || opts.token === '') {
      const error = new Error('gateway token is missing');
      error.code = 'NO_TOKEN';
      throw error;
    }
    if (client.status.state === 'live' && client.isLive) return client;
    const ok = await client.revive({ connectMs: opts.connectMs || 12000 });
    if (!ok) {
      const error = new Error(client.status?.message || 'OpenClaw 未连接');
      error.code = 'GATEWAY_UNAVAILABLE';
      error.status = client.status;
      throw error;
    }
    return client;
  }

  async function request(method, params, timeoutMs) {
    await ensureLive();
    return client.request(method, params, timeoutMs);
  }

  return {
    client,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status() {
      return { ...client.status };
    },
    isLive() {
      return client.status.state === 'live';
    },
    async close() {
      listeners.clear();
      client.disconnect();
    },
    ensureLive,
    request,
    health: () => request('health', {}, 8000),
    listSessions: () => client.listSessions(),
    listModels: () => client.listModels(),
    listAgents: () => client.listAgents(),
    async catalog() {
      await ensureLive();
      const [models, agents] = await Promise.all([
        client.listModels().catch(() => []),
        client.listAgents().catch(() => []),
      ]);
      return { models, agents };
    },
    async history(sessionKey, { limit = 60, after = '' } = {}) {
      const params = { sessionKey, limit };
      if (after) params.after = after;
      const payload = await request('chat.history', params, 30000);
      return payload || {};
    },
    /**
     * True when the transcript holds an assistant message produced by `runId`.
     * Used to decide whether a run already finished before we restarted.
     */
    findRunInHistory(payload, runId) {
      return classifyRun(payload?.messages || [], runId);
    },
    /**
     * Drive one chat turn to completion.
     *
     * @param {{
     *   sessionKey: string,
     *   message: string,
     *   runId: string,
     *   thinking?: string,
     *   model?: string,
     *   signal?: AbortSignal,
     *   timeoutMs?: number,
     *   onProgress?: (event: { kind: 'text'|'tool'|'status'|'thinking', text?: string, status?: string, tool?: any }) => void,
     * }} turn
     */
    streamTurn(turn) {
      return withSessionLane(turn.sessionKey, () => this.streamTurnNow(turn));
    },
    async streamTurnNow(turn) {
      const sessionKey = turn.sessionKey;
      await applySessionSettings(turn);
      const idleMs = turn.timeoutMs || opts.turnTimeoutMs || 15 * 60 * 1000;
      let full = '';
      let aborted = false;
      let activity = emptyActivity();

      const emitActivity = () => {
        if (activity.reasoning) {
          turn.onProgress?.({ kind: 'thinking', text: activity.reasoning });
        }
        for (const tool of activity.tools) {
          turn.onProgress?.({
            kind: 'tool',
            tool,
            text: JSON.stringify({
              id: tool.id,
              name: tool.name,
              phase: tool.phase,
              title: tool.title,
              args: tool.args,
            }),
          });
        }
        if (activity.status) {
          turn.onProgress?.({ kind: 'status', text: activity.status, status: activity.status });
        }
      };

      const result = await new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        let unsubscribe = () => {};
        let stopStatus = () => {};
        let runId = turn.runId;

        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          stopStatus();
          fn(value);
        };
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            finish(reject, Object.assign(new Error('OpenClaw 回复超时'), { code: 'TURN_TIMEOUT' }));
          }, idleMs);
        };
        const cancel = async () => {
          aborted = true;
          try {
            await client.abort(sessionKey, runId);
          } catch {
            /* the abort is best-effort; the caller still gets the failure */
          }
          finish(reject, Object.assign(new Error('已终止'), { code: 'ABORTED' }));
        };
        if (turn.signal) {
          if (turn.signal.aborted) {
            finish(reject, Object.assign(new Error('已终止'), { code: 'ABORTED' }));
            return;
          }
          turn.signal.addEventListener('abort', cancel, { once: true });
        }
        arm();

        stopStatus = client.onStatus((status) => {
          if (status.state === 'live' || status.state === 'connecting') return;
          finish(reject, Object.assign(new Error('连接中断'), { code: 'CONNECTION_LOST' }));
        });

        unsubscribe = (() => {
          const handler = (frame) => {
            if (frame?.type !== 'event') return;
            const payload = frame.payload || {};
            if (frame.event === 'chat') {
              if (payload.sessionKey && payload.sessionKey !== sessionKey) return;
              if (runId && payload.runId && payload.runId !== runId) return;
              if (payload.runId && !runId) runId = payload.runId;
              arm();
              if (payload.state === 'delta') {
                if (payload.replace && payload.message) {
                  full = contentText(payload.message?.content) || full;
                } else if (typeof payload.deltaText === 'string') {
                  full += payload.deltaText;
                } else if (payload.message) {
                  full = contentText(payload.message.content) || full;
                }
                turn.onProgress?.({ kind: 'text', text: full });
                return;
              }
              if (payload.state === 'final') {
                const finalText = contentText(payload.message?.content) || full;
                finish(resolve, {
                  ok: true,
                  text: finalText,
                  runId: payload.runId || runId,
                  stopReason: payload.stopReason || 'end_turn',
                });
                return;
              }
              if (payload.state === 'error') {
                finish(
                  reject,
                  Object.assign(new Error(payload.errorMessage || 'agent run failed'), {
                    code: 'RUN_FAILED',
                  })
                );
                return;
              }
              if (payload.state === 'aborted') {
                finish(resolve, {
                  ok: false,
                  aborted: true,
                  text: full,
                  runId: payload.runId || runId,
                  stopReason: 'aborted',
                });
              }
              const beforeChat = JSON.stringify(activity);
              activity = reduceActivity(activity, frame);
              if (JSON.stringify(activity) !== beforeChat) emitActivity();
              return;
            }
            const before = JSON.stringify(activity);
            activity = reduceActivity(activity, frame);
            if (JSON.stringify(activity) !== before) emitActivity();
          };
          return client.onEvent(handler);
        })();

        client
          .request('chat.send', chatSendParams(turn), 30000)
          .then((payload) => {
            const status = payload?.status;
            if (payload?.runId) runId = payload.runId;
            if (status === 'in_flight') {
              // The gateway already has this run; keep streaming its events.
              turn.onProgress?.({ kind: 'status', text: '已在执行' });
              arm();
            }
          })
          .catch((error) => finish(reject, error));
      });

      if (aborted) {
        const error = new Error('已终止');
        error.code = 'ABORTED';
        throw error;
      }
      return result;
    },
    async abort(sessionKey, runId) {
      return client.abort(sessionKey, runId);
    },
  };
}
