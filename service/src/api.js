/**
 * HTTP API for the Mac service.
 *
 * Minimal by design — the phone talks to this, not to OpenClaw:
 *   POST   /v1/pair/claim                  one-time code -> device credential
 *   GET    /v1/health                      entry / service / kernel diagnosis
 *   POST   /v1/turns                       idempotent receive
 *   GET    /v1/turns/{id}?after=N          status + increments + result
 *   POST   /v1/turns/{id}/cancel           user-initiated abort
 *   POST   /v1/turns/{id}/retry            explicit re-run after review
 *   GET    /v1/catalog                     models + agents from OpenClaw
 *   GET    /v1/sessions                    session list
 *   DELETE /v1/sessions/{key}              delete one session
 *   GET    /v1/sessions/{key}/history      message history
 *   GET    /v1/devices                     paired devices (admin)
 *   POST   /v1/devices/{id}/revoke         revoke a device (admin)
 *   POST   /v1/devices/{id}/rotate         re-issue a device credential (admin)
 *
 * Auth: `Authorization: Bearer <device credential>` on business routes.
 * A device credential can be revoked individually; the admin token can only be
 * read from the local filesystem.
 */
import { checkWritePolicy } from '@obsidian-agent-os/protocol';
import { bearerFromHeader, normalizePairingCode } from './devices.js';

const JSON_LIMIT = 256 * 1024;

