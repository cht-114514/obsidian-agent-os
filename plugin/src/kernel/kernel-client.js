/**
 * Operator (and shared handshake) client for the OpenClaw gateway.
 * Does not spawn a CLI. One WebSocket, device-signed connect, chat/session RPCs.
 */
import {
  buildDeviceAuthPayloadV3,
  signDevicePayload,
} from './device-identity.js';
import { reduceActivity } from './activity.js';
import { GatewaySocket, newIdempotencyKey } from './transport.js';

export const OPERATOR_SCOPES = ['operator.read', 'operator.write', 'operator.approvals'];
export const OPERATOR_CAPS = ['tool-events', 'chat-only-assistant-text'];

export function thinkingLevelsOf(profile) {
  const levels = Array.isArray(profile?.thinkingLevels) ? profile.thinkingLevels : [];
  return levels
    .map((level) => {
      if (typeof level === 'string') {
        const id = level.trim();
        return id ? { id, label: id } : null;
      }
      const id = String(level?.id || '').trim();
      if (!id) return null;
      return { id, label: String(level.label || id) };
    })
    .filter(Boolean);
}

/**
 * Pick a thinking level the active model actually accepts.
 * A stored preference wins when it is in the catalog. Otherwise use that
 * model's own thinkingDefault. With no catalog, send nothing and let the gateway decide.
 */
export function resolveThinking(preference, profile) {
  const levels = thinkingLevelsOf(profile);
  if (!levels.length) return '';
  const pref = String(preference || '').trim().toLowerCase();
  const chosen = levels.find((level) => level.id.toLowerCase() === pref);
  if (chosen) return chosen.id;
  const fallback = String(profile?.thinkingDefault || '').trim();
  if (fallback && levels.some((level) => level.id === fallback)) return fallback;
  return '';
}

export function normalizeGatewayUrl(input) {
  const raw = String(input || '').trim() || 'ws://127.0.0.1:18789';
  if (raw.startsWith('http://')) return `ws://${raw.slice('http://'.length)}`.replace(/\/$/, '');
  if (raw.startsWith('https://')) return `wss://${raw.slice('https://'.length)}`.replace(/\/$/, '');
  return raw.replace(/\/$/, '');
}

export function pairingFromError(error) {
  const details = error?.details && typeof error.details === 'object' ? error.details : {};
  const code = details.code || error?.code || '';
  const message = error?.message || '';
  const pairing =
    code === 'PAIRING_REQUIRED' ||
    code === 'NOT_PAIRED' ||
    details.reason === 'metadata-upgrade' ||
    /pairing required/i.test(message);
  if (!pairing) return null;
  const requestId = details.requestId || null;
  const role = details.requestedRole || '';
  const approveCommand = requestId
    ? role === 'node'
      ? `openclaw nodes approve ${requestId}`
      : `openclaw devices approve ${requestId}`
    : '';
  return { requestId, role, message, approveCommand, reason: details.reason || '' };
}

function messageText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if (typeof message.text === 'string' && message.text) return message.text;
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === 'string') return part;
        return part?.text || part?.content || '';
      })
      .join('');
  }
  return '';
}

