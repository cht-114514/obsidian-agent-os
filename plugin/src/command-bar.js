/**
 * Cursor-style floating command bar for Obsidian Agent OS.
 * Summon with hotkey → multi-turn NL → stream → apply to editor (or show only).
 * Panel is draggable and non-blocking so the note / cursor stay usable.
 */
import { MarkdownView } from 'obsidian';
import { parseApplyResponse, stripApplyHeaderForPreview } from './intent.js';
import {
  captureEditorContext,
  applyToEditor,
  cleanModelOutput,
} from './editor-apply.js';
import { buildCommandBarPrompt, runAgentTurn } from './agent-turn.js';
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
import { renderMarkdownWithMath } from './markdown-render.js';
import {
  loadSessionFromVault,
  saveSessionToVault,
  appendMessage,
  sessionToCmdbarTurns,
  createEmptySession,
  rotateSession,
  listArchivedSessions,
  restoreArchivedSession,
  summarizeSession,
  SESSION_PATH,
} from './chat-history.js';
import { parseSlashSkillCommand } from './skill-prompt.js';

const POSITION_KEY = 'me-soul-cmdbar-pos';

/**
 * @param {import('obsidian').App} app
 * @param {any} plugin MeSoulPlugin
 * @param {{
 *   Notice: any,
 *   MarkdownRenderer?: any,
 *   loadMathJax?: () => Promise<void>,
 *   renderMath?: (source: string, display: boolean) => HTMLElement,
 *   finishRenderMath?: () => Promise<void>,
 * }} deps
 */