function sendJson(res, status, body) {
  const text = JSON.stringify(body ?? {});
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

function errorBody(code, message, extra = {}) {
  return { error: { code, message, ...extra } };
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      // Stop buffering but leave the socket readable so the caller can still
      // write a real HTTP error response (a destroyed socket would just look
      // like a network failure to the phone).
      req.pause();
      reject(Object.assign(new Error(message), { code }));
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > JSON_LIMIT) {
        fail('PAYLOAD_TOO_LARGE', 'payload too large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { code: 'BAD_JSON' }));
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function clientIp(req) {
  const forwarded = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function matchPath(pattern, path) {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params = {};
  for (let i = 0; i < want.length; i += 1) {
    if (want[i].startsWith(':')) {
      params[want[i].slice(1)] = decodeURIComponent(got[i]);
      continue;
    }
    if (want[i] !== got[i]) return null;
  }
  return params;
}

function previewOf(row) {
  const raw = row?.lastMessagePreview || row?.preview || row?.lastMessage || '';
  const text = typeof raw === 'string' ? raw : raw?.text || '';
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function createApi(deps) {
  const { store, engine, gateway, devices, logger, config, rateLimit, vault, confirmations } = deps;
  const agentId = config.agentId || 'main';

  /** Pairing attempts are guessable, so they get their own tighter budget. */
  const pairMax = Number(config.rateLimit?.pairMax) || 20;

  /**
   * Bounded kernel round trip for the diagnosis. Never lets a slow kernel turn
   * a health check into a hang.
   */
  async function probeKernel(timeoutMs = 4000) {
    if (gateway.isLive()) return true;
    try {
      await Promise.race([
        gateway.ensureLive(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('kernel probe timeout')), timeoutMs)),
      ]);
      return gateway.isLive();
    } catch {
      return false;
    }
  }

  /** Translate vault failures into stable, phone-readable codes. */
  function sendVaultError(res, error) {
    const code = error?.code || 'VAULT_ERROR';
    const status =
      code === 'NOT_FOUND'
        ? 404
        : code === 'VAULT_UNAVAILABLE'
          ? 503
          : code === 'PRECONDITION_FAILED' || code === 'PRECONDITION_REQUIRED'
            ? 409
            : code === 'BAD_PATH' || code === 'UNSUPPORTED_TYPE'
              ? 400
              : 500;
    if (status >= 500) logger.error('vault error', { code, err: error?.message });
    sendJson(res, status, {
      error: { code, message: error?.message || '笔记操作失败' },
      ...(error?.current ? { current: error.current } : {}),
    });
  }

  function limiterFor(req, bucket = 'api') {
    const key = `${bucket}:${clientIp(req)}`;
    return { key, result: rateLimit.check(key, 1, bucket === 'pair' ? pairMax : undefined) };
  }

  function requireDevice(req, res, bucket = 'api') {
    const { key, result } = limiterFor(req, bucket);
    if (!result.allowed) {
      sendJson(res, 429, errorBody('RATE_LIMITED', '请求过于频繁，请稍后再试', {
        retryAfterMs: result.retryAfterMs,
      }));
      return null;
    }
    const token = bearerFromHeader(req.headers.authorization);
    const device = devices.authenticate(token);
    if (!device) {
      sendJson(res, 401, errorBody('UNAUTHORIZED', '设备凭据无效或已被撤销'));
      return null;
    }
    store.touchDevice(device.id);
    return device;
  }

  function requireAdmin(req, res) {
    const { result } = limiterFor(req, 'admin');
    if (!result.allowed) {
      sendJson(res, 429, errorBody('RATE_LIMITED', '请求过于频繁，请稍后再试'));
      return null;
    }
    const token = bearerFromHeader(req.headers.authorization);
    if (!devices.isAdminToken(token)) {
      sendJson(res, 401, errorBody('UNAUTHORIZED', '需要管理员凭据（本机 admin.token）'));
      return null;
    }
    return { admin: true };
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method || 'GET').toUpperCase();

    // ---- pairing (unauthenticated, tightly rate limited) -----------------
    if (method === 'POST' && matchPath('/v1/pair/claim', path)) {
      const { result } = limiterFor(req, 'pair');
      if (!result.allowed) {
        sendJson(res, 429, errorBody('RATE_LIMITED', '尝试过于频繁，请稍后再试'));
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, errorBody(error.code || 'BAD_REQUEST', error.message));
        return;
      }
      const code = normalizePairingCode(body.code);
      if (!code) {
        sendJson(res, 400, errorBody('BAD_CODE', '配对码格式不对'));
        return;
      }
      const claimed = devices.claimPairingCode(code, {
        name: String(body.name || '').slice(0, 80),
        platform: String(body.platform || '').slice(0, 40),
      });
      if (!claimed.ok) {
        sendJson(res, 401, errorBody(claimed.error || 'PAIRING_FAILED', claimed.message || '配对码无效或已过期'));
        return;
      }
      logger.info('device paired', { deviceId: claimed.device.id, platform: body.platform });
      sendJson(res, 201, {
        device: { id: claimed.device.id, name: claimed.device.name },
        credential: claimed.credential,
        service: { publicUrl: config.publicUrl, protocol: 1 },
      });
      return;
    }

    // ---- health ----------------------------------------------------------
    if (method === 'GET' && matchPath('/v1/health', path)) {
      const token = bearerFromHeader(req.headers.authorization);
      const device = devices.authenticate(token, { allowAdmin: true });
      const detailed = !!device;
      // Only a caller that proved it is ours may trigger a kernel round trip;
      // an anonymous probe just reads the cached state.
      const kernelLive = detailed ? await probeKernel() : false;
      const status = gateway.status();
      const active = store.listActiveTurns();
      sendJson(res, 200, {
        ok: true,
        service: {
          version: config.serviceVersion || '0.3.0',
          uptimeSec: Math.round(process.uptime()),
          db: config.dbPath,
        },
        kernel: {
          state: kernelLive ? 'live' : status.state,
          message: status.message || '',
          live: detailed ? kernelLive : undefined,
        },
        queue: {
          active: active.filter((turn) => turn.status === 'running').length,
          queued: active.filter((turn) => turn.status === 'queued').length,
          interrupted: active.filter((turn) => turn.status === 'interrupted').length,
          needsVerification: active.filter((turn) => turn.needsAttention).length,
        },
        authenticated: !!device,
        ...(detailed
          ? {
              diagnosis: {
                entry: 'ok',
                service: 'ok',
                kernel: kernelLive ? 'ok' : 'unreachable',
              },
            }
          : {}),
      });
      return;
    }

    // ---- turns -----------------------------------------------------------
    if (method === 'POST' && matchPath('/v1/turns', path)) {
      const device = requireDevice(req, res);
      if (!device) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, errorBody(error.code || 'BAD_REQUEST', error.message));
        return;
      }
      // Validate before touching the engine so a bad request never creates a
      // half-defined turn.
      const clientTurnId = String(body.clientTurnId || '').trim().slice(0, 128);
      if (!clientTurnId) {
        sendJson(res, 400, errorBody('BAD_REQUEST', 'clientTurnId is required'));
        return;
      }
      const message = String(body.message ?? '');
      if (!message.trim()) {
        sendJson(res, 400, errorBody('BAD_REQUEST', 'message is required'));
        return;
      }
      const received = engine.receiveTurn({
        clientTurnId,
        sessionKey: String(body.sessionKey || '').trim().slice(0, 200),
        message,
        deviceId: device.id,
        agentId: String(body.agentId || agentId).slice(0, 64),
        thinking: String(body.thinking || '').trim().slice(0, 64),
        model: String(body.model || '').trim().slice(0, 200),
      });
      if (received.error) {
        sendJson(res, 400, errorBody('BAD_REQUEST', received.error));
        return;
      }
      sendJson(res, received.created ? 201 : 200, {
        turn: engine.describeTurn(received.turn, 0),
        duplicate: !received.created,
      });
      return;
    }

    const byClient = matchPath('/v1/turns/by-client/:clientTurnId', path);
    if (byClient && method === 'GET') {
      const device = requireDevice(req, res);
      if (!device) return;
      const turn = store.turnByClientId(byClient.clientTurnId);
      if (!turn) {
        sendJson(res, 404, errorBody('NOT_FOUND', '找不到这条消息'));
        return;
      }
      sendJson(res, 200, { turn: engine.describeTurn(turn, 0) });
      return;
    }

    const turnMatch = matchPath('/v1/turns/:id', path);
    if (turnMatch && method === 'GET') {
      const device = requireDevice(req, res);
      if (!device) return;
      const turn = store.turnById(turnMatch.id);
      if (!turn) {
        sendJson(res, 404, errorBody('NOT_FOUND', '找不到这条消息'));
        return;
      }
      const after = Number(url.searchParams.get('after') || '0') || 0;
      sendJson(res, 200, { turn: engine.describeTurn(turn, after) });
      return;
    }

    const verifyMatch = matchPath('/v1/turns/:id/verify', path);
    if (verifyMatch && method === 'POST') {
      const device = requireDevice(req, res);
      if (!device) return;
      const result = await engine.reconcileTurn(verifyMatch.id);
      if (result.error) {
        sendJson(res, 404, errorBody('NOT_FOUND', result.error));
        return;
      }
      sendJson(res, 200, { turn: engine.describeTurn(result.turn, 0) });
      return;
    }

    const cancelMatch = matchPath('/v1/turns/:id/cancel', path);
    if (cancelMatch && method === 'POST') {
      const device = requireDevice(req, res);
      if (!device) return;
      const result = await engine.cancelTurn(cancelMatch.id);
      if (result.error) {
        sendJson(res, result.error === 'not found' ? 404 : 400, errorBody('CANCEL_FAILED', result.error));
        return;
      }
      sendJson(res, 200, { turn: engine.describeTurn(result.turn, 0) });
      return;
    }

    const retryMatch = matchPath('/v1/turns/:id/retry', path);
    if (retryMatch && method === 'POST') {
      const device = requireDevice(req, res);
      if (!device) return;
      const result = engine.retryTurn(retryMatch.id);
      if (result.error) {
        sendJson(res, 400, errorBody('RETRY_FAILED', result.error));
        return;
      }
      sendJson(res, 200, { turn: engine.describeTurn(result.turn, 0) });
      return;
    }

    // ---- catalog ---------------------------------------------------------
    if (method === 'GET' && matchPath('/v1/catalog', path)) {
      const device = requireDevice(req, res);
      if (!device) return;
      try {
        const payload = await gateway.catalog();
        sendJson(res, 200, {
          models: payload?.models || [],
          agents: payload?.agents || [],
          agentId,
        });
      } catch (error) {
        sendJson(res, 503, errorBody('KERNEL_UNAVAILABLE', error?.message || 'OpenClaw 不可用'));
      }
      return;
    }

    // ---- sessions --------------------------------------------------------
    if (method === 'GET' && matchPath('/v1/sessions', path)) {
      const device = requireDevice(req, res);
      if (!device) return;
      const local = store.listSessions(60);
      let remote = [];
      if (gateway.isLive()) {
        try {
          remote = await gateway.listSessions();
        } catch (error) {
          logger.warn('remote session list failed', { err: error?.message });
        }
      }
      const merged = new Map();
      for (const row of local) {
        merged.set(row.key, { key: row.key, label: row.label, agentId: row.agentId, updatedAt: row.updatedAt });
      }
      for (const row of remote) {
        const key = row.key || row.sessionKey;
        if (!key) continue;
        const prev = merged.get(key) || {};
        merged.set(key, {
          key,
          label: row.derivedTitle || row.displayName || row.label || row.title || prev.label || '',
          preview: previewOf(row) || prev.preview || '',
          lastMessagePreview: previewOf(row) || prev.lastMessagePreview || '',
          agentId: row.agentId || prev.agentId || agentId,
          updatedAt: row.updatedAt || prev.updatedAt || 0,
        });
      }
      const sessions = [...merged.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      sendJson(res, 200, { sessions });
      return;
    }

    const historyMatch = matchPath('/v1/sessions/:key/history', path);
    if (historyMatch && method === 'GET') {
      const device = requireDevice(req, res);
      if (!device) return;
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || '60') || 60));
      try {
        const payload = await gateway.history(historyMatch.key, { limit });
        const rows = payload?.messages || [];
        sendJson(res, 200, {
          sessionKey: historyMatch.key,
          messages: rows.map(publicMessage),
          hasMore: !!payload?.hasMore,
          totalMessages: payload?.totalMessages ?? rows.length,
        });
      } catch (error) {
        sendJson(res, 503, errorBody('KERNEL_UNAVAILABLE', error?.message || 'OpenClaw 不可用'));
      }
      return;
    }

    const sessionMatch = matchPath('/v1/sessions/:key', path);
    if (sessionMatch && method === 'DELETE') {
      const device = requireDevice(req, res);
      if (!device) return;
      const key = sessionMatch.key || '';
      if (!key) {
        sendJson(res, 400, errorBody('BAD_REQUEST', '缺少会话'));
        return;
      }
      if (!gateway.isLive?.()) {
        sendJson(res, 503, errorBody('KERNEL_UNAVAILABLE', 'Mac 上的 OpenClaw 没连上，这条会话先留着'));
        return;
      }
      try {
        await gateway.deleteSession(key);
      } catch (error) {
        const msg = String(error?.message || '');
        const missing = error?.code === 'NOT_FOUND' || /not found|unknown session|no such session/i.test(msg);
        if (!missing) {
          sendJson(res, 503, errorBody('KERNEL_UNAVAILABLE', error?.message || '删不掉这条会话'));
          return;
        }
      }
      store.deleteSession?.(key);
      sendJson(res, 200, { ok: true, key });
      return;
    }

    // ---- vault (notes) ---------------------------------------------------
    if (method === 'GET' && matchPath('/v1/notes', path)) {
      const device = requireDevice(req, res);
      if (!device) return;
      const prefix = url.searchParams.get('prefix') || '';
      const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit') || '2000') || 2000));
      try {
        sendJson(res, 200, { root: vault.root, notes: vault.listNotes(prefix, limit) });
      } catch (error) {
        sendVaultError(res, error);
      }
      return;
    }

    if (method === 'GET' && matchPath('/v1/notes/search', path)) {
      const device = requireDevice(req, res);
      if (!device) return;
      const query = url.searchParams.get('q') || '';
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || '12') || 12));
      try {
        sendJson(res, 200, { query, hits: vault.searchNotes(query, limit) });
      } catch (error) {
        sendVaultError(res, error);
      }
      return;
    }

    if (method === 'GET' && matchPath('/v1/note', path)) {
      const device = requireDevice(req, res);
      if (!device) return;
      try {
        sendJson(res, 200, { note: vault.readNote(url.searchParams.get('path') || '') });
      } catch (error) {
        sendVaultError(res, error);
      }
      return;
    }

    if (method === 'POST' && matchPath('/v1/note/read', path)) {
      const device = requireDevice(req, res);
      if (!device) return;
      try {
        const body = await readJsonBody(req);
        sendJson(res, 200, { note: vault.readNote(String(body.path || '')) });
      } catch (error) {
        sendVaultError(res, error);
      }
      return;
    }

    if (method === 'POST' && matchPath('/v1/notes/write', path)) {
      const device = requireDevice(req, res);
      if (!device) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, errorBody(error.code || 'BAD_REQUEST', error.message));
        return;
      }
      const notePath = String(body.path || '').trim();
      const content = String(body.content ?? '');
      if (!notePath) {
        sendJson(res, 400, errorBody('BAD_REQUEST', 'path is required'));
        return;
      }
      try {
        // A confirmation is only valid for a human-owned path, and only when
        // the text the user approved is still the text on disk. The token is
        // consumed before the write so a failed compare-and-set cannot be
        // retried with the same approval.
        const confirmation = body.confirmationToken
          ? confirmations.consume(String(body.confirmationToken), {
              deviceId: device.id,
              path: notePath,
            })
          : null;
        if (body.confirmationToken && !confirmation) {
          sendJson(res, 409, {
            error: { code: 'CONFIRMATION_EXPIRED', message: '确认已过期或已被使用，请重新确认' },
          });
          return;
        }
        if (confirmation) {
          // Pin the write to the content the user actually saw.
          const preview = vault.describeWrite(notePath, content);
          if (preview.currentFingerprint !== confirmation.fingerprint) {
            const current = vault.readNote(notePath).content;
            sendJson(res, 409, {
              error: {
                code: 'PRECONDITION_FAILED',
                message: '笔记内容已经变化，请重新确认后再写入',
              },
              current: { fingerprint: preview.currentFingerprint, content: current.slice(0, 20000) },
            });
            return;
          }
        }
        // No token yet: for a path that needs approval, describe it instead of
        // a bare refusal, so the phone can render a confirmation card.
        const preview = vault.describeWrite(notePath, content);
        const policy = checkWritePolicy(preview.path, { approvedPending: !!confirmation });
        if (!policy.allowed) {
          const token = confirmations.issue({
            deviceId: device.id,
            path: preview.path,
            fingerprint: preview.currentFingerprint,
          });
          sendJson(res, 428, {
            error: {
              code: 'CONFIRMATION_REQUIRED',
              message: '这个位置需要确认卡',
              reason: policy.reason,
            },
            confirm: {
              token,
              path: preview.path,
              humanZone: preview.humanZone,
              currentFingerprint: preview.currentFingerprint,
              proposedFingerprint: preview.proposedFingerprint,
              currentBytes: preview.currentBytes,
              proposedBytes: preview.proposedBytes,
            },
          });
          return;
        }
        const result = await vault.writeNote(notePath, content, {
          expectFingerprint: body.expectFingerprint ?? preview.currentFingerprint,
          approvedPending: !!confirmation,
          requireExisting: !!body.requireExisting,
        });
        logger.info('note written', { path: result.path, bytes: result.bytes, created: result.created });
        sendJson(res, 200, { write: result });
      } catch (error) {
        if (error.code === 'POLICY_DENIED') {
          // Human-owned zone: hand back a one-time confirmation the user must
          // approve on the phone, bound to the exact content we would replace.
          const preview = vault.describeWrite(notePath, content);
          const token = confirmations.issue({
            deviceId: device.id,
            path: preview.path,
            fingerprint: preview.currentFingerprint,
          });
          sendJson(res, 428, {
            error: {
              code: 'CONFIRMATION_REQUIRED',
              message: '这个位置需要确认卡',
              reason: error.reason,
            },
            confirm: {
              token,
              path: preview.path,
              humanZone: preview.humanZone,
              currentFingerprint: preview.currentFingerprint,
              proposedFingerprint: preview.proposedFingerprint,
              currentBytes: preview.currentBytes,
              proposedBytes: preview.proposedBytes,
            },
          });
          return;
        }
        sendVaultError(res, error);
      }
      return;
    }

    const confirmMatch = matchPath('/v1/notes/confirm/:token', path);
    if (confirmMatch && method === 'GET') {
      const device = requireDevice(req, res);
      if (!device) return;
      const pending = confirmations.peek(confirmMatch.token, device.id);
      if (!pending) {
        sendJson(res, 404, errorBody('NOT_FOUND', '确认已过期或已被使用'));
        return;
      }
      try {
        // A confirmation for a path that does not exist yet (a new note) is
        // perfectly valid: the card just shows "new file".
        let current = null;
        try {
          current = vault.readNote(pending.path);
        } catch (error) {
          if (error.code !== 'NOT_FOUND') throw error;
        }
        sendJson(res, 200, {
          confirm: {
            path: pending.path,
            exists: !!current,
            currentFingerprint: current ? current.fingerprint : null,
            currentContent: current ? current.content : '',
            changedSinceIssue: current ? current.fingerprint !== pending.fingerprint : false,
            expiresAt: pending.expiresAt,
          },
        });
      } catch (error) {
        sendVaultError(res, error);
      }
      return;
    }

    // ---- devices (admin) -------------------------------------------------
    if (method === 'GET' && matchPath('/v1/devices', path)) {
      if (!requireAdmin(req, res)) return;
      sendJson(res, 200, { devices: devices.listDevices() });
      return;
    }
    const revokeMatch = matchPath('/v1/devices/:id/revoke', path);
    if (revokeMatch && method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const revoked = devices.revokeDevice(revokeMatch.id);
      if (!revoked) {
        sendJson(res, 404, errorBody('NOT_FOUND', '找不到这台设备'));
        return;
      }
      sendJson(res, 200, { device: revoked });
      return;
    }
    const rotateMatch = matchPath('/v1/devices/:id/rotate', path);
    if (rotateMatch && method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const rotated = devices.rotateDevice(rotateMatch.id);
      if (!rotated) {
        sendJson(res, 404, errorBody('NOT_FOUND', '找不到这台设备'));
        return;
      }
      sendJson(res, 200, rotated);
      return;
    }

    sendJson(res, 404, errorBody('NOT_FOUND', 'no such route'));
  }

  /** Strip OpenClaw-internal metadata down to what the phone needs. */
  function publicMessage(row) {
    const meta = row.__openclaw || {};
    return {
      role: row.role,
      ts: row.timestamp || meta.recordTimestampMs || 0,
      content: row.content,
      runId: meta.runId || '',
      isError: !!row.isError,
      toolName: row.toolName || '',
    };
  }

  return {
    /** Never throws: any failure becomes a JSON error response. */
    async handler(req, res) {
      try {
        await handle(req, res);
      } catch (error) {
        logger.error('request failed', { path: req.url, err: error?.message });
        if (!res.headersSent) sendJson(res, 500, errorBody('INTERNAL', '服务内部错误'));
        else {
          try {
            res.end();
          } catch {
            /* ignore */
          }
        }
      }
    },
    _internal: { sendJson, readJsonBody, matchPath, clientIp, publicMessage },
  };
}
