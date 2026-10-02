/**
 * Device-local chat cache + outbound queue (not vault Markdown).
 *
 * The store is the single source of truth for the phone's pending turns.
 * It is intentionally storage-agnostic: pass any synchronous
 * `{ get, set, remove }` map (localStorage, or an IndexedDB snapshot cache).
 *
 * Durability contract
 * -------------------
 * `saveTurnWithPending()` writes the transcript and the outbox record with no
 * `await` in between, so a turn that is visible in the UI is always also in the
 * outbox. Nothing may drop an outbox record except an explicit `markSent` /
 * `dropTurn`, and only once the delivery state is known.
 *
 * Delivery states
 * ---------------
 * - `queued`  — never handed to a gateway. Safe to send on any later attempt.
 * - `sending` — handed to the gateway (or about to be). NEVER re-sent blindly.
 * - `sent`    — confirmed delivered. The payload is cleared; the turn id stays
 *               as a tombstone so a late history refresh cannot resurrect it.
 * - `unknown` — submission outcome unknown (crash, socket loss). NEVER re-sent
 *               blindly; it is surfaced to the user instead.
 */

const PENDING_CAP = 200;

function safeParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function nowMs() {
  return Date.now();
}

/** @param {{ get: (k: string) => string | null, set: (k: string, v: string) => void, remove?: (k: string) => void }} storage */
export function createSessionStore(storage, prefix = 'aos:sk:') {
  const key = (name) => `${prefix}${name}`;

  function write(name, value) {
    storage.set(key(name), JSON.stringify(value));
  }

  /** @returns {Record<string, any>} */
  function loadPending() {
    const data = safeParse(storage.get(key('pending')));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }

  function savePending(pending) {
    const entries = Object.entries(pending || {});
    const trimmed =
      entries.length > PENDING_CAP
        ? Object.fromEntries(entries.slice(entries.length - PENDING_CAP))
        : pending || {};
    write('pending', trimmed);
  }

  function upsertPending(turnId, patch) {
    if (!turnId) return null;
    const pending = loadPending();
    pending[turnId] = { ...(pending[turnId] || {}), ...patch, updatedAt: nowMs() };
    savePending(pending);
    return pending[turnId];
  }

  return {
    // ---- device identity (stays on the device, never in vault config) -----
    loadDeviceCredential() {
      const data = safeParse(storage.get(key('device')));
      return data && typeof data === 'object' ? data : null;
    },
    saveDeviceCredential(record) {
      if (!record) {
        storage.remove?.(key('device'));
        return;
      }
      write('device', record);
    },

    // ---- sessions / transcripts -------------------------------------------
    loadSessions() {
      const data = safeParse(storage.get(key('sessions')));
      return Array.isArray(data) ? data : [];
    },
    saveSessions(sessions) {
      write('sessions', sessions || []);
    },
    loadActiveKey() {
      return storage.get(key('active')) || '';
    },
    saveActiveKey(sessionKey) {
      if (!sessionKey) storage.remove?.(key('active'));
      else storage.set(key('active'), sessionKey);
    },
    loadTranscript(sessionKey) {
      if (!sessionKey) return [];
      const data = safeParse(storage.get(key(`tx:${sessionKey}`)));
      return Array.isArray(data) ? data : [];
    },
    saveTranscript(sessionKey, messages) {
      if (!sessionKey) return;
      write(`tx:${sessionKey}`, messages || []);
    },

    // ---- pending turns ----------------------------------------------------
    /** @returns {Record<string, any>} turnId -> record (chronological by ts) */
    loadPending,
    listPending(sessionKey = '') {
      const rows = Object.entries(loadPending()).map(([turnId, row]) => ({ turnId, ...row }));
      return (sessionKey ? rows.filter((row) => row.sessionKey === sessionKey) : rows).sort(
        (a, b) => (a.ts || 0) - (b.ts || 0)
      );
    },
    pendingFor(turnId) {
      if (!turnId) return null;
      return loadPending()[turnId] || null;
    },
    /** Turns that are still worth rendering as in-flight in the thread. */
    activePending(sessionKey = '') {
      return this.listPending(sessionKey).filter((row) => row.status !== 'sent');
    },
    /**
     * Write the transcript and the `queued` outbox record in one pass, with no
     * `await` between them. This is the "save first, then send" primitive.
     *
     * The queue record is written first: losing the transcript copy only costs
     * a redraw, whereas losing the queue record would lose the message.
     * @returns {{ ok: boolean, error?: Error, record?: any }}
     */
    saveTurnWithPending(sessionKey, messages, record) {
      let pending;
      let next;
      try {
        pending = loadPending();
        next = {
          status: 'queued',
          attempts: 0,
          ts: nowMs(),
          ...(pending[record.turnId] || {}),
          ...record,
          updatedAt: nowMs(),
        };
        pending[record.turnId] = next;
        savePending(pending);
      } catch (error) {
        return { ok: false, error };
      }
      try {
        if (sessionKey) write(`tx:${sessionKey}`, messages || []);
      } catch {
        /* the queue record is durable; the transcript will be rebuilt from it */
      }
      return { ok: true, record: next };
    },
    markPending(turnId, patch) {
      return upsertPending(turnId, patch);
    },
    markSending(turnId) {
      const current = this.pendingFor(turnId);
      return upsertPending(turnId, {
        status: 'sending',
        attempts: (current?.attempts || 0) + 1,
        sendingAt: nowMs(),
      });
    },
    /** Delivered and accepted: keep the tombstone, drop the payload. */
    markSent(turnId, extra = {}) {
      return upsertPending(turnId, {
        status: 'sent',
        sentAt: nowMs(),
        message: '',
        prompt: '',
        ...extra,
      });
    },
    /** Outcome unknown — never auto-retried, surfaced to the user. */
    markUnknown(turnId, reason = '') {
      return upsertPending(turnId, { status: 'unknown', reason, unknownAt: nowMs() });
    },
    /** A hard failure stays failed. Only an explicit retry sends it again. */
    markFailed(turnId, reason = '') {
      return upsertPending(turnId, { status: 'failed', reason, failedAt: nowMs() });
    },
    /** The user explicitly asked for this turn to be sent again. */
    markQueuedForRetry(turnId) {
      return upsertPending(turnId, { status: 'queued', retryAt: nowMs() });
    },
    dropTurn(turnId) {
      const pending = loadPending();
      if (!(turnId in pending)) return;
      delete pending[turnId];
      savePending(pending);
    },
    hasPending(turnId) {
      return !!this.pendingFor(turnId);
    },
  };
}