export class KernelClient {
  /**
   * @param {{
   *   url: string,
   *   token: string,
   *   identity: { deviceId: string, publicKey: string, privateKey: string },
   *   role?: 'operator' | 'node',
   *   clientId?: string,
   *   clientMode?: string,
   *   platform?: string,
   *   deviceFamily?: string,
   *   displayName?: string,
   *   scopes?: string[],
   *   caps?: string[],
   *   commands?: string[],
   *   deviceToken?: string,
   *   WebSocketImpl: any,
   * }} opts
   */
  constructor(opts) {
    this.url = normalizeGatewayUrl(opts.url);
    this.token = String(opts.token || '').trim();
    this.identity = opts.identity;
    this.role = opts.role || 'operator';
    this.clientId = opts.clientId || (this.role === 'node' ? 'node-host' : 'gateway-client');
    this.clientMode = opts.clientMode || (this.role === 'node' ? 'node' : 'backend');
    this.platform = opts.platform || 'macos';
    this.deviceFamily = opts.deviceFamily || (this.platform === 'macos' ? 'mac' : '');
    this.displayName = opts.displayName || 'Obsidian Agent OS';
    this.scopes = opts.scopes || (this.role === 'node' ? [] : OPERATOR_SCOPES);
    this.caps = opts.caps || (this.role === 'node' ? [] : OPERATOR_CAPS);
    this.commands = opts.commands || [];
    this.deviceToken = opts.deviceToken || '';
    this.WebSocketImpl = opts.WebSocketImpl;
    this.hello = null;
    this.status = { state: 'offline', role: this.role, message: '' };
    this.statusListeners = new Set();
    this.eventListeners = new Set();
    this.socket = null;
    this.reconnectTimer = null;
    this.reconnectPending = false;
    this.reconnectAttempt = 0;
    this.closedByUser = false;
    this.generation = 0;
    this.connectPromise = null;
    this.lastFrameAt = 0;
    this.heartbeatTimer = null;
  }

  socketOpen() {
    const socket = this.socket;
    if (!socket) return false;
    return typeof socket.isOpen === 'function' ? socket.isOpen() : !!socket.opened;
  }

  get isLive() {
    return this.status.state === 'live' && this.socketOpen();
  }

  onStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  setStatus(patch) {
    this.status = { ...this.status, role: this.role, ...patch };
    for (const listener of this.statusListeners) listener(this.status);
  }

  /**
   * Connect once at a time. A second caller joins the attempt already in flight
   * unless `force` asks for a fresh socket.
   * @param {{ force?: boolean }} [opts]
   */
  connect(opts = {}) {
    if (this.connectPromise && !opts.force) return this.connectPromise;
    const run = this._connect();
    const tracked = run.finally(() => {
      if (this.connectPromise === tracked) this.connectPromise = null;
    });
    this.connectPromise = tracked;
    return tracked;
  }

  async _connect() {
    this.closedByUser = false;
    const generation = ++this.generation;
    clearTimeout(this.reconnectTimer);
    this.reconnectPending = false;
    this.stopHeartbeat();
    this.setStatus({ state: 'connecting', message: '正在连接 OpenClaw…', requestId: '', approveCommand: '' });
    this.socket?.close();
    const socket = new GatewaySocket({
      WebSocketImpl: this.WebSocketImpl,
      onFrame: () => {
        this.lastFrameAt = Date.now();
      },
      onEvent: (frame) => {
        for (const listener of this.eventListeners) listener(frame);
      },
      onSeqGap: () => {
        if (generation !== this.generation || this.closedByUser) return;
        this.scheduleReconnect('事件序号断开，正在重连…');
      },
      onClose: () => {
        if (generation !== this.generation || this.closedByUser) return;
        if (this.status.state === 'live' || this.status.state === 'connecting') {
          this.scheduleReconnect('连接已断开');
        }
      },
    });
    this.socket = socket;
    try {
      await socket.open(this.url, 8000);
      const challenge = await socket.nextEvent('connect.challenge', 8000);
      const nonce = challenge.payload?.nonce;
      const signedAtMs = challenge.payload?.ts;
      if (typeof signedAtMs !== 'number' || !nonce) {
        throw new Error('gateway challenge missing ts/nonce');
      }
      const payload = buildDeviceAuthPayloadV3({
        deviceId: this.identity.deviceId,
        clientId: this.clientId,
        clientMode: this.clientMode,
        role: this.role,
        scopes: this.scopes,
        signedAtMs,
        token: this.token,
        nonce,
        platform: this.platform,
        deviceFamily: this.deviceFamily,
      });
      const signature = signDevicePayload(this.identity, payload);
      const auth = { token: this.token };
      if (this.deviceToken) auth.deviceToken = this.deviceToken;
      const hello = await socket.request('connect', {
        minProtocol: 4,
        maxProtocol: 4,
        client: {
          id: this.clientId,
          version: '0.2.0-beta',
          platform: this.platform,
          deviceFamily: this.deviceFamily,
          mode: this.clientMode,
          displayName: this.displayName,
        },
        role: this.role,
        scopes: this.scopes,
        caps: this.caps,
        commands: this.commands,
        auth,
        device: {
          id: this.identity.deviceId,
          publicKey: this.identity.publicKey,
          signature,
          signedAt: signedAtMs,
          nonce,
        },
      }, 10000);
      if (generation !== this.generation) return hello;
      this.hello = hello;
      if (hello?.auth?.deviceToken) this.deviceToken = hello.auth.deviceToken;
      this.reconnectAttempt = 0;
      this.lastFrameAt = Date.now();
      this.setStatus({ state: 'live', message: '已连接', deviceToken: this.deviceToken });
      this.startHeartbeat();
      return hello;
    } catch (error) {
      if (generation !== this.generation) throw error;
      const pairing = pairingFromError(error);
      if (pairing) {
        this.setStatus({
          state: 'pairing',
          message: pairing.message || '需要在 Mac mini 上批准这台设备',
          requestId: pairing.requestId || '',
          approveCommand: pairing.approveCommand,
        });
        return null;
      }
      this.setStatus({ state: 'offline', message: error?.message || '连接失败' });
      this.scheduleReconnect(error?.message || '连接失败');
      throw error;
    }
  }