export function createCommandBarController(app, plugin, deps) {
  const {
    Notice,
    MarkdownRenderer,
    loadMathJax,
    renderMath,
    finishRenderMath,
  } = deps;

  /** @type {HTMLElement | null} */
  let root = null;
  /** @type {HTMLElement | null} */
  let panelEl = null;
  /** @type {HTMLTextAreaElement | null} */
  let inputEl = null;
  /** @type {HTMLElement | null} */
  let transcriptEl = null;
  /** @type {HTMLElement | null} */
  let resultEl = null;
  /** @type {HTMLElement | null} */
  let thinkingEl = null;
  /** @type {HTMLElement | null} */
  let actionsEl = null;
  /** @type {HTMLElement | null} */
  let feedbackEl = null;
  /** @type {HTMLElement | null} */
  let statusEl = null;
  /** @type {HTMLButtonElement | null} */
  let sendBtn = null;
  /** @type {HTMLSelectElement | null} */
  let modelSelect = null;
  /** @type {HTMLSelectElement | null} */
  let effortSelect = null;
  /** @type {HTMLElement | null} */
  let sessionWrap = null;
  /** @type {HTMLButtonElement | null} */
  let sessionBtn = null;
  /** @type {HTMLElement | null} */
  let sessionMenu = null;
  /** @type {(() => void) | null} */
  let removeSessionMenuOutside = null;
  /** @type {{ resolve: () => void, token: { aborted: boolean } } | null} */
  let pendingFullscreenOpen = null;
  /** @type {HTMLElement | null} */
  let skillPillEl = null;
  /** @type {HTMLElement | null} */
  let suggestEl = null;
  /** @type {HTMLElement | null} */
  let skillLiveEl = null;
  /** @type {{ id: string, label: string } | null} */
  let activeSkill = null;
  /** @type {any[]} */
  let suggestItems = [];
  let suggestIndex = 0;
  /** @type {'skill'|null} */
  let suggestKind = null;

  let busy = false;
  /** @type {((busy: boolean) => void) | null} */
  let busyListener = null;
  let resultRenderToken = 0;
  let transcriptRenderToken = 0;
  /** @type {import('./editor-apply.js').EditorCapture | null} */
  let lastCapture = null;
  /** @type {import('obsidian').Editor | null} */
  let lastEditor = null;
  /** @type {import('./intent.js').ApplyMode} */
  let lastMode = 'show_only';
  /** @type {string} */
  let lastFullText = '';
  /** @type {string} */
  let lastUserPrompt = '';
  /** @type {string | null} */
  let lastFbId = null;
  /** @type {'up' | 'down' | null} */
  let lastVote = null;
  /** @type {Array<{ role: 'user' | 'assistant', text: string }>} */
  let turns = [];
  /** @type {(() => void) | null} */
  let removeKeyHandler = null;
  /** @type {(() => void) | null} */
  let removeContextListeners = null;
  /** @type {(() => void) | null} */
  let removeDragHandlers = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let contextPoll = null;

  function isEnabled() {
    return plugin.settings.commandBarEnabled !== false;
  }

  function getMarkdownView() {
    const v = app.workspace.getActiveViewOfType(MarkdownView);
    return v || null;
  }

  function notify(msg) {
    try {
      new Notice(msg);
    } catch {
      /* */
    }
  }

  function loadSavedPosition() {
    try {
      const raw = localStorage.getItem(POSITION_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (typeof p?.left === 'number' && typeof p?.top === 'number') {
        return { left: p.left, top: p.top };
      }
    } catch {
      /* */
    }
    return null;
  }

  function savePosition(left, top) {
    try {
      localStorage.setItem(POSITION_KEY, JSON.stringify({ left, top }));
    } catch {
      /* */
    }
  }

  /**
   * Place panel at default (centered top) or restored position.
   * @param {{ forceDefault?: boolean }} [opts]
   */
  function placePanel(opts = {}) {
    if (!panelEl) return;
    const saved = opts.forceDefault ? null : loadSavedPosition();
    const maxW = Math.min(560, window.innerWidth - 24);
    panelEl.style.width = `${maxW}px`;
    panelEl.style.maxWidth = 'calc(100vw - 24px)';

    if (saved) {
      const left = Math.max(8, Math.min(saved.left, window.innerWidth - 80));
      const top = Math.max(8, Math.min(saved.top, window.innerHeight - 80));
      panelEl.classList.add('is-positioned');
      panelEl.style.left = `${left}px`;
      panelEl.style.top = `${top}px`;
      panelEl.style.right = 'auto';
      panelEl.style.transform = 'none';
    } else {
      panelEl.classList.remove('is-positioned');
      panelEl.style.left = '50%';
      panelEl.style.top = '12vh';
      panelEl.style.right = 'auto';
      panelEl.style.transform = 'translateX(-50%)';
    }
  }

  /**
   * Drag panel by the header (skip interactive controls).
   * @param {HTMLElement} handle
   * @param {HTMLElement} panel
   */
  function setupDrag(handle, panel) {
    if (removeDragHandlers) {
      removeDragHandlers();
      removeDragHandlers = null;
    }

    let dragging = false;
    /** @type {number} */
    let startX = 0;
    /** @type {number} */
    let startY = 0;
    /** @type {number} */
    let origLeft = 0;
    /** @type {number} */
    let origTop = 0;

    const onPointerDown = (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      const t = /** @type {HTMLElement} */ (ev.target);
      if (t.closest('button, select, input, textarea, a, option')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      panel.classList.add('is-positioned', 'is-dragging');
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.transform = 'none';
      panel.style.right = 'auto';
      startX = ev.clientX;
      startY = ev.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      try {
        handle.setPointerCapture(ev.pointerId);
      } catch {
        /* */
      }
      ev.preventDefault();
    };

    const onPointerMove = (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const left = Math.max(8, Math.min(origLeft + dx, window.innerWidth - 80));
      const top = Math.max(8, Math.min(origTop + dy, window.innerHeight - 80));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };

    const onPointerUp = (ev) => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('is-dragging');
      const left = parseFloat(panel.style.left) || 0;
      const top = parseFloat(panel.style.top) || 0;
      savePosition(left, top);
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch {
        /* */
      }
    };

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);

    removeDragHandlers = () => {
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerUp);
    };
  }

  function ensureDom() {
    if (root) return;
    root = document.body.createDiv({ cls: 'me-soul-cmdbar-root' });
    root.setAttr('aria-hidden', 'true');

    // No full-screen backdrop: note stays visible and interactive.
    // Clicking outside does not steal focus / block the editor.

    panelEl = root.createDiv({ cls: 'me-soul-cmdbar-panel' });
    panelEl.setAttr('role', 'dialog');
    panelEl.setAttr('aria-label', 'Agent 命令条');

    const head = panelEl.createDiv({ cls: 'me-soul-cmdbar-head' });
    head.setAttr('title', '拖动标题栏可移动面板');
    const brand = head.createDiv({ cls: 'me-soul-cmdbar-brand' });
    brand.createSpan({ cls: 'me-soul-cmdbar-dot', attr: { 'aria-hidden': 'true' } });
    brand.createSpan({ cls: 'me-soul-cmdbar-title', text: plugin.settings.agentName || 'Agent' });

    modelSelect = head.createEl('select', {
      cls: 'me-soul-cmdbar-model',
      attr: {
        'aria-label': '切换模型',
        title: '切换模型（Grok订阅 / 第三方）',
      },
    });
    modelSelect.onchange = () => onModelChange();

    effortSelect = head.createEl('select', {
      cls: 'me-soul-cmdbar-model me-soul-cmdbar-effort',
      attr: {
        'aria-label': '思考等级',
        title: '思考等级（reasoning effort，下一条生效）',
      },
    });
    effortSelect.onchange = () => onEffortChange();

    sessionWrap = head.createDiv({ cls: 'me-soul-cmdbar-session-wrap' });
    sessionBtn = sessionWrap.createEl('button', {
      cls: 'me-soul-cmdbar-session-btn',
      attr: {
        type: 'button',
        'aria-label': '会话',
        'aria-expanded': 'false',
        title: '新建或加载历史对话',
      },
      text: '会话',
    });
    sessionMenu = sessionWrap.createDiv({
      cls: 'me-soul-cmdbar-session-menu',
      attr: { role: 'menu', 'aria-hidden': 'true' },
    });
    sessionBtn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (busy) {
        notify('生成中，稍后再切换会话');
        return;
      }
      void toggleSessionMenu();
    };

    statusEl = head.createSpan({ cls: 'me-soul-cmdbar-status', text: '' });

    const fullBtn = head.createEl('button', {
      cls: 'me-soul-cmdbar-icon-btn',
      attr: {
        type: 'button',
        'aria-label': '全屏对话',
        title: '打开全屏 Agent（共享聊天记录）',
      },
      text: '⛶',
    });
    fullBtn.onclick = () => {
      void openFullscreenChat();
    };

    const closeBtn = head.createEl('button', {
      cls: 'me-soul-cmdbar-close',
      attr: { type: 'button', 'aria-label': '关闭', title: 'Esc' },
      text: '×',
    });
    closeBtn.onclick = () => {
      if (busy) {
        try {
          plugin.acp?.cancel?.();
        } catch {
          /* */
        }
      }
      close();
    };

    setupDrag(head, panelEl);

    const ctxLine = panelEl.createDiv({ cls: 'me-soul-cmdbar-context' });
    ctxLine.createSpan({ cls: 'me-soul-cmdbar-context-label', text: '上下文' });
    const ctxPath = ctxLine.createSpan({ cls: 'me-soul-cmdbar-context-path', text: '—' });
    panelEl._ctxPath = ctxPath;
    const ctxCursor = ctxLine.createSpan({ cls: 'me-soul-cmdbar-context-cursor', text: '' });
    panelEl._ctxCursor = ctxCursor;
    const ctxSel = ctxLine.createSpan({ cls: 'me-soul-cmdbar-context-sel', text: '' });
    panelEl._ctxSel = ctxSel;
    const refreshCtxBtn = ctxLine.createEl('button', {
      cls: 'me-soul-cmdbar-ctx-refresh',
      attr: {
        type: 'button',
        title: '从当前编辑器刷新光标/选区（也可在笔记里点一下）',
      },
      text: '刷新',
    });
    refreshCtxBtn.onclick = (ev) => {
      ev.preventDefault();
      refreshContextFromEditor({ notifyIfMoved: true });
    };

    // Multi-turn transcript (prior messages)
    transcriptEl = panelEl.createDiv({ cls: 'me-soul-cmdbar-transcript' });
    transcriptEl.style.display = 'none';
    transcriptEl.setAttr('aria-live', 'polite');

    // Thinking animation (shown while busy, before/without text)
    thinkingEl = panelEl.createDiv({ cls: 'me-soul-cmdbar-thinking' });
    thinkingEl.style.display = 'none';
    thinkingEl.setAttr('aria-live', 'polite');
    const thinkInner = thinkingEl.createDiv({ cls: 'me-soul-cmdbar-thinking-inner' });
    thinkInner.createSpan({ cls: 'me-soul-cmdbar-thinking-label', text: '思考中' });
    const dots = thinkInner.createDiv({ cls: 'me-soul-cmdbar-thinking-dots' });
    dots.createSpan({ cls: 'me-soul-cmdbar-dot-bounce' });
    dots.createSpan({ cls: 'me-soul-cmdbar-dot-bounce' });
    dots.createSpan({ cls: 'me-soul-cmdbar-dot-bounce' });
    const thinkTip = thinkingEl.createDiv({ cls: 'me-soul-cmdbar-thinking-tip' });
    thinkTip.setText('');
    panelEl._thinkTip = thinkTip;

    // Latest assistant reply (streaming + final)
    resultEl = panelEl.createDiv({ cls: 'me-soul-cmdbar-result' });
    resultEl.style.display = 'none';

    // Apply actions: insert / replace / copy
    actionsEl = panelEl.createDiv({ cls: 'me-soul-cmdbar-actions' });
    actionsEl.style.display = 'none';

    const btnInsert = actionsEl.createEl('button', {
      cls: 'me-soul-cmdbar-action',
      attr: { type: 'button' },
      text: '插入光标处',
    });
    btnInsert.onclick = () => {
      refreshContextFromEditor();
      manualApply('insert_at_cursor');
    };

    const btnReplace = actionsEl.createEl('button', {
      cls: 'me-soul-cmdbar-action',
      attr: { type: 'button' },
      text: '替换选区',
    });
    btnReplace.onclick = () => {
      refreshContextFromEditor();
      manualApply('replace_selection');
    };

    const btnCopy = actionsEl.createEl('button', {
      cls: 'me-soul-cmdbar-action',
      attr: { type: 'button' },
      text: '复制',
    });
    btnCopy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(lastFullText || '');
        notify('已复制');
      } catch {
        notify('复制失败');
      }
    };

    // Feedback row (after a reply)
    feedbackEl = panelEl.createDiv({ cls: 'me-soul-cmdbar-feedback' });
    feedbackEl.style.display = 'none';

    const fbUp = feedbackEl.createEl('button', {
      cls: 'me-soul-cmdbar-fb-btn',
      attr: { type: 'button', title: '有用（再点取消）', 'data-vote': 'up' },
      text: '👍',
    });
    const fbDown = feedbackEl.createEl('button', {
      cls: 'me-soul-cmdbar-fb-btn',
      attr: { type: 'button', title: '不佳（再点取消）', 'data-vote': 'down' },
      text: '👎',
    });
    const fbWrite = feedbackEl.createEl('button', {
      cls: 'me-soul-cmdbar-fb-btn me-soul-cmdbar-fb-write',
      attr: { type: 'button', title: '写具体反馈' },
      text: '反馈',
    });
    panelEl._fbUp = fbUp;
    panelEl._fbDown = fbDown;

    fbUp.onclick = () => void setCmdVote('up');
    fbDown.onclick = () => void setCmdVote('down');

    const fbCompose = panelEl.createDiv({ cls: 'me-soul-cmdbar-fb-compose' });
    fbCompose.style.display = 'none';
    fbCompose.createDiv({
      cls: 'me-soul-cmdbar-fb-hint',
      text: '写希望以后怎样。点赞本身不改人格；写反馈会记入日迹（深度反思请用全屏 Chat）。',
    });
    const fbTa = fbCompose.createEl('textarea', {
      cls: 'me-soul-cmdbar-fb-input',
      attr: {
        rows: '2',
        placeholder: '例如：更简洁；公式分步写…',
      },
    });
    const fbRow = fbCompose.createDiv({ cls: 'me-soul-cmdbar-fb-row' });
    const fbSend = fbRow.createEl('button', {
      cls: 'me-soul-cmdbar-fb-send',
      attr: { type: 'button' },
      text: '提交反馈',
    });
    const fbCancel = fbRow.createEl('button', {
      cls: 'me-soul-cmdbar-fb-cancel',
      attr: { type: 'button' },
      text: '收起',
    });
    panelEl._fbCompose = fbCompose;
    panelEl._fbTa = fbTa;

    fbWrite.onclick = () => {
      const open = fbCompose.style.display === 'none';
      fbCompose.style.display = open ? '' : 'none';
      if (open) requestAnimationFrame(() => fbTa.focus());
    };
    fbCancel.onclick = () => {
      fbCompose.style.display = 'none';
    };
    fbSend.onclick = async () => {
      const note = (fbTa.value || '').trim();
      if (!note) {
        notify('请先写一点具体反馈');
        return;
      }
      try {
        const emoji = lastVote === 'up' ? '👍' : lastVote === 'down' ? '👎' : '📝';
        if (!lastFbId) {
          lastFbId = makeFeedbackId();
          await appendFeedbackEntry(app, {
            id: lastFbId,
            vote: emoji,
            excerpt: lastFullText,
            note,
          });
        } else {
          await updateFeedbackVote(app, lastFbId, emoji, { note });
        }
        fbTa.value = '';
        fbCompose.style.display = 'none';
        notify('已记录反馈 → soul/feedback（深度反思请在全屏 Chat 点「反馈」）');
      } catch (e) {
        notify(e?.message || '反馈写入失败');
      }
    };

    // Composer at bottom — skills (/) + follow-ups
    const composer = panelEl.createDiv({ cls: 'me-soul-cmdbar-composer' });
    skillPillEl = composer.createDiv({ cls: 'me-soul-cmdbar-skill-slot' });
    skillLiveEl = composer.createDiv({ cls: 'me-soul-cmdbar-skill-live' });
    skillLiveEl.style.display = 'none';

    inputEl = composer.createEl('textarea', {
      cls: 'me-soul-cmdbar-input',
      attr: {
        rows: '2',
        placeholder: '改短一点 · 或输入 / 选用技能（如 /me-imagine）…',
        'aria-label': '指令',
      },
    });

    suggestEl = composer.createDiv({ cls: 'me-soul-suggest me-soul-cmdbar-suggest' });
    suggestEl.style.display = 'none';

    inputEl.addEventListener('input', () => {
      updateSkillSuggest();
      updateSkillLiveHint();
      syncComposerSkillClass();
    });

    inputEl.addEventListener('keydown', (ev) => {
      if (suggestKind && suggestItems.length) {
        if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          suggestIndex = (suggestIndex + 1) % suggestItems.length;
          paintSkillSuggest();
          return;
        }
        if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          suggestIndex =
            (suggestIndex - 1 + suggestItems.length) % suggestItems.length;
          paintSkillSuggest();
          return;
        }
        if (ev.key === 'Tab' || (ev.key === 'Enter' && !ev.shiftKey && suggestKind)) {
          // Enter with open suggest accepts skill; Shift+Enter still newline via fallthrough only when no suggest
          if (ev.key === 'Tab' || !ev.shiftKey) {
            ev.preventDefault();
            acceptSkillSuggest();
            return;
          }
        }
        if (ev.key === 'Escape') {
          ev.preventDefault();
          closeSkillSuggest();
          return;
        }
      }
      if (ev.key === 'Backspace' && !inputEl.value && activeSkill) {
        ev.preventDefault();
        activeSkill = null;
        renderSkillPill();
        syncComposerSkillClass();
        updateSkillLiveHint();
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        if (busy) {
          try {
            plugin.acp?.cancel?.();
          } catch {
            /* */
          }
        }
        close();
        return;
      }
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        if (!busy) void submit();
        else {
          try {
            plugin.acp?.cancel?.();
          } catch {
            /* */
          }
        }
      }
    });

    const row = panelEl.createDiv({ cls: 'me-soul-cmdbar-row' });
    sendBtn = row.createEl('button', {
      cls: 'me-soul-cmdbar-send',
      attr: { type: 'button' },
      text: '发送',
    });
    sendBtn.onclick = () => {
      if (busy) {
        try {
          plugin.acp?.cancel?.();
        } catch {
          /* */
        }
      } else {
        void submit();
      }
    };
    row.createSpan({
      cls: 'me-soul-cmdbar-hint',
      text: 'Enter 发送 · / 技能 · 可多轮 · Esc 关闭',
    });

    refreshModelSelect();
    placePanel();
    renderSkillPill();
  }

  function skillDesc(id) {
    const map = {
      'me-digest': '消化笔记 → 待审 wiki',
      'me-write-insight': '沉淀心迹草案',
      'me-reflect-feedback': '根据反馈反思记忆',
      'me-care-check': '检查牵挂',
      'me-soul-promote': '升格 Soul',
      'me-imagine': 'Grok Imagine 生图并插入笔记',
      memorized: '写入向量记忆库',
      'me-reindex': '（别名）同 memorized',
      'me-apply-pending': '合并已确认 pending',
      'me-apply-insight': '合并 insight',
    };
    return map[id] || '技能 · 全屏 Chat 运行';
  }

  function skillCatalog() {
    return (plugin.controller?.listSkills?.() || []).map((s) => ({
      ...s,
      desc: skillDesc(s.id),
    }));
  }

  function renderSkillPill() {
    if (!skillPillEl) return;
    skillPillEl.empty();
    skillPillEl.toggleClass('is-active', !!activeSkill);
    if (!activeSkill) {
      if (inputEl) {
        inputEl.setAttr(
          'placeholder',
          '改短一点 · 或输入 / 选用技能（如 /me-imagine）…'
        );
      }
      return;
    }
    const pill = skillPillEl.createDiv({ cls: 'me-soul-skill-active-pill' });
    pill.createSpan({ text: activeSkill.label });
    const meta = pill.createSpan({
      cls: 'me-soul-cmdbar-skill-pill-desc',
      text: skillDesc(activeSkill.id),
    });
    meta.setAttr('title', skillDesc(activeSkill.id));
    const x = pill.createSpan({ cls: 'me-soul-chip-x', text: '×' });
    x.onclick = () => {
      activeSkill = null;
      renderSkillPill();
      syncComposerSkillClass();
      updateSkillLiveHint();
      inputEl?.focus();
    };
    if (inputEl) {
      inputEl.setAttr(
        'placeholder',
        `为 ${activeSkill.label} 补充参数…（Enter 在全屏 Chat 运行）`
      );
    }
  }

  function syncComposerSkillClass() {
    if (!inputEl) return;
    const live = !activeSkill && !!parseSlashSkillCommand(inputEl.value || '');
    inputEl.toggleClass('is-skill-mode', !!(activeSkill || live));
  }

  function updateSkillLiveHint() {
    if (!skillLiveEl) return;
    if (activeSkill) {
      skillLiveEl.style.display = 'none';
      skillLiveEl.empty();
      return;
    }
    const parsed = parseSlashSkillCommand(inputEl?.value || '');
    if (!parsed) {
      // Partial "/me-ima…" — still show matching skill hint if unique-ish
      const v = String(inputEl?.value || '');
      if (v.startsWith('/') && !v.slice(1).includes(' ')) {
        const q = v.slice(1).toLowerCase();
        const hits = skillCatalog().filter(
          (s) => s.id.includes(q) || s.label.toLowerCase().includes(q)
        );
        if (hits.length === 1 && q) {
          skillLiveEl.style.display = '';
          skillLiveEl.empty();
          skillLiveEl.createSpan({
            cls: 'me-soul-cmdbar-skill-live-badge',
            text: `技能 ${hits[0].label}`,
          });
          skillLiveEl.createSpan({
            cls: 'me-soul-cmdbar-skill-live-desc',
            text: hits[0].desc || '',
          });
          return;
        }
      }
      skillLiveEl.style.display = 'none';
      skillLiveEl.empty();
      return;
    }
    skillLiveEl.style.display = '';
    skillLiveEl.empty();
    skillLiveEl.createSpan({
      cls: 'me-soul-cmdbar-skill-live-badge',
      text: `技能 /${parsed.skillId}`,
    });
    skillLiveEl.createSpan({
      cls: 'me-soul-cmdbar-skill-live-desc',
      text: skillDesc(parsed.skillId),
    });
  }

  function closeSkillSuggest() {
    suggestKind = null;
    suggestItems = [];
    if (suggestEl) {
      suggestEl.style.display = 'none';
      suggestEl.empty();
    }
  }

  function paintSkillSuggest() {
    if (!suggestEl) return;
    suggestEl.empty();
    suggestItems.forEach((it, i) => {
      const el = suggestEl.createDiv({ cls: 'me-soul-suggest-item' });
      el.toggleClass('is-selected', i === suggestIndex);
      el.createSpan({ cls: 'me-soul-suggest-name', text: it.label });
      if (it.desc) {
        el.createSpan({ cls: 'me-soul-suggest-path', text: it.desc });
      }
      el.onmousedown = (ev) => {
        ev.preventDefault();
        suggestIndex = i;
        acceptSkillSuggest();
      };
    });
  }

  function updateSkillSuggest() {
    if (activeSkill || !inputEl) {
      closeSkillSuggest();
      return;
    }
    const v = inputEl.value;
    if (!v.startsWith('/') || v.slice(1).includes(' ')) {
      closeSkillSuggest();
      return;
    }
    const q = v.slice(1).toLowerCase();
    const items = skillCatalog()
      .filter((s) => s.label.toLowerCase().includes(q) || (s.id || '').includes(q))
      .slice(0, 10);
    if (!items.length) {
      closeSkillSuggest();
      return;
    }
    suggestKind = 'skill';
    suggestItems = items;
    suggestIndex = 0;
    suggestEl.style.display = 'block';
    paintSkillSuggest();
  }

  function acceptSkillSuggest() {
    const it = suggestItems[suggestIndex];
    if (!it) return closeSkillSuggest();
    activeSkill = { id: it.id, label: it.label };
    if (inputEl) inputEl.value = '';
    closeSkillSuggest();
    renderSkillPill();
    syncComposerSkillClass();
    updateSkillLiveHint();
    inputEl?.focus();
  }

  function clearSkillUi() {
    activeSkill = null;
    closeSkillSuggest();
    if (skillLiveEl) {
      skillLiveEl.style.display = 'none';
      skillLiveEl.empty();
    }
    renderSkillPill();
    if (inputEl) {
      inputEl.setAttr(
        'placeholder',
        '改短一点 · 或输入 / 选用技能（如 /me-imagine）…'
      );
      inputEl.removeClass('is-skill-mode');
    }
  }

  function refreshModelSelect() {
    if (!modelSelect) return;
    const profiles = normalizeGrokProfiles(plugin.settings.grokProfiles);
    plugin.settings.grokProfiles = profiles;
    const active = plugin.settings.grokActiveProfile || profiles[0]?.id || 'supergrok';
    modelSelect.empty();
    for (const p of profiles) {
      const opt = modelSelect.createEl('option', {
        text: p.label || p.model || p.id,
        attr: { value: p.id },
      });
      if (p.id === active) opt.selected = true;
    }
    try {
      const rt = resolveGrokRuntime(plugin.settings);
      modelSelect.setAttr('title', `当前：${formatGrokRuntimeLabel(rt)}`);
    } catch {
      /* */
    }
    if (effortSelect) {
      const activeProfile = profiles.find((p) => p.id === active) || profiles[0];
      const current = normalizeReasoningEffort(activeProfile?.reasoningEffort);
      effortSelect.empty();
      for (const l of REASONING_EFFORT_LEVELS) {
        const opt = effortSelect.createEl('option', {
          text: l.value ? `思考:${l.value}` : '思考:默认',
          attr: { value: l.value },
        });
        if (l.value === current) opt.selected = true;
      }
    }
  }

  async function onEffortChange() {
    if (!effortSelect) return;
    if (busy) {
      notify('请等当前回复结束后再调整思考等级');
      refreshModelSelect();
      return;
    }
    try {
      await plugin.setGrokReasoningEffort(effortSelect.value);
      try {
        plugin.acp?.resetSession?.();
      } catch {
        /* */
      }
      refreshModelSelect();
      notify(`思考等级 → ${effortSelect.value || '默认'}（下一条生效）`);
    } catch (e) {
      notify(e?.message || String(e));
      refreshModelSelect();
    }
  }

  async function onModelChange() {
    if (!modelSelect) return;
    const id = modelSelect.value;
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
      try {
        plugin.acp?.resetSession?.();
      } catch {
        /* */
      }
      refreshModelSelect();
      notify(`已切换 → ${formatGrokRuntimeLabel(rt)}（下一条生效）`);
    } catch (e) {
      notify(e?.message || String(e));
      refreshModelSelect();
    }
  }

  function paintVoteBtns() {
    if (!panelEl) return;
    const up = panelEl._fbUp;
    const down = panelEl._fbDown;
    if (up) up.toggleClass('is-voted', lastVote === 'up');
    if (down) down.toggleClass('is-voted', lastVote === 'down');
  }

  /**
   * @param {'up' | 'down'} next
   */
  async function setCmdVote(next) {
    if (!lastFullText.trim()) {
      notify('还没有可评价的回复');
      return;
    }
    try {
      if (lastVote === next) {
        if (lastFbId) await updateFeedbackVote(app, lastFbId, null);
        lastVote = null;
        lastFbId = null;
        paintVoteBtns();
        notify('已取消评价');
        return;
      }
      const emoji = next === 'up' ? '👍' : '👎';
      if (!lastFbId) {
        lastFbId = makeFeedbackId();
        await appendFeedbackEntry(app, {
          id: lastFbId,
          vote: emoji,
          excerpt: lastFullText,
        });
      } else {
        await updateFeedbackVote(app, lastFbId, emoji);
      }
      lastVote = next;
      paintVoteBtns();
      notify(next === 'up' ? '已记录 👍' : '已记录 👎');
    } catch (e) {
      notify(e?.message || '反馈失败');
    }
  }

  /**
   * @param {boolean} b
   * @param {{ phase?: 'thinking' | 'streaming' | 'tool', tip?: string }} [opts]
   */
  function setBusy(b, opts = {}) {
    const prev = busy;
    busy = b;
    if (sendBtn) sendBtn.setText(b ? '停止' : '发送');
    if (inputEl) inputEl.toggleClass('is-busy', b);
    if (root) root.toggleClass('is-busy', b);
    if (modelSelect) modelSelect.disabled = !!b;
    if (effortSelect) effortSelect.disabled = !!b;
    if (sessionBtn) sessionBtn.disabled = !!b;
    if (b) closeSessionMenu();
    if (prev !== !!b) {
      try {
        busyListener?.(!!b);
      } catch {
        /* */
      }
    }

    if (!b) {
      hideThinking();
      if (statusEl) statusEl.setText('');
      return;
    }

    const phase = opts.phase || 'thinking';
    if (statusEl) {
      if (phase === 'tool') statusEl.setText(opts.tip || '调用工具…');
      else if (phase === 'streaming') statusEl.setText('生成中…');
      else statusEl.setText('思考中…');
    }
    if (phase === 'thinking' || (phase === 'streaming' && !lastFullText)) {
      showThinking(opts.tip || '');
    } else if (phase === 'streaming' && lastFullText) {
      hideThinking();
    } else if (phase === 'tool') {
      showThinking(opts.tip || '工具运行中…');
    }
  }

  function showThinking(tip) {
    if (!thinkingEl) return;
    thinkingEl.style.display = '';
    thinkingEl.addClass('is-active');
    if (panelEl) {
      const tipEl = panelEl._thinkTip;
      if (tipEl) {
        tipEl.setText(tip || '');
        tipEl.style.display = tip ? '' : 'none';
      }
    }
  }

  function hideThinking() {
    if (!thinkingEl) return;
    thinkingEl.style.display = 'none';
    thinkingEl.removeClass('is-active');
  }

  /**
   * Re-read active editor cursor / selection into lastCapture + chrome.
   * @param {{ notifyIfMoved?: boolean }} [opts]
   */
  function refreshContextFromEditor(opts = {}) {
    const view = getMarkdownView();
    const editor = view?.editor || lastEditor;
    const file = view?.file || app.workspace.getActiveFile?.();
    const path = file?.path || lastCapture?.path || null;
    let noteBody = '';
    try {
      noteBody = editor?.getValue?.() || '';
    } catch {
      /* */
    }
    const prev = lastCapture;
    lastEditor = editor || lastEditor;
    lastCapture = captureEditorContext(editor, { path, noteBody });
    paintContext(lastCapture);

    if (opts.notifyIfMoved && prev && lastCapture) {
      const moved =
        prev.cursor?.line !== lastCapture.cursor?.line ||
        prev.cursor?.ch !== lastCapture.cursor?.ch ||
        prev.hasSelection !== lastCapture.hasSelection ||
        prev.selection !== lastCapture.selection ||
        prev.path !== lastCapture.path;
      notify(
        moved
          ? `已刷新 · L${(lastCapture.cursor?.line ?? 0) + 1}:${(lastCapture.cursor?.ch ?? 0) + 1}`
          : `光标未变 · L${(lastCapture.cursor?.line ?? 0) + 1}:${(lastCapture.cursor?.ch ?? 0) + 1}`
      );
    }
  }

  /**
   * Update context chrome only when text actually changes.
   * Any unnecessary DOM write clears window.getSelection() and blocks copy.
   * @param {HTMLElement | null | undefined} el
   * @param {string} next
   */
  function setTextIfChanged(el, next) {
    if (!el) return;
    const s = String(next ?? '');
    if (el.textContent === s) return;
    el.setText(s);
  }

  function paintContext(capture) {
    if (!panelEl) return;
    const pathEl = panelEl._ctxPath;
    const cursorEl = panelEl._ctxCursor;
    const selEl = panelEl._ctxSel;
    setTextIfChanged(pathEl, capture?.path || '（无活动笔记）');
    if (cursorEl) {
      if (capture?.path || capture?.cursor) {
        const line = (capture?.cursor?.line ?? 0) + 1;
        const ch = (capture?.cursor?.ch ?? 0) + 1;
        setTextIfChanged(cursorEl, ` · 光标 L${line}:${ch}`);
        cursorEl.style.display = '';
      } else {
        setTextIfChanged(cursorEl, '');
        cursorEl.style.display = 'none';
      }
    }
    if (selEl) {
      if (capture?.hasSelection) {
        const n = capture.selection.length;
        const preview =
          capture.selection.length > 48
            ? capture.selection.slice(0, 48) + '…'
            : capture.selection;
        setTextIfChanged(
          selEl,
          ` · 选区 ${n} 字：「${preview.replace(/\s+/g, ' ')}」`
        );
        selEl.style.display = '';
      } else {
        setTextIfChanged(selEl, '');
        selEl.style.display = 'none';
      }
    }
  }

  /**
   * Rebuild transcript. Latest assistant reply (if any) stays in resultEl
   * with apply/feedback chrome — prior turns only appear here.
   */
  async function paintTranscript() {
    if (!transcriptEl) return;
    const token = ++transcriptRenderToken;
    transcriptEl.empty();
    let list = turns;
    // Keep newest assistant message out of the scroll log when result pane shows it
    if (list.length && list[list.length - 1].role === 'assistant') {
      list = list.slice(0, -1);
    }
    if (!list.length) {
      transcriptEl.style.display = 'none';
      return;
    }
    transcriptEl.style.display = '';
    for (const turn of list) {
      if (token !== transcriptRenderToken) return;
      const bubble = transcriptEl.createDiv({
        cls:
          'me-soul-cmdbar-msg' +
          (turn.role === 'user' ? ' is-user' : ' is-assistant'),
      });
      bubble.createDiv({
        cls: 'me-soul-cmdbar-msg-role',
        text: turn.role === 'user' ? '你' : plugin.settings.agentName || 'Agent',
      });
      const textEl = bubble.createDiv({ cls: 'me-soul-cmdbar-msg-text' });
      if (turn.role === 'assistant' && MarkdownRenderer) {
        await renderMarkdownInto(textEl, turn.text || '');
      } else {
        textEl.setText(turn.text || '');
      }
    }
    requestAnimationFrame(() => {
      if (transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight;
    });
  }

  /**
   * @param {HTMLElement} el
   * @param {string} markdown
   */
  async function renderMarkdownInto(el, markdown) {
    if (!MarkdownRenderer) {
      el.setText(markdown || '');
      return;
    }
    el.removeClass('is-streaming');
    try {
      await renderMarkdownWithMath({
        app,
        MarkdownRenderer,
        component: plugin,
        el,
        markdown: markdown || '',
        sourcePath:
          app.workspace.getActiveFile?.()?.path || 'agent-inbox/sessions/current.md',
        loadMathJax,
        finishRenderMath,
        renderMath,
        copyText: async (text) => {
          try {
            await navigator.clipboard.writeText(text || '');
            return true;
          } catch {
            return false;
          }
        },
        onCopied: () => notify('已复制 LaTeX'),
      });
    } catch {
      el.setText(markdown || '');
    }
  }

  async function showResult(text, { streaming = false } = {}) {
    if (!resultEl) return;
    const token = ++resultRenderToken;
    const has = !!(text && String(text).trim()) || streaming;
    resultEl.style.display = has ? '' : 'none';
    resultEl.empty();
    if (!has) return;

    resultEl.createDiv({
      cls: 'me-soul-cmdbar-msg-role',
      text: streaming
        ? `${plugin.settings.agentName || 'Agent'} · 回复中`
        : `${plugin.settings.agentName || 'Agent'} · 最新回复`,
    });
    const body = resultEl.createDiv({
      cls: 'me-soul-cmdbar-result-text' + (streaming ? ' is-streaming' : ''),
    });
    body.setAttr('tabindex', '0');
    body.setAttr('role', 'textbox');
    body.setAttr('aria-readonly', 'true');
    body.setAttr('aria-label', 'Agent 回复（可选中复制）');

    if (streaming) {
      body.setText(text || '');
    } else {
      await renderMarkdownInto(body, text || '');
      if (token !== resultRenderToken) return;
    }
    if (streaming && text) hideThinking();
  }

  /**
   * Append one turn into shared vault session (fullscreen + cmdbar).
   * @param {'user' | 'assistant'} role
   * @param {string} text
   */
  async function persistSharedMessage(role, text) {
    const body = String(text || '');
    if (!body.trim()) return;
    try {
      let session = await loadSessionFromVault(app);
      session = appendMessage(session, {
        role: role === 'user' ? 'user' : 'agent',
        text: body,
      });
      await saveSessionToVault(app, session);
    } catch (e) {
      console.warn('cmdbar session persist failed', e);
    }
  }

  async function hydrateFromVault() {
    try {
      const session = await loadSessionFromVault(app);
      turns = sessionToCmdbarTurns(session);
    } catch (e) {
      console.warn('cmdbar hydrate failed', e);
      turns = [];
    }
    lastFullText = '';
    lastUserPrompt = '';
    lastMode = 'show_only';
    lastFbId = null;
    lastVote = null;
    showFallbackActions(false);
    showFeedbackRow(false);

    const last = turns.length ? turns[turns.length - 1] : null;
    if (last?.role === 'assistant') {
      lastFullText = last.text || '';
      await paintTranscript();
      await showResult(last.text || '');
      showFallbackActions(!!String(last.text || '').trim());
    } else {
      await paintTranscript();
      await showResult('');
    }
  }

  /**
   * Flush in-memory turns to shared current.json before rotate / restore.
   */
  async function flushTurnsToVault() {
    if (!turns.length) return;
    try {
      const existing = await loadSessionFromVault(app);
      let session = createEmptySession();
      session.id = existing.id || session.id;
      for (const t of turns) {
        session = appendMessage(session, {
          role: t.role === 'user' ? 'user' : 'agent',
          text: t.text,
        });
      }
      await saveSessionToVault(app, session);
    } catch (e) {
      console.warn('cmdbar flush turns failed', e);
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

  function closeSessionMenu() {
    if (sessionMenu) {
      sessionMenu.removeClass('is-open');
      sessionMenu.setAttr('aria-hidden', 'true');
    }
    if (sessionBtn) sessionBtn.setAttr('aria-expanded', 'false');
    if (removeSessionMenuOutside) {
      removeSessionMenuOutside();
      removeSessionMenuOutside = null;
    }
  }

  async function paintSessionMenu() {
    if (!sessionMenu) return;
    sessionMenu.empty();

    const newItem = sessionMenu.createEl('button', {
      cls: 'me-soul-cmdbar-session-item is-action',
      attr: { type: 'button', role: 'menuitem' },
      text: '＋ 新会话',
    });
    newItem.onclick = () => {
      void startNewSession();
    };

    sessionMenu.createDiv({ cls: 'me-soul-cmdbar-session-sep' });

    /** @type {Array<{ path: string, id: string, updatedAt: string, messageCount: number, title: string, isCurrent?: boolean }>} */
    const rows = [];
    try {
      const cur = await loadSessionFromVault(app);
      const sum = summarizeSession(cur, SESSION_PATH);
      rows.push({ ...sum, isCurrent: true });
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
      sessionMenu.createDiv({
        cls: 'me-soul-cmdbar-session-empty',
        text: '暂无历史会话',
      });
      return;
    }

    for (const row of rows) {
      const item = sessionMenu.createEl('button', {
        cls:
          'me-soul-cmdbar-session-item' + (row.isCurrent ? ' is-current' : ''),
        attr: {
          type: 'button',
          role: 'menuitem',
          title: row.isCurrent ? '当前会话' : `加载：${row.title}`,
        },
      });
      if (row.isCurrent) item.setAttr('disabled', 'true');
      const title = item.createDiv({ cls: 'me-soul-cmdbar-session-item-title' });
      title.setText(row.isCurrent ? `当前 · ${row.title}` : row.title);
      item.createDiv({
        cls: 'me-soul-cmdbar-session-item-meta',
        text: `${row.messageCount} 条 · ${formatHistTime(row.updatedAt)}`,
      });
      if (!row.isCurrent) {
        item.onclick = () => {
          void loadSessionFromArchive(row.path);
        };
      }
    }
  }

  async function toggleSessionMenu() {
    if (!sessionMenu || !sessionBtn) return;
    const open = !sessionMenu.hasClass('is-open');
    if (!open) {
      closeSessionMenu();
      return;
    }
    await paintSessionMenu();
    sessionMenu.addClass('is-open');
    sessionMenu.setAttr('aria-hidden', 'false');
    sessionBtn.setAttr('aria-expanded', 'true');

    if (removeSessionMenuOutside) removeSessionMenuOutside();
    const onDoc = (ev) => {
      const t = /** @type {Node} */ (ev.target);
      if (sessionWrap && sessionWrap.contains(t)) return;
      closeSessionMenu();
    };
    // next tick so this click doesn't immediately close
    requestAnimationFrame(() => {
      document.addEventListener('pointerdown', onDoc, true);
      removeSessionMenuOutside = () =>
        document.removeEventListener('pointerdown', onDoc, true);
    });
  }

  async function startNewSession() {
    if (busy) {
      notify('生成中，稍后再开新会话');
      return;
    }
    closeSessionMenu();
    try {
      await flushTurnsToVault();
      plugin.acp?.resetSession?.();
      const cur = await loadSessionFromVault(app);
      await rotateSession(app, cur);
      await hydrateFromVault();
      notify('新会话已开启（上一会话已归档）');
    } catch (e) {
      notify(e?.message || '无法开启新会话');
    }
  }

  async function loadSessionFromArchive(archivePath) {
    if (busy) {
      notify('生成中，稍后再加载');
      return;
    }
    closeSessionMenu();
    try {
      await flushTurnsToVault();
      plugin.acp?.resetSession?.();
      await restoreArchivedSession(app, archivePath);
      await hydrateFromVault();
      notify('已加载历史会话');
    } catch (e) {
      notify(e?.message || '加载失败');
    }
  }

  async function openFullscreenChat() {
    // Do not cancel an in-flight turn — wait for it to finish, then open.
    if (busy) {
      notify('回复生成中，完成后会打开全屏…');
      const token = { aborted: false };
      await new Promise((resolve) => {
        pendingFullscreenOpen = { resolve, token };
      });
      if (token.aborted) return;
    }

    try {
      await flushTurnsToVault();
    } catch (e) {
      console.warn('flush before fullscreen failed', e);
    }
    close({ reason: 'fullscreen', cancelIfBusy: false });
    try {
      await plugin.activateView?.();
    } catch (e) {
      notify(e?.message || '无法打开全屏对话');
    }
  }

  function showFallbackActions(show) {
    if (!actionsEl) return;
    actionsEl.style.display = show ? '' : 'none';
  }

  function showFeedbackRow(show) {
    if (!feedbackEl) return;
    feedbackEl.style.display = show ? '' : 'none';
    if (!show && panelEl) {
      if (panelEl._fbCompose) panelEl._fbCompose.style.display = 'none';
    }
    paintVoteBtns();
  }

  function manualApply(mode) {
    if (!lastEditor || !lastFullText) {
      notify('没有可应用的结果');
      return;
    }
    // Re-read cursor right before apply so insert hits where the user last clicked
    refreshContextFromEditor();
    const editor = lastEditor;
    if (!editor) {
      notify('无活动编辑器');
      return;
    }
    const r = applyToEditor(editor, mode, lastFullText);
    if (r.applied) {
      notify(
        mode === 'replace_selection'
          ? '已替换选区'
          : `已插入 L${(lastCapture?.cursor?.line ?? 0) + 1}:${(lastCapture?.cursor?.ch ?? 0) + 1}`
      );
    } else {
      notify('未能应用（可能无选区）');
    }
  }

  /**
   * True when the event (or current selection) is inside the floating panel.
   * Must skip context refresh then — DOM writes clear the copy selection.
   * @param {Event | null} [ev]
   */
  function isInteractionInsidePanel(ev) {
    if (panelEl && ev?.target instanceof Node && panelEl.contains(ev.target)) {
      return true;
    }
    try {
      const sel = window.getSelection?.();
      if (sel && sel.rangeCount > 0 && panelEl) {
        const node = sel.anchorNode;
        if (node && panelEl.contains(node)) return true;
      }
    } catch {
      /* */
    }
    return false;
  }

  function attachContextListeners() {
    detachContextListeners();

    const onEditorActivity = (ev) => {
      if (!isOpen()) return;
      // Selecting / copying reply text lives in the panel — do not touch DOM
      if (isInteractionInsidePanel(ev)) return;
      refreshContextFromEditor();
    };

    // Clicks / selection in the note should update the chip without closing the bar
    document.addEventListener('mouseup', onEditorActivity, true);
    document.addEventListener('keyup', onEditorActivity, true);

    const leafRef = app.workspace.on?.('active-leaf-change', () => {
      if (!isOpen()) return;
      if (isInteractionInsidePanel(null)) return;
      refreshContextFromEditor();
    });

    // Light poll: CM selection changes don't always bubble as DOM events
    contextPoll = setInterval(() => {
      if (!isOpen() || busy) return;
      // Don't mutate chrome while user is selecting text in the panel
      if (isInteractionInsidePanel(null)) return;
      try {
        const view = getMarkdownView();
        const ed = view?.editor;
        if (!ed) return;
        const c = ed.getCursor?.('from') || ed.getCursor?.();
        const sel = String(ed.getSelection?.() || '');
        if (!lastCapture) {
          refreshContextFromEditor();
          return;
        }
        if (
          c &&
          (c.line !== lastCapture.cursor?.line ||
            c.ch !== lastCapture.cursor?.ch ||
            sel !== lastCapture.selection)
        ) {
          refreshContextFromEditor();
        }
      } catch {
        /* */
      }
    }, 400);

    removeContextListeners = () => {
      document.removeEventListener('mouseup', onEditorActivity, true);
      document.removeEventListener('keyup', onEditorActivity, true);
      if (leafRef) {
        try {
          app.workspace.offref?.(leafRef);
        } catch {
          /* */
        }
      }
      if (contextPoll) {
        clearInterval(contextPoll);
        contextPoll = null;
      }
    };
  }

  function detachContextListeners() {
    if (removeContextListeners) {
      removeContextListeners();
      removeContextListeners = null;
    }
    if (contextPoll) {
      clearInterval(contextPoll);
      contextPoll = null;
    }
  }

  /**
   * @param {{
   *   seedText?: string,
   *   forceOpen?: boolean,
   *   keepHistory?: boolean,
   *   autoSubmit?: boolean,
   * }} [opts]
   */
  function open(opts = {}) {
    if (!isEnabled() && !opts.forceOpen) {
      notify('命令条已在设置中关闭');
      return;
    }
    ensureDom();
    if (!root || !panelEl) return;

    const wasOpen = isOpen();
    const keep = !!(wasOpen && opts.keepHistory);

    refreshContextFromEditor();
    placePanel();

    root.addClass('is-open');
    root.setAttr('aria-hidden', 'false');
    hideThinking();
    if (!opts.autoSubmit) setBusy(false);
    refreshModelSelect();

    const title = root.querySelector('.me-soul-cmdbar-title');
    if (title) title.setText(plugin.settings.agentName || 'Agent');

    if (removeKeyHandler) removeKeyHandler();
    const onKey = (ev) => {
      if (ev.key === 'Escape' && root?.hasClass('is-open')) {
        // Don't steal Esc from editor when focus is in note (panel is non-modal)
        const ae = document.activeElement;
        const inPanel = !!(panelEl && ae && panelEl.contains(ae));
        if (!inPanel && ae !== inputEl) return;
        if (document.activeElement === inputEl || inPanel) {
          ev.preventDefault();
          close();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    removeKeyHandler = () => document.removeEventListener('keydown', onKey, true);

    attachContextListeners();

    void (async () => {
      if (!keep) {
        await hydrateFromVault();
      }
      if (inputEl) {
        if (opts.seedText != null) inputEl.value = opts.seedText;
        if (opts.autoSubmit && String(opts.seedText || '').trim()) {
          void submit();
          return;
        }
        requestAnimationFrame(() => {
          inputEl?.focus();
          if (opts.seedText != null && !opts.autoSubmit) inputEl?.select?.();
        });
      }
    })();
  }

  function close(opts = {}) {
    const reason = opts.reason || 'close';
    const cancelIfBusy = opts.cancelIfBusy !== false;

    // User dismissed the bar (not fullscreen handoff) while waiting to open fullscreen
    if (pendingFullscreenOpen && reason !== 'fullscreen') {
      pendingFullscreenOpen.token.aborted = true;
      const r = pendingFullscreenOpen.resolve;
      pendingFullscreenOpen = null;
      r();
    }

    if (busy && cancelIfBusy) {
      try {
        plugin.acp?.cancel?.();
      } catch {
        /* */
      }
      setBusy(false);
    } else if (busy && !cancelIfBusy) {
      // Keep request alive; only hide UI
      setBusy(false);
    }
    closeSessionMenu();
    if (root) {
      root.removeClass('is-open');
      root.setAttr('aria-hidden', 'true');
    }
    if (removeKeyHandler) {
      removeKeyHandler();
      removeKeyHandler = null;
    }
    detachContextListeners();
    // Clear multi-turn session on close
    turns = [];
    clearSkillUi();
    try {
      const view = getMarkdownView();
      view?.editor?.focus?.();
    } catch {
      /* */
    }
  }

  function isOpen() {
    return !!root?.hasClass('is-open');
  }

  function toggle() {
    if (isOpen()) close();
    else open();
  }

  async function submit() {
    if (busy) return;
    const text = (inputEl?.value || '').trim();
    if (!text) return;
    lastUserPrompt = text;

    // Snapshot prior turns for prompt *before* pushing this user message
    const historyForPrompt = turns.slice();

    // Capture editor context at send time (user may have moved cursor while bar open)
    refreshContextFromEditor();
    lastMode = 'show_only';
    lastFbId = null;
    lastVote = null;
    showFeedbackRow(false);

    const skillCmd = activeSkill
      ? { skillId: activeSkill.id, rest: text }
      : parseSlashSkillCommand(text);
    if (skillCmd) {
      plugin.queueChatLaunch?.({
        skillId: skillCmd.skillId,
        text: skillCmd.rest,
        autoSend: true,
      });
      if (inputEl) inputEl.value = '';
      clearSkillUi();
      notify(`正在全屏 Chat 运行 /${skillCmd.skillId}…`);
      close({ reason: 'fullscreen', cancelIfBusy: false });
      try {
        await plugin.activateView?.();
      } catch (e) {
        notify(e?.message || '无法打开全屏对话');
      }
      return;
    }

    if (plugin.settings.engine === 'openclaw') {
      notify('命令条目前需要 Grok Build 引擎（设置里切换）');
      return;
    }

    let client;
    try {
      client = plugin.getAcp();
    } catch (e) {
      notify(e?.message || '无法启动内核');
      return;
    }

    // Commit user turn to transcript + clear input so follow-ups are natural
    turns.push({ role: 'user', text });
    void paintTranscript();
    void persistSharedMessage('user', text);
    if (inputEl) {
      inputEl.value = '';
    }

    const promptText = buildCommandBarPrompt({
      userText: text,
      capture: lastCapture || captureEditorContext(null, {}),
      injectSoul: !!plugin.settings.commandBarInjectSoul,
      soulBlock: '',
      history: historyForPrompt,
    });

    setBusy(true, { phase: 'thinking' });
    lastFullText = '';
    let thoughtBuf = '';
    let sawTool = false;
    showResult('', { streaming: true });
    showFallbackActions(false);

    const onPermission = async (req) => {
      const options = req?.options || [];
      const toolCall = req?.toolCall || {};
      const kind = String(toolCall.kind || '').toLowerCase();
      const allow =
        options.find((o) => (o.kind || '') === 'allow_once') ||
        options.find((o) => /allow|approve|yes/i.test(o.name || ''));
      const reject =
        options.find((o) => /reject|deny/i.test(o.kind || '')) ||
        options.find((o) => /reject|deny/i.test(o.name || ''));
      if (['read', 'search', 'fetch', 'think'].includes(kind) && allow) {
        return allow.optionId;
      }
      if (reject) return reject.optionId;
      if (allow) return allow.optionId;
      return options[0]?.optionId;
    };

    const result = await runAgentTurn({
      acp: client,
      promptText,
      ephemeral: true,
      handlers: {
        onText: (t) => {
          lastFullText += t;
          const preview = stripApplyHeaderForPreview(lastFullText) || '…';
          showResult(preview, { streaming: true });
          setBusy(true, { phase: 'streaming' });
        },
        onThought: (t) => {
          thoughtBuf += t || '';
          if (!lastFullText) {
            const tip = thoughtBuf.replace(/\s+/g, ' ').trim().slice(-64);
            setBusy(true, {
              phase: 'thinking',
              tip: tip || '',
            });
          }
        },
        onToolCall: (u) => {
          sawTool = true;
          const title =
            u?.title || u?.toolCall?.title || u?.kind || u?.toolCall?.kind || '工具';
          setBusy(true, {
            phase: 'tool',
            tip: String(title).slice(0, 48),
          });
        },
        onToolUpdate: (u) => {
          sawTool = true;
          const st = u?.status || u?.toolCall?.status || '';
          if (st) {
            setBusy(true, { phase: 'tool', tip: String(st).slice(0, 40) });
          }
        },
        onPermission,
      },
    });

    setBusy(false);

    // After reply, refocus input for multi-turn
    requestAnimationFrame(() => {
      try {
        inputEl?.focus();
      } catch {
        /* */
      }
    });

    try {
      if (!result.ok) {
        const errText = result.error || '失败';
        lastFullText = errText;
        turns.push({ role: 'assistant', text: errText });
        await persistSharedMessage('assistant', errText);
        void paintTranscript();
        void showResult(errText);
        showFallbackActions(false);
        showFeedbackRow(false);
        return;
      }

      if (result.stopReason === 'cancelled') {
        const base =
          stripApplyHeaderForPreview(lastFullText) || lastFullText || '';
        const cancelledBody = String(base).trim()
          ? `${base}\n（已停止）`
          : '（已停止）';
        lastFullText = cancelledBody;
        turns.push({ role: 'assistant', text: cancelledBody });
        await persistSharedMessage('assistant', cancelledBody);
        void paintTranscript();
        void showResult(cancelledBody);
        showFallbackActions(!!String(base).trim());
        showFeedbackRow(!!String(base).trim());
        return;
      }

      lastFullText = result.text || lastFullText;
      const parsed = parseApplyResponse(lastFullText, {
        hasSelection: !!lastCapture?.hasSelection,
      });
      lastMode = parsed.mode;
      const body = parsed.body;

      if (!String(body).trim()) {
        const hint = [
          '（模型没有返回正文）',
          sawTool
            ? '刚才走了工具调用，可能被卡住。请重试，或切换模型。'
            : '可能只输出了内部思考。请重试或换一句指令。',
          thoughtBuf.trim()
            ? `\n思考片段：${thoughtBuf.replace(/\s+/g, ' ').trim().slice(0, 200)}`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
        lastFullText = hint;
        turns.push({ role: 'assistant', text: hint });
        await persistSharedMessage('assistant', hint);
        void paintTranscript();
        void showResult(hint);
        showFallbackActions(false);
        showFeedbackRow(false);
        notify('没有收到正文');
        return;
      }

      lastFullText = body;
      turns.push({ role: 'assistant', text: body });
      await persistSharedMessage('assistant', body);
      void paintTranscript();
      void showResult(body);
      showFeedbackRow(true);
      // Never auto-write into the note — user must click 插入/替换
      showFallbackActions(true);
    } finally {
      if (pendingFullscreenOpen) {
        const r = pendingFullscreenOpen.resolve;
        pendingFullscreenOpen = null;
        r();
      }
    }
  }

  function destroy() {
    close();
    if (removeDragHandlers) {
      removeDragHandlers();
      removeDragHandlers = null;
    }
    if (root) {
      root.remove();
      root = null;
    }
    panelEl = null;
    inputEl = null;
    skillPillEl = null;
    suggestEl = null;
    skillLiveEl = null;
    activeSkill = null;
    transcriptEl = null;
    resultEl = null;
    thinkingEl = null;
    actionsEl = null;
    feedbackEl = null;
    statusEl = null;
    sendBtn = null;
    modelSelect = null;
    effortSelect = null;
    sessionWrap = null;
    sessionBtn = null;
    sessionMenu = null;
  }

  /**
   * @param {((busy: boolean) => void) | null} fn
   */
  function onBusyChange(fn) {
    busyListener = typeof fn === 'function' ? fn : null;
  }

  return {
    open,
    close,
    toggle,
    isOpen,
    isBusy: () => busy,
    onBusyChange,
    destroy,
    submit,
  };
}