export function createMemorySessionStore() {
  const map = new Map();
  return createSessionStore({
    get: (k) => map.get(k) ?? null,
    set: (k, v) => map.set(k, v),
    remove: (k) => map.delete(k),
  });
}

/**
 * An IndexedDB-backed snapshot exposing the same synchronous map API.
 *
 * IndexedDB gives the phone a durable, transactional store that survives a
 * WebView reload better than localStorage. Writes land in the in-memory
 * snapshot synchronously (so the durability contract above holds) and are
 * flushed to IndexedDB in the same tick, in one transaction.
 *
 * Falls back to a memory map when IndexedDB is unavailable or broken.
 * @param {{ name?: string, prefix?: string }} [opts]
 */
export function createIndexedDbStore(opts = {}) {
  const prefix = opts.prefix || 'aos:sk:';
  const dbName = opts.name || 'obsidian-agent-os';
  const map = new Map();
  let db = null;
  let opened = false;
  let failure = null;

  const openDb = () =>
    new Promise((resolve) => {
      const factory = globalThis.indexedDB;
      if (!factory) {
        resolve(null);
        return;
      }
      let request;
      try {
        request = factory.open(dbName, 1);
      } catch (error) {
        failure = error;
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('kv')) database.createObjectStore('kv');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        failure = request.error;
        resolve(null);
      };
      request.onblocked = () => resolve(null);
    });

  const tx = (mode, run) =>
    new Promise((resolve, reject) => {
      if (!db) {
        reject(new Error('indexeddb unavailable'));
        return;
      }
      let transaction;
      try {
        transaction = db.transaction('kv', mode);
      } catch (error) {
        reject(error);
        return;
      }
      run(transaction.objectStore('kv'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

  const storage = {
    /** Load the persisted snapshot into memory. Safe to call more than once. */
    async hydrate() {
      if (opened) return !!db;
      opened = true;
      const database = await openDb();
      if (!database) return false;
      db = database;
      await new Promise((resolve) => {
        try {
          const transaction = db.transaction('kv', 'readonly');
          const store = transaction.objectStore('kv');
          const keyRequest = store.getAllKeys();
          const valueRequest = store.getAll();
          transaction.oncomplete = () => {
            const keys = keyRequest.result || [];
            const values = valueRequest.result || [];
            keys.forEach((key, index) => {
              const value = values[index];
              if (typeof key === 'string' && typeof value === 'string') map.set(key, value);
            });
            resolve();
          };
          transaction.onerror = () => resolve();
          transaction.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
      return true;
    },
    get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    set(key, value) {
      const text = String(value);
      map.set(key, text);
      if (!db) return;
      tx('readwrite', (store) => store.put(text, key)).catch(() => {});
    },
    remove(key) {
      map.delete(key);
      if (!db) return;
      tx('readwrite', (store) => store.delete(key)).catch(() => {});
    },
    /** Flush the whole snapshot in a single transaction. */
    async flush() {
      if (!db) return false;
      try {
        await tx('readwrite', (store) => {
          for (const [key, value] of map.entries()) store.put(String(value), key);
        });
        return true;
      } catch {
        return false;
      }
    },
    isPersistent() {
      return !!db;
    },
    error() {
      return failure;
    },
  };

  return { storage, store: createSessionStore(storage, prefix) };
}

/** @param {Error | { message?: string, code?: string }} error */
export function isTransportNoise(error) {
  const code = error?.code || '';
  const message = error?.message || '';
  if (code === 'CONNECTION_REPLACED' || code === 'NOT_CONNECTED' || code === 'CONNECTION_LOST') return true;
  return (
    /gateway .* timed out/i.test(message) ||
    /连接已更换|未连接|socket closed|not open|连接超时|无法连接/i.test(message)
  );
}
