/**
 * Durable turn store (SQLite via node:sqlite).
 *
 * Every write the phone depends on goes through a transaction here *before* a
 * response is sent. "已送达" means committed, not "received over the wire".
 *
 * Turn lifecycle
 * --------------
 *   queued -> running -> completed
 *                     -> failed
 *                     -> aborted
 *   any    -> needs_verification   (outcome on the Mac cannot be determined)
 *   running -> interrupted         (service died mid-run; reconciled on boot)
 *
 * A terminal turn is never re-executed. A `needs_verification` turn requires an
 * explicit user decision, because blindly re-running it could repeat a write.
 */
import { DatabaseSync } from 'node:sqlite';

const TERMINAL = new Set(['completed', 'failed', 'aborted']);
/**
 * Statuses where polling must stop. `needs_verification` is not terminal for
 * scheduling (a user may requeue it) but it is settled for the phone: there is
 * nothing more to poll, and the decision belongs to the user.
 */
const SETTLED = new Set([...TERMINAL, 'needs_verification']);

export function isTerminal(status) {
  return TERMINAL.has(status);
}

export function isSettled(status) {
  return SETTLED.has(status);
}

/** Statuses where the phone should keep polling. */
export function isActive(status) {
  return status === 'queued' || status === 'running' || status === 'interrupted';
}

