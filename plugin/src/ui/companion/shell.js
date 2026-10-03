/**
 * Resident companion window: capsule + panel, shared chat controller.
 */
import { MarkdownView, Platform } from 'obsidian';
import { mountChatPane } from '../chat-pane.js';
import { mountComposer } from '../composer.js';
import { renderMarkdownWithMath } from '../../markdown-render.js';
import { phaseLabel } from '../turn-phase.js';
import { placeholderFor } from '../connection-view.js';
import { sessionLabel, sessionKey } from '../sidebar.js';
import {
  captureContextSnapshot,
  liveContextLabel,
} from '../../context-snapshot.js';
import { buildApplyPreview, applyCompanionEdit } from '../../companion-apply.js';
import {
  defaultCapsulePos,
  defaultPanelGeom,
  loadCapsulePos,
  loadPanelGeom,
  saveCapsulePos,
  savePanelGeom,
} from './layout.js';
import { composerOffsetPx, resolveMobileKeyboardPx } from '../mobile-insets.js';
import {
  listArchivedSessions,
  loadSessionFromPath,
  SESSION_PATH,
} from '../../chat-history.js';

function isMobile() {
  return Platform.isMobileApp || Platform.isMobile;
}

/**
 * @param {import('obsidian').App} app
 * @param {any} plugin
 * @param {*} deps
 */
