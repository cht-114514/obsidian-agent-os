/**
 * OpenClaw-style shell: drawer, thread, composer, connection banner.
 */
import { buildTurnPrompt, loadSoulPack } from '../memory/inject.js';
import { handleConfirmAccept, handleConfirmReject } from '../confirm-actions.js';
import { renderMarkdownWithMath } from '../markdown-render.js';
import { isUserSession, mountSidebar, sessionKey, sessionLabel } from './sidebar.js';
import { mountChatPane } from './chat-pane.js';
import { mountComposer } from './composer.js';
import { placeholderFor, renderConnection } from './connection-view.js';
import { historyToTurns, newMessageId } from './turns.js';

function isMobileApp(app) {
  const body = typeof document !== 'undefined' ? document.body : null;
  return !!(
    app?.isMobile ||
    app?.isPhone ||
    body?.classList?.contains('is-mobile') ||
    body?.classList?.contains('is-phone')
  );
}

function usageOf(row) {
  const used = Number(row?.totalTokens);
  const limit = Number(row?.contextTokens);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return { used, limit };
}

export function mountAgentApp(container, deps) {
  const plugin = deps.plugin;
  const app = deps.app;
  const mobile = isMobileApp(app);
  const root = container.createDiv({
    cls: `aos-root${mobile ? ' is-mobile' : ''}`,
  });
  const shell = root.createDiv({ cls: 'aos-shell' });
  const backdrop = shell.createDiv({ cls: 'aos-backdrop' });
  const sidebarEl = shell.createDiv({ cls: mobile ? 'aos-sidebar' : 'aos-sidebar is-open' });
  const main = shell.createDiv({ cls: 'aos-main' });
  const top = main.createDiv({ cls: 'aos-topbar' });
  const menuBtn = top.createEl('button', {
    cls: 'aos-text-btn',
    text: '会话',
    attr: { type: 'button', 'aria-label': '会话' },
  });
  const titleEl = top.createDiv({ cls: 'aos-top-title', text: 'Agent' });
  const newBtn = top.createEl('button', {
    cls: 'aos-text-btn',
    text: '新会话',
    attr: { type: 'button', 'aria-label': '新会话' },
  });

  const connection = main.createDiv({ cls: 'aos-connection' });
  const log = main.createDiv({ cls: 'aos-log' });
  const composerHost = main.createDiv({ cls: 'aos-composer-host' });

  const state = {
    sessions: [],
    activeKey: '',
    messages: [],
    busy: false,
    sidebarOpen: !mobile,
    startedAt: 0,
    progressLabel: '思考中',
  };

  const sidebar = mountSidebar(sidebarEl, {
    onNew: () => newSession(),
    onSelect: (key) => openSession(key),
  });

  const thread = mountChatPane(log, {
    agentName: plugin.settings.agentName,
    quiet: plugin.settings.quiet,
    renderMarkdown: (el, markdown) => renderMarkdown(el, markdown),
    onConfirm: (card, action) => confirm(card, action),
    onCopy: async (text) => {
      try {
        await navigator.clipboard.writeText(text || '');
        deps.Notice?.('已复制');
      } catch {
        deps.Notice?.(text || '');
      }
    },
    onRegenerate: (message) => regenerate(message),
    onContinue: () => continueRecent(),
  });

  const composer = mountComposer(composerHost, {
    mobile,
    onSend: (text) => send(text),
    onAbort: () => abort(),
    onNew: () => newSession(),
    onThinking: (id) => plugin.setConnectionPrefs?.({ thinking: id }),
    onModel: (id) => plugin.setKernelModel?.(id),
  });

  backdrop.onclick = () => {
    state.sidebarOpen = false;
    paintChrome();
  };
  menuBtn.onclick = () => toggleDrawer();
  newBtn.onclick = () => newSession();

  function connectionState() {
    return plugin.operator?.status || { state: 'offline', message: '尚未连接' };
  }

  function activeRow() {
    return state.sessions.find((row) => sessionKey(row) === state.activeKey) || null;
  }

  function emitTitle() {
    const title = state.activeKey
      ? sessionLabel(activeRow() || { key: state.activeKey, label: '新会话' })
      : 'Agent';
    if (titleEl) titleEl.setText(title);
    deps.onTitle?.(title);
  }

  function paintChrome() {
    root.toggleClass('is-drawer', !!(mobile && state.sidebarOpen));
    const status = connectionState();
    sidebar.update({
      agentName: plugin.settings.agentName,
      sessions: state.sessions,
      activeKey: state.activeKey,
      open: state.sidebarOpen || !mobile,
      connection: status.state,
      now: Date.now(),
    });
    thread.update({
      messages: state.messages,
      canContinue: state.sessions.length > 0,
    });
    composer.setBusy(state.busy);
    composer.setProgress({
      on: state.busy,
      label: state.progressLabel || '思考中',
      startedAt: state.startedAt,
    });
    composer.setPlaceholder(placeholderFor(status.state, plugin.settings.agentName));
    composer.setUsage(usageOf(activeRow()));
    composer.setThinking(plugin.thinkingChoices?.() || [], plugin.resolveOutgoingThinking?.() || '');
    const models = Array.isArray(plugin.kernelModels) ? plugin.kernelModels : [];
    composer.setModels(
      models.map((model) => ({
        id: model.id,
        label: model.name || model.id,
      })),
      plugin.connectionPrefs?.().model || ''
    );
    renderConnection(connection, status, {
      onRetry: () => plugin.ensureOperator?.().then(() => refreshSessions()),
      onCopy: async (text) => {
        try {
          await navigator.clipboard.writeText(text);
          deps.Notice?.('已复制批准命令');
        } catch {
          deps.Notice?.(text);
        }
      },
    });
    emitTitle();
    applyNavbar();
  }

  function paintThread() {
    thread.update({ messages: state.messages });
    if (state.busy) {
      composer.setProgress({
        on: true,
        label: state.progressLabel || '思考中',
        startedAt: state.startedAt,
      });
    }
  }

  async function renderMarkdown(el, markdown) {
    if (!deps.MarkdownRenderer && !deps.renderMath) {
      el.setText(markdown);
      return;
    }
    await renderMarkdownWithMath({
      app,
      MarkdownRenderer: deps.MarkdownRenderer,
      component: deps.view || plugin,
      el,
      markdown,
      loadMathJax: deps.loadMathJax,
      renderMath: deps.renderMath,
      finishRenderMath: deps.finishRenderMath,
    });
  }

  function applySafeTop() {
    let px = 0;
    try {
      const raw = getComputedStyle(document.body).getPropertyValue('--safe-area-inset-top').trim();
      const parsed = parseFloat(raw);
      if (parsed > 0) px = parsed;
    } catch {
      /* ignore */
    }
    if (!px && mobile) px = 54;
    if (!mobile) px = 0;
    root.style.setProperty('--aos-safe-top', `${Math.round(px)}px`);
  }

  function applyNavbar() {
    applySafeTop();
    const hide = !!(mobile && plugin.settings?.hideMobileNavbar);
    document.body.classList.toggle('aos-hide-navbar', hide);
    if (hide) {
      root.style.setProperty('--aos-navbar-h', '0px');
      return;
    }
    const nav = document.querySelector('.mobile-navbar');
    const height = nav ? Math.round(nav.getBoundingClientRect().height) : 0;
    root.style.setProperty('--aos-navbar-h', `${height}px`);
  }

  function bindKeyboard() {
    const viewport = window.visualViewport;
    if (!viewport) return () => {};
    const update = () => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      root.style.setProperty('--aos-keyboard', `${Math.round(inset)}px`);
      if (inset > 0) thread.scrollToEnd();
    };
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    update();
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }

  function bindNavbar() {
    const nav = document.querySelector('.mobile-navbar');
    if (!nav || typeof ResizeObserver === 'undefined') return () => {};
    const observer = new ResizeObserver(() => applyNavbar());
    observer.observe(nav);
    return () => observer.disconnect();
  }

  const unbindKeyboard = mobile ? bindKeyboard() : () => {};
  const unbindNavbar = mobile ? bindNavbar() : () => {};

  function toggleDrawer() {
    state.sidebarOpen = !state.sidebarOpen;
    paintChrome();
    if (state.sidebarOpen) refreshSessions();
  }

  async function refreshSessions() {
    const client = plugin.operator;
    if (!client || client.status.state !== 'live') {
      paintChrome();
      return;
    }
    try {
      state.sessions = (await client.listSessions()).filter((row) => !row?.archived && isUserSession(row));
    } catch (error) {
      state.sessions = [];
      deps.Notice?.(error?.message || '会话列表加载失败');
    }
    if (!isUserSession({ key: state.activeKey })) {
      const mainKey = state.sessions.map(sessionKey).find((key) => key.endsWith(':main'));
      state.activeKey = mainKey || state.sessions.map(sessionKey).find(Boolean) || '';
      state.messages = [];
    }
    paintChrome();
    if (state.activeKey && !state.messages.length && !state.sidebarOpen) {
      await openSession(state.activeKey, { keepIfMissing: true });
    }
  }

  async function openSession(key, opts = {}) {
    const client = plugin.operator;
    if (!client || client.status.state !== 'live') {
      paintChrome();
      deps.Notice?.('还没连上，暂时不能切换会话');
      return;
    }
    try {
      const payload = await client.history(key, 80);
      const messages = historyToTurns(payload);
      state.activeKey = key;
      if (mobile) state.sidebarOpen = false;
      if (messages.length || !opts.keepIfMissing) state.messages = messages;
    } catch (error) {
      deps.Notice?.(error?.message || '打不开这个会话');
    }
    paintChrome();
  }

  function newSession() {
    const key = `agent:${plugin.settings.agentId || 'main'}:aos-${Date.now().toString(36)}`;
    state.activeKey = key;
    state.messages = [];
    if (mobile) state.sidebarOpen = false;
    state.sessions = [{ key, label: '新会话', updatedAt: Date.now() }, ...state.sessions];
    paintChrome();
    composer.focus();
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
    if (error?.code === 'CONNECTION_LOST' || error?.code === 'NOT_CONNECTED') return '连接断了，正在重连。';
    return message;
  }

  async function send(text) {
    if (state.busy) return;
    const client = await plugin.ensureOperator?.();
    if (!client || client.status.state !== 'live') {
      paintChrome();
      deps.Notice?.(client?.status?.message || 'OpenClaw 未连接');
      return;
    }
    if (!isUserSession({ key: state.activeKey })) newSession();
    let prompt = text;
    try {
      const pack = await loadSoulPack(readRel);
      prompt = buildTurnPrompt({ ...pack, userMessage: text });
    } catch {
      prompt = text;
    }
    const turnId = newMessageId('t');
    const now = Date.now();
    state.messages.push({ id: newMessageId('u'), role: 'user', text, ts: now, turnId });
    const draft = {
      id: newMessageId('a'),
      role: 'assistant',
      text: '',
      ts: now,
      turnId,
      streaming: true,
      activity: { reasoning: '', tools: [], status: '思考中', startedAt: now },
    };
    state.messages.push(draft);
    state.busy = true;
    state.startedAt = now;
    state.progressLabel = '思考中';
    paintChrome();
    try {
      const result = await client.prompt({
        sessionKey: state.activeKey,
        message: prompt,
        thinking: plugin.resolveOutgoingThinking?.() || '',
        onText: (_chunk, full) => {
          draft.text = full;
          draft.streaming = true;
          paintThread();
        },
        onActivity: (activity) => {
          draft.activity = { ...activity, startedAt: draft.activity?.startedAt || now };
          draft.streaming = true;
          state.progressLabel = activity?.status || state.progressLabel;
          paintThread();
        },
      });
      draft.text = result.text || draft.text;
      draft.streaming = false;
    } catch (error) {
      draft.text = draft.text || `出错了：${explainSendError(error)}`;
      draft.streaming = false;
    }
    state.busy = false;
    paintChrome();
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
    if (!state.activeKey || !plugin.operator) return;
    try {
      await plugin.operator.abort(state.activeKey);
    } catch {
      /* ignore */
    }
    const draft = [...state.messages].reverse().find((item) => item.streaming);
    if (draft) draft.streaming = false;
    state.busy = false;
    paintChrome();
  }

  async function confirm(card, action) {
    const path = card.getAttribute('data-path') || '';
    if (!path) return;
    const file = app.vault.getAbstractFileByPath(path);
    if (!file) {
      deps.Notice?.(`找不到 ${path}`);
      return;
    }
    const markdown = await app.vault.read(file);
    const result = action === 'accept' ? handleConfirmAccept(markdown) : handleConfirmReject(markdown);
    if (!result.ok) {
      deps.Notice?.(result.reason || '无法更新确认卡');
      return;
    }
    await app.vault.modify(file, result.markdown);
    deps.Notice?.(action === 'accept' ? '已接受' : '已拒绝');
  }

  if (deps.preview) {
    state.sessions = deps.preview.sessions || [];
    state.messages = deps.preview.messages || [];
    state.activeKey = deps.preview.activeKey || sessionKey(state.sessions[0]) || '';
    state.sidebarOpen = !!deps.preview.drawer;
    if (deps.preview.keyboard) root.style.setProperty('--aos-keyboard', deps.preview.keyboard);
  }

  const offStatus = plugin.operator?.onStatus?.(() => paintChrome());
  paintChrome();
  if (!deps.preview) {
    plugin.ensureOperator?.().then(() => refreshSessions()).catch(() => paintChrome());
  }

  return {
    destroy() {
      unbindKeyboard();
      unbindNavbar();
      offStatus?.();
      thread.destroy();
      composer.destroy();
      document.body.classList.remove('aos-hide-navbar');
      root.remove();
    },
    toggleDrawer,
    newSession,
    async reloadSession() {
      if (state.activeKey) await openSession(state.activeKey);
    },
    async consumeQueuedLaunch() {
      const launch = plugin.takeChatLaunch?.();
      if (!launch?.skillId) return;
      const text = `/${launch.skillId}${launch.text ? ` ${launch.text}` : ''}`;
      if (launch.autoSend !== false) await send(text);
    },
  };
}
