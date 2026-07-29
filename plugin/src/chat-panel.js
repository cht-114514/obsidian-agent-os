/**
 * Obsidian Agent OS chat panel — streaming ACP (Grok Build).
 *
 * Slash skills: load vault SKILL.md → Grok Build prompt → stream + confirm cards.
 * Plugin keeps UI + confirm Accept/Reject (digest / insight / soul-promote / memorized).
 *
 * Interaction model (obsidian-cc inspired):
 *   @  → vault-wide fuzzy file search → reference chips
 *   /  → skill menu → pill mode (Backspace on empty input clears)
 *   paste/drop file → agent-inbox/raw/ + attachment chip
 *   👍 / 👎 (toggle/cancel) + 反馈 (written note → reflect skill) + copy
 *   编辑 / 重发（用户气泡）+ 重发/重新生成（助手气泡；截断后续并重置 ACP）
 *   → agent-inbox/soul/feedback/<date>.md；写反馈触发 me-reflect-feedback
 */
import { renderAgentMessage } from './renderer.js';
import { renderMarkdownWithMath } from './markdown-render.js';
import { setWikiStatus } from './digest.js';
import { buildTurnPrompt, loadSoulPack } from './memory/inject.js';
import { shouldSkipRetrieve } from './memory/retrieve.js';
import {
  retrieveRelevantMemory,
  reindexAllVectors,
  upsertVectorsForPath,
  removeVectorsForPath,
} from './memory/index-ops.js';
import { VoiceInputSession, resolveXaiApiKey, joinSegments } from './voice-stt.js';
import { polishDictation, appendPolished } from './voice-polish.js';
import {
  createActiveNoteState,
  onMarkdownFocus,
  setActiveNoteMode,
  getEffectiveActivePath,
  mergeActiveNoteChips,
  composeWithContext,
  markdownPathFromLeaf,
  DEFAULT_ACTIVE_NOTE_MAX_CHARS,
} from './active-note.js';
import { checkWritePolicy } from './protocol-bridge.js';
import {
  buildGrokSkillPrompt,
  isGrokSkill,
  loadSkillMarkdown,
} from './skill-prompt.js';
import {
  appendMessage,
  createEmptySession,
  loadSessionFromVault,
  rotateSession,
  saveSessionToVault,
  listArchivedSessions,
  deleteSessionFile,
  restoreArchivedSession,
  formatRecentConversation,
  truncateFromMessage,
  findPrecedingUserMessage,
  newId,
  SESSION_PATH,
} from './chat-history.js';
import {
  REASONING_EFFORT_LEVELS,
  formatGrokRuntimeLabel,
  normalizeGrokProfiles,
  normalizeReasoningEffort,
  resolveGrokRuntime,
} from './grok-runtime.js';
import {
  makeFeedbackId,
  appendFeedbackEntry,
  updateFeedbackVote,
} from './feedback-store.js';
import {
  embedWikilink,
  extractImagineImagePath,
  ingestImagineImageToRaw,
  isImagineTool,
} from './image-ingest.js';
import { applyToEditor } from './editor-apply.js';
import { MarkdownView } from 'obsidian';

/**
 * @param {HTMLElement} containerEl
 * @param {{
 *   app: any,
 *   controller: import('./main.js').MeSoulController,
 *   plugin: any,
 *   Notice: any,
 *   MarkdownRenderer?: any,
 *   loadMathJax?: () => Promise<void>,
 *   renderMath?: (source: string, display: boolean) => HTMLElement,
 *   finishRenderMath?: () => Promise<void>,
 *   mode?: 'home' | 'sidebar' | 'fullscreen',
 * }} ctx
 */
