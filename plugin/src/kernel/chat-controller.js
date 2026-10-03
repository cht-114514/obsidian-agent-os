/**
 * Plugin-level chat session controller (fullscreen + companion share one queue).
 */
import { buildTurnPrompt, loadSoulPack } from '../memory/inject.js';
import { recallMemory } from '../memory/index-ops.js';
import { scheduleFormationAfterTurn } from '../memory/turn-memory.js';
import { historyToTurns, mergeTranscript, newMessageId } from '../ui/turns.js';
import { newIdempotencyKey } from './transport.js';
import { isTransportNoise } from './session-store.js';
import { createOutboxRunner, isRetryable } from './outbox-runner.js';
import { serviceMessagesFromPayload, serviceSessionsFromPayload } from './service-payload.js';
import { isUserSession, sessionKey, sessionLabel } from '../ui/sidebar.js';
import { nextStepFor, phaseLabel } from '../ui/turn-phase.js';
import { choosePack, isCompletePack, withDeadline, PREP_TIMEOUT_MS } from '../ui/send-prep.js';
import { AOS_BUILD } from '../ui/build-id.js';
import { chooseSession, isEphemeralLocalKey } from './chat-session-sync.js';
import { formatSnapshotForPrompt } from '../context-snapshot-pure.js';

export function createChatController(plugin, app, hooks = {}) {
  const deps = { Notice: hooks.Notice };
  const listeners = new Set();
  const viewHooks = [];
  function emit() { for (const fn of listeners) fn(); }
  function emitThread() { for (const h of viewHooks) h.onThread?.(); }
  const state = {
    sessions: [],
    activeKey: '',
    messages: [],
    busy: false,
    startedAt: 0,
    progressLabel: '思考中',
    syncHint: '',
    sessionsLoading: false,
    saveError: '',
    serviceError: '',
    stage: { build: AOS_BUILD, savedAt: 0, prep: '', receipt: '', poll: '' },
  };
  let sessionRestored = false;
  let soulCache = null;
  const prepTokens = new Map();
  const livePolls = new Set();
  let resumingTurns = false;
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function attachView(h) {
    viewHooks.push(h);
    return () => { const i = viewHooks.indexOf(h); if (i >= 0) viewHooks.splice(i, 1); };
  }
  function getState() { return state; }

  function sessionCache() {
    return plugin.sessionStore?.() || null;
  }

  function persistLocal() {
    const store = sessionCache();
    if (!store) return;
    store.saveSessions(state.sessions);
    store.saveActiveKey(state.activeKey);
    if (state.activeKey) store.saveTranscript(state.activeKey, state.messages);
  }

  /**
   * Re-attach a queued turn's rendering state from the durable store, so a
   * message typed offline still shows up after a reload.
   */
  function hydratePending(sessionKeyName, messages) {
    const store = sessionCache();
    if (!store || !sessionKeyName) return messages;
    const rows = messages.slice();
    for (const turn of store.activePending(sessionKeyName)) {
      const ts = turn.ts || Date.now();
      const userRow = rows.find((row) => row.role === 'user' && row.turnId === turn.turnId);
      if (!userRow && turn.message) {
        rows.push({ id: `u-${turn.turnId}`, role: 'user', text: turn.message, ts, turnId: turn.turnId });
      }
      if (!rows.some((row) => row.role === 'assistant' && row.turnId === turn.turnId)) {
        rows.push({
          id: `a-${turn.turnId}`,
          role: 'assistant',
          text: turn.status === 'queued' ? '待发出（已排队）' : '',
          ts,
          turnId: turn.turnId,
          turnStatus: turn.status,
          streaming: turn.status === 'sending',
        });
      }
    }
    return rows;
  }

  function isEphemeralLocalKey(key) {
    const k = String(key || '');
    return /:aos-[a-z0-9]+$/i.test(k);
  }

  function sessionHasLocalContent(key) {
    if (!key) return false;
    const rows = key === state.activeKey ? state.messages : sessionCache()?.loadTranscript(key) || [];
    return rows.some((row) => row.role === 'user' && String(row.text || '').trim());
  }

  function loadLocalCache() {
    const store = sessionCache();
    if (!store) return;
    const sessions = store.loadSessions();
    if (sessions.length && entryMode() !== 'service') state.sessions = sessions;
    const active = store.loadActiveKey();
    if (active && entryMode() !== 'service') state.activeKey = active;
    if (entryMode() === 'service' && active && !isEphemeralLocalKey(active)) {
      state.activeKey = active;
    }
    if (state.activeKey) {
      const cached = store.loadTranscript(state.activeKey);
      if (cached.length) state.messages = settleLoaded(state.activeKey, hydratePending(state.activeKey, cached));
    }
  }

  function settleLoaded(sessionKeyName, rows) {
    const store = sessionCache();
    for (const row of rows) {
      if (row.role !== 'assistant' || !row.turnId) continue;
      const pending = store?.pendingFor(row.turnId);
      if (pending?.status) {
        row.turnStatus = pending.status === 'failed' ? row.turnStatus || 'error' : pending.status;
        if (pending.status === 'failed' && row.text === '上下文读取失败') row.turnStatus = 'prep_failed';
        row.streaming = pending.status === 'sending' || pending.status === 'preparing';
        if (row.activity?.status === '保存中') row.activity = { ...row.activity, status: '' };
      } else if (row.streaming || row.activity?.status === '保存中') {
        row.streaming = false;
        row.turnStatus = 'unconfirmed';
        row.text = row.text || '未确认发送';
        row.errorHint = '这条只有本地占位，没有进入发送队列。可以重试，不会自动重发。';
        row.activity = null;
      }
    }
    return rows;
  }
  async function fetchSessions() {
    if (entryMode() === 'service') {
      const client = plugin.serviceClient?.();
      if (!client?.hasCredential?.()) {
        const error = new Error('还没有配对这台设备');
        error.code = 'NOT_PAIRED';
        throw error;
      }
      const payload = await client.listSessions();
      const rows = serviceSessionsFromPayload(payload);
      state.serviceError = '';
      return rows.map((row) => ({
        key: row.key,
        label: row.label || '',
        displayName: row.label || '',
        preview: row.preview || row.lastMessagePreview || '',
        lastMessagePreview: row.preview || row.lastMessagePreview || '',
        updatedAt: row.updatedAt || 0,
      }));
    }
    const client = plugin.operator;
    if (!client || client.status.state !== 'live') {
      const error = new Error(client?.status?.message || 'OpenClaw 未连接');
      error.code = 'NOT_CONNECTED';
      throw error;
    }
    return client.listSessions();
  }

  /** History from whichever transport this device uses. */
  async function fetchHistory(key) {
    if (entryMode() === 'service') {
      const client = plugin.serviceClient?.();
      if (!client?.hasCredential?.()) {
        const error = new Error('还没有配对这台设备');
        error.code = 'NOT_PAIRED';
        throw error;
      }
      const payload = await client.history(key, 80);
      state.serviceError = '';
      return { messages: serviceMessagesFromPayload(payload).map(serviceMessageToRow) };
    }
    const client = plugin.operator;
    if (!client || client.status.state !== 'live') {
      const error = new Error(client?.status?.message || 'OpenClaw 未连接');
      error.code = 'NOT_CONNECTED';
      throw error;
    }
    return client.history(key, 80);
  }

  /** The service returns plain rows; shape them like gateway history. */
  function serviceMessageToRow(row) {
    return {
      role: row.role,
      content: row.content,
      timestamp: row.ts,
      isError: row.isError,
      toolName: row.toolName,
      __openclaw: { runId: row.runId },
    };
  }

  async function refreshSessions() {
    state.sessionsLoading = true;
    emit();
    try {
      state.sessions = (await fetchSessions()).filter((row) => !row?.archived && isUserSession(row));
      state.syncHint = '';
      if (entryMode() === 'service') {
        await plugin.loadServiceCatalog?.().catch(() => {});
      }
      persistLocal();
    } catch (error) {
      state.syncHint = entryMode() === 'service' ? 'Mac 未同步' : '会话列表未同步';
      if (entryMode() === 'service') {
        if (error?.code === 'NOT_PAIRED') state.serviceError = '';
        else state.serviceError = error?.message || '连不上 Mac 服务';
      }
      if (!isTransportNoise(error) && error?.code !== 'NOT_PAIRED') {
        state.syncHint = error?.message || state.syncHint;
      }
    } finally {
      state.sessionsLoading = false;
    }
    if (entryMode() === 'service' && state.sessions.length && !sessionRestored) {
      sessionRestored = true;
      const onServer = state.sessions.some((row) => sessionKey(row) === state.activeKey);
      const keep = onServer && sessionHasLocalContent(state.activeKey);
      if (!keep) {
        const nextKey = sessionKey(state.sessions[0]) || '';
        if (nextKey && nextKey !== state.activeKey) {
          state.activeKey = nextKey;
          state.messages = [];
        }
      }
    } else if (entryMode() === 'service' && state.sessions.length) {
      const staleLocal =
        isEphemeralLocalKey(state.activeKey) && !sessionHasLocalContent(state.activeKey);
      const missingActive = !state.activeKey || !isUserSession({ key: state.activeKey });
      if (staleLocal || missingActive) {
        const serverKeys = state.sessions.map(sessionKey).filter(Boolean);
        const mainKey = serverKeys.find((key) => key.endsWith(':main'));
        const nextKey = mainKey || serverKeys[0] || '';
        if (nextKey && nextKey !== state.activeKey) {
          state.activeKey = nextKey;
          const cached = sessionCache()?.loadTranscript(nextKey);
          state.messages = cached?.length ? hydratePending(nextKey, cached) : [];
        }
      }
    } else if (!isUserSession({ key: state.activeKey })) {
      const mainKey = state.sessions.map(sessionKey).find((key) => key.endsWith(':main'));
      const nextKey = mainKey || state.sessions.map(sessionKey).find(Boolean) || '';
      if (nextKey && nextKey !== state.activeKey) {
        state.activeKey = nextKey;
        const cached = sessionCache()?.loadTranscript(nextKey);
        state.messages = cached?.length ? hydratePending(nextKey, cached) : [];
      }
    }
    emit();
    const pick = chooseSession({
      sessions: state.sessions,
      activeKey: state.activeKey,
      messages: state.messages,
      composerDraft: viewHooks.map((h) => h.getDraft?.() || '').find((d) => d) || '',
      getTranscript: (key) => sessionCache()?.loadTranscript(key) || [],
      listPending: (key) => sessionCache()?.listPending(key) || [],
    });
    if (pick.key && pick.key !== state.activeKey && !['keep_local', 'keep_new'].includes(pick.reason)) {
      state.activeKey = pick.key;
      const cached = sessionCache()?.loadTranscript(pick.key);
      state.messages = cached?.length ? hydratePending(pick.key, cached) : [];
    }
    if (state.activeKey && !state.messages.length && !viewHooks.some((h) => h.sidebarOpen)) {
      await openSession(state.activeKey, { keepIfMissing: true });
    }
    await flushOutbox();
  }

  async function openSession(key, opts = {}) {
    state.activeKey = key;
    viewHooks.forEach((h) => h.onCloseSidebar?.());
    const cached = sessionCache()?.loadTranscript(key);
    if (cached?.length) state.messages = hydratePending(key, cached);
    persistLocal();
    try {
      const payload = await fetchHistory(key);
      const incoming = historyToTurns(payload);
      // History must never replace a message the phone still has queued.
      const merged = mergeTranscript(state.messages, incoming);
      if (merged.length || !opts.keepIfMissing) state.messages = hydratePending(key, merged);
      state.syncHint = '';
      persistLocal();
    } catch (error) {
      if (entryMode() === 'service') {
        state.syncHint = '历史未同步';
        if (error?.code === 'NOT_PAIRED') state.serviceError = '';
        else state.serviceError = error?.message || '连不上 Mac 服务';
        if (!isTransportNoise(error) && error?.code !== 'NOT_PAIRED') {
          state.syncHint = error?.message || state.syncHint;
        }
      } else {
        state.syncHint = '历史未同步';
        if (!isTransportNoise(error)) state.syncHint = error?.message || state.syncHint;
      }
    }
    emit();
    await flushOutbox();
  }

  async function removeSession(key) {
    if (!key) return;
    const row = state.sessions.find((item) => sessionKey(item) === key);
    try {
      if (!isEphemeralLocalKey(key) || sessionHasLocalContent(key)) {
        if (entryMode() === 'service') {
          const client = plugin.serviceClient?.();
          if (!client?.hasCredential?.()) {
            const error = new Error('还没有配对这台设备');
            error.code = 'NOT_PAIRED';
            throw error;
          }
          await client.deleteSession(key);
        } else {
          const client = plugin.operator;
          if (!client || client.status.state !== 'live') {
            const error = new Error(client?.status?.message || 'OpenClaw 未连接');
            error.code = 'NOT_CONNECTED';
            throw error;
          }
          await client.deleteSession(key);
        }
      }
    } catch (error) {
      const message = error?.message || '删不掉这条会话';
      state.syncHint = message;
      deps.Notice?.(message);
      emit();
      return;
    }
    const store = sessionCache();
    for (const turn of store?.listPending?.(key) || []) {
      if (turn?.turnId) store.dropTurn(turn.turnId);
    }
    store?.saveTranscript?.(key, []);
    state.sessions = state.sessions.filter((item) => sessionKey(item) !== key);
    persistLocal();
    deps.Notice?.(row ? `已删除「${sessionLabel(row)}」` : '已删除');
    if (state.activeKey === key) {
      const next = state.sessions.map(sessionKey).find(Boolean);
      if (next) {
        await openSession(next);
        return;
      }
      newSession();
      return;
    }
    emit();
  }

  function newSession() {
    sessionRestored = true;
    const key = `agent:${plugin.settings.agentId || 'main'}:aos-${Date.now().toString(36)}`;
    state.activeKey = key;
    state.messages = [];
    viewHooks.forEach((h) => h.onCloseSidebar?.())
    state.sessions = [{ key, label: '新会话', updatedAt: Date.now() }, ...state.sessions];
    persistLocal();
    emit();
    viewHooks.forEach((h) => h.onComposerFocus?.());
  }

  function continueRecent() {
    const key = state.sessions.map(sessionKey).find(Boolean);
    if (key) openSession(key);
  }

  async function readRel(path) {
    const file = app.vault.getAbstractFileByPath(path);
    if (!file || !app.vault.read) return null;
    try {
      return await app.vault.read(file);
    } catch {
      return null;
    }
  }

  function explainSendError(error) {
    const message = error?.message || String(error || '');
    if (/does not match its placement/i.test(message)) {
      return '这个会话的运行位置和网关对不上。点「新会话」再发一次。';
    }
    if (error?.code === 'CONNECTION_LOST' || error?.code === 'NOT_CONNECTED' || error?.code === 'CONNECTION_REPLACED') {
      return '连接断了，正在重连。';
    }
    if (/request format rejected|HTTP 400/i.test(message)) {
      return message.includes('LLM') ? message : `LLM request failed (${message})`;
    }
    return message;
  }

  async function readPack() {
    return loadSoulPack(readRel);
  }

  function onTurnSent(sessionKeyName, turnId, rows) {
    scheduleFormationAfterTurn(app, plugin, {
      sessionKey: sessionKeyName,
      turnId,
      rows,
    });
  }

  async function continuePrep(sessionKey, turnId, content, token) {
    state.stage.prep = 'reading';
    let fresh = null;
    let error = null;
    try {
      fresh = await withDeadline(() => readPack(), PREP_TIMEOUT_MS, token);
    } catch (caught) {
      error = caught;
    }
    if (token.cancelled || prepTokens.get(turnId) !== token) return;
    if (isCompletePack(fresh)) soulCache = fresh;
    const chosen = choosePack(fresh, soulCache, error);
    const store = sessionCache();
    const loaded = draftFor(sessionKey, turnId, Date.now());
    const draft = loaded.draft;
    if (!chosen.ok) {
      state.stage.prep = 'failed';
      if (draft) {
        draft.streaming = false;
        draft.turnStatus = 'prep_failed';
        draft.text = '上下文读取失败';
        draft.errorHint = '重试会再读一次。没有完整上下文时不会发送。';
        draft.activity = null;
      }
      store?.markFailed?.(turnId, '上下文读取失败');
      saveSessionTranscript(sessionKey, loaded.rows);
      if (sessionKey === state.activeKey) emit();
      deps.Notice?.('上下文读取失败');
      return;
    }
    state.stage.prep = chosen.source;
    let memoryRecall = null;
    if (plugin.settings?.retrieve !== false) {
      try {
        memoryRecall = await recallMemory(app, plugin, content);
      } catch {
        memoryRecall = null;
      }
    }
    const pendingRow = store?.pendingFor(turnId);
    let prompt = buildTurnPrompt({
      ...chosen.pack,
      userMessage: content,
      memoryRecall,
    });
    if (pendingRow?.surface === 'companion' && pendingRow?.contextSnapshot) {
      prompt += `\n${formatSnapshotForPrompt(pendingRow.contextSnapshot)}`;
    }
    store?.markPending?.(turnId, { prompt, status: 'queued', message: content });
    if (draft) {
      draft.turnStatus = 'queued';
      draft.streaming = false;
      draft.text = '待发出（已排队）';
      draft.activity = null;
    }
    saveSessionTranscript(sessionKey, loaded.rows);
    if (sessionKey === state.activeKey) {
      state.progressLabel = phaseLabel({ status: 'queued' });
      emit();
    }
    if (!isLive()) return;
    await flushOutbox();
  }

  async function send(text, opts = {}) {
    if (!text || !String(text).trim()) return;
    const status = connectionState();
    if (status.state === 'pairing') {
      emit();
      return;
    }
    const content = String(text);
    if (entryMode() !== 'service') plugin.ensureOperator?.().catch(() => {});
    if (!isUserSession({ key: state.activeKey })) newSession();
    const sessionKey = state.activeKey;
    const turnId = newIdempotencyKey();
    const now = Date.now();
    const prefs = plugin.connectionPrefs?.() || {};
    const thinking = plugin.resolveOutgoingThinking?.() || prefs.thinking || '';
    const model = prefs.model || '';
    const base = sessionKey === state.activeKey ? state.messages : sessionCache()?.loadTranscript(sessionKey) || [];
    const messages = base.concat(
      { id: newMessageId('u'), role: 'user', text: content, ts: now, turnId },
      {
        id: newMessageId('a'),
        role: 'assistant',
        text: '',
        ts: now,
        turnId,
        streaming: true,
        turnStatus: 'preparing',
        activity: null,
      }
    );
    const store = sessionCache();
    if (!store?.saveTurnWithPending) {
      deps.Notice?.('本地保存失败');
      return { ok: false, error: new Error('本地存储不可用') };
    }
    const written = store.saveTurnWithPending(sessionKey, messages, {
      turnId,
      sessionKey,
      message: content,
      prompt: '',
      ts: now,
      thinking,
      model,
      status: 'preparing',
      surface: opts.surface || 'fullscreen',
      contextSnapshot: opts.contextSnapshot || null,
    });
    if (!written.ok) {
      state.saveError = written.error?.message || '本地保存失败';
      deps.Notice?.(`消息没有保存：${state.saveError}`);
      emit();
      return { ok: false, error: written.error };
    }
    state.stage.savedAt = Date.now();
    state.stage.prep = 'saved';
    state.saveError = '';
    if (state.activeKey === sessionKey) state.messages = messages;
    state.progressLabel = phaseLabel({ status: 'preparing' });
    emit();
    const token = { cancelled: false };
    const previous = prepTokens.get(turnId);
    if (previous) previous.cancelled = true;
    prepTokens.set(turnId, token);
    continuePrep(sessionKey, turnId, content, token).catch((error) => {
      deps.Notice?.(error?.message || '准备上下文失败');
      const loaded = draftFor(sessionKey, turnId);
      if (loaded.draft && loaded.draft.turnStatus === 'preparing') {
        loaded.draft.streaming = false;
        loaded.draft.turnStatus = 'prep_failed';
        loaded.draft.text = '上下文读取失败';
        saveSessionTranscript(sessionKey, loaded.rows);
      }
      emit();
    });
    return { ok: true };
  }

  async function restartPrep(message) {
    const turnId = message?.turnId;
    if (!turnId) return;
    const sessionKey = state.activeKey;
    const user = state.messages.find((row) => row.role === 'user' && row.turnId === turnId);
    const content = user?.text || sessionCache()?.pendingFor(turnId)?.message || '';
    if (!content) {
      deps.Notice?.('找不到原文，不能重试');
      return;
    }
    const previous = prepTokens.get(turnId);
    if (previous) previous.cancelled = true;
    const token = { cancelled: false };
    prepTokens.set(turnId, token);
    const store = sessionCache();
    if (!store?.pendingFor(turnId)) {
      const written = store?.saveTurnWithPending(sessionKey, state.messages, {
        turnId,
        sessionKey,
        message: content,
        prompt: '',
        ts: message.ts || Date.now(),
        status: 'preparing',
      });
      if (!written?.ok) {
        deps.Notice?.(written?.error?.message || '没有保存');
        return;
      }
    } else {
      store.markPending(turnId, { status: 'preparing', message: content });
    }
    message.turnStatus = 'preparing';
    message.streaming = true;
    message.text = '';
    message.errorHint = '';
    message.activity = null;
    state.progressLabel = phaseLabel({ status: 'preparing' });
    emit();
    await continuePrep(sessionKey, turnId, content, token);
  }

  /** Locate (or create) the assistant draft that belongs to a turn. */
  function draftFor(sessionKeyName, turnId, ts) {
    const store = sessionCache();
    const rows =
      sessionKeyName === state.activeKey ? state.messages : store?.loadTranscript(sessionKeyName) || [];
    let draft = rows.find((row) => row.turnId === turnId && row.role === 'assistant');
    if (!draft) {
      draft = {
        id: `a-${turnId}`,
        role: 'assistant',
        text: '',
        ts: ts || Date.now(),
        turnId,
        streaming: true,
        activity: null,
      };
      rows.push(draft);
    }
    return { draft, rows };
  }

  function saveSessionTranscript(sessionKeyName, rows) {
    const store = sessionCache();
    if (store && sessionKeyName) store.saveTranscript(sessionKeyName, rows);
  }

  /**
   * Drive one queued turn through the gateway. Called by the outbox runner only
   * after the record has been frozen as `sending`.
   */
  async function deliverTurnViaGateway(turn) {
    const client = plugin.operator;
    if (!client || client.status.state !== 'live') {
      const error = new Error('OpenClaw 未连接');
      error.code = 'NOT_CONNECTED';
      throw error;
    }
    const sessionKeyName = turn.sessionKey || state.activeKey;
    const onActive = sessionKeyName === state.activeKey;
    const loaded = draftFor(sessionKeyName, turn.turnId, turn.ts);
    const draft = loaded.draft;
    const rows = loaded.rows;
    if (draft) {
      draft.text = '';
      draft.turnStatus = 'sending';
      draft.streaming = true;
      draft.activity = { reasoning: '', tools: [], status: '发出排队消息…', startedAt: Date.now() };
    }
    if (onActive) {
      state.busy = true;
      state.startedAt = Date.now();
      state.progressLabel = '发出排队消息…';
      emit();
    }
    try {
      const result = await client.prompt({
        sessionKey: sessionKeyName,
        message: turn.prompt || turn.message,
        idempotencyKey: turn.turnId,
        thinking: turn.thinking || '',
        model: turn.model || '',
        onText: (_chunk, full) => {
          if (!draft) return;
          draft.text = full;
          draft.streaming = true;
          draft.turnStatus = 'sending';
          if (sessionKeyName === state.activeKey) emitThread();
        },
        onActivity: (activity) => {
          if (!draft) return;
          draft.activity = { ...activity, startedAt: draft.activity?.startedAt || Date.now() };
          draft.streaming = true;
          if (sessionKeyName === state.activeKey) {
            state.progressLabel = activity?.status || state.progressLabel;
            emitThread();
          }
        },
      });
      if (draft) {
        draft.text = result?.text || draft.text;
        draft.streaming = false;
        draft.turnStatus = 'sent';
      }
      saveSessionTranscript(sessionKeyName, rows);
      if (draft?.turnStatus === 'sent') onTurnSent(sessionKeyName, turn.turnId, rows);
      return result;
    } catch (error) {
      if (draft && !isRetryable(error)) {
        draft.text = draft.text || `出错了：${explainSendError(error)}`;
        draft.streaming = false;
        draft.turnStatus = 'error';
        saveSessionTranscript(sessionKeyName, rows);
      } else if (draft) {
        draft.text = draft.text || '状态未知，需要核对';
        draft.streaming = false;
        draft.turnStatus = 'unknown';
        saveSessionTranscript(sessionKeyName, rows);
      }
      throw error;
    } finally {
      if (onActive) {
        state.busy = false;
        emit();
      }
    }
  }

  /**
   * Deliver one turn through the Mac service (durable HTTPS path).
   *
   * The service owns the run, so losing this request does not lose the turn:
   * the same `clientTurnId` is re-submitted and the Mac returns the existing
   * task instead of starting a second one. Progress is polled with `after`, and
   * polling stops the moment the app goes to the background.
   */
  async function deliverTurnViaService(turn) {
    const client = plugin.serviceClient?.();
    if (!client?.hasCredential?.()) {
      const error = new Error('这台设备还没有配对');
      error.code = 'NOT_PAIRED';
      throw error;
    }
    const sessionKeyName = turn.sessionKey || state.activeKey;
    const onActive = sessionKeyName === state.activeKey;
    const loaded = draftFor(sessionKeyName, turn.turnId, turn.ts);
    const draft = loaded.draft;
    const rows = loaded.rows;
    if (draft) {
      draft.turnStatus = 'sending';
      draft.streaming = true;
      draft.activity = { reasoning: '', tools: [], status: '发出到 Mac…', startedAt: Date.now() };
    }
    if (onActive) {
      state.busy = true;
      state.startedAt = Date.now();
      state.progressLabel = '发出到 Mac…';
      emit();
    }
    const repaint = () => {
      if (sessionKeyName === state.activeKey) emitThread();
    };
    let lastAnswerAt = Date.now();
    try {
      const result = await client.runTurn({
        clientTurnId: turn.turnId,
        sessionKey: sessionKeyName,
        message: turn.prompt || turn.message,
        thinking: turn.thinking || '',
        model: turn.model || '',
        onAccepted: (receipt) => {
          state.stage.receipt = receipt.serverTurnId ? 'ok' : '';
          if (!draft) return;
          draft.serverTurnId = receipt.serverTurnId;
          draft.serviceCursor = receipt.cursor || 0;
          draft.model = receipt.model || turn.model || '';
          draft.thinking = receipt.thinking || turn.thinking || '';
          draft.turnStatus = 'sending';
          sessionCache()?.markPending(turn.turnId, {
            serverTurnId: receipt.serverTurnId,
            serviceCursor: receipt.cursor || 0,
            model: draft.model,
            thinking: draft.thinking,
          });
          saveSessionTranscript(sessionKeyName, rows);
        },
        onProgress: (event) => {
          if (!draft) return;
          if (event.text) {
            draft.text = event.text;
            draft.lastProgressAt = Date.now();
            lastAnswerAt = draft.lastProgressAt;
          }
          if (event.activity?.status || event.status) draft.lastProgressAt = Date.now();
          draft.streaming = true;
          draft.turnStatus = 'sending';
          if (event.cursor) {
            draft.serviceCursor = event.cursor;
            state.stage.poll = `seq ${event.cursor}`;
          }
          if (event.activity) {
            draft.activity = {
              reasoning: event.activity.reasoning || '',
              tools: event.activity.tools || [],
              status: event.activity.status || draft.activity?.status || '',
              startedAt: draft.activity?.startedAt || Date.now(),
            };
          } else if (event.status) {
            draft.activity = {
              reasoning: draft.activity?.reasoning || '',
              tools: draft.activity?.tools || [],
              status: event.status,
              startedAt: draft.activity?.startedAt || Date.now(),
            };
          }
          if (sessionKeyName === state.activeKey) paintWait(draft, sessionKeyName);
          repaint();
        },
        shouldContinue: () => isForeground(),
      });
      if (draft) {
        if (result?.aborted) {
          draft.streaming = false;
          draft.turnStatus = 'aborted';
          draft.text = draft.text || '已停止';
          draft.errorHint = nextStepFor('aborted');
        } else {
          draft.text = result?.text || draft.text;
          draft.streaming = false;
          draft.turnStatus = 'sent';
          draft.errorHint = '';
        }
      }
      saveSessionTranscript(sessionKeyName, rows);
      if (draft?.turnStatus === 'sent') onTurnSent(sessionKeyName, turn.turnId, rows);
      return result;
    } catch (error) {
      if (draft) {
        if (error?.code === 'BACKGROUNDED') {
          // Keep the turn id and cursor: the next foreground pass resumes.
          draft.serviceCursor = error.cursor || draft.serviceCursor || 0;
          draft.streaming = true;
          draft.turnStatus = 'sending';
        } else if (error?.code === 'NEEDS_VERIFICATION') {
          draft.text = draft.text || '状态未知，需要核对';
          draft.streaming = false;
          draft.turnStatus = 'unknown';
          draft.errorHint = nextStepFor('unknown', error);
        } else if (isRetryable(error) || error?.code === 'NETWORK' || error?.code === 'TIMEOUT') {
          draft.text = draft.text || '状态未知，需要核对';
          draft.streaming = false;
          draft.turnStatus = 'unknown';
          draft.errorHint = nextStepFor('unknown', error);
        } else {
          draft.text = draft.text || `出错了：${explainSendError(error)}`;
          draft.streaming = false;
          draft.turnStatus = 'error';
          draft.errorHint = nextStepFor('error', error);
        }
        saveSessionTranscript(sessionKeyName, rows);
      }
      throw error;
    } finally {
      if (onActive) {
        state.busy = false;
        emit();
      }
    }
  }

  function paintWait(draft, sessionKeyName) {
    if (sessionKeyName !== state.activeKey || !draft) return;
    const frozen = draft.turnStatus;
    if (frozen && frozen !== 'sending') {
      state.progressLabel = phaseLabel({ status: frozen, hasText: !!String(draft.text || '').trim() });
      return;
    }
    const since = draft.lastProgressAt || state.startedAt || Date.now();
    const idle = Date.now() - since;
    const tools = draft.activity?.tools || [];
    if (tools.length) {
      const tool = tools[tools.length - 1];
      state.progressLabel = tool.title || tool.name || '正在回复';
    } else if (idle >= 30000 && !String(draft.text || '').trim()) {
      const secs = Math.floor(idle / 1000);
      const stamp = new Date(since);
      const clock = `${stamp.getHours()}:${String(stamp.getMinutes()).padStart(2, '0')}`;
      state.progressLabel = `等待模型回复 · ${secs} 秒 · ${clock} 更新`;
    } else {
      state.progressLabel = phaseLabel({
        status: 'sending',
        hasText: !!String(draft.text || '').trim(),
        delivered: !!draft.serverTurnId,
      });
    }
    if (idle >= 90000 && draft.serverTurnId && !draft.verifying) {
      draft.verifying = true;
      const client = plugin.serviceClient?.();
      client
        ?.verifyTurn?.(draft.serverTurnId)
        .catch(() => {})
        .finally(() => {
          draft.verifying = false;
        });
    }
    emit();
  }

  /** The phone only polls while the chat is actually visible. */
  function isForeground() {
    if (typeof document === 'undefined') return true;
    return document.visibilityState !== 'hidden';
  }

  function entryMode() {
    if (typeof plugin.entryMode === 'function') return plugin.entryMode();
    return plugin.deviceCredential?.() ? 'service' : 'direct';
  }

  function isPhoneApp() {
    const body = typeof document !== 'undefined' ? document.body : null;
    return !!(
      app?.isMobile ||
      app?.isPhone ||
      body?.classList?.contains('is-mobile') ||
      body?.classList?.contains('is-phone')
    );
  }

  function connectionState() {
    const mobileClient = isPhoneApp() || plugin.entryMode?.() === 'service';
    if (entryMode() === 'service' || (mobileClient && !plugin.deviceCredential?.())) {
      const device = plugin.deviceInfo?.();
      if (!plugin.deviceCredential?.()) {
        return {
          state: 'offline',
          message: '还没有配对这台设备，消息只会留在本机',
          needsPairing: true,
        };
      }
      if (state.serviceError) return { state: 'offline', message: state.serviceError, paired: true };
      return {
        state: 'live',
        message: `已配对${device?.name ? ` · ${device.name}` : ''}`,
        paired: true,
      };
    }
    return plugin.operator?.status || { state: 'offline', message: '尚未连接' };
  }

  function isLive() {
    if (entryMode() === 'service') return !!plugin.deviceCredential?.();
    return plugin.operator?.status?.state === 'live';
  }

  function deliverTurn(turn) {
    return entryMode() === 'service' ? deliverTurnViaService(turn) : deliverTurnViaGateway(turn);
  }

  const outbox = createOutboxRunner({
    store: {
      loadTranscript: (key) => sessionCache()?.loadTranscript(key) || [],
      saveTurnWithPending: (...args) => {
        const store = sessionCache();
        if (!store) return { ok: false, error: new Error('本地存储不可用') };
        return store.saveTurnWithPending(...args);
      },
      listPending: (key) => sessionCache()?.listPending(key) || [],
      pendingFor: (id) => sessionCache()?.pendingFor(id) || null,
      markSending: (id) => sessionCache()?.markSending(id),
      markSent: (id, extra) => sessionCache()?.markSent(id, extra),
      markUnknown: (id, reason) => sessionCache()?.markUnknown(id, reason),
      markFailed: (id, reason) => sessionCache()?.markFailed(id, reason),
      markPending: (id, patch) => sessionCache()?.markPending(id, patch),
      markQueuedForRetry: (id) => sessionCache()?.markQueuedForRetry(id),
      dropTurn: (id) => sessionCache()?.dropTurn(id),
    },
    // In service mode the only precondition is a device credential: the Mac
    // does not need to be reachable for a message to be saved and queued.
    isConnected: () => (entryMode() === 'service' ? !!plugin.deviceCredential?.() : isLive()),
    send: (turn) => deliverTurn(turn),
    onTurn: (event) => {
      if (event.kind === 'sent') {
        applyTurnStatus(event.turn.turnId, 'sent', '');
      } else if (event.kind === 'unknown') {
        applyTurnStatus(event.turn.turnId, 'unknown', '状态未知，需要核对');
        deps.Notice?.('这条消息的状态未知，可在消息下方选择重发或忽略');
      } else if (event.kind === 'error') {
        applyTurnStatus(event.turn.turnId, 'error', explainSendError(event.error));
      }
      emitThread();
      emit();
    },
  });

  /** Reflect a durable turn status onto whatever thread is on screen. */
  function applyTurnStatus(turnId, status, text) {
    const store = sessionCache();
    const key = store?.pendingFor(turnId)?.sessionKey || state.activeKey;
    if (key === state.activeKey) {
      const draft = state.messages.find((row) => row.turnId === turnId && row.role === 'assistant');
      if (draft) {
        draft.turnStatus = status;
        draft.streaming = status === 'sending';
        if (status === 'unknown') {
          draft.text = draft.text || '状态未知，需要核对';
          draft.streaming = false;
        } else if (status === 'error' && text) {
          draft.text = draft.text || `出错了：${text}`;
          draft.streaming = false;
        }
      }
      persistLocal();
      return;
    }
    const rows = store?.loadTranscript(key) || [];
    const draft = rows.find((row) => row.turnId === turnId && row.role === 'assistant');
    if (draft) {
      draft.turnStatus = status;
      draft.streaming = status === 'sending';
      saveSessionTranscript(key, rows);
    }
  }

  async function flushOutbox() {
    // Service mode only needs a device credential: the Mac may be unreachable
    // and the message still belongs in the queue.
    if (entryMode() === 'service') {
      if (!plugin.deviceCredential?.()) return;
    } else if (!isLive()) {
      return;
    }
    await outbox.flush();
    emit();
  }

  async function pendingAction(message, action) {
    const turnId = message?.turnId;
    if (!turnId) return;
    if (action === 'retry') {
      const pending = sessionCache()?.pendingFor(turnId);
      const needsPrep =
        !pending ||
        message?.turnStatus === 'prep_failed' ||
        message?.turnStatus === 'unconfirmed' ||
        pending.status === 'preparing' ||
        pending.status === 'prep_failed';
      if (needsPrep) {
        try {
          await restartPrep(message);
        } catch (error) {
          deps.Notice?.(error?.message || '重试失败');
        }
        return;
      }
      const result = await outbox.retry(turnId);
      if (!result?.ok) deps.Notice?.(result?.error?.message || '重发失败');
      applyTurnStatus(turnId, 'sending', '');
      emit();
      return;
    }
    if (action === 'discard') {
      const result = outbox.discard(turnId);
      if (!result?.ok) {
        deps.Notice?.(result?.error?.message || '无法忽略');
        return;
      }
      state.messages = state.messages.filter((row) => row.turnId !== turnId);
      persistLocal();
      emit();
    }
  }

  async function regenerate(message) {
    const index = state.messages.findIndex((item) => item.id === message?.id);
    let text = '';
    for (let i = index - 1; i >= 0; i -= 1) {
      if (state.messages[i].role === 'user') {
        text = state.messages[i].text;
        break;
      }
    }
    if (text) await send(text);
  }

  async function abort() {
    const draft = [...state.messages].reverse().find((item) => item.streaming);
    state.progressLabel = phaseLabel({ confirmingStop: true });
    emit();
    if (entryMode() === 'service') {
      const serverId = draft?.serverTurnId;
      if (!serverId) {
        deps.Notice?.('还没有拿到服务端任务，停止尚未确认');
        return;
      }
      try {
        const response = await plugin.serviceClient?.().cancelTurn(serverId);
        const status = response?.json?.turn?.status;
        if (status === 'aborted') {
          if (draft) {
            draft.streaming = false;
            draft.turnStatus = 'aborted';
            draft.text = draft.text || '已停止';
            draft.errorHint = nextStepFor('aborted');
          }
          state.busy = false;
          state.progressLabel = '已停止';
        } else {
          deps.Notice?.('停止请求已发出，正在确认');
        }
      } catch {
        deps.Notice?.('停止还没得到确认');
      }
      emit();
      return;
    }
    if (!state.activeKey || !plugin.operator) return;
    try {
      await plugin.operator.abort(state.activeKey);
    } catch {
      deps.Notice?.('停止还没得到确认');
      return;
    }
    if (draft) {
      draft.streaming = false;
      draft.turnStatus = 'aborted';
    }
    state.busy = false;
    emit();
  }

  loadLocalCache();
  plugin.operator?.onStatus?.((status) => {
    if (entryMode() === 'service') return;
    emit();
    if (status?.state === 'live') {
      refreshSessions().catch(() => emit());
    }
  });
  emit();
  if (!deps.preview) {
    // Cold start: reconcile delivered/executed state before sending anything,
    // then flush whatever the phone still owes the Mac.
    if (entryMode() === 'service') {
      checkService()
        .then(() => refreshSessions())
        .catch(() => emit());
    } else {
      plugin
        .ensureOperator?.()
        .then(() => refreshSessions())
        .catch(() => emit());
    }
  }

  /** Cheap reachability probe so the banner can distinguish "offline" from "broken". */
  async function showDiagnosis() {
    const client = plugin.serviceClient?.();
    let phone = '未检查';
    let kernel = '未检查';
    if (client?.diagnose) {
      try {
        const report = await client.diagnose();
        phone = report.reachable ? '通' : '不通';
        kernel = report.kernel || (report.reachable ? '未知' : '未到达');
      } catch {
        phone = '不通';
      }
    } else if (plugin.operator?.status) {
      phone = plugin.operator.status.state === 'live' ? '通' : '不通';
      kernel = phone;
    }
    const saved = state.stage.savedAt ? new Date(state.stage.savedAt).toISOString().slice(11, 19) : '无';
    const text = [
      `构建：${state.stage.build}`,
      `保存：${saved}`,
      `上下文：${state.stage.prep || '无'}`,
      `回执：${state.stage.receipt || '无'}`,
      `查询：${state.stage.poll || '无'}`,
      `手机到服务：${phone}`,
      `服务到 OpenClaw：${kernel}`,
      `任务：${state.progressLabel || '空闲'}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      deps.Notice?.(`${text}\n已复制`);
    } catch {
      deps.Notice?.(text);
    }
  }

  /** Cheap reachability probe so the banner can distinguish "offline" from "broken". */
  async function checkService() {
    const client = plugin.serviceClient?.();
    if (!client?.hasCredential?.()) {
      state.serviceError = '';
      return false;
    }
    try {
      await client.health();
      await plugin.loadServiceCatalog?.().catch(() => {});
      state.serviceError = '';
      return true;
    } catch (error) {
      state.serviceError = error?.message || '连不上 Mac 服务';
      return false;
    } finally {
      emit();
    }
  }

  /** Foreground recovery: verify state, fetch results, then send the queue. */
  async function recoverFromBackground() {
    if (entryMode() !== 'service') {
      await refreshSessions();
      return;
    }
    await checkService();
    await refreshSessions();
    await resumePendingTurns();
    await flushOutbox();
  }

  /**
   * Turns whose poll was interrupted (background, crash, network) are picked up
   * again by id. This never re-submits, so a resumed turn cannot run twice.
   */
  async function resumePendingTurns() {
    if (resumingTurns) return;
    const client = plugin.serviceClient?.();
    if (!client?.hasCredential?.()) return;
    const store = sessionCache();
    if (!store) return;
    resumingTurns = true;
    try {
      await resumePendingTurnsInner(client, store);
    } finally {
      resumingTurns = false;
    }
  }

  async function resumePendingTurnsInner(client, store) {
    const pending = store
      .listPending()
      .filter((turn) => turn.status === 'sending' || turn.status === 'unknown');
    const groups = new Map();
    for (const turn of pending) {
      const key = turn.sessionKey || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(turn);
    }
    await Promise.all([...groups.values()].map((turns) => resumeSessionTurns(client, store, turns)));
    emit();
  }

  async function resumeSessionTurns(client, store, turns) {
    for (const turn of turns) {
      if (!isForeground()) return;
      if (livePolls.has(turn.turnId)) continue;
      livePolls.add(turn.turnId);
      const sessionKeyName = turn.sessionKey;
      const loaded = draftFor(sessionKeyName, turn.turnId, turn.ts);
      const draft = loaded.draft;
      const rows = loaded.rows;
      try {
        let serverId = turn.serverTurnId || draft?.serverTurnId || '';
        if (!serverId) {
          const found = await client.lookupClientTurn(turn.turnId);
          if (!found?.id) continue;
          serverId = found.id;
          store.markPending(turn.turnId, { serverTurnId: serverId });
          if (draft) draft.serverTurnId = serverId;
        }
        if (sessionKeyName === state.activeKey) {
          state.progressLabel = phaseLabel({ reconnecting: true });
          emit();
        }
        const result = await client.resumeTurn(serverId, {
          after: draft?.serviceCursor || turn.serviceCursor || 0,
          pollMs: 2000,
          shouldContinue: () => isForeground(),
          onProgress: (event) => {
            if (!draft) return;
            if (event.text) draft.text = event.text;
            if (event.cursor) draft.serviceCursor = event.cursor;
            if (event.activity) {
              draft.activity = {
                reasoning: event.activity.reasoning || '',
                tools: event.activity.tools || [],
                status: event.activity.status || draft.activity?.status || '',
                startedAt: draft.activity?.startedAt || Date.now(),
              };
            }
            draft.streaming = true;
            draft.lastProgressAt = Date.now();
            if (sessionKeyName === state.activeKey) paintWait(draft, sessionKeyName);
          },
        });
        if (draft) {
          if (result?.aborted) {
            draft.text = draft.text || '已停止';
            draft.streaming = false;
            draft.turnStatus = 'aborted';
            draft.errorHint = nextStepFor('aborted');
            store.markFailed(turn.turnId, '已停止');
          } else {
            draft.text = result?.text || draft.text;
            draft.streaming = false;
            draft.turnStatus = 'sent';
            outbox.markSent(turn.turnId, { runId: result?.runId || '', serverTurnId: serverId });
          }
        }
        store.saveTranscript(sessionKeyName, rows);
        if (draft?.turnStatus === 'sent') onTurnSent(sessionKeyName, turn.turnId, rows);
      } catch (error) {
        if (draft) saveSessionTranscript(sessionKeyName, rows);
        if (error?.code === 'BACKGROUNDED') return;
        if (error?.code === 'NEEDS_VERIFICATION') {
          if (draft) {
            draft.text = draft.text || '状态未知，需要核对';
            draft.streaming = false;
            draft.turnStatus = 'unknown';
            draft.errorHint = nextStepFor('unknown', error);
          }
          outbox.markUnknown(turn.turnId, error.message);
          store.saveTranscript(sessionKeyName, rows);
          continue;
        }
        if (error?.code === 'RUN_FAILED') {
          if (draft) {
            draft.streaming = false;
            draft.turnStatus = 'error';
            draft.errorHint = nextStepFor('error', error);
            draft.text = draft.text || `出错了：${explainSendError(error)}`;
          }
          store.markFailed(turn.turnId, error.message || '');
          store.saveTranscript(sessionKeyName, rows);
          continue;
        }
        return;
      } finally {
        livePolls.delete(turn.turnId);
      }
    }
  }
  return {
    state, getState, subscribe, attachView,
    loadLocalCache, persistLocal, send, abort, openSession, removeSession, newSession,
    refreshSessions, flushOutbox, recoverFromBackground, pendingAction, regenerate,
    connectionState, entryMode, isLive, sessionCache, explainSendError, applyTurnStatus,
    continueRecent, outbox, showDiagnosis, checkService,
  };
}