function now() {
  return Date.now();
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function createStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      client_turn_id TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT '',
      session_key TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      run_id TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      needs_attention INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER NOT NULL DEFAULT 0,
      ended_at INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS turns_client_turn_idx ON turns(client_turn_id);
    CREATE INDEX IF NOT EXISTS turns_session_idx ON turns(session_key, created_at);
    CREATE INDEX IF NOT EXISTS turns_status_idx ON turns(status, created_at);

    CREATE TABLE IF NOT EXISTS turn_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turn_events_turn_idx ON turn_events(turn_id, seq);

    CREATE TABLE IF NOT EXISTS sessions (
      key TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL DEFAULT 'main',
      label TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
      secret_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL DEFAULT 0,
      revoked_at INTEGER NOT NULL DEFAULT 0,
      pairing_code TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS pairing_codes (
      code TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER NOT NULL DEFAULT 0,
      used_by TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  for (const sql of [
    'ALTER TABLE turns ADD COLUMN thinking TEXT NOT NULL DEFAULT ""',
    'ALTER TABLE turns ADD COLUMN model TEXT NOT NULL DEFAULT ""',
  ]) {
    try {
      db.exec(sql);
    } catch {
      /* column already exists */
    }
  }

  const stmt = {
    insertTurn: db.prepare(`
      INSERT INTO turns (
        id, client_turn_id, device_id, session_key, message, thinking, model, status, created_at, updated_at, seq
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0)
    `),
    turnByClientId: db.prepare('SELECT * FROM turns WHERE client_turn_id = ?'),
    turnById: db.prepare('SELECT * FROM turns WHERE id = ?'),
    turnsBySession: db.prepare(
      'SELECT * FROM turns WHERE session_key = ? ORDER BY created_at DESC LIMIT ?'
    ),
    activeTurns: db.prepare(
      "SELECT * FROM turns WHERE status IN ('queued','running','interrupted') ORDER BY created_at ASC"
    ),
    nextQueuedForSession: db.prepare(
      "SELECT * FROM turns WHERE session_key = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1"
    ),
    nextQueued: db.prepare(
      "SELECT * FROM turns WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"
    ),
    runningCountForSession: db.prepare(
      "SELECT COUNT(*) AS n FROM turns WHERE session_key = ? AND status = 'running'"
    ),
    markRunning: db.prepare(`
      UPDATE turns SET status = 'running', run_id = ?, started_at = ?, updated_at = ?,
        attempts = attempts + 1
      WHERE id = ? AND status IN ('queued','interrupted')
    `),
    markCompleted: db.prepare(`
      UPDATE turns SET status = 'completed', result = ?, error = '', ended_at = ?, updated_at = ?
      WHERE id = ?
    `),
    markFailed: db.prepare(`
      UPDATE turns SET status = 'failed', error = ?, ended_at = ?, updated_at = ?
      WHERE id = ?
    `),
    markAborted: db.prepare(`
      UPDATE turns SET status = 'aborted', ended_at = ?, updated_at = ? WHERE id = ?
    `),
    markNeedsVerification: db.prepare(`
      UPDATE turns SET status = 'needs_verification', needs_attention = 1, error = ?, updated_at = ?
      WHERE id = ?
    `),
    markInterrupted: db.prepare(`
      UPDATE turns SET status = 'interrupted', error = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `),
    markQueuedForRetry: db.prepare(`
      UPDATE turns SET status = 'queued', error = '', needs_attention = 0, updated_at = ?
      WHERE id = ? AND status IN ('failed','needs_verification','aborted','running','interrupted','queued')
    `),
    setRunId: db.prepare('UPDATE turns SET run_id = ?, updated_at = ? WHERE id = ?'),
    nextSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM turn_events WHERE turn_id = ?'),
    insertEvent: db.prepare(
      'INSERT INTO turn_events (turn_id, seq, kind, text, created_at) VALUES (?, ?, ?, ?, ?)'
    ),
    eventsAfter: db.prepare(
      'SELECT seq, kind, text, created_at FROM turn_events WHERE turn_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
    ),
    upsertSession: db.prepare(`
      INSERT INTO sessions (key, agent_id, label, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at,
        label = CASE WHEN excluded.label <> '' THEN excluded.label ELSE sessions.label END
    `),
    listSessions: db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?'),
    sessionByKey: db.prepare('SELECT * FROM sessions WHERE key = ?'),
    insertDevice: db.prepare(`
      INSERT INTO devices (id, name, platform, secret_hash, created_at, last_seen_at, pairing_code)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    deviceById: db.prepare('SELECT * FROM devices WHERE id = ?'),
    listDevices: db.prepare('SELECT * FROM devices ORDER BY created_at ASC'),
    touchDevice: db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?'),
    revokeDevice: db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?'),
    insertPairingCode: db.prepare(
      'INSERT INTO pairing_codes (code, created_at, expires_at) VALUES (?, ?, ?)'
    ),
    pairingCode: db.prepare('SELECT * FROM pairing_codes WHERE code = ?'),
    usePairingCode: db.prepare('UPDATE pairing_codes SET used_at = ?, used_by = ? WHERE code = ? AND used_at = 0'),
    // Expired codes are kept briefly so a late phone gets "已过期" instead of
    // "无效" — the clearer message matters when someone is standing at a
    // terminal minting codes.
    prunePairingCodes: db.prepare('DELETE FROM pairing_codes WHERE expires_at < ? AND created_at < ?'),
    meta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ),
  };

  function rowToTurn(row) {
    if (!row) return null;
    return {
      id: row.id,
      clientTurnId: row.client_turn_id,
      deviceId: row.device_id,
      sessionKey: row.session_key,
      message: row.message,
      thinking: row.thinking || '',
      model: row.model || '',
      status: row.status,
      runId: row.run_id,
      result: row.result,
      error: row.error,
      needsAttention: !!row.needs_attention,
      attempts: row.attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  }

  const store = {
    db,
    close() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
    turnById(id) {
      return rowToTurn(stmt.turnById.get(id));
    },
    turnByClientId(clientTurnId) {
      return rowToTurn(stmt.turnByClientId.get(clientTurnId));
    },
    /**
     * Idempotent receive. Returns the existing turn when the same
     * `clientTurnId` was already accepted, so a retry can never create a
     * second run.
     */
    receiveTurn({ id, clientTurnId, deviceId, sessionKey, message, agentId, thinking, model }) {
      const existing = stmt.turnByClientId.get(clientTurnId);
      if (existing) return { turn: rowToTurn(existing), created: false };
      const ts = now();
      db.exec('BEGIN IMMEDIATE');
      try {
        stmt.insertTurn.run(
          id,
          clientTurnId,
          deviceId || '',
          sessionKey,
          message,
          String(thinking || ''),
          String(model || ''),
          ts,
          ts
        );
        stmt.upsertSession.run(sessionKey, agentId || 'main', '', ts, ts);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        // A concurrent duplicate slipped in between the read and the write.
        const raced = stmt.turnByClientId.get(clientTurnId);
        if (raced) return { turn: rowToTurn(raced), created: false };
        throw error;
      }
      return { turn: rowToTurn(stmt.turnById.get(id)), created: true };
    },
    turnsForSession(sessionKey, limit = 50) {
      return stmt.turnsBySession.all(sessionKey, limit).map(rowToTurn);
    },
    listActiveTurns() {
      return stmt.activeTurns.all().map(rowToTurn);
    },
    nextQueued(sessionKey = '') {
      const row = sessionKey ? stmt.nextQueuedForSession.get(sessionKey) : stmt.nextQueued.get();
      return rowToTurn(row);
    },
    sessionBusy(sessionKey) {
      const row = stmt.runningCountForSession.get(sessionKey);
      return (row?.n || 0) > 0;
    },
    markRunning(id, runId) {
      const ts = now();
      const info = stmt.markRunning.run(runId || '', ts, ts, id);
      return info.changes > 0 ? store.turnById(id) : null;
    },
    markCompleted(id, result) {
      const ts = now();
      stmt.markCompleted.run(result || '', ts, ts, id);
      return store.turnById(id);
    },
    markFailed(id, error) {
      const ts = now();
      stmt.markFailed.run(String(error || '').slice(0, 2000), ts, ts, id);
      return store.turnById(id);
    },
    markAborted(id) {
      const ts = now();
      stmt.markAborted.run(ts, ts, id);
      return store.turnById(id);
    },
    markNeedsVerification(id, reason) {
      const ts = now();
      stmt.markNeedsVerification.run(String(reason || '').slice(0, 500), ts, id);
      return store.turnById(id);
    },
    markInterrupted(id, reason) {
      const ts = now();
      const info = stmt.markInterrupted.run(String(reason || '').slice(0, 500), ts, id);
      return info.changes > 0 ? store.turnById(id) : null;
    },
    /**
     * Move a turn back to `queued`.
     *
     * `running` is accepted because reconciliation only calls this after the
     * gateway confirmed it has no record of the run — so the turn was never
     * executed and re-delivering it cannot duplicate anything. Delivering the
     * same turn id again is deduplicated by the gateway anyway.
     */
    requeue(id) {
      const ts = now();
      const info = stmt.markQueuedForRetry.run(ts, id);
      return info.changes > 0 ? store.turnById(id) : null;
    },
    setRunId(id, runId) {
      stmt.setRunId.run(runId || '', now(), id);
      return store.turnById(id);
    },
    /** Append streamed progress. Returns the event seq. */
    appendEvent(turnId, kind, text) {
      const seq = stmt.nextSeq.get(turnId)?.seq || 1;
      stmt.insertEvent.run(turnId, seq, kind, text || '', now());
      db.prepare('UPDATE turns SET updated_at = ? WHERE id = ?').run(now(), turnId);
      return seq;
    },
    eventsAfter(turnId, afterSeq = 0, limit = 200) {
      return stmt.eventsAfter.all(turnId, afterSeq, limit).map((row) => ({
        seq: row.seq,
        kind: row.kind,
        text: row.text,
        at: row.created_at,
      }));
    },
    upsertSession(key, agentId, label = '') {
      const ts = now();
      stmt.upsertSession.run(key, agentId || 'main', label, ts, ts);
      return stmt.sessionByKey.get(key);
    },
    listSessions(limit = 60) {
      return stmt.listSessions.all(limit).map((row) => ({
        key: row.key,
        agentId: row.agent_id,
        label: row.label,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },
    // ---- devices ----------------------------------------------------------
    insertDevice(device) {
      stmt.insertDevice.run(
        device.id,
        device.name || '',
        device.platform || '',
        device.secretHash,
        device.createdAt || now(),
        device.lastSeenAt || 0,
        device.pairingCode || ''
      );
      return stmt.deviceById.get(device.id);
    },
    deviceById(id) {
      return stmt.deviceById.get(id) || null;
    },
    listDevices() {
      return stmt.listDevices.all();
    },
    touchDevice(id) {
      stmt.touchDevice.run(now(), id);
    },
    revokeDevice(id) {
      stmt.revokeDevice.run(now(), id);
      return stmt.deviceById.get(id) || null;
    },
    // ---- pairing ----------------------------------------------------------
    insertPairingCode(code, ttlMs) {
      const ts = now();
      stmt.insertPairingCode.run(code, ts, ts + ttlMs);
      return { code, createdAt: ts, expiresAt: ts + ttlMs };
    },
    pairingCode(code) {
      return stmt.pairingCode.get(code) || null;
    },
    usePairingCode(code, deviceId) {
      const info = stmt.usePairingCode.run(now(), deviceId, code);
      return info.changes > 0;
    },
    prunePairingCodes(retentionMs = 10 * 60 * 1000) {
      stmt.prunePairingCodes.run(now(), now() - retentionMs);
    },
    // ---- meta -------------------------------------------------------------
    getMeta(key) {
      return stmt.meta.get(key)?.value ?? null;
    },
    setMeta(key, value) {
      stmt.setMeta.run(key, String(value));
    },
  };

  return store;
}