export function mountMeSoulChat(containerEl, ctx) {
  const {
    app,
    controller,
    plugin,
    Notice,
    MarkdownRenderer,
    loadMathJax,
    renderMath,
    finishRenderMath,
    mode = 'home',
  } = ctx;
  containerEl.empty();
  containerEl.addClass('me-soul-panel');
  // fullscreen = main-tab ChatGPT-style; home = embedded note; sidebar = legacy narrow
  const modeClass =
    mode === 'fullscreen'
      ? 'me-soul-panel-fullscreen'
      : mode === 'sidebar'
        ? 'me-soul-panel-sidebar'
        : 'me-soul-panel-home';
  containerEl.addClass(modeClass);

  /** @param {string} message */
  function notify(message) {
    showNotice(Notice, message);
  }

  const shell = containerEl.createDiv({ cls: 'me-soul-shell' });

  // ---------- state ----------
  /** @type {{ path: string, kind: 'ref'|'raw' }[]} */
  let chips = [];
  /** @type {{ id: string, label: string } | null} */
  let activeSkill = null;
  let busy = false;
  /** @type {import('./chat-history.js').ChatSession} */
  let chatSession = createEmptySession();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let persistTimer = null;
  let persistInFlight = false;
  let persistQueued = false;

  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      flushPersist().catch((e) => console.warn('chat persist failed', e));
    }, 250);
  }

  async function flushPersist() {
    if (persistInFlight) {
      persistQueued = true;
      return;
    }
    persistInFlight = true;
    try {
      do {
        persistQueued = false;
        await saveSessionToVault(app, chatSession);
      } while (persistQueued);
    } finally {
      persistInFlight = false;
    }
  }

  /**
   * @param {Omit<import('./chat-history.js').ChatMessage, 'id' | 'ts'> & { id?: string, ts?: number }} msg
   */
  function recordMessage(msg) {
    chatSession = appendMessage(chatSession, msg);
    schedulePersist();
  }

  // ---------- floating chrome (overlays scroll log for real glass) ----------
  const chromeTop = shell.createDiv({ cls: 'me-soul-chrome-top' });
  // ---------- header (compact: brand + overflow) ----------
  const header = chromeTop.createDiv({ cls: 'me-soul-header' });
  const brand = header.createDiv({ cls: 'me-soul-brand' });
  brand.createDiv({ cls: 'me-soul-dot' });
  const brandText = brand.createDiv({ cls: 'me-soul-brand-text' });
  const agentName = plugin.settings.agentName || 'Agent';
  brandText.createDiv({ cls: 'me-soul-title', text: agentName });
  const statusEl = brandText.createDiv({ cls: 'me-soul-subtitle', text: '就绪' });

  const tools = header.createDiv({ cls: 'me-soul-header-tools' });

  // Model picker — always visible in header (fullscreen + home + sidebar)
  const modelSelect = tools.createEl('select', {
    cls: 'me-soul-model-select me-soul-model-select--header',
    attr: {
      'aria-label': '切换模型',
      title: '切换模型（Grok订阅 / 第三方）',
    },
  });

  // Reasoning effort — applies to the active profile
  const effortSelect = tools.createEl('select', {
    cls: 'me-soul-model-select me-soul-effort-select--header',
    attr: {
      'aria-label': '思考等级',
      title: '思考等级（reasoning effort，下一条消息生效）',
    },
  });

  const careEl = tools.createEl('button', {
    cls: 'me-soul-care-chip me-soul-care-chip--header',
    attr: { type: 'button', 'aria-label': '牵挂', title: '牵挂' },
    text: '牵挂',
  });
  // Care chip on spacious layouts (home embed + full-screen tab)
  careEl.style.display = mode === 'sidebar' ? 'none' : '';

  const moreWrap = tools.createDiv({ cls: 'me-soul-more-wrap' });
  const moreBtn = moreWrap.createEl('button', {
    cls: 'me-soul-icon-btn me-soul-more-btn',
    attr: {
      type: 'button',
      'aria-label': '更多',
      'aria-expanded': 'false',
      title: '会话 · 历史 · 安静 · 牵挂',
    },
    text: '···',
  });
  const moreMenu = moreWrap.createDiv({
    cls: 'me-soul-more-menu',
    attr: { role: 'menu', 'aria-hidden': 'true' },
  });

  const menuActions = moreMenu.createDiv({ cls: 'me-soul-menu-actions' });
  const careMenuBtn = menuActions.createEl('button', {
    cls: 'me-soul-menu-item',
    attr: { type: 'button', role: 'menuitem' },
    text: '牵挂',
  });
  const newBtn = menuActions.createEl('button', {
    cls: 'me-soul-menu-item',
    attr: { type: 'button', role: 'menuitem' },
    text: '新会话',
  });
  const histBtn = menuActions.createEl('button', {
    cls: 'me-soul-menu-item',
    attr: { type: 'button', role: 'menuitem' },
    text: '历史会话',
  });
  const quietBtn = menuActions.createEl('button', {
    cls: 'me-soul-menu-item',
    attr: { type: 'button', role: 'menuitem' },
    text: controller.settings.quiet ? '今日少说话 · 开' : '今日少说话 · 关',
  });
  quietBtn.toggleClass('is-on', !!controller.settings.quiet);

  /** @type {HTMLElement | null} */
  let historyPanel = null;

  function closeHistoryPanel() {
    if (historyPanel) {
      historyPanel.remove();
      historyPanel = null;
    }
  }

  function formatHistTime(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch {
      return '';
    }
  }

  async function reloadChatFromSession(session) {
    chatSession = session;
    logEl.empty();
    if (!chatSession.messages?.length) {
      appendWelcome();
      return;
    }
    for (const m of chatSession.messages) {
      if (m.role === 'user') {
        appendUser(m.text || '', m.chips || [], m.skill || null, {
          persist: false,
          id: m.id,
        });
      } else if (m.role === 'agent') {
        await appendAgentFromHistory(m);
      }
    }
    scrollDown();
  }

  async function openHistoryPanel() {
    closeHistoryPanel();
    const panel = shell.createDiv({
      cls: 'me-soul-history-panel',
      attr: { role: 'dialog', 'aria-label': '历史会话' },
    });
    historyPanel = panel;

    const head = panel.createDiv({ cls: 'me-soul-history-head' });
    head.createSpan({ cls: 'me-soul-history-title', text: '历史会话' });
    const closeH = head.createEl('button', {
      cls: 'me-soul-history-close',
      attr: { type: 'button', 'aria-label': '关闭' },
      text: '×',
    });
    closeH.onclick = () => closeHistoryPanel();

    const list = panel.createDiv({ cls: 'me-soul-history-list' });
    list.createDiv({ cls: 'me-soul-history-empty', text: '加载中…' });

    async function paintList() {
      list.empty();
      /** @type {Array<{ path: string, id: string, updatedAt: string, messageCount: number, title: string, isCurrent?: boolean }>} */
      const rows = [];
      try {
        const cur = await loadSessionFromVault(app);
        rows.push({ ...summarizeCurrent(cur), isCurrent: true });
      } catch {
        /* */
      }
      try {
        const archived = await listArchivedSessions(app);
        for (const a of archived) rows.push({ ...a, isCurrent: false });
      } catch (e) {
        console.warn('list archives failed', e);
      }

      if (!rows.length) {
        list.createDiv({
          cls: 'me-soul-history-empty',
          text: '暂无会话记录',
        });
        return;
      }

      for (const row of rows) {
        const item = list.createDiv({
          cls: 'me-soul-history-item' + (row.isCurrent ? ' is-current' : ''),
        });
        const main = item.createDiv({ cls: 'me-soul-history-item-main' });
        main.createDiv({
          cls: 'me-soul-history-item-title',
          text: row.isCurrent ? `当前 · ${row.title}` : row.title,
        });
        main.createDiv({
          cls: 'me-soul-history-item-meta',
          text: `${row.messageCount} 条 · ${formatHistTime(row.updatedAt)}`,
        });

        const actions = item.createDiv({ cls: 'me-soul-history-item-actions' });
        if (!row.isCurrent) {
          const loadBtn = actions.createEl('button', {
            cls: 'me-soul-history-action',
            attr: { type: 'button' },
            text: '加载',
          });
          loadBtn.onclick = async () => {
            try {
              plugin.acp?.resetSession?.();
              const next = await restoreArchivedSession(app, row.path, chatSession);
              await reloadChatFromSession(next);
              closeHistoryPanel();
              notify('已加载历史会话');
            } catch (e) {
              notify(e?.message || '加载失败');
            }
          };
        }

        const delBtn = actions.createEl('button', {
          cls: 'me-soul-history-action is-danger',
          attr: { type: 'button' },
          text: '删除',
        });
        delBtn.onclick = async () => {
          const ok = window.confirm(
            row.isCurrent
              ? '删除当前会话？内容将清空（不会进入归档）。'
              : `删除归档「${row.title}」？此操作不可恢复。`
          );
          if (!ok) return;
          try {
            if (row.isCurrent) {
              plugin.acp?.resetSession?.();
              const empty = createEmptySession();
              await saveSessionToVault(app, empty);
              await reloadChatFromSession(empty);
              notify('当前会话已删除');
            } else {
              await deleteSessionFile(app, row.path);
              notify('归档已删除');
            }
            await paintList();
          } catch (e) {
            notify(e?.message || '删除失败');
          }
        };
      }
    }

    function summarizeCurrent(cur) {
      const firstUser = (cur.messages || []).find((m) => m.role === 'user');
      const title = String(firstUser?.text || '空会话')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 48);
      return {
        path: SESSION_PATH,
        id: cur.id || '',
        updatedAt: cur.updatedAt || '',
        messageCount: (cur.messages || []).length,
        title: title || '空会话',
      };
    }

    await paintList();
  }

  function setMoreOpen(open) {
    moreMenu.toggleClass('is-open', open);
    moreMenu.setAttr('aria-hidden', open ? 'false' : 'true');
    moreBtn.setAttr('aria-expanded', open ? 'true' : 'false');
    moreBtn.toggleClass('is-on', open);
  }
  function toggleMore() {
    setMoreOpen(!moreMenu.hasClass('is-open'));
  }
  moreBtn.onclick = (ev) => {
    ev.stopPropagation();
    toggleMore();
  };
  // Close on outside click
  const onDocPointer = (ev) => {
    if (!moreMenu.hasClass('is-open')) return;
    if (moreWrap.contains(/** @type {Node} */ (ev.target))) return;
    setMoreOpen(false);
  };
  document.addEventListener('pointerdown', onDocPointer, true);

  quietBtn.onclick = async () => {
    controller.setQuiet(!controller.settings.quiet);
    plugin.settings.quiet = controller.settings.quiet;
    await plugin.saveSettings();
    quietBtn.setText(controller.settings.quiet ? '今日少说话 · 开' : '今日少说话 · 关');
    quietBtn.toggleClass('is-on', controller.settings.quiet);
    logEl.toggleClass('is-quiet', controller.settings.quiet);
    notify(controller.settings.quiet ? '今日少说话：开' : '今日少说话：关');
  };
  newBtn.onclick = async () => {
    setMoreOpen(false);
    closeHistoryPanel();
    plugin.acp?.resetSession?.();
    try {
      chatSession = await rotateSession(app, chatSession);
    } catch (e) {
      console.warn('rotate session failed', e);
      chatSession = createEmptySession();
    }
    logEl.empty();
    appendWelcome();
    notify('新会话已开启（上一会话已归档）');
  };
  histBtn.onclick = () => {
    setMoreOpen(false);
    void openHistoryPanel();
  };
  careMenuBtn.onclick = () => {
    setMoreOpen(false);
    closeHistoryPanel();
    const f = app.vault.getAbstractFileByPath('agent-inbox/soul/pending-care.md');
    if (f) app.workspace.getLeaf(false).openFile(f);
    else notify('暂无牵挂文件');
  };
  careEl.onclick = () => careMenuBtn.onclick?.();

  // ---------- active note context ----------
  const activeNoteEnabled = () => plugin.settings.activeNoteContext !== false;
  /** Seed path: live active md, or last pinned path from settings */
  const seedActivePath = (() => {
    try {
      const af = app.workspace.getActiveFile?.();
      if (af?.extension === 'md') return af.path;
    } catch {
      /* */
    }
    return plugin.settings.activeNotePinnedPath || null;
  })();
  /** @type {import('./active-note.js').ActiveNoteState} */
  let activeNoteState = createActiveNoteState({ mode: 'follow' });
  if (seedActivePath) {
    activeNoteState = onMarkdownFocus(activeNoteState, seedActivePath);
  }
  const savedMode = plugin.settings.activeNoteMode || 'follow';
  if (savedMode === 'pin') {
    activeNoteState = setActiveNoteMode(activeNoteState, 'pin', {
      pinPath: plugin.settings.activeNotePinnedPath || seedActivePath,
    });
  } else if (savedMode === 'off') {
    activeNoteState = setActiveNoteMode(activeNoteState, 'off');
  }

  // Compact context chip — path + mode; modes live in a popover
  const contextStrip = chromeTop.createDiv({ cls: 'me-soul-context-strip' });
  const contextChip = contextStrip.createEl('button', {
    cls: 'me-soul-context-chip',
    attr: {
      type: 'button',
      title: '当前笔记上下文',
      'aria-expanded': 'false',
    },
  });
  const contextModeTag = contextChip.createSpan({ cls: 'me-soul-context-mode-tag', text: '自动' });
  const contextPathEl = contextChip.createSpan({ cls: 'me-soul-context-path', text: '…' });
  const contextPopover = contextStrip.createDiv({
    cls: 'me-soul-context-popover',
    attr: { role: 'menu', 'aria-hidden': 'true' },
  });
  const btnFollow = contextPopover.createEl('button', {
    cls: 'me-soul-context-btn',
    text: '跟随当前笔记',
    attr: { type: 'button', role: 'menuitem', title: '跟随当前打开的笔记' },
  });
  const btnPin = contextPopover.createEl('button', {
    cls: 'me-soul-context-btn',
    text: '固定此笔记',
    attr: { type: 'button', role: 'menuitem', title: '固定当前笔记，换页不变' },
  });
  const btnOff = contextPopover.createEl('button', {
    cls: 'me-soul-context-btn',
    text: '关闭自动上下文',
    attr: { type: 'button', role: 'menuitem', title: '本会话不自动附带' },
  });
  const btnOpenNote = contextPopover.createEl('button', {
    cls: 'me-soul-context-btn me-soul-context-btn--secondary',
    text: '打开笔记',
    attr: { type: 'button', role: 'menuitem' },
  });

  function setContextOpen(open) {
    contextPopover.toggleClass('is-open', open);
    contextPopover.setAttr('aria-hidden', open ? 'false' : 'true');
    contextChip.setAttr('aria-expanded', open ? 'true' : 'false');
    contextChip.toggleClass('is-open', open);
  }
  contextChip.onclick = (ev) => {
    ev.stopPropagation();
    setContextOpen(!contextPopover.hasClass('is-open'));
  };
  const onDocContext = (ev) => {
    if (!contextPopover.hasClass('is-open')) return;
    if (contextStrip.contains(/** @type {Node} */ (ev.target))) return;
    setContextOpen(false);
  };
  document.addEventListener('pointerdown', onDocContext, true);

  /**
   * Avoid no-op DOM writes — setText on chrome clears window.getSelection()
   * and blocks copying reply text (same pitfall as command-bar).
   * @param {HTMLElement | null | undefined} el
   * @param {string} next
   */
  function setTextIfChanged(el, next) {
    if (!el) return;
    const s = String(next ?? '');
    if (el.textContent === s) return;
    el.setText(s);
  }

  function paintContextStrip() {
    if (!activeNoteEnabled()) {
      contextStrip.addClass('is-disabled');
      setTextIfChanged(contextModeTag, '关');
      setTextIfChanged(contextPathEl, '设置中已关闭');
      btnFollow.removeClass('is-on');
      btnPin.removeClass('is-on');
      btnOff.addClass('is-on');
      return;
    }
    contextStrip.removeClass('is-disabled');
    const path = getEffectiveActivePath(activeNoteState);
    const noteMode = activeNoteState.mode;
    btnFollow.toggleClass('is-on', noteMode === 'follow');
    btnPin.toggleClass('is-on', noteMode === 'pin');
    btnOff.toggleClass('is-on', noteMode === 'off');
    if (noteMode === 'off') {
      setTextIfChanged(contextModeTag, '关');
      setTextIfChanged(contextPathEl, '不附带笔记');
      contextStrip.removeClass('has-note');
      return;
    }
    setTextIfChanged(contextModeTag, noteMode === 'pin' ? '固定' : '自动');
    if (path) {
      const short = shortName(path);
      const pathChanged = contextPathEl.textContent !== short;
      setTextIfChanged(contextPathEl, short);
      contextChip.setAttr('title', path);
      contextStrip.addClass('has-note');
      if (pathChanged) {
        contextStrip.addClass('is-flash');
        window.setTimeout(() => contextStrip.removeClass('is-flash'), 280);
      }
    } else {
      setTextIfChanged(contextPathEl, '打开一篇笔记');
      contextStrip.removeClass('has-note');
    }
  }

  function syncActiveFromWorkspace() {
    if (!activeNoteEnabled()) {
      paintContextStrip();
      return;
    }
    try {
      const leaf = app.workspace.activeLeaf || app.workspace.getMostRecentLeaf?.();
      const view = leaf?.view;
      const viewType = view?.getViewType?.() || '';
      const file = view?.file || app.workspace.getActiveFile?.();
      const filePath = file?.path || null;
      const reported = markdownPathFromLeaf({ viewType, filePath });
      if (reported) {
        activeNoteState = onMarkdownFocus(activeNoteState, reported);
      } else if (filePath && /\.md$/i.test(filePath)) {
        // markdown path even if view type unknown
        activeNoteState = onMarkdownFocus(activeNoteState, filePath);
      }
      // Prefer live active markdown file when available
      const af = app.workspace.getActiveFile?.();
      if (af?.extension === 'md') {
        const vt = app.workspace.activeLeaf?.view?.getViewType?.() || '';
        if (vt === 'markdown' || !vt) {
          activeNoteState = onMarkdownFocus(activeNoteState, af.path);
        }
      }
    } catch (e) {
      console.warn('active note sync', e);
    }
    paintContextStrip();
  }

  btnFollow.onclick = () => {
    activeNoteState = setActiveNoteMode(activeNoteState, 'follow');
    plugin.settings.activeNoteMode = 'follow';
    plugin.saveSettings?.();
    setContextOpen(false);
    syncActiveFromWorkspace();
  };
  btnPin.onclick = () => {
    const cur =
      getEffectiveActivePath(activeNoteState) ||
      app.workspace.getActiveFile?.()?.path ||
      plugin.settings.activeNotePinnedPath ||
      null;
    activeNoteState = setActiveNoteMode(activeNoteState, 'pin', { pinPath: cur });
    plugin.settings.activeNoteMode = 'pin';
    plugin.settings.activeNotePinnedPath = getEffectiveActivePath(activeNoteState);
    plugin.saveSettings?.();
    setContextOpen(false);
    paintContextStrip();
  };
  btnOff.onclick = () => {
    activeNoteState = setActiveNoteMode(activeNoteState, 'off');
    plugin.settings.activeNoteMode = 'off';
    plugin.saveSettings?.();
    setContextOpen(false);
    paintContextStrip();
  };
  btnOpenNote.onclick = () => {
    setContextOpen(false);
    const p = getEffectiveActivePath(activeNoteState);
    if (!p) {
      notify('没有可打开的笔记');
      return;
    }
    const f = app.vault.getAbstractFileByPath(p);
    if (f) app.workspace.getLeaf(false).openFile(f);
  };

  const unsubLeaf = app.workspace.on?.('active-leaf-change', () => syncActiveFromWorkspace());
  const unsubOpen = app.workspace.on?.('file-open', () => syncActiveFromWorkspace());
  syncActiveFromWorkspace();

  // ---------- log (full-bleed under floating chrome) ----------
  const logEl = shell.createDiv({ cls: 'me-soul-log' });
  logEl.toggleClass('is-quiet', !!controller.settings.quiet);

  // ---------- composer (liquid glass bar) ----------
  const composer = shell.createDiv({ cls: 'me-soul-composer' });
  const suggestEl = composer.createDiv({ cls: 'me-soul-suggest' });
  suggestEl.style.display = 'none';

  const chipsEl = composer.createDiv({ cls: 'me-soul-chips' });
  // Single liquid-glass capsule: input + model + mic + send
  const glass = composer.createDiv({ cls: 'me-soul-glass' });
  const inputWrap = glass.createDiv({ cls: 'me-soul-input-wrap' });
  const skillPillEl = inputWrap.createDiv({ cls: 'me-soul-active-skill' });
  const inputEl = inputWrap.createEl('textarea', {
    cls: 'me-soul-input',
    attr: {
      rows: '1',
      placeholder: `跟${agentName}说…  @笔记  /技能  ·  点击 🎤`,
    },
  });
  const actionsEl = glass.createDiv({ cls: 'me-soul-composer-actions' });
  const hintEl = glass.createDiv({ cls: 'me-soul-status' });
  hintEl.addClass('is-empty');
  // Secondary model picker next to mic (same control state as header)
  const modelSelectComposer = actionsEl.createEl('select', {
    cls: 'me-soul-model-select me-soul-model-select--composer',
    attr: {
      'aria-label': '切换模型',
      title: '切换模型（Grok订阅 / 第三方）',
    },
  });
  const micBtn = actionsEl.createEl('button', {
    cls: 'me-soul-mic',
    attr: {
      type: 'button',
      'aria-label': '点击开始说话',
      title: '点击开始 / 再点结束（xAI 流式语音）',
      'aria-pressed': 'false',
    },
    text: '🎤',
  });
  const sendBtn = actionsEl.createEl('button', { cls: 'me-soul-send', text: '↑' });

  // Keep log padding in sync so messages can scroll *under* glass (iOS Liquid Glass)
  function syncChromeInsets() {
    try {
      const top = Math.ceil(chromeTop.getBoundingClientRect().height || 0);
      const bottom = Math.ceil(composer.getBoundingClientRect().height || 0);
      logEl.style.paddingTop = `${Math.max(top, 48)}px`;
      logEl.style.paddingBottom = `${Math.max(bottom, 72)}px`;
      shell.style.setProperty('--ms-chrome-top', `${top}px`);
      shell.style.setProperty('--ms-chrome-bottom', `${bottom}px`);
    } catch {
      /* */
    }
  }
  let chromeRo = null;
  try {
    if (typeof ResizeObserver !== 'undefined') {
      chromeRo = new ResizeObserver(() => syncChromeInsets());
      chromeRo.observe(chromeTop);
      chromeRo.observe(composer);
      chromeRo.observe(glass);
    }
  } catch {
    /* */
  }
  // first paint + after fonts
  requestAnimationFrame(syncChromeInsets);
  setTimeout(syncChromeInsets, 50);

  function fillModelSelect(sel) {
    if (!sel) return;
    const profiles = normalizeGrokProfiles(plugin.settings.grokProfiles);
    plugin.settings.grokProfiles = profiles;
    const active = plugin.settings.grokActiveProfile || profiles[0]?.id || 'supergrok';
    sel.empty();
    for (const p of profiles) {
      const opt = sel.createEl('option', {
        text: p.label || p.model || p.id,
        attr: { value: p.id },
      });
      if (p.id === active) opt.selected = true;
    }
    const rt = resolveGrokRuntime(plugin.settings);
    const label = formatGrokRuntimeLabel(rt);
    sel.setAttr('title', `当前：${label}`);
  }

  function fillEffortSelect(sel) {
    if (!sel) return;
    const profiles = normalizeGrokProfiles(plugin.settings.grokProfiles);
    const activeId = plugin.settings.grokActiveProfile || profiles[0]?.id || 'supergrok';
    const p = profiles.find((x) => x.id === activeId) || profiles[0];
    const current = normalizeReasoningEffort(p?.reasoningEffort);
    sel.empty();
    for (const l of REASONING_EFFORT_LEVELS) {
      const opt = sel.createEl('option', {
        text: l.value ? `思考:${l.value}` : '思考:默认',
        attr: { value: l.value },
      });
      if (l.value === current) opt.selected = true;
    }
  }

  function refreshModelSelect() {
    fillModelSelect(modelSelect);
    fillModelSelect(modelSelectComposer);
    fillEffortSelect(effortSelect);
  }
  refreshModelSelect();

  async function onModelChange(fromEl) {
    const id = fromEl?.value;
    if (!id || id === plugin.settings.grokActiveProfile) return;
    if (busy) {
      notify('请等当前回复结束后再切换模型');
      refreshModelSelect();
      return;
    }
    try {
      const rt = plugin.switchGrokProfile
        ? await plugin.switchGrokProfile(id)
        : (() => {
            plugin.settings.grokActiveProfile = id;
            return resolveGrokRuntime(plugin.settings);
          })();
      // Drop ACP session when switching endpoints/models
      try {
        plugin.acp?.resetSession?.();
      } catch {
        /* */
      }
      refreshModelSelect();
      setStatus(`模型：${formatGrokRuntimeLabel(rt)}`);
      notify(`已切换 → ${formatGrokRuntimeLabel(rt)}（下一条消息生效）`);
    } catch (e) {
      notify(e?.message || String(e));
      refreshModelSelect();
    }
  }
  modelSelect.onchange = () => onModelChange(modelSelect);
  modelSelectComposer.onchange = () => onModelChange(modelSelectComposer);

  async function onEffortChange() {
    const v = effortSelect.value;
    if (busy) {
      notify('请等当前回复结束后再调整思考等级');
      refreshModelSelect();
      return;
    }
    try {
      const rt = await plugin.setGrokReasoningEffort(v);
      try {
        plugin.acp?.resetSession?.();
      } catch {
        /* */
      }
      refreshModelSelect();
      notify(`思考等级 → ${v || '默认'}（下一条消息生效）`);
      setStatus(`模型：${formatGrokRuntimeLabel(rt)}`);
    } catch (e) {
      notify(e?.message || String(e));
      refreshModelSelect();
    }
  }
  effortSelect.onchange = () => onEffortChange();

  /** @type {VoiceInputSession | null} */
  let voiceSession = null;
  let voiceBaseText = '';
  let voiceListening = false;

  function setStatus(t) {
    setTextIfChanged(statusEl, t);
  }
  function setHint(t) {
    const text = String(t || '').trim();
    setTextIfChanged(hintEl, text);
    hintEl.toggleClass('is-empty', !text);
  }
  function setBusy(b) {
    busy = b;
    shell.toggleClass('is-busy', b);
    sendBtn.setText(b ? '■' : '↑');
    sendBtn.setAttr('title', b ? '停止' : '发送');
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
  }

  function setVoiceUi(on) {
    voiceListening = on;
    micBtn.toggleClass('is-listening', on);
    micBtn.setAttr('aria-pressed', on ? 'true' : 'false');
    micBtn.setAttr('aria-label', on ? '点击结束说话' : '点击开始说话');
    micBtn.setAttr('title', on ? '点击结束 · Esc 取消' : '点击开始 / 再点结束（xAI 流式语音）');
    composer.toggleClass('is-voice-listening', on);
    glass.toggleClass('is-voice-listening', on);
    shell.toggleClass('is-voice-listening', on);
  }

  async function startVoice() {
    if (voiceListening || busy) return;
    if (plugin.settings.voiceEnabled === false) {
      notify('语音输入已关闭（设置里可开启）');
      return;
    }
    const apiKey = resolveXaiApiKey(plugin.settings);
    if (!apiKey) {
      notify('未找到 xAI API Key：在设置填写，或配置环境变量 XAI_API_KEY');
      return;
    }

    voiceBaseText = inputEl.value;
    const session = new VoiceInputSession({
      apiKey,
      language: plugin.settings.voiceLanguage || '',
      onStatus: (s) => {
        setHint(s);
        if (s.includes('聆听') || s.includes('麦克风')) setStatus('听…');
      },
      // Do NOT stream into the input — wait until user stops (avoids duplicates & flicker)
      onPartial: () => {
        setHint('聆听中…');
        setStatus('听…');
      },
      onError: (err) => {
        notify(err?.message || String(err));
        setStatus('就绪');
        setHint('');
      },
    });
    voiceSession = session;
    setVoiceUi(true);
    setHint('聆听中… 再说完后点一次 🎤');
    setStatus('听…');
    try {
      await session.start();
    } catch (e) {
      setVoiceUi(false);
      voiceSession = null;
      notify(e?.message || String(e));
      setStatus('就绪');
      setHint('');
    }
  }

  async function stopVoice(sendAfter = false) {
    if (!voiceSession) {
      setVoiceUi(false);
      return;
    }
    const session = voiceSession;
    voiceSession = null;
    const base = voiceBaseText;
    try {
      setHint('识别中…');
      setStatus('识别…');
      const raw = await session.stop();
      if (!raw) {
        notify('没有识别到语音');
        return;
      }
      // Typeless-style polish (local + optional LLM) before a single write
      setHint('整理中…');
      setStatus('整理…');
      const polished = await polishDictation(raw, {
        apiKey: resolveXaiApiKey(plugin.settings),
        model: plugin.settings.voicePolishModel || 'grok-3-mini',
      });
      const finalText = polished || raw;
      inputEl.value = appendPolished(base, finalText, joinSegments);
      autoGrow();
      setHint('');
      if (sendAfter && plugin.settings.voiceAutoSend) {
        setTimeout(() => send(), 30);
      }
    } catch (e) {
      notify(e?.message || String(e));
    } finally {
      setVoiceUi(false);
      setStatus('就绪');
      setHint('');
      inputEl.focus();
    }
  }

  function cancelVoice() {
    if (voiceSession) {
      voiceSession.cancel();
      voiceSession = null;
    }
    setVoiceUi(false);
    setHint('');
    setStatus('就绪');
  }

  // Click-to-talk toggle (not press-and-hold)
  micBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (voiceListening) stopVoice(!!plugin.settings.voiceAutoSend);
    else startVoice();
  });
  micBtn.addEventListener('contextmenu', (e) => e.preventDefault());

  // Esc cancels listening or closes menus
  shell.tabIndex = -1;
  const onKeyDown = (ev) => {
    if (ev.key !== 'Escape') return;
    if (voiceListening) {
      ev.preventDefault();
      cancelVoice();
      notify('已取消语音输入');
      return;
    }
    if (moreMenu.hasClass('is-open')) {
      setMoreOpen(false);
      return;
    }
    if (contextPopover.hasClass('is-open')) setContextOpen(false);
  };
  shell.addEventListener('keydown', onKeyDown);
  document.addEventListener('keydown', onKeyDown);

  // ---------- chips ----------
  function renderChips() {
    chipsEl.empty();
    chipsEl.toggleClass('has-chips', chips.length > 0);
    for (const c of chips) {
      const chip = chipsEl.createDiv({ cls: 'me-soul-chip' });
      chip.createSpan({ cls: 'me-soul-chip-icon', text: c.kind === 'raw' ? '📎' : '🔗' });
      chip.createSpan({ cls: 'me-soul-chip-label', text: shortName(c.path) });
      chip.setAttr('title', c.path);
      const x = chip.createSpan({ cls: 'me-soul-chip-x', text: '×' });
      x.onclick = () => {
        chips = chips.filter((k) => k !== c);
        renderChips();
      };
    }
  }

  function renderSkillPill() {
    skillPillEl.empty();
    skillPillEl.toggleClass('is-active', !!activeSkill);
    if (activeSkill) {
      const pill = skillPillEl.createDiv({ cls: 'me-soul-skill-active-pill' });
      pill.createSpan({ text: activeSkill.label });
      const x = pill.createSpan({ cls: 'me-soul-chip-x', text: '×' });
      x.onclick = () => {
        activeSkill = null;
        renderSkillPill();
        inputEl.focus();
      };
    }
  }

  // ---------- suggest popup (@ files, / skills) ----------
  let suggestItems = [];
  let suggestIndex = 0;
  /** @type {'file'|'skill'|null} */
  let suggestKind = null;
  let suggestToken = { start: 0, end: 0 };

  function closeSuggest() {
    suggestKind = null;
    suggestItems = [];
    suggestEl.style.display = 'none';
    suggestEl.empty();
  }

  function openSuggest(kind, items) {
    suggestKind = kind;
    suggestItems = items;
    suggestIndex = 0;
    if (!items.length) {
      closeSuggest();
      return;
    }
    suggestEl.style.display = 'block';
    paintSuggest();
  }

  function paintSuggest() {
    suggestEl.empty();
    suggestItems.forEach((it, i) => {
      const el = suggestEl.createDiv({ cls: 'me-soul-suggest-item' });
      el.toggleClass('is-selected', i === suggestIndex);
      if (suggestKind === 'file') {
        el.createSpan({ cls: 'me-soul-suggest-name', text: it.name });
        el.createSpan({ cls: 'me-soul-suggest-path', text: it.path });
      } else {
        el.createSpan({ cls: 'me-soul-suggest-name', text: it.label });
        if (it.desc) el.createSpan({ cls: 'me-soul-suggest-path', text: it.desc });
      }
      el.onmousedown = (ev) => {
        ev.preventDefault();
        suggestIndex = i;
        acceptSuggest();
      };
    });
  }

  function acceptSuggest() {
    const it = suggestItems[suggestIndex];
    if (!it) return closeSuggest();
    if (suggestKind === 'file') {
      chips.push({ path: it.path, kind: 'ref' });
      renderChips();
      const v = inputEl.value;
      inputEl.value = v.slice(0, suggestToken.start) + v.slice(suggestToken.end);
      inputEl.selectionStart = inputEl.selectionEnd = suggestToken.start;
    } else {
      activeSkill = { id: it.id, label: it.label };
      renderSkillPill();
      inputEl.value = '';
    }
    closeSuggest();
    inputEl.focus();
    autoGrow();
  }

  function updateSuggest() {
    const v = inputEl.value;
    const caret = inputEl.selectionStart ?? v.length;

    // "/skill" — only at very start, no active skill
    if (!activeSkill && v.startsWith('/') && !v.slice(1).includes(' ')) {
      const q = v.slice(1).toLowerCase();
      const skills = builtinCommands()
        .concat(controller.listSkills().map((s) => ({ ...s, desc: skillDesc(s.id) })))
        .filter((s) => s.label.toLowerCase().includes(q) || (s.id || '').includes(q));
      openSuggest('skill', skills.slice(0, 10));
      return;
    }

    // "@query" token before caret
    const upto = v.slice(0, caret);
    const m = upto.match(/(?:^|\s)@([^\s@]*)$/);
    if (m) {
      const q = m[1];
      suggestToken = { start: caret - m[1].length - 1, end: caret };
      openSuggest('file', fuzzyFiles(app, q).slice(0, 8));
      return;
    }
    closeSuggest();
  }

  function builtinCommands() {
    return [
      { id: '__new', label: '/new', desc: '开启新会话' },
      { id: '__quiet', label: '/quiet', desc: '切换今日少说话' },
    ];
  }
  function skillDesc(id) {
    const map = {
      'me-digest': 'Grok 消化笔记 → 待审 wiki（可删）',
      'me-write-insight': '沉淀心迹（对你的认知草案，非聊笔记）',
      'me-reflect-feedback': '根据具体反馈反思并写入记忆（确认门）',
      'me-care-check': '检查牵挂',
      'me-soul-promote': '清洗 Wiki→升格 Soul',
      'me-imagine': 'Grok Imagine 生图 → 入库并可插入笔记',
      memorized: '写入/重建向量记忆库',
      'me-reindex': '（别名）同 /memorized',
      'me-apply-pending': '合并已确认 pending',
      'me-apply-insight': '合并 insight',
    };
    return map[id] || '技能';
  }

  // ---------- messages ----------
  /**
   * After Grok image_gen/image_edit completes: copy session file → agent-inbox/raw/
   * and show preview + insert button under the tool row.
   * @param {any} u
   * @param {{ root: HTMLElement, prompt?: string, ingested?: boolean }} t
   */
  async function handleImagineCompleted(u, t) {
    if (t.ingested) return;
    const abs = extractImagineImagePath(u);
    if (!abs) return;
    t.ingested = true;
    try {
      const { vaultPath } = await ingestImagineImageToRaw(app, abs, {
        prompt: t.prompt || u.rawInput?.prompt || '',
        ensureFolder,
      });
      renderImagineCard(t.root, vaultPath);
      scrollDown();
    } catch (e) {
      const err = document.createElement('div');
      err.className = 'me-soul-imagine-error';
      err.textContent = `生图入库失败：${e?.message || e}`;
      t.root.insertAdjacentElement('afterend', err);
      scrollDown();
    }
  }

  /**
   * @param {HTMLElement} toolRoot
   * @param {string} vaultPath
   */
  function renderImagineCard(toolRoot, vaultPath) {
    const parent = toolRoot.parentElement;
    if (!parent?.createDiv) return;
    const existing = parent.querySelector(
      `.me-soul-imagine-card[data-path="${CSS.escape(vaultPath)}"]`
    );
    if (existing) return;

    const card = parent.createDiv({ cls: 'me-soul-imagine-card' });
    toolRoot.insertAdjacentElement('afterend', card);
    card.setAttr('data-path', vaultPath);

    const img = card.createEl('img', { cls: 'me-soul-imagine-thumb' });
    img.setAttr('alt', shortName(vaultPath));
    try {
      const src =
        app.vault.adapter?.getResourcePath?.(vaultPath) ||
        app.vault.getResourcePath?.(app.vault.getAbstractFileByPath(vaultPath));
      if (src) img.setAttr('src', src);
    } catch {
      /* preview optional */
    }

    const meta = card.createDiv({ cls: 'me-soul-imagine-meta' });
    meta.createDiv({ cls: 'me-soul-imagine-path', text: vaultPath });
    const actions = meta.createDiv({ cls: 'me-soul-imagine-actions' });

    const btnInsert = actions.createEl('button', {
      text: '插入当前笔记',
      attr: { type: 'button' },
    });
    btnInsert.onclick = () => {
      const ok = insertImagineIntoActiveNote(vaultPath);
      if (ok) notify(`已插入 ${vaultPath}`);
    };

    const btnCopy = actions.createEl('button', {
      text: '复制链接',
      attr: { type: 'button' },
    });
    btnCopy.onclick = async () => {
      const link = embedWikilink(vaultPath);
      try {
        await navigator.clipboard.writeText(link);
        notify('已复制 ' + link);
      } catch {
        notify(link);
      }
    };
  }

  /**
   * @param {string} vaultPath
   * @returns {boolean}
   */
  function insertImagineIntoActiveNote(vaultPath) {
    const view = app.workspace.getActiveViewOfType(MarkdownView);
    const editor = view?.editor;
    if (!editor) {
      notify('请先打开一篇 Markdown 笔记，再插入图片');
      return false;
    }
    const text = embedWikilink(vaultPath);
    // Prefer a leading newline when cursor is mid-line with content before it
    let insert = text;
    try {
      const cur = editor.getCursor?.('to') || editor.getCursor?.() || { line: 0, ch: 0 };
      const line = editor.getLine?.(cur.line) ?? '';
      if (cur.ch > 0 && line.slice(0, cur.ch).trim()) insert = '\n' + text;
      if (line.slice(cur.ch).trim()) insert = insert + '\n';
    } catch {
      /* plain insert */
    }
    applyToEditor(editor, 'insert_at_cursor', insert);
    return true;
  }

  function appendWelcome() {
    const w = logEl.createDiv({
      cls:
        'me-soul-msg me-soul-agent me-soul-welcome' +
        (mode === 'fullscreen' ? ' me-soul-welcome--hero' : ''),
    });
    const body = w.createDiv({ cls: 'me-soul-msg-body' });
    const mobile =
      typeof navigator !== 'undefined' &&
      /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '');
    if (mode === 'fullscreen') {
      const name = plugin.settings.agentName || 'Agent';
      body.createDiv({
        cls: 'me-soul-welcome-title',
        text: name,
      });
      body.createDiv({
        cls: 'me-soul-welcome-sub',
        text: '有什么想聊的？写笔记时也可用快捷键召唤命令条。',
      });
    }
    const tips = body.createDiv({ cls: 'me-soul-welcome-tips' });
    for (const t of ['@ 引用笔记', '/ 技能', '粘贴文件 → raw', '点击 🎤 说话']) {
      tips.createSpan({ cls: 'me-soul-tip', text: t });
    }
    if (mobile) {
      body.createDiv({
        cls: 'me-soul-text me-soul-mobile-note',
        text:
          '手机端可看对话与本地技能；本地 Grok 需电脑。手机对话请在设置改用 OpenClaw Gateway。',
      });
    }
  }

  /**
   * @param {string} text
   * @param {{ path: string, kind?: string }[]} usedChips
   * @param {{ id?: string, label?: string } | null} [skill]
   * @param {{ persist?: boolean, id?: string }} [opts]
   */
  function appendUser(text, usedChips, skill, opts = {}) {
    const msgId = opts.id || newId('m');
    const div = logEl.createDiv({ cls: 'me-soul-msg me-soul-user' });
    div.dataset.msgId = msgId;
    const body = div.createDiv({ cls: 'me-soul-msg-body' });
    if (skill || (usedChips && usedChips.length)) {
      const meta = body.createDiv({ cls: 'me-soul-user-meta' });
      if (skill) meta.createSpan({ cls: 'me-soul-user-skill', text: skill.label || skill.id || '' });
      for (const c of usedChips || []) {
        const icon = c.kind === 'raw' ? '📎' : c.kind === 'active' ? '📄' : '🔗';
        meta.createSpan({
          cls: `me-soul-user-chip${c.kind === 'active' ? ' is-active-note' : ''}`,
          text: `${icon} ${shortName(c.path)}`,
        });
      }
    }
    if (text) body.createDiv({ cls: 'me-soul-user-text', text });
    appendUserActions(div, {
      id: msgId,
      text: text || '',
      chips: (usedChips || [])
        .filter((c) => c?.path)
        .map((c) => ({ path: c.path, kind: c.kind || 'ref' })),
      skill: skill ? { id: skill.id, label: skill.label || skill.id } : null,
    });
    scrollDown();
    if (opts.persist !== false) {
      recordMessage({
        id: msgId,
        role: 'user',
        text: text || '',
        skill: skill ? { id: skill.id, label: skill.label || skill.id } : null,
        chips: (usedChips || [])
          .filter((c) => c?.path)
          .map((c) => ({ path: c.path, kind: c.kind || 'ref' })),
      });
    }
  }

  /**
   * Edit / resend controls on user bubbles.
   * @param {HTMLElement} msgDiv
   * @param {{ id: string, text: string, chips: { path: string, kind?: string }[], skill: { id?: string, label?: string } | null }} snap
   */
  function appendUserActions(msgDiv, snap) {
    const foot = msgDiv.createDiv({ cls: 'me-soul-msg-foot me-soul-msg-foot--user' });
    const editBtn = foot.createEl('button', {
      cls: 'me-soul-foot-btn',
      attr: { type: 'button', title: '编辑后重发', 'aria-label': '编辑' },
      text: '编辑',
    });
    const resendBtn = foot.createEl('button', {
      cls: 'me-soul-foot-btn',
      attr: { type: 'button', title: '截断后续并原样重发', 'aria-label': '重发' },
      text: '重发',
    });
    editBtn.onclick = () => {
      void editUserTurn(snap.id);
    };
    resendBtn.onclick = () => {
      void resendUserTurn(snap.id);
    };
  }

  /**
   * Replay a stored agent turn (fences → cards; errors as error row).
   * @param {import('./chat-history.js').ChatMessage} m
   */
  async function appendAgentFromHistory(m) {
    const div = logEl.createDiv({ cls: 'me-soul-msg me-soul-agent' });
    if (m.id) div.dataset.msgId = m.id;
    const body = div.createDiv({ cls: 'me-soul-msg-body' });
    if (m.error) {
      body.createDiv({ cls: 'me-soul-error', text: `出错了：${m.error}` });
    } else if (m.text && /:::(?:confirm|thought)\b/.test(m.text)) {
      const rendered = renderAgentMessage(m.text, { quiet: controller.settings.quiet });
      body.innerHTML = rendered.html;
      await hydrateMarkdownBlocks(body);
      await wireConfirms(app, controller, body, Notice, plugin);
    } else if (m.text) {
      const el = body.createDiv({ cls: 'me-soul-stream-text' });
      await renderMarkdownInto(el, m.text);
    } else {
      body.createDiv({ cls: 'me-soul-text', text: '（空回复）' });
    }
    appendFooter(div, m.text || m.error || '', {
      messageId: m.id,
      isError: !!m.error,
    });
  }

  /**
   * Cut transcript + vault session from messageId (inclusive), reset ACP kernel session.
   * @param {string} messageId
   * @returns {Promise<import('./chat-history.js').ChatMessage | null>}
   */
  async function truncateAndResetFrom(messageId) {
    const { session, removed } = truncateFromMessage(chatSession, messageId);
    if (!removed) {
      notify('找不到要重发的消息');
      return null;
    }
    chatSession = session;
    schedulePersist();
    plugin.acp?.resetSession?.();
    await reloadChatFromSession(chatSession);
    return removed;
  }

  /**
   * Put a prior user turn back into the composer (after truncating it and later turns).
   * @param {string} messageId
   */
  async function editUserTurn(messageId) {
    if (busy) {
      notify('请等待当前回复结束');
      return;
    }
    const removed = await truncateAndResetFrom(messageId);
    if (!removed || removed.role !== 'user') return;
    restoreComposerFromUser(removed);
    notify('已载入到输入框，改完直接发送（后续消息已截断）');
    requestAnimationFrame(() => {
      inputEl.focus();
      autoGrow();
    });
  }

  /**
   * Resend a user turn, or regenerate from an agent turn.
   * @param {string} messageId
   * @param {{ asAgentRetry?: boolean }} [opts]
   */
  async function resendUserTurn(messageId, opts = {}) {
    if (busy) {
      notify('请等待当前回复结束');
      return;
    }
    const snap = (chatSession.messages || []).find((m) => m.id === messageId) || null;

    // Agent「重发 / 重新生成」：保留用户气泡，只砍掉该助手回复及之后
    if (opts.asAgentRetry || snap?.role === 'agent') {
      const user = findPrecedingUserMessage(chatSession, messageId);
      if (!user) {
        notify('没有可重发的用户消息');
        return;
      }
      const cutId =
        snap?.role === 'agent'
          ? snap.id
          : (chatSession.messages || []).find(
              (m) => m.role === 'agent' && m.id === messageId
            )?.id || messageId;
      const removed = await truncateAndResetFrom(cutId);
      if (!removed) return;
      const chipsSnap = (user.chips || []).map((c) => ({
        path: c.path,
        kind: c.kind || 'ref',
      }));
      const skillSnap = user.skill?.id
        ? { id: user.skill.id, label: user.skill.label || user.skill.id }
        : null;
      setBusy(true);
      setStatus('思考中…');
      try {
        if (skillSnap) {
          await runSkillFlow(skillSnap, user.text || '', chipsSnap);
        } else {
          await runChatFlow(user.text || '', chipsSnap);
        }
        setStatus('就绪');
      } catch (e) {
        const msg = createAgentMessage();
        msg.fail(e?.message || String(e));
        setStatus('失败');
      } finally {
        setBusy(false);
        refreshCare();
      }
      return;
    }

    if (!snap || snap.role !== 'user') {
      notify('只能重发用户消息');
      return;
    }
    const removed = await truncateAndResetFrom(messageId);
    if (!removed || removed.role !== 'user') return;
    await send({
      text: removed.text || '',
      chips: (removed.chips || []).map((c) => ({
        path: c.path,
        kind: c.kind || 'ref',
      })),
      skill: removed.skill
        ? { id: removed.skill.id || '', label: removed.skill.label || removed.skill.id || '' }
        : null,
      skipComposerClear: true,
    });
  }

  /**
   * @param {import('./chat-history.js').ChatMessage} userMsg
   */
  function restoreComposerFromUser(userMsg) {
    inputEl.value = userMsg.text || '';
    const restored = (userMsg.chips || [])
      .filter((c) => c?.path && c.kind !== 'active')
      .map((c) => ({ path: c.path, kind: c.kind === 'raw' ? 'raw' : 'ref' }));
    chips = restored;
    if (userMsg.skill?.id && !String(userMsg.skill.id).startsWith('__')) {
      activeSkill = {
        id: userMsg.skill.id,
        label: userMsg.skill.label || userMsg.skill.id,
      };
    } else {
      activeSkill = null;
    }
    renderChips();
    renderSkillPill();
    autoGrow();
  }

  /**
   * Build chips for send: manual @ + optional active note.
   * @param {typeof chips} manual
   */
  function buildSendChips(manual) {
    if (!activeNoteEnabled()) return manual.slice();
    const activePath = getEffectiveActivePath(activeNoteState);
    return mergeActiveNoteChips(manual, activePath);
  }

  async function loadChipContents(chipList) {
    const maxChars =
      plugin.settings.activeNoteMaxChars || DEFAULT_ACTIVE_NOTE_MAX_CHARS;
    const out = [];
    for (const c of chipList) {
      if (!c?.path) continue;
      if (c.kind === 'raw') {
        out.push(c);
        continue;
      }
      let content = '';
      try {
        content = (await readNoteBodyPreferEditor(app, c.path)) ?? '';
      } catch {
        content = '';
      }
      out.push({ ...c, content });
    }
    return { chips: out, maxChars };
  }

  function scrollDown() {
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function renderMarkdownInto(el, markdown) {
    el.removeClass('is-streaming-plain');
    el.addClass('is-md');
    try {
      await renderMarkdownWithMath({
        app,
        MarkdownRenderer,
        component: plugin,
        el,
        markdown,
        sourcePath:
          app.workspace.getActiveFile?.()?.path || 'agent-inbox/sessions/current.md',
        loadMathJax,
        finishRenderMath,
        renderMath,
        copyText: copyTextToClipboard,
        onCopied: () => notify('已复制 LaTeX'),
      });
    } catch {
      el.empty();
      el.setText(String(markdown ?? ''));
      el.addClass('is-streaming-plain');
      el.removeClass('is-md');
    }
  }

  /**
   * After fence HTML is injected, turn .me-soul-needs-md text blocks into MD+LaTeX.
   * @param {HTMLElement} root
   */
  async function hydrateMarkdownBlocks(root) {
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll('.me-soul-needs-md'));
    for (const el of nodes) {
      const md = el.textContent || '';
      el.removeClass('me-soul-needs-md');
      await renderMarkdownInto(el, md);
    }
  }

  /** Streaming agent message builder. */
  function createAgentMessage() {
    const msgId = newId('m');
    const div = logEl.createDiv({ cls: 'me-soul-msg me-soul-agent' });
    div.dataset.msgId = msgId;
    const body = div.createDiv({ cls: 'me-soul-msg-body' });

    let thoughtEl = null; // current <details> body
    let thoughtBuf = '';
    let textEl = null; // current streaming text div
    let textBuf = '';
    const toolEls = new Map(); // toolCallId → { root, statusEl }

    async function endText() {
      if (textEl && textBuf.trim()) {
        const el = textEl;
        const md = textBuf;
        textEl = null;
        textBuf = '';
        await renderMarkdownInto(el, md);
      } else if (textEl && !textBuf.trim()) {
        textEl.remove();
        textEl = null;
        textBuf = '';
      } else {
        textEl = null;
        textBuf = '';
      }
    }
    function endThought() {
      thoughtEl = null;
      thoughtBuf = '';
    }

    return {
      root: div,
      thought(t) {
        if (!t) return;
        void endText();
        if (!thoughtEl) {
          const d = body.createEl('details', { cls: 'me-soul-thought' });
          if (!controller.settings.quiet) d.setAttr('open', '');
          d.createEl('summary', { text: '思绪' });
          thoughtEl = d.createDiv({ cls: 'me-soul-thought-body' });
          thoughtBuf = '';
        }
        thoughtBuf += t;
        thoughtEl.setText(thoughtBuf);
        scrollDown();
      },
      text(t) {
        if (!t) return;
        endThought();
        if (!textEl) {
          textEl = body.createDiv({
            cls: 'me-soul-stream-text is-streaming-plain',
          });
          textBuf = '';
        }
        textBuf += t;
        textEl.setText(textBuf);
        scrollDown();
      },
      toolCall(u) {
        endThought();
        void endText();
        const root = body.createDiv({ cls: 'me-soul-tool-row' });
        const iconKind = isImagineTool(u) ? 'image_gen' : u.kind;
        root.createSpan({ cls: 'me-soul-tool-icon', text: toolIcon(iconKind) });
        root.createSpan({
          cls: 'me-soul-tool-title',
          text: u.title || u.kind || 'tool',
        });
        const st = root.createSpan({ cls: 'me-soul-tool-status is-running', text: '' });
        toolEls.set(u.toolCallId, {
          root,
          statusEl: st,
          imagine: isImagineTool(u),
          prompt: String(u.rawInput?.prompt || ''),
        });
        scrollDown();
      },
      toolUpdate(u) {
        const t = toolEls.get(u.toolCallId);
        if (!t) return;
        if (isImagineTool(u)) t.imagine = true;
        if (u.rawInput?.prompt) t.prompt = String(u.rawInput.prompt);
        const s = (u.status || '').toLowerCase();
        if (s === 'completed') {
          t.statusEl.removeClass('is-running');
          t.statusEl.addClass('is-done');
          if (t.imagine || isImagineTool(u)) {
            void handleImagineCompleted(u, t);
          }
        } else if (s === 'failed') {
          t.statusEl.removeClass('is-running');
          t.statusEl.addClass('is-failed');
        }
        if (u.title) {
          const titleEl = t.root.querySelector('.me-soul-tool-title');
          if (titleEl) titleEl.setText(u.title);
        }
      },
      /** Inline permission card; resolves optionId. */
      permission({ toolCall, options }) {
        endThought();
        void endText();
        return new Promise((resolve, reject) => {
          const card = body.createDiv({ cls: 'me-soul-confirm' });
          card.createDiv({ cls: 'me-soul-confirm-title', text: '需要你的许可' });
          const meta = card.createDiv({ cls: 'me-soul-confirm-body' });
          meta.setText(
            `${toolIcon(toolCall.kind)} ${toolCall.title || toolCall.kind || '操作'}` +
              (toolCall.locations?.length
                ? `\n${toolCall.locations.map((l) => l.path).join('\n')}`
                : '')
          );
          const actions = card.createDiv({ cls: 'me-soul-confirm-actions' });
          for (const o of options || []) {
            const btn = actions.createEl('button', { text: permLabel(o) });
            if (/allow/.test(o.kind || '')) btn.setAttr('data-action', 'accept');
            btn.onclick = () => {
              card.addClass(/allow/.test(o.kind || '') ? 'is-accepted' : 'is-rejected');
              actions.querySelectorAll('button').forEach((b) => b.setAttr('disabled', 'true'));
              resolve(o.optionId);
            };
          }
          scrollDown();
        });
      },
      async finalize(fullText) {
        endThought();
        // Skill path may have emptied/rebuilt body; only MD-render if stream node still mounted
        if (textEl && textEl.isConnected) {
          await endText();
        } else {
          textEl = null;
          textBuf = '';
        }
        appendFooter(div, fullText, { messageId: msgId, isError: false });
        scrollDown();
        recordMessage({
          id: msgId,
          role: 'agent',
          text: fullText || '',
        });
      },
      async fail(err) {
        endThought();
        await endText();
        const msg = err?.message || String(err || 'unknown');
        body.createDiv({ cls: 'me-soul-error', text: `出错了：${msg}` });
        appendFooter(div, msg, { messageId: msgId, isError: true });
        scrollDown();
        recordMessage({
          id: msgId,
          role: 'agent',
          text: '',
          error: msg,
        });
      },
    };
  }

  /**
   * @param {HTMLElement} msgDiv
   * @param {string} fullText
   * @param {{ messageId?: string, isError?: boolean }} [opts]
   */
  function appendFooter(msgDiv, fullText, opts = {}) {
    const foot = msgDiv.createDiv({ cls: 'me-soul-msg-foot' });
    const messageId = opts.messageId || msgDiv.dataset.msgId || '';
    const isError = !!opts.isError;

    const retry = foot.createEl('button', {
      cls: 'me-soul-foot-btn me-soul-foot-btn--retry',
      attr: {
        type: 'button',
        title: isError
          ? '截断本条失败回复并重发上一用户消息'
          : '截断本条回复并重新生成',
        'aria-label': isError ? '重发' : '重新生成',
      },
      text: isError ? '重发' : '重新生成',
    });
    retry.onclick = () => {
      void resendUserTurn(messageId, { asAgentRetry: true });
    };

    const up = foot.createEl('button', {
      cls: 'me-soul-foot-btn',
      attr: { type: 'button', title: '有用（再点取消）', 'aria-label': '有用' },
      text: '👍',
    });
    const down = foot.createEl('button', {
      cls: 'me-soul-foot-btn',
      attr: { type: 'button', title: '不佳（再点取消）', 'aria-label': '不佳' },
      text: '👎',
    });
    const fbBtn = foot.createEl('button', {
      cls: 'me-soul-foot-btn me-soul-foot-btn--feedback',
      attr: {
        type: 'button',
        title: '写具体反馈 → AI 反思并写入记忆（需确认）',
        'aria-label': '写反馈',
      },
      text: '反馈',
    });
    const copy = foot.createEl('button', {
      cls: 'me-soul-foot-btn',
      attr: { type: 'button', title: '复制', 'aria-label': '复制' },
      text: '⧉',
    });

    /** @type {'up' | 'down' | null} */
    let vote = null;
    /** @type {string | null} */
    let fbId = null;
    let fbBusy = false;

    const compose = msgDiv.createDiv({ cls: 'me-soul-feedback-compose' });
    compose.style.display = 'none';
    compose.createDiv({
      cls: 'me-soul-feedback-hint',
      text: '写清楚希望以后怎样。提交后会反思并生成待确认的记忆更新（点赞本身不会自动改人格）。',
    });
    const ta = compose.createEl('textarea', {
      cls: 'me-soul-feedback-input',
      attr: {
        rows: '3',
        placeholder: '例如：少用客服腔；解题先给思路再给答案；这段公式讲错了…',
      },
    });
    const composeRow = compose.createDiv({ cls: 'me-soul-feedback-actions' });
    const sendFb = composeRow.createEl('button', {
      cls: 'me-soul-feedback-send',
      attr: { type: 'button' },
      text: '提交并反思',
    });
    const cancelFb = composeRow.createEl('button', {
      cls: 'me-soul-feedback-cancel',
      attr: { type: 'button' },
      text: '收起',
    });

    function paintVote() {
      up.toggleClass('is-voted', vote === 'up');
      down.toggleClass('is-voted', vote === 'down');
      fbBtn.toggleClass('is-open', compose.style.display !== 'none');
    }

    /**
     * @param {'up' | 'down'} next
     */
    async function setVote(next) {
      if (fbBusy) return;
      fbBusy = true;
      try {
        if (vote === next) {
          // cancel
          if (fbId) {
            await updateFeedbackVote(app, fbId, null);
          }
          vote = null;
          fbId = null;
          paintVote();
          notify('已取消评价');
          return;
        }
        const emoji = next === 'up' ? '👍' : '👎';
        if (!fbId) {
          fbId = makeFeedbackId();
          await appendFeedbackEntry(app, {
            id: fbId,
            vote: emoji,
            excerpt: fullText,
          });
        } else {
          await updateFeedbackVote(app, fbId, emoji);
        }
        vote = next;
        paintVote();
        notify(
          next === 'up'
            ? '已记录 👍（再点可取消；写「反馈」才会触发反思）'
            : '已记录 👎（再点可取消；写「反馈」才会触发反思）'
        );
      } catch (e) {
        notify(e?.message || '反馈写入失败');
      } finally {
        fbBusy = false;
      }
    }

    up.onclick = () => setVote('up');
    down.onclick = () => setVote('down');

    fbBtn.onclick = () => {
      const open = compose.style.display === 'none';
      compose.style.display = open ? '' : 'none';
      paintVote();
      if (open) {
        requestAnimationFrame(() => ta.focus());
      }
    };
    cancelFb.onclick = () => {
      compose.style.display = 'none';
      paintVote();
    };

    sendFb.onclick = async () => {
      const note = (ta.value || '').trim();
      if (!note) {
        notify('请先写一点具体反馈');
        return;
      }
      if (busy || fbBusy) {
        notify('请等待当前回复结束');
        return;
      }
      fbBusy = true;
      sendFb.setAttr('disabled', 'true');
      try {
        const emoji = vote === 'up' ? '👍' : vote === 'down' ? '👎' : '📝';
        if (!fbId) {
          fbId = makeFeedbackId();
          await appendFeedbackEntry(app, {
            id: fbId,
            vote: emoji,
            excerpt: fullText,
            note,
          });
        } else {
          await updateFeedbackVote(app, fbId, emoji, { note });
        }
        if (!vote && emoji === '📝') {
          // no thumbs; leave vote null but file has 📝
        }
        paintVote();
        compose.style.display = 'none';
        paintVote();
        ta.value = '';

        // Reflect into memory via skill (confirm gate)
        const userPayload = [
          '【用户对上一条回复的具体反馈】',
          `评价：${emoji}`,
          '',
          '## 原回复摘录',
          String(fullText || '').slice(0, 2500),
          '',
          '## 用户反馈',
          note,
          '',
          '请按 me-reflect-feedback 起草 insight/pending 并输出确认卡。',
        ].join('\n');

        notify('已记录反馈，正在反思…');
        setBusy(true);
        try {
          await runSkillWithGrok(
            { id: 'me-reflect-feedback', label: '/me-reflect-feedback' },
            userPayload,
            []
          );
          setStatus('就绪');
        } finally {
          setBusy(false);
        }
      } catch (e) {
        notify(e?.message || '反馈反思失败');
        setStatus('失败');
        setBusy(false);
      } finally {
        fbBusy = false;
        sendFb.removeAttribute('disabled');
      }
    };

    copy.onclick = async () => {
      const ok = await copyTextToClipboard(fullText || '');
      notify(ok ? '已复制' : '复制失败');
    };
  }

  /**
   * Clipboard helper — navigator.clipboard can fail in Electron/ItemView;
   * fall back to a transient textarea + execCommand.
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async function copyTextToClipboard(text) {
    const t = String(text ?? '');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(t);
        return true;
      }
    } catch {
      /* fall through */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch {
      return false;
    }
  }

  // ---------- send ----------
  /**
   * @param {{
   *   text?: string,
   *   chips?: { path: string, kind?: string }[],
   *   skill?: { id: string, label: string } | null,
   *   skipComposerClear?: boolean,
   * }} [override]
   */
  async function send(override = {}) {
    if (busy) {
      plugin.acp?.cancel?.();
      return;
    }
    const fromOverride = override.text != null || override.chips != null || override.skill !== undefined;
    const text = fromOverride
      ? String(override.text || '').trim()
      : inputEl.value.trim();
    const skill = fromOverride
      ? override.skill || null
      : activeSkill;
    const manualChips = fromOverride
      ? Array.isArray(override.chips)
        ? override.chips.slice()
        : []
      : chips;
    const usedChips = fromOverride
      ? // Resend keeps the exact chip set from the prior turn (incl. active if saved).
        manualChips.slice()
      : buildSendChips(manualChips);
    // Allow send with only active-note context (no text) only if skill or chips
    if (!text && !skill && !usedChips.length) return;

    // builtin commands
    if (skill?.id === '__new') {
      activeSkill = null;
      renderSkillPill();
      newBtn.onclick();
      return;
    }
    if (skill?.id === '__quiet') {
      activeSkill = null;
      renderSkillPill();
      quietBtn.onclick();
      return;
    }

    if (!override.skipComposerClear) {
      inputEl.value = '';
      autoGrow();
      chips = [];
      activeSkill = null;
      renderChips();
      renderSkillPill();
      closeSuggest();
    } else {
      // Resend path: composer may still hold unrelated draft — leave it,
      // but clear skill pill if we injected one only for the resend payload.
      closeSuggest();
    }

    // Skill pill must not hijack "discuss this note" into 心迹 draft.
    let effectiveSkill = skill;
    if (
      effectiveSkill?.id === 'me-write-insight' &&
      looksLikeNoteDiscussion(text, usedChips)
    ) {
      notify('已退出「写心迹」：你像是在讨论笔记，改为普通对话');
      effectiveSkill = null;
    }

    appendUser(text, usedChips, effectiveSkill);
    setBusy(true);
    setStatus('思考中…');

    try {
      if (effectiveSkill) {
        await runSkillFlow(effectiveSkill, text, usedChips);
      } else {
        await runChatFlow(text, usedChips);
      }
      setStatus('就绪');
    } catch (e) {
      const msg = createAgentMessage();
      msg.fail(e?.message || String(e));
      setStatus('失败');
    } finally {
      setBusy(false);
      refreshCare();
    }
  }

  async function runChatFlow(text, usedChips) {
    const { chips: loaded, maxChars } = await loadChipContents(usedChips);
    const composed = composeWithContext(text, loaded, { maxChars });
    const conversation = formatRecentConversation(chatSession, {
      currentUserText: text,
    });
    const fullPrompt = await assembleMemoryPrompt(
      app,
      plugin,
      composed,
      text,
      usedChips,
      conversation
    );

    if (plugin.settings.engine === 'openclaw') {
      // legacy gateway path — still inject soul pack into text
      const res = await controller.handleUserMessage(fullPrompt, []);
      const msg = createAgentMessage();
      if (!res.ok) {
        msg.fail(res.error || 'gateway error');
        return;
      }
      const body = msg.root.querySelector('.me-soul-msg-body');
      body.innerHTML = res.html;
      wireConfirms(app, controller, body, Notice, plugin);
      await msg.finalize(res.agentText || '');
      return;
    }

    const client = plugin.getAcp();
    const msg = createAgentMessage();
    let full = '';
    const { stopReason } = await client.prompt(fullPrompt, {
      onThought: (t) => msg.thought(t),
      onText: (t) => {
        full += t;
        msg.text(t);
      },
      onToolCall: (u) => msg.toolCall(u),
      onToolUpdate: (u) => msg.toolUpdate(u),
      onPermission: (req) => msg.permission(req),
    });
    if (stopReason === 'cancelled') {
      msg.root.querySelector('.me-soul-msg-body')?.createDiv({
        cls: 'me-soul-error',
        text: '（已停止）',
      });
    }
    await msg.finalize(full);
  }

  /**
   * All slash skills: load SKILL.md → Grok Build ACP → render confirm fences.
   * Plugin only keeps UI, confirm Accept/Reject wiring (digest/insight/soul/memorized).
   */
  async function runSkillFlow(skill, text, usedChips) {
    if (!isGrokSkill(skill.id)) {
      await runChatFlow(`/${skill.id} ${text}`.trim(), usedChips);
      return;
    }
    await runSkillWithGrok(skill, text, usedChips);
  }

  async function runSkillWithGrok(skill, text, usedChips) {
    const msg = createAgentMessage();

    if (plugin.settings.engine === 'openclaw') {
      msg.fail(
        '此技能需要 Grok Build 内核。请在设置里把引擎改为 Grok Build。'
      );
      return;
    }

    setStatus(`运行 /${skill.id}…`);
    const skillMd = await loadSkillMarkdown(skill.id, (rel) => vaultRead(app, rel));
    const { chips: loaded, maxChars } = await loadChipContents(usedChips);
    // Section-only (already starts with ## 附带上下文 when non-empty)
    const contextBlock = composeWithContext('', loaded, { maxChars });
    const activePath = activeNoteEnabled()
      ? getEffectiveActivePath(activeNoteState)
      : null;
    const conversation = formatRecentConversation(chatSession, {
      currentUserText: text,
    });

    const fullPrompt = buildGrokSkillPrompt({
      skillId: skill.id,
      skillMd,
      userText: text || '',
      contextBlock,
      activePath,
      conversation,
    });

    let full = '';
    try {
      const client = plugin.getAcp();
      const { stopReason } = await client.prompt(fullPrompt, {
        onThought: (t) => msg.thought(t),
        onText: (t) => {
          full += t;
          msg.text(t);
        },
        onToolCall: (u) => msg.toolCall(u),
        onToolUpdate: (u) => msg.toolUpdate(u),
        onPermission: (req) => msg.permission(req),
      });
      if (stopReason === 'cancelled') {
        msg.root.querySelector('.me-soul-msg-body')?.createDiv({
          cls: 'me-soul-error',
          text: '（已停止）',
        });
      }
    } catch (e) {
      msg.fail(e?.message || String(e));
      return;
    }

    // Re-render final text so :::confirm / :::thought become interactive cards
    const bodyEl = msg.root.querySelector('.me-soul-msg-body');
    if (bodyEl && full.trim()) {
      bodyEl.empty();
      const rendered = renderAgentMessage(full, {
        quiet: controller.settings.quiet,
      });
      bodyEl.innerHTML = rendered.html;
      await hydrateMarkdownBlocks(bodyEl);
      await wireConfirms(app, controller, bodyEl, Notice, plugin);
    }
    await msg.finalize(full);
  }

  // ---------- paste / drop → raw ----------
  async function saveToRaw(file) {
    const dir = 'agent-inbox/raw';
    await ensureFolder(app, dir);
    let name = file.name || `pasted-${Date.now()}.png`;
    let path = `${dir}/${name}`;
    let n = 1;
    while (app.vault.getAbstractFileByPath(path)) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      path = `${dir}/${stem}-${n}${ext}`;
      n += 1;
    }
    const buf = await file.arrayBuffer();
    await app.vault.createBinary(path, buf);
    chips.push({ path, kind: 'raw' });
    renderChips();
    notify(`已存入 ${path}`);
  }

  inputEl.addEventListener('paste', async (ev) => {
    const files = Array.from(ev.clipboardData?.files || []);
    if (!files.length) return;
    ev.preventDefault();
    for (const f of files) await saveToRaw(f);
  });
  for (const el of [composer, logEl]) {
    el.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      composer.addClass('is-dragover');
    });
    el.addEventListener('dragleave', () => composer.removeClass('is-dragover'));
    el.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      composer.removeClass('is-dragover');
      const files = Array.from(ev.dataTransfer?.files || []);
      for (const f of files) await saveToRaw(f);
    });
  }

  // ---------- input events ----------
  inputEl.addEventListener('input', () => {
    autoGrow();
    updateSuggest();
  });
  inputEl.addEventListener('keydown', (ev) => {
    if (suggestKind) {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        suggestIndex = (suggestIndex + 1) % suggestItems.length;
        paintSuggest();
        return;
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        suggestIndex = (suggestIndex - 1 + suggestItems.length) % suggestItems.length;
        paintSuggest();
        return;
      }
      if (ev.key === 'Enter' || ev.key === 'Tab') {
        ev.preventDefault();
        acceptSuggest();
        return;
      }
      if (ev.key === 'Escape') {
        closeSuggest();
        return;
      }
    }
    if (ev.key === 'Backspace' && !inputEl.value && activeSkill) {
      activeSkill = null;
      renderSkillPill();
      return;
    }
    if (ev.key === 'Backspace' && !inputEl.value && chips.length) {
      chips.pop();
      renderChips();
      return;
    }
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      send();
    }
  });
  sendBtn.onclick = () => send();

  // ---------- care ----------
  async function refreshCare() {
    try {
      const f = app.vault.getAbstractFileByPath('agent-inbox/soul/pending-care.md');
      if (!f) {
        careEl.setText('牵挂 · 无');
        careEl.removeClass('has-items');
        return;
      }
      const t = await app.vault.read(f);
      const n = (t.match(/^##\s+\d+\./gm) || []).length;
      careEl.setText(n ? `牵挂 · ${n}` : '牵挂 · 无');
      careEl.toggleClass('has-items', n > 0);
    } catch {
      careEl.setText('牵挂 · —');
    }
  }

  async function restoreOrWelcome() {
    try {
      chatSession = await loadSessionFromVault(app);
    } catch (e) {
      console.warn('load chat session failed', e);
      chatSession = createEmptySession();
    }
    logEl.empty();
    if (!chatSession.messages?.length) {
      appendWelcome();
      return;
    }
    for (const m of chatSession.messages) {
      if (m.role === 'user') {
        appendUser(m.text || '', m.chips || [], m.skill || null, {
          persist: false,
          id: m.id,
        });
      } else if (m.role === 'agent') {
        await appendAgentFromHistory(m);
      }
    }
    scrollDown();
  }

  // Restore previous transcript (or welcome). Fire-and-forget with care refresh.
  const bootPromise = restoreOrWelcome()
    .then(() => refreshCare())
    .catch((e) => {
      console.warn(e);
      appendWelcome();
      refreshCare();
    });
  autoGrow();

  /**
   * Run a skill queued by the IDE command bar (`/me-digest …` etc.).
   */
  async function consumeQueuedLaunch() {
    try {
      await bootPromise;
    } catch {
      /* */
    }
    const launch = plugin.takeChatLaunch?.();
    if (!launch?.skillId) return;
    if (busy) {
      // Re-queue so a later idle call can pick it up
      plugin.queueChatLaunch?.(launch);
      notify('对话进行中，技能将在空闲后运行');
      return;
    }
    activeSkill = { id: launch.skillId, label: `/${launch.skillId}` };
    renderSkillPill();
    inputEl.value = launch.text || '';
    autoGrow();
    closeSuggest();
    if (launch.autoSend === false) {
      inputEl.focus();
      return;
    }
    await send();
  }

  return {
    refreshCare,
    reloadSession: restoreOrWelcome,
    consumeQueuedLaunch,
    destroy() {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      flushPersist().catch((e) => console.warn('flush on destroy failed', e));
      try {
        if (unsubLeaf && app.workspace.offref) app.workspace.offref(unsubLeaf);
        else if (unsubLeaf) app.workspace.off?.('active-leaf-change', unsubLeaf);
      } catch {
        /* */
      }
      try {
        if (unsubOpen && app.workspace.offref) app.workspace.offref(unsubOpen);
        else if (unsubOpen) app.workspace.off?.('file-open', unsubOpen);
      } catch {
        /* */
      }
      try {
        document.removeEventListener('pointerdown', onDocPointer, true);
        document.removeEventListener('pointerdown', onDocContext, true);
        document.removeEventListener('keydown', onKeyDown);
        shell.removeEventListener('keydown', onKeyDown);
      } catch {
        /* */
      }
      closeHistoryPanel();
      try {
        chromeRo?.disconnect?.();
      } catch {
        /* */
      }
      cancelVoice?.();
      containerEl.empty();
    },
  };
}

/**
 * Prefer unsaved editor buffer for path; else vault read.
 * @param {any} app
 * @param {string} path
 */
async function readNoteBodyPreferEditor(app, path) {
  try {
    const leaves = app.workspace.getLeavesOfType?.('markdown') || [];
    for (const leaf of leaves) {
      const f = leaf?.view?.file;
      if (f?.path === path && typeof leaf.view.editor?.getValue === 'function') {
        return leaf.view.editor.getValue();
      }
    }
  } catch {
    /* */
  }
  return vaultRead(app, path);
}

// ================= helpers =================

function shortName(path) {
  const parts = String(path).split('/');
  return parts[parts.length - 1];
}

function toolIcon(kind) {
  const map = {
    read: '📖',
    edit: '✏️',
    delete: '🗑',
    move: '📦',
    search: '🔍',
    execute: '⌨️',
    fetch: '🌐',
    think: '💭',
    image_gen: '🖼',
    image_edit: '🎨',
    other: '🔧',
  };
  return map[(kind || '').toLowerCase()] || '🔧';
}

function permLabel(o) {
  const k = o.kind || '';
  if (k === 'allow_once') return '允许';
  if (k === 'allow_always') return '总是允许';
  if (k === 'reject_once') return '拒绝';
  if (k === 'reject_always') return '总是拒绝';
  return o.name || k || '选项';
}

/** Simple subsequence fuzzy over vault files. */
export function fuzzyScore(query, target) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx; // substring: strong
  let qi = 0;
  let score = 0;
  let last = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += ti === last + 1 ? 5 : 1;
      last = ti;
      qi++;
    }
  }
  return qi === q.length ? score : -1;
}