export function createCompanionController(app, plugin, deps) {
  const { Notice, MarkdownRenderer, loadMathJax, renderMath, finishRenderMath } = deps;
  const mobile = isMobile();
  let root = null;
  let capsule = null;
  let panel = null;
  let threadHost = null;
  let composerHost = null;
  let contextEl = null;
  let titleEl = null;
  let expanded = false;
  let inputDraft = '';
  let contextMode = 'follow';
  let pinnedPath = '';
  let unsub = null;
  let detachView = null;
  let thread = null;
  let composer = null;
  /** @type {Map<string, any>} */
  const turnSnapshots = new Map();

  const ctrl = () => plugin.ensureChatController();

  function notify(msg) {
    try {
      new Notice(msg);
    } catch {
      /* */
    }
  }

  function connectionState() {
    return ctrl().connectionState();
  }

  function runtimeLabel() {
    const st = ctrl().state;
    if (st.busy) return st.progressLabel || '思考中';
    const status = connectionState();
    if (status.state === 'offline') return '离线';
    if (st.messages.some((m) => m.role === 'assistant' && m.turnStatus === 'error')) return '失败';
    const last = [...st.messages].reverse().find((m) => m.role === 'assistant' && m.text);
    if (last && !last.streaming) return '有回复';
    return '在线';
  }

  function paintContextChip() {
    if (!contextEl) return;
    const label = liveContextLabel(app, {
      mode: contextMode,
      pinnedPath,
    });
    const parts = [];
    if (contextMode === 'off') parts.push('未附带上下文');
    else if (!label.attached) parts.push(label.title || '未附带正文');
    else {
      parts.push(label.title);
      if (label.hasSelection) parts.push('· 有选区');
    }
    contextEl.setText(parts.join(' '));
  }

  function syncUi() {
    if (!root) return;
    const st = ctrl().state;
    const name = plugin.settings.agentName || 'Agent';
    if (capsule) {
      capsule.setText(`${name} · ${runtimeLabel()}`);
      capsule.toggleClass('is-busy', !!st.busy);
    }
    if (titleEl) {
      const row = st.sessions.find((r) => sessionKey(r) === st.activeKey);
      titleEl.setText(sessionLabel(row || { key: st.activeKey, label: '会话' }));
    }
    paintContextChip();
    thread?.update({ messages: st.messages, canContinue: st.sessions.length > 0 });
    composer?.setBusy(st.busy);
    composer?.setProgress({
      on: st.busy,
      label: st.progressLabel || phaseLabel({ status: 'sending' }),
      startedAt: st.startedAt,
    });
    const status = connectionState();
    composer?.setPlaceholder(placeholderFor(status.state, name));
    document.body.classList.toggle('aos-companion-open', expanded);
    const fullscreen = plugin.isChatViewActive?.();
    root.toggleClass('is-hidden', !!fullscreen);
  }

  async function renderMarkdown(el, markdown) {
    await renderMarkdownWithMath({
      app,
      MarkdownRenderer,
      component: plugin,
      el,
      markdown,
      loadMathJax,
      renderMath,
      finishRenderMath,
    });
  }

  function ensureDom() {
    if (root) return;
    root = document.body.createDiv({ cls: `aos-companion-root${mobile ? ' is-mobile' : ''}` });
    capsule = root.createDiv({ cls: 'aos-companion-capsule', attr: { role: 'button', tabindex: '0' } });
    panel = root.createDiv({ cls: 'aos-companion-panel', attr: { 'aria-hidden': 'true' } });
    const head = panel.createDiv({ cls: 'aos-companion-head' });
    titleEl = head.createDiv({ cls: 'aos-companion-title' });
    const headActions = head.createDiv({ cls: 'aos-companion-head-actions' });
    headActions
      .createEl('button', { text: '全屏', attr: { type: 'button' } })
      .addEventListener('click', () => plugin.activateView?.());
    headActions
      .createEl('button', { text: '收起', attr: { type: 'button' } })
      .addEventListener('click', () => collapse());
    threadHost = panel.createDiv({ cls: 'aos-companion-log' });
    const foot = panel.createDiv({ cls: 'aos-companion-foot' });
    contextEl = foot.createDiv({ cls: 'aos-companion-context' });
    contextEl.addEventListener('click', () => cycleContextMode());
    composerHost = foot.createDiv({ cls: 'aos-companion-composer' });

    thread = mountChatPane(threadHost, {
      agentName: plugin.settings.agentName,
      quiet: plugin.settings.quiet,
      renderMarkdown,
      onCopy: async (text) => {
        try {
          await navigator.clipboard.writeText(text || '');
          notify('已复制');
        } catch {
          notify(text || '');
        }
      },
      onRegenerate: (m) => ctrl().regenerate(m),
      onContinue: () => ctrl().continueRecent(),
      onPendingAction: (m, a) => ctrl().pendingAction(m, a),
      onCompanionApply: async (message, action) => {
        const snap = turnSnapshots.get(message.turnId);
        if (!snap) {
          notify('找不到该轮笔记快照');
          return;
        }
        const preview = await buildApplyPreview(app, snap, message.text);
        const mode = action === 'replace' ? 'replace_selection' : 'insert_at_cursor';
        await applyCompanionEdit(app, plugin, {
          snapshot: snap,
          text: preview.cleaned,
          mode,
          onNotice: notify,
        });
      },
    });

    composer = mountComposer(composerHost, {
      mobile,
      onSend: (text) => submit(text),
      onAbort: () => ctrl().abort(),
      onThinking: (id) => plugin.setConnectionPrefs?.({ thinking: id }),
      onModel: (id) => plugin.setKernelModel?.(id),
      onApply: async ({ model, thinking }) => {
        await plugin.setConnectionPrefs?.({ model: model || '', thinking: thinking || '' });
        syncUi();
      },
      onNotice: notify,
    });

    capsule.addEventListener('click', () => {
      if (expanded) collapse();
      else expand();
    });
    capsule.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (expanded) collapse();
        else expand();
      }
    });
    document.addEventListener('keydown', onKeydown);
    placeCapsule();
    placePanel();
    bindFollowNote();
  }

  function cycleContextMode() {
    const order = ['follow', 'pin', 'off'];
    const i = order.indexOf(contextMode);
    contextMode = order[(i + 1) % order.length];
    if (contextMode === 'pin') {
      const v = app.workspace.getActiveViewOfType(MarkdownView);
      pinnedPath = v?.file?.path || pinnedPath || '';
    }
    paintContextChip();
  }

  function onKeydown(e) {
    if (e.key === 'Escape' && expanded) {
      e.preventDefault();
      collapse();
    }
  }

  function placeCapsule() {
    if (!capsule) return;
    const pos = loadCapsulePos() || defaultCapsulePos(mobile, window.innerWidth, window.innerHeight);
    if (mobile && pos.edge === 'bottom') {
      capsule.style.bottom = `${pos.offset || 88}px`;
      capsule.style[pos.side === 'left' ? 'left' : 'right'] = '16px';
      capsule.style.top = 'auto';
    } else {
      capsule.style.left = `${pos.left}px`;
      capsule.style.top = `${pos.top}px`;
      capsule.style.right = 'auto';
      capsule.style.bottom = 'auto';
    }
  }

  function placePanel() {
    if (!panel) return;
    const g = loadPanelGeom() || defaultPanelGeom(mobile, window.innerWidth, window.innerHeight);
    if (mobile) {
      panel.style.height = `${Math.round(window.innerHeight * (g.heightPct || 0.6))}px`;
      panel.style.width = '100%';
      panel.style.left = '0';
      panel.style.bottom = '0';
      panel.style.top = 'auto';
    } else {
      panel.style.width = `${g.width}px`;
      panel.style.height = `${g.height}px`;
      panel.style.left = `${g.left}px`;
      panel.style.top = `${g.top}px`;
    }
  }

  function bindFollowNote() {
    const refresh = () => {
      if (!expanded) paintContextChip();
    };
    plugin.registerEvent(app.workspace.on('active-leaf-change', refresh));
    plugin.registerEvent(app.workspace.on('file-open', refresh));
  }

  function expand() {
    if (plugin.settings.commandBarEnabled === false) return;
    ensureDom();
    attachController();
    expanded = true;
    root.addClass('is-expanded');
    panel.setAttr('aria-hidden', 'false');
    syncUi();
    ctrl().refreshSessions?.().catch(() => syncUi());
  }

  function collapse() {
    if (!root) return;
    expanded = false;
    root.removeClass('is-expanded');
    panel?.setAttr('aria-hidden', 'true');
    const ta = composerHost?.querySelector('textarea');
    if (ta) inputDraft = ta.value;
    document.body.classList.remove('aos-companion-open');
  }

  function attachController() {
    if (unsub) return;
    const c = ctrl();
    viewHook = {
      mobile,
      get sidebarOpen() {
        return false;
      },
      onThread: () => syncUi(),
      getDraft: () => composerHost?.querySelector('textarea')?.value || inputDraft || '',
    };
    detachView = c.attachView(viewHook);
    unsub = c.subscribe(() => syncUi());
    c.loadLocalCache();
  }

  let viewHook = null;

  async function submit(text) {
    const snap = captureContextSnapshot(app, {
      mode: contextMode,
      pinnedPath,
      maxChars: plugin.settings.activeNoteMaxChars,
    });
    const before = ctrl().state.messages.length;
    await ctrl().send(text, { surface: 'companion', contextSnapshot: snap });
    const userRow = ctrl().state.messages.slice(before).find((m) => m.role === 'user');
    if (userRow?.turnId) turnSnapshots.set(userRow.turnId, snap);
    inputDraft = '';
    syncUi();
  }

  function open(opts = {}) {
    if (plugin.settings.commandBarEnabled === false) return;
    ensureDom();
    attachController();
    expand();
    if (opts.seedText && composerHost) {
      const ta = composerHost.querySelector('textarea');
      if (ta) {
        ta.value = opts.seedText;
        if (!opts.autoSubmit) ta.focus();
      }
    }
    if (opts.autoSubmit && opts.seedText) submit(opts.seedText);
  }

  function close() {
    collapse();
  }

  function toggle() {
    if (expanded) collapse();
    else expand();
  }

  function isOpen() {
    return expanded;
  }

  function destroy() {
    unsub?.();
    detachView?.();
    document.removeEventListener('keydown', onKeydown);
    root?.remove();
    root = null;
    document.body.classList.remove('aos-companion-open');
  }

  async function openLegacyHistory() {
    const session = await loadSessionFromPath(app, SESSION_PATH);
    if (!session?.messages?.length) {
      notify('没有可读的旧命令条历史');
      return;
    }
    notify(`旧会话只读：${session.messages.length} 条消息（agent-inbox/sessions/current.json）`);
  }

  try {
    if (plugin.settings.commandBarEnabled !== false) {
      ensureDom();
      syncUi();
    }
  } catch (error) {
    console.error('Agent companion failed to mount', error);
  }

  return {
    open,
    close,
    toggle,
    isOpen,
    destroy,
    expand,
    collapse,
    openLegacyHistory,
  };
}
