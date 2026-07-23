/**
 * Cursor-style floating command bar for Obsidian Agent OS.
 * Summon with hotkey → NL intent → stream → apply to editor (or show only).
 * Includes model switcher, feedback, and thinking animation.
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
  formatGrokRuntimeLabel,
  normalizeGrokProfiles,
  resolveGrokRuntime,
} from './grok-runtime.js';
import {
  makeFeedbackId,
  appendFeedbackEntry,
  updateFeedbackVote,
} from './feedback-store.js';

/**
 * @param {import('obsidian').App} app
 * @param {any} plugin MeSoulPlugin
 * @param {{ Notice: any }} deps
 */
export function createCommandBarController(app, plugin, deps) {
  const { Notice } = deps;

  /** @type {HTMLElement | null} */
  let root = null;
  /** @type {HTMLTextAreaElement | null} */
  let inputEl = null;
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

  let busy = false;
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
  /** @type {(() => void) | null} */
  let removeKeyHandler = null;
  /** @type {(() => void) | null} */
  let removePointerHandler = null;

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

  function ensureDom() {
    if (root) return;
    root = document.body.createDiv({ cls: 'me-soul-cmdbar-root' });
    root.setAttr('aria-hidden', 'true');

    const backdrop = root.createDiv({ cls: 'me-soul-cmdbar-backdrop' });
    backdrop.onclick = () => {
      if (!busy) close();
    };

    const panel = root.createDiv({ cls: 'me-soul-cmdbar-panel' });
    panel.setAttr('role', 'dialog');
    panel.setAttr('aria-label', 'Agent 命令条');

    const head = panel.createDiv({ cls: 'me-soul-cmdbar-head' });
    const brand = head.createDiv({ cls: 'me-soul-cmdbar-brand' });
    brand.createSpan({ cls: 'me-soul-cmdbar-dot', attr: { 'aria-hidden': 'true' } });
    brand.createSpan({ cls: 'me-soul-cmdbar-title', text: plugin.settings.agentName || 'Agent' });

    modelSelect = head.createEl('select', {
      cls: 'me-soul-cmdbar-model',
      attr: {
        'aria-label': '切换模型',
        title: '切换 Grok Build 模型 / 第三方 API',
      },
    });
    modelSelect.onchange = () => onModelChange();

    statusEl = head.createSpan({ cls: 'me-soul-cmdbar-status', text: '' });

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

    const ctxLine = panel.createDiv({ cls: 'me-soul-cmdbar-context' });
    ctxLine.createSpan({ cls: 'me-soul-cmdbar-context-label', text: '上下文' });
    const ctxPath = ctxLine.createSpan({ cls: 'me-soul-cmdbar-context-path', text: '—' });
    panel._ctxPath = ctxPath;
    const ctxSel = ctxLine.createSpan({ cls: 'me-soul-cmdbar-context-sel', text: '' });
    panel._ctxSel = ctxSel;

    inputEl = panel.createEl('textarea', {
      cls: 'me-soul-cmdbar-input',
      attr: {
        rows: '2',
        placeholder: '改短一点 · 续写两句 · 这段在说什么…',
        'aria-label': '指令',
      },
    });

    inputEl.addEventListener('keydown', (ev) => {
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

    const row = panel.createDiv({ cls: 'me-soul-cmdbar-row' });
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
      text: 'Enter 发送 · Shift+Enter 换行 · Esc 关闭',
    });

    // Thinking animation (shown while busy, before/without text)
    thinkingEl = panel.createDiv({ cls: 'me-soul-cmdbar-thinking' });
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
    panel._thinkTip = thinkTip;

    resultEl = panel.createDiv({ cls: 'me-soul-cmdbar-result' });
    resultEl.style.display = 'none';

    // Apply actions: insert / replace / copy
    actionsEl = panel.createDiv({ cls: 'me-soul-cmdbar-actions' });
    actionsEl.style.display = 'none';

    const btnInsert = actionsEl.createEl('button', {
      cls: 'me-soul-cmdbar-action',
      attr: { type: 'button' },
      text: '插入光标处',
    });
    btnInsert.onclick = () => manualApply('insert_at_cursor');

    const btnReplace = actionsEl.createEl('button', {
      cls: 'me-soul-cmdbar-action',
      attr: { type: 'button' },
      text: '替换选区',
    });
    btnReplace.onclick = () => manualApply('replace_selection');

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
    feedbackEl = panel.createDiv({ cls: 'me-soul-cmdbar-feedback' });
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
    panel._fbUp = fbUp;
    panel._fbDown = fbDown;

    fbUp.onclick = () => void setCmdVote('up');
    fbDown.onclick = () => void setCmdVote('down');

    const fbCompose = panel.createDiv({ cls: 'me-soul-cmdbar-fb-compose' });
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
    panel._fbCompose = fbCompose;
    panel._fbTa = fbTa;

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

    refreshModelSelect();
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
    if (!root) return;
    const panel = root.querySelector('.me-soul-cmdbar-panel');
    const up = panel?._fbUp;
    const down = panel?._fbDown;
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
    busy = b;
    if (sendBtn) sendBtn.setText(b ? '停止' : '发送');
    if (inputEl) inputEl.toggleClass('is-busy', b);
    if (root) root.toggleClass('is-busy', b);
    if (modelSelect) modelSelect.disabled = !!b;

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
    if (root) {
      const panel = root.querySelector('.me-soul-cmdbar-panel');
      const tipEl = panel?._thinkTip;
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

  function paintContext(capture) {
    if (!root) return;
    const panel = root.querySelector('.me-soul-cmdbar-panel');
    if (!panel) return;
    const pathEl = panel._ctxPath;
    const selEl = panel._ctxSel;
    if (pathEl) {
      pathEl.setText(capture?.path || '（无活动笔记）');
    }
    if (selEl) {
      if (capture?.hasSelection) {
        const n = capture.selection.length;
        const preview =
          capture.selection.length > 48
            ? capture.selection.slice(0, 48) + '…'
            : capture.selection;
        selEl.setText(` · 选区 ${n} 字：「${preview.replace(/\s+/g, ' ')}」`);
        selEl.style.display = '';
      } else {
        selEl.setText('');
        selEl.style.display = 'none';
      }
    }
  }

  function showResult(text, { streaming = false } = {}) {
    if (!resultEl) return;
    const has = !!(text && String(text).trim()) || streaming;
    resultEl.style.display = has ? '' : 'none';
    resultEl.empty();
    resultEl.createDiv({
      cls: 'me-soul-cmdbar-result-text' + (streaming ? ' is-streaming' : ''),
      text: text || (streaming ? '' : ''),
    });
    if (streaming && text) hideThinking();
  }

  function showFallbackActions(show) {
    if (!actionsEl) return;
    actionsEl.style.display = show ? '' : 'none';
  }

  function showFeedbackRow(show) {
    if (!feedbackEl) return;
    feedbackEl.style.display = show ? '' : 'none';
    if (!show && root) {
      const panel = root.querySelector('.me-soul-cmdbar-panel');
      if (panel?._fbCompose) panel._fbCompose.style.display = 'none';
    }
    paintVoteBtns();
  }

  function manualApply(mode) {
    if (!lastEditor || !lastFullText) {
      notify('没有可应用的结果');
      return;
    }
    const r = applyToEditor(lastEditor, mode, lastFullText);
    if (r.applied) {
      notify(mode === 'replace_selection' ? '已替换选区' : '已插入');
      // keep open so user can still feedback
    } else {
      notify('未能应用（可能无选区）');
    }
  }

  /**
   * @param {{ seedText?: string, forceOpen?: boolean }} [opts]
   */
  function open(opts = {}) {
    if (!isEnabled() && !opts.forceOpen) {
      notify('命令条已在设置中关闭');
      return;
    }
    ensureDom();
    if (!root) return;

    const view = getMarkdownView();
    const editor = view?.editor || null;
    const file = view?.file || app.workspace.getActiveFile?.();
    const path = file?.path || null;
    let noteBody = '';
    try {
      noteBody = editor?.getValue?.() || '';
    } catch {
      /* */
    }

    lastEditor = editor;
    lastCapture = captureEditorContext(editor, {
      path,
      noteBody,
    });
    lastFullText = '';
    lastUserPrompt = '';
    lastMode = 'show_only';
    lastFbId = null;
    lastVote = null;

    root.addClass('is-open');
    root.setAttr('aria-hidden', 'false');
    paintContext(lastCapture);
    showResult('');
    showFallbackActions(false);
    showFeedbackRow(false);
    hideThinking();
    setBusy(false);
    refreshModelSelect();

    // update title with agent name
    const title = root.querySelector('.me-soul-cmdbar-title');
    if (title) title.setText(plugin.settings.agentName || 'Agent');

    if (inputEl) {
      if (opts.seedText != null) inputEl.value = opts.seedText;
      requestAnimationFrame(() => {
        inputEl?.focus();
        inputEl?.select?.();
      });
    }

    if (removeKeyHandler) removeKeyHandler();
    const onKey = (ev) => {
      if (ev.key === 'Escape' && root?.hasClass('is-open')) {
        if (document.activeElement === inputEl) return;
        ev.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKey, true);
    removeKeyHandler = () => document.removeEventListener('keydown', onKey, true);
  }

  function close() {
    if (busy) {
      try {
        plugin.acp?.cancel?.();
      } catch {
        /* */
      }
      setBusy(false);
    }
    if (root) {
      root.removeClass('is-open');
      root.setAttr('aria-hidden', 'true');
    }
    if (removeKeyHandler) {
      removeKeyHandler();
      removeKeyHandler = null;
    }
    if (removePointerHandler) {
      removePointerHandler();
      removePointerHandler = null;
    }
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
    lastEditor = editor;
    lastCapture = captureEditorContext(editor, { path, noteBody });
    lastMode = 'show_only';
    lastFbId = null;
    lastVote = null;
    paintContext(lastCapture);
    showFeedbackRow(false);

    if (
      /^\/(me-digest|me-write-insight|me-care-check|memorized|me-reindex|me-soul-promote|me-reflect-feedback)/.test(
        text
      )
    ) {
      notify('深度技能请在全屏 Chat 中运行');
      close();
      await plugin.activateView?.();
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

    const promptText = buildCommandBarPrompt({
      userText: text,
      capture: lastCapture,
      injectSoul: !!plugin.settings.commandBarInjectSoul,
      soulBlock: '',
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

    if (!result.ok) {
      showResult(result.error || '失败');
      showFallbackActions(!!lastFullText);
      showFeedbackRow(!!String(lastFullText).trim());
      return;
    }

    if (result.stopReason === 'cancelled') {
      showResult(
        (stripApplyHeaderForPreview(lastFullText) || lastFullText || '') +
          '\n（已停止）'
      );
      showFallbackActions(!!String(lastFullText).trim());
      showFeedbackRow(!!String(lastFullText).trim());
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
      showResult(hint);
      showFallbackActions(false);
      showFeedbackRow(false);
      notify('没有收到正文');
      return;
    }

    lastFullText = body;
    showResult(body);
    showFeedbackRow(true);

    if (parsed.mode === 'show_only') {
      showFallbackActions(true);
      return;
    }

    if (!lastEditor) {
      showFallbackActions(true);
      notify('无活动编辑器，结果仅展示');
      return;
    }

    const applied = applyToEditor(lastEditor, parsed.mode, body);
    if (applied.applied) {
      notify(
        parsed.mode === 'replace_selection'
          ? '已替换选区（Cmd/Ctrl+Z 可撤销）'
          : '已插入（Cmd/Ctrl+Z 可撤销）'
      );
      showResult(cleanModelOutput(body, parsed.mode));
      showFallbackActions(true);
    } else {
      showFallbackActions(true);
      notify('未自动写入，可手动插入/替换/复制');
    }
  }

  function destroy() {
    close();
    if (root) {
      root.remove();
      root = null;
    }
    inputEl = null;
    resultEl = null;
    thinkingEl = null;
    actionsEl = null;
    feedbackEl = null;
    statusEl = null;
    sendBtn = null;
    modelSelect = null;
  }

  return {
    open,
    close,
    toggle,
    isOpen,
    destroy,
    submit,
  };
}