function fuzzyFiles(app, query) {
  const files = app.vault.getFiles();
  const scored = [];
  for (const f of files) {
    const s = Math.max(fuzzyScore(query, f.name), fuzzyScore(query, f.path) - 1);
    if (s >= 0) scored.push({ name: f.name, path: f.path, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

async function ensureFolder(app, dir) {
  const parts = dir.split('/');
  let cur = '';
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try {
        await app.vault.createFolder(cur);
      } catch {}
    }
  }
}

/** Compose message with chip contents (refs read; raw referenced by path). */

  /**
 * Force-inject soul pack + optional wiki retrieval before every model call.
 * Module-level: must receive app/plugin (not closed over mount scope).
 */
async function assembleMemoryPrompt(
  app,
  plugin,
  composedUser,
  rawText,
  usedChips,
  conversation = ''
) {
  const readFile = async (rel) => vaultRead(app, rel);
  const pack = await loadSoulPack(readFile);
  let retrieved = [];
  const q = [rawText || '', ...(usedChips || []).map((c) => c.path || '')].join(' ');
  const skipRetrieve =
    shouldSkipRetrieve(rawText) ||
    (plugin && plugin.settings && plugin.settings.retrieve === false);
  if (!skipRetrieve) {
    try {
      retrieved = await retrieveRelevantMemory(app, plugin, q);
    } catch (e) {
      console.warn('retrieve failed', e);
    }
  }
  return buildTurnPrompt({
    identity: pack.identity || '',
    soul: pack.soul || '',
    profile: pack.profile || '',
    style: pack.style || '',
    constitution: pack.constitution || '',
    retrieved,
    conversation,
    userMessage: composedUser,
  });
}

/**
 * Legacy compose used by tests / call sites that pass chips without preloaded content.
 * Prefer composeWithContext after loadChipContents in the chat panel.
 */
async function composeMessage(app, text, chips, opts = {}) {
  if (!chips?.length) return text;
  const maxChars = opts.maxChars ?? DEFAULT_ACTIVE_NOTE_MAX_CHARS;
  const enriched = [];
  for (const c of chips) {
    if (c.kind === 'raw') {
      enriched.push(c);
      continue;
    }
    let content = c.content;
    if (content == null) {
      try {
        content = (await readNoteBodyPreferEditor(app, c.path)) ?? '(读取失败)';
      } catch {
        content = '(读取失败)';
      }
    }
    enriched.push({ ...c, content });
  }
  return composeWithContext(text, enriched, { maxChars });
}

async function vaultWrite(app, rel, content) {
  if (!rel.startsWith('agent-inbox/')) {
    throw new Error(`refuse write outside agent-inbox: ${rel}`);
  }
  await ensureFolder(app, rel.split('/').slice(0, -1).join('/'));
  const existing = app.vault.getAbstractFileByPath(rel);
  if (existing) await app.vault.modify(existing, content);
  else await app.vault.create(rel, content);
  return rel;
}

async function vaultRead(app, rel) {
  const f = app.vault.getAbstractFileByPath(rel);
  if (!f) return null;
  return app.vault.read(f);
}

/** True when user is asking to discuss a note, not write a profile 心迹. */
function looksLikeNoteDiscussion(text, chips = []) {
  const hasChip = (chips || []).some((c) => c && (c.path || c.kind === 'ref' || c.kind === 'raw'));
  const t = String(text || '');
  const hasAt = /@\S+/.test(t) || /\[\[[^\]]+\]\]/.test(t);
  if (!hasChip && !hasAt) {
    return false;
  }
  if (/讨论|聊聊|分析|看看|解读|讲解|讲讲|帮我看|读一下|总结一下|什么意思|讲下|说说这/.test(t)) {
    return true;
  }
  if (hasChip && t && !/(偏好|习惯|边界|记住|以后|不要|别再|我希望|我更|风格|纠正)/.test(t)) {
    if (/^(讨论|聊聊|看看|分析)/.test(t.trim())) return true;
  }
  return false;
}

/** On digest Accept: embed into vectors.jsonl only (no keyword index). */
async function updateWikiIndexOnAccept(app, wikiPath, plugin) {
  if (!wikiPath || !wikiPath.startsWith('agent-inbox/wiki/')) return;
  const md = await vaultRead(app, wikiPath);
  if (!md || !plugin) return;
  try {
    await upsertVectorsForPath(app, plugin, wikiPath, md);
  } catch (e) {
    console.warn('vector upsert on accept failed', e);
  }
}

/** On digest Reject: drop vector chunks for that path. */
async function updateWikiIndexOnReject(app, wikiPath) {
  if (!wikiPath) return;
  try {
    await removeVectorsForPath(app, wikiPath);
  } catch (e) {
    console.warn('vector remove on reject failed', e);
  }
}

async function applySoulPromotePlan(app, pendingMd) {
  const jsonMatch = pendingMd.match(/```json\n([\s\S]*?)\n```/);
  if (!jsonMatch) throw new Error('pending 中无 JSON 计划');
  const plan = JSON.parse(jsonMatch[1]);
  const updates = plan.updates || [];
  const date = new Date().toISOString().slice(0, 10);
  const targetMap = {
    profile: 'agent-inbox/soul/profile.md',
    style: 'agent-inbox/soul/style.md',
    soul: 'agent-inbox/soul/SOUL.md',
  };
  for (const u of updates) {
    const rel = targetMap[u.target];
    if (!rel) continue;
    let cur = await vaultRead(app, rel);
    if (cur == null) cur = `# ${u.target}\n`;
    const snippet = (u.text || '').trim();
    if (!snippet) continue;
    if (cur.includes(snippet.slice(0, Math.min(40, snippet.length)))) continue;
    const block = `\n\n## Promote ${date} — ${u.title || 'update'}\n\n${snippet}\n`;
    await vaultWrite(app, rel, cur.trimEnd() + block);
  }
}

/**
 * @param {any} Notice - Obsidian Notice constructor (must be invoked with `new`)
 * @param {string} message
 */
function showNotice(Notice, message) {
  if (!Notice) return;
  new Notice(String(message ?? ''));
}

/**
 * Embed accepted wiki sources into vectors.jsonl (plugin-side; Grok cannot call embed API).
 * @returns {Promise<{ ok?: boolean, skipped?: boolean, reason?: string, summary: string, vectorChunks?: number }>}
 */
async function runMemorizedEmbed(app, plugin) {
  const folder = app.vault.getAbstractFileByPath('agent-inbox/wiki/sources');
  const files = folder?.children?.filter((c) => c.extension === 'md') || [];
  /** @type {{ path: string, md: string }[]} */
  const acceptedFiles = [];
  for (const f of files) {
    const md = await app.vault.read(f);
    if (/wiki_status:\s*pending_review/.test(md)) continue;
    acceptedFiles.push({ path: f.path, md });
  }
  const vres = await reindexAllVectors(app, plugin, acceptedFiles);
  if (vres.skipped) {
    return {
      skipped: true,
      reason: vres.reason,
      summary:
        vres.reason === 'no-key'
          ? '未能写入记忆库：未配置 Embed API Key（设置 → 向量记忆）。'
          : '向量记忆写入已跳过。',
      vectorChunks: 0,
    };
  }
  return {
    ok: true,
    summary: `已写入向量记忆库：${acceptedFiles.length} 篇 wiki → ${vres.vectorChunks} 块（新 embed ${vres.embedded} · 复用 ${vres.reused} · ${vres.model}）→ agent-inbox/wiki/vectors.jsonl`,
    vectorChunks: vres.vectorChunks,
  };
}

async function wireConfirms(app, controller, root, Notice, plugin) {
  root.querySelectorAll('.me-soul-confirm').forEach((card) => {
    const path = card.getAttribute('data-path');
    const confirmType = card.getAttribute('data-type') || '';
    card.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-action');
        if (!path && confirmType !== 'memorized') return;

        // memorized: no pending markdown — plugin runs embedder on Accept
        if (confirmType === 'memorized') {
          if (action === 'reject') {
            card.classList.add('is-rejected');
            card.querySelectorAll('button').forEach((b) => b.setAttr('disabled', 'true'));
            showNotice(Notice, '已取消写入向量记忆');
            return;
          }
          if (action === 'accept') {
            card.querySelectorAll('button').forEach((b) => b.setAttr('disabled', 'true'));
            showNotice(Notice, '正在写入向量记忆…');
            try {
              const res = await runMemorizedEmbed(app, plugin);
              if (res.skipped) {
                showNotice(Notice, res.summary);
                card.classList.add('is-rejected');
              } else {
                showNotice(Notice, res.summary);
                card.classList.add('is-accepted');
              }
            } catch (e) {
              showNotice(Notice, `向量记忆失败：${e?.message || e}`);
              card.classList.add('is-rejected');
            }
            return;
          }
          return;
        }

        if (!checkWritePolicy(path).allowed) {
          showNotice(Notice, '拒绝写入 agent-inbox 以外路径');
          return;
        }
        const file = app.vault.getAbstractFileByPath(path);
        if (!file) {
          showNotice(Notice, `找不到 pending：${path}`);
          return;
        }
        const md = await app.vault.read(file);
        const { parsePendingMarkdown } = await import('./protocol-bridge.js');
        const rec = parsePendingMarkdown(md);
        const isDigest = rec.type === 'digest' || confirmType === 'digest';
        // pending.path points at wiki file for type=digest
        const wikiPath = (rec.path || '').trim();

        if (action === 'reject') {
          const result = controller.rejectConfirm(md);
          if (!result.ok) {
            showNotice(Notice, result.error || '拒绝失败');
            return;
          }
          await app.vault.modify(file, result.markdown);
          if (isDigest && wikiPath && wikiPath.startsWith('agent-inbox/')) {
            const wikiFile = app.vault.getAbstractFileByPath(wikiPath);
            if (wikiFile) {
              await app.vault.delete(wikiFile);
              try {
                await updateWikiIndexOnReject(app, wikiPath);
              } catch (e) {
                console.warn(e);
              }
              showNotice(Notice, `已拒绝并删除 wiki：${wikiPath}`);
            } else {
              showNotice(Notice, `已拒绝 pending（wiki 未找到：${wikiPath}）`);
            }
          } else {
            showNotice(Notice, `已拒绝 → ${path}`);
          }
          card.classList.add('is-rejected');
          card.querySelectorAll('button').forEach((b) => b.setAttr('disabled', 'true'));
          return;
        }

        if (action === 'accept') {
          const result = controller.approveConfirm(md);
          if (!result.ok) {
            showNotice(Notice, result.error || '批准失败');
            return;
          }
          await app.vault.modify(file, result.markdown);
          if (isDigest && wikiPath && wikiPath.startsWith('agent-inbox/')) {
            const wikiFile = app.vault.getAbstractFileByPath(wikiPath);
            if (wikiFile) {
              const wikiMd = await app.vault.read(wikiFile);
              const finalized = setWikiStatus(wikiMd, 'accepted');
              await app.vault.modify(wikiFile, finalized);
              try {
                await updateWikiIndexOnAccept(app, wikiPath, plugin);
              } catch (e) {
                console.warn(e);
              }
              showNotice(Notice, `已定稿 wiki：${wikiPath}`);
            } else {
              showNotice(Notice, `已批准 pending，但 wiki 不存在：${wikiPath}`);
            }
          } else if (rec.type === 'soul-promote' || confirmType === 'soul-promote') {
            try {
              await applySoulPromotePlan(app, md);
              showNotice(Notice, '已写入 Soul / profile / style');
            } catch (e) {
              showNotice(Notice, `升格写入失败：${e.message || e}`);
            }
          } else {
            showNotice(Notice, `已批准 → ${path}`);
          }
          card.classList.add('is-accepted');
          card.querySelectorAll('button').forEach((b) => b.setAttr('disabled', 'true'));
          return;
        }
      });
    });
  });
}
