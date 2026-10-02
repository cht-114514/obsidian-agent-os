/**
 * OpenClaw gateway WebSocket: req/res correlation, buffered events, seq gaps.
 * Pass a WebSocket constructor (browser or Node `ws`).
 */

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function frameData(data) {
  if (typeof data === 'string') return data;
  if (data?.data != null) return frameData(data.data);
  if (typeof data?.toString === 'function') return data.toString();
  return String(data ?? '');
}

export class GatewaySocket {
  /**
   * @param {{
   *   WebSocketImpl: any,
   *   onEvent?: (frame: any) => void,
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
  }

  /** True only while the underlying socket reports OPEN. */
  isOpen() {
    if (!this.opened || !this.ws) return false;
    const state = this.ws.readyState;
    return state === undefined || state === 1;
  }

  open(url, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const WS = this.WebSocketImpl;
      const ws = new WS(url);
      this.ws = ws;
      let settled = false;
      let timer = null;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      timer = setTimeout(() => {
        finish(new Error(`连接超时 ${url}`));
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      const onOpen = () => {
        this.opened = true;
        finish();
      };
      const onMessage = (event) => {
        let frame;
        try {
          frame = JSON.parse(frameData(event));
        } catch {
          return;
        }
        this._accept(frame);
      };
      const onError = (event) => {
        const detail = event?.message || event?.error?.message || '';
        finish(new Error(detail ? `无法连接 ${url}（${detail}）` : `无法连接 ${url}`));
      };
      const onClose = (event) => {
        this.opened = false;
        const info = {
          code: event?.code,
          reason: typeof event?.reason === 'string' ? event.reason : '',
        };
        for (const waiter of this.waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('gateway socket closed'));
        }
        this.onClose(info);
        finish(new Error('gateway socket closed before open'));
      };
      if (typeof ws.addEventListener === 'function') {
        ws.addEventListener('open', onOpen);
        ws.addEventListener('message', onMessage);
        ws.addEventListener('error', onError);
        ws.addEventListener('close', onClose);
      } else {
        ws.on('open', onOpen);
        ws.on('message', onMessage);
        ws.on('error', onError);
        ws.on('close', (code, reason) => onClose({ code, reason: String(reason || '') }));
      }
    });
  }

  _accept(frame) {
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

  nextEvent(event, timeoutMs = 8000) {
    const existing = this.queue.find((frame) => frame?.type === 'event' && frame.event === event);
    if (existing) {
      this.queue = this.queue.filter((frame) => frame !== existing);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`timed out waiting for ${event}`));
      }, timeoutMs);
      this.eventWaiters.push({ event, resolve, timer });
    });
  }

  request(method, params, timeoutMs = 30000) {
    if (!this.ws) return Promise.reject(new Error('gateway socket is not open'));
    const id = randomId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.id !== id);
        reject(new Error(`gateway ${method} timed out`));
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
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.opened = false;
  }
}

export function newIdempotencyKey() {
  return randomId();
}