  scheduleReconnect(message) {
    if (this.closedByUser || this.status.state === 'pairing') return;
    this.stopHeartbeat();
    this.setStatus({ state: 'offline', message });
    if (this.reconnectPending) return;
    this.reconnectPending = true;
    const base = Math.min(8000, 400 * 2 ** this.reconnectAttempt);
    const delay = Math.round(base * (0.85 + Math.random() * 0.3));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectPending = false;
      this.connect().catch(() => {});
    }, delay);
  }

  disconnect() {
    this.closedByUser = true;
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectPending = false;
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
    this.setStatus({ state: 'offline', message: '已断开' });
  }

  request(method, params, timeoutMs) {
    if (!this.socketOpen()) {
      const error = new Error('OpenClaw 未连接');
      error.code = 'NOT_CONNECTED';
      return Promise.reject(error);
    }
    return this.socket.request(method, params, timeoutMs);
  }

  /** Cheap round trip that proves the socket still reaches the gateway. */
  async probe(timeoutMs = 3500) {
    if (!this.socketOpen()) return false;
    try {
      await this.socket.request('health', {}, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Bring the connection back after the app was suspended or the network moved.
   * Keeps a healthy socket, replaces a dead one right away (no backoff wait).
   * @param {{ probeMs?: number, connectMs?: number }} [opts]
   * @returns {Promise<boolean>} true when live afterwards
   */
  async revive(opts = {}) {
    if (this.status.state === 'pairing') return false;
    const withTimeout = (promise, ms) =>
      Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
    if (this.status.state === 'connecting' && this.connectPromise) {
      await withTimeout(this.connectPromise.catch(() => {}), opts.connectMs || 12000);
      return this.isLive;
    }
    if (this.isLive && (await this.probe(opts.probeMs || 3500))) return true;
    this.reconnectAttempt = 0;
    await withTimeout(this.connect({ force: true }).catch(() => {}), opts.connectMs || 12000);
    return this.isLive;
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch(() => {});
    }, 20000);
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async heartbeat() {
    if (this.status.state !== 'live') return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (Date.now() - this.lastFrameAt < 15000 && this.socketOpen()) return;
    if (await this.probe(4000)) return;
    if (this.status.state !== 'live') return;
    this.reconnectAttempt = 0;
    await this.connect({ force: true }).catch(() => {});
  }

  async listSessions() {
    const payload = await this.request('sessions.list', {
      limit: 60,
      includeDerivedTitles: true,
      includeLastMessage: true,
      excludeCron: true,
      excludeSubagents: true,
      excludeSystem: true,
    });
    const rows = payload?.sessions || payload?.items || payload?.rows || [];
    return Array.isArray(rows) ? rows : [];
  }

  async listModels() {
    const payload = await this.request('models.list', {});
    const rows = payload?.models || payload?.items || [];
    return Array.isArray(rows) ? rows : [];
  }

  async listAgents() {
    const payload = await this.request('agents.list', {});
    return payload?.agents || payload?.items || [];
  }

  health() {
    return this.request('health', {});
  }

  /**
   * Send a chat turn and stream chat/agent/tool events until final.
   * @param {{
   *   sessionKey: string,
   *   message: string,
   *   thinking?: string,
   *   onText?: (chunk: string, full: string) => void,
   *   onThought?: (chunk: string) => void,
   *   onTool?: (event: any) => void,
   *   onActivity?: (activity: { reasoning: string, tools: any[], status: string }) => void,
   *   timeoutMs?: number,
   * }} opts
   */
  async prompt(opts) {
    const sessionKey = opts.sessionKey;
    let full = '';
    let runId = '';
    let activity = { reasoning: '', tools: [], status: '' };
    const result = await new Promise((resolve, reject) => {
      const idleMs = opts.timeoutMs || 120000;
      let settled = false;
      let timer = null;
      let stop = () => {};
      let stopStatus = () => {};
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stop();
        stopStatus();
        fn(value);
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(reject, new Error('OpenClaw 回复超时')), idleMs);
      };
      arm();
      stopStatus = this.onStatus((status) => {
        if (status.state === 'live') return;
        const error = new Error('连接中断');
        error.code = 'CONNECTION_LOST';
        finish(reject, error);
      });
      stop = this.onEvent((frame) => {
        if (frame?.type !== 'event') return;
        const payload = frame.payload || {};
        if (frame.event === 'chat' && payload.sessionKey && payload.sessionKey !== sessionKey) return;
        if (runId && payload.runId && payload.runId !== runId) return;
        if (frame.event === 'chat' || frame.event === 'agent') arm();
        const before = `${activity.reasoning}\n${activity.status}\n${activity.tools.map((tool) => `${tool.id}:${tool.phase}`).join(',')}`;
        activity = reduceActivity(activity, frame);
        const after = `${activity.reasoning}\n${activity.status}\n${activity.tools.map((tool) => `${tool.id}:${tool.phase}`).join(',')}`;
        if (after !== before) {
          opts.onActivity?.({
            reasoning: activity.reasoning,
            status: activity.status,
            tools: activity.tools.map((tool) => ({ ...tool })),
          });
          const tool = activity.tools.at(-1);
          if (tool) opts.onTool?.({ title: tool.title || tool.name, phase: tool.phase, name: tool.name });
        }
        if (frame.event === 'chat') {
          if (payload.sessionKey && payload.sessionKey !== sessionKey) return;
          if (runId && payload.runId && payload.runId !== runId) return;
          if (payload.state === 'delta') {
            if (payload.replace && payload.message) {
              full = messageText(payload.message);
            } else if (typeof payload.deltaText === 'string') {
              full += payload.deltaText;
            } else if (payload.message) {
              full = messageText(payload.message) || full;
            }
            opts.onText?.(payload.deltaText || '', full);
          } else if (payload.state === 'final') {
            const finalText = messageText(payload.message) || full;
            full = finalText;
            finish(resolve, {
              ok: true,
              text: finalText,
              stopReason: payload.stopReason || 'end_turn',
              runId: payload.runId || runId,
            });
          } else if (payload.state === 'error') {
            finish(reject, new Error(payload.errorMessage || 'agent run failed'));
          } else if (payload.state === 'aborted') {
            finish(resolve, { ok: false, text: full, stopReason: 'aborted', runId: payload.runId || runId });
          }
          return;
        }
      });
      this.request('chat.send', {
        sessionKey,
        message: opts.message,
        idempotencyKey: newIdempotencyKey(),
        ...(opts.thinking ? { thinking: opts.thinking } : {}),
      })
        .then((payload) => {
          runId = payload?.runId || '';
        })
        .catch((error) => finish(reject, error));
    });
    return result;
  }

  abort(sessionKey, runId) {
    return this.request('chat.abort', { sessionKey, ...(runId ? { runId } : {}) });
  }

  history(sessionKey, limit = 80) {
    return this.request('chat.history', { sessionKey, limit });
  }
}
