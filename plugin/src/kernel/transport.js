/**
 * OpenClaw gateway WebSocket: req/res correlation, buffered events, seq gaps.
 * Pass a WebSocket constructor (browser or Node `ws`).
 *
 * Every wait in this file is bounded: an `open()`, a request, or an event wait
 * always settles, so a handshake can never hang the UI forever. When a socket is
 * replaced or closed, all in-flight work fails immediately with a retryable
 * error instead of waiting out its timeout.
 */

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function frameData(data) {
  if (typeof data === 'string') return data;
  if (data == null) return '';
  // Browser MessageEvent: the payload lives on `.data`.
  if (data.data != null && data.data !== data) return frameData(data.data);
  // Node Buffer / typed array / ArrayBuffer.
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (typeof data.toString === 'function') {
    const text = data.toString();
    if (text !== '[object Object]') return text;
  }
  return '';
}

function retryable(message, code = 'CONNECTION_REPLACED') {
  const error = new Error(message);
  error.code = code;
  error.retryable = true;
  return error;
}

export class GatewaySocket {
  /**
   * @param {{
   *   WebSocketImpl: any,
   *   onEvent?: (frame: any) => void,
   *   onFrame?: (frame: any) => void,
   *   onSeqGap?: () => void,
   *   onClose?: (info: { code?: number, reason?: string }) => void,
   * }} opts
   */
  constructor(opts) {
    this.WebSocketImpl = opts.WebSocketImpl;
    this.onEvent = opts.onEvent || (() => {});
    this.onFrame = opts.onFrame || (() => {});
    this.onSeqGap = opts.onSeqGap || (() => {});
    this.onClose = opts.onClose || (() => {});
    this.ws = null;
    this.queue = [];
    this.waiters = [];
    this.eventWaiters = [];
    this.lastSeq = null;
    this.opened = false;
    this.closed = false;
  }

  /** True only while the underlying socket reports OPEN. */
  isOpen() {
    if (!this.opened || this.closed || !this.ws) return false;
    const state = this.ws.readyState;
    return state === undefined || state === 1;
  }

  open(url, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const WS = this.WebSocketImpl;
      this.closed = false;
      this.opened = false;
      let ws;
      try {
        ws = new WS(url);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.ws = ws;
      const self = this;
      let settled = false;
      let timer = null;
      const onOpen = () => {
        self.opened = true;
        finish();
      };
      const onMessage = (event) => {
        let frame;
        try {
          frame = JSON.parse(frameData(event));
        } catch {
          return;
        }
        self._accept(frame);
      };
      const onError = (event) => {
        const detail = event?.message || event?.error?.message || '';
        finish(new Error(detail ? `无法连接 ${url}（${detail}）` : `无法连接 ${url}`));
      };
      const onClose = (event) => {
        self.opened = false;
        const raw = event || {};
        const info = {
          code: raw.code,
          reason: typeof raw.reason === 'string' ? raw.reason : '',
        };
        self.rejectAllPending('gateway socket closed');
        self.onClose(info);
        finish(retryable('gateway socket closed before open', 'CONNECTION_LOST'));
      };
      const detach = () => {
        clearTimeout(timer);
        if (typeof ws.removeEventListener === 'function') {
          ws.removeEventListener('open', onOpen);
          ws.removeEventListener('message', onMessage);
          ws.removeEventListener('error', onError);
          ws.removeEventListener('close', onClose);
        } else if (typeof ws.off === 'function') {
          ws.off('open', onOpen);
          ws.off('message', onMessage);
          ws.off('error', onError);
          ws.off('close', onClose);
        }
      };
      // Only a *failed* open may release the listeners: after a successful
      // open the same `message`/`close` handlers must keep running for the life
      // of the socket.
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) detach();
        if (error) reject(error);
        else resolve();
      };
      this._detachListeners = detach;
      timer = setTimeout(() => {
        finish(retryable(`连接超时 ${url}`, 'TIMEOUT'));
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      if (typeof ws.addEventListener === 'function') {
        ws.addEventListener('open', onOpen);
        ws.addEventListener('message', onMessage);
        ws.addEventListener('error', onError);
        ws.addEventListener('close', onClose);
      } else if (typeof ws.on === 'function') {
        ws.on('open', onOpen);
        ws.on('message', onMessage);
        ws.on('error', onError);
        ws.on('close', (code, reason) => onClose({ code, reason: String(reason || '') }));
      } else {
        ws.onopen = onOpen;
        ws.onmessage = onMessage;
        ws.onerror = onError;
        ws.onclose = onClose;
      }
    });
  }

  _accept(frame) {
    if (this.closed) return;
    this.onFrame(frame);
    if (frame?.type === 'event' && typeof frame.seq === 'number') {
      if (this.lastSeq != null && frame.seq > this.lastSeq + 1) this.onSeqGap();
      this.lastSeq = frame.seq;
    }
    if (frame?.type === 'res') {
      const index = this.waiters.findIndex((waiter) => waiter.id === frame.id);
      if (index >= 0) {
        const waiter = this.waiters.splice(index, 1)[0];
        clearTimeout(waiter.timer);
        if (frame.ok) waiter.resolve(frame.payload);
        else {
          const error = new Error(frame.error?.message || 'gateway request failed');
          error.code = frame.error?.code;
          error.details = frame.error?.details;
          waiter.reject(error);
        }
        return;
      }
    }
    this.queue.push(frame);
    if (frame?.type === 'event') {
      const index = this.eventWaiters.findIndex((waiter) => waiter.event === frame.event);
      if (index >= 0) {
        const waiter = this.eventWaiters.splice(index, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
      this.onEvent(frame);
    }
  }

  /**
   * Wait for one event, bounded by `timeoutMs`. Rejects with a retryable error
   * on timeout so the caller can restart the handshake instead of hanging.
   */
  nextEvent(event, timeoutMs = 8000) {
    const existing = this.queue.find((frame) => frame?.type === 'event' && frame.event === event);
    if (existing) {
      this.queue = this.queue.filter((frame) => frame !== existing);
      return Promise.resolve(existing);
    }
    if (this.closed) return Promise.reject(retryable('gateway socket closed', 'CONNECTION_LOST'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter((waiter) => waiter.timer !== timer);
        reject(retryable(`timed out waiting for ${event}`, 'TIMEOUT'));
      }, timeoutMs);
      this.eventWaiters.push({ event, resolve, reject, timer });
    });
  }

  /** Fail in-flight RPCs immediately (socket replaced or closed). */
  rejectAllPending(message = '连接已更换') {
    const error = retryable(message);
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    for (const waiter of this.eventWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  request(method, params, timeoutMs = 30000) {
    if (this.closed || !this.ws) {
      return Promise.reject(retryable('gateway socket is not open', 'NOT_CONNECTED'));
    }
    const id = randomId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.id !== id);
        reject(retryable(`gateway ${method} timed out`, 'TIMEOUT'));
      }, timeoutMs);
      this.waiters.push({ id, resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((waiter) => waiter.id !== id);
        reject(error);
      }
    });
  }

  close() {
    this.closed = true;
    this.opened = false;
    this.rejectAllPending('gateway socket closed');
    try {
      this._detachListeners?.();
    } catch {
      /* ignore */
    }
    this._detachListeners = null;
    try {
      this.ws?.terminate?.();
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}

export function newIdempotencyKey() {
  return randomId();
}
