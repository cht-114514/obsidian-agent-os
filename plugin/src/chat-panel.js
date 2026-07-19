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
 *   👍 / 👎 / copy on every agent message → agent-inbox/soul/feedback/<date>.md
 */
import { renderAgentMessage } from './renderer.js';
import { setWikiStatus } from './digest.js';
import { buildTurnPrompt, loadSoulPack } from './memory/inject.js';
import { shouldSkipRetrieve } from './memory/retrieve.js';
import {
  retrieveRelevantMemory,
  reindexAllVectors,
  upsertVectorsForPath,
  removeVectorsForPath,
} from './memory/index-ops.js';
import { VoiceInputSession, resolveXaiApiKey } from './voice-stt.js';
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
} from './chat-history.js';
import {
  formatGrokRuntimeLabel,
  normalizeGrokProfiles,
  resolveGrokRuntime,
} from './grok-runtime.js';

/**
 * @param {HTMLElement} containerEl
 * @param {{
 *   app: any,
 *   controller: import('./main.js').MeSoulController,
 *   plugin: any,
 *   Notice: any,
 *   MarkdownRenderer?: any,
 *   mode?: 'home' | 'sidebar',
 * }} ctx
 */
export function mountMeSoulChat(containerEl, ctx) {
  const { app, controller, plugin, Notice, MarkdownRenderer, mode = 'home' } = ctx;
  containerEl.empty();
  containerEl.addClass('me-soul-panel');
  containerEl.addClass(mode === 'home' ? 'me-soul-panel-home' : 'me-soul-panel-sidebar');

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

  // ---------- header ----------
  const header = shell.createDiv({ cls: 'me-soul-header' });
  const brand = header.createDiv({ cls: 'me-soul-brand' });
  const soulDot = brand.createDiv({ cls: 'me-soul-dot' });
  const brandText = brand.createDiv({ cls: 'me-soul-brand-text' });
  const agentName = plugin.settings.agentName || 'Agent';
  brandText.createDiv({ cls: 'me-soul-title', text: agentName });
  const statusEl = brandText.createDiv({ cls: 'me-soul-subtitle', text: '就绪' });

  // Model profile switcher (SuperGrok vs third-party) — always visible on home/sidebar
  const modelRow = brandText.createDiv({ cls: 'me-soul-model-row' });
  const modelSelect = modelRow.createEl('select', {
    cls: 'me-soul-model-select',
    attr: {
      'aria-label': '模型配置档',
      title: '切换 Grok Build 模型 / 第三方 API（不改对话记录）',
    },
  });
  function refreshModelSelect() {
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
    const rt = resolveGrokRuntime(plugin.settings);
    modelSelect.setAttr('title', formatGrokRuntimeLabel(rt));
  }
  refreshModelSelect();
  modelSelect.onchange = async () => {
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
      refreshModelSelect();
      setStatus(`模型：${formatGrokRuntimeLabel(rt)}`);
      notify(`已切换 → ${formatGrokRuntimeLabel(rt)}（下一条消息生效）`);
    } catch (e) {
      notify(e?.message || String(e));
      refreshModelSelect();
    }
  };

  const tools = header.createDiv({ cls: 'me-soul-header-tools' });
  const careEl = tools.createDiv({ cls: 'me-soul-care-chip', text: '牵挂' });
  const newBtn = tools.createEl('button', {
    cls: 'me-soul-icon-btn',
    attr: { 'aria-label': '新会话', title: '新会话' },
    text: '⟳',
  });
  const quietBtn = tools.createEl('button', {
    cls: 'me-soul-icon-btn',
    attr: { 'aria-label': '今日少说话', title: '今日少说话' },
    text: controller.settings.quiet ? '🌙' : '☀️',
  });
  quietBtn.toggleClass('is-on', !!controller.settings.quiet);
  quietBtn.onclick = async () => {
    controller.setQuiet(!controller.settings.quiet);
    plugin.settings.quiet = controller.settings.quiet;
    await plugin.saveSettings();
    quietBtn.setText(controller.settings.quiet ? '🌙' : '☀️');
    quietBtn.toggleClass('is-on', controller.settings.quiet);
    logEl.toggleClass('is-quiet', controller.settings.quiet);
    notify(controller.settings.quiet ? '今日少说话：开' : '今日少说话：关');
  };
  newBtn.onclick = async () => {
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

  const contextStrip = shell.createDiv({ cls: 'me-soul-context-strip' });
  const contextLabel = contextStrip.createDiv({ cls: 'me-soul-context-label' });
  const contextPathEl = contextStrip.createDiv({
    cls: 'me-soul-context-path',
    attr: { title: '点击打开笔记' },
  });
  const contextModes = contextStrip.createDiv({ cls: 'me-soul-context-modes' });
  const btnFollow = contextModes.createEl('button', {
    cls: 'me-soul-context-btn',
    text: '跟随',
    attr: { type: 'button', title: '跟随当前打开的笔记' },
  });
  const btnPin = contextModes.createEl('button', {
    cls: 'me-soul-context-btn',
    text: '固定',
    attr: { type: 'button', title: '固定当前笔记，换页不变' },
  });
  const btnOff = contextModes.createEl('button', {
    cls: 'me-soul-context-btn',
    text: '关闭',
    attr: { type: 'button', title: '本会话不自动附带' },
  });

  function paintContextStrip() {
    if (!activeNoteEnabled()) {
      contextStrip.addClass('is-disabled');
      contextLabel.setText('当前笔记');
      contextPathEl.setText('（设置中已关闭自动上下文）');
      btnFollow.removeClass('is-on');
      btnPin.removeClass('is-on');
      btnOff.addClass('is-on');
      return;
    }
    contextStrip.removeClass('is-disabled');
    const path = getEffectiveActivePath(activeNoteState);
    const mode = activeNoteState.mode;
    btnFollow.toggleClass('is-on', mode === 'follow');
    btnPin.toggleClass('is-on', mode === 'pin');
    btnOff.toggleClass('is-on', mode === 'off');
    if (mode === 'off') {
      contextLabel.setText('当前笔记 · 关');
      contextPathEl.setText('发送时不自动附带');
      return;
    }
    contextLabel.setText(mode === 'pin' ? '当前笔记 · 固定' : '当前笔记 · 自动');
    if (path) {
      contextPathEl.setText(path);
      contextPathEl.setAttr('title', path);
      contextStrip.addClass('has-note');
      contextStrip.addClass('is-flash');
      window.setTimeout(() => contextStrip.removeClass('is-flash'), 280);
    } else {
      contextPathEl.setText('（打开一篇 Markdown 笔记）');
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
    paintContextStrip();
  };
  btnOff.onclick = () => {
    activeNoteState = setActiveNoteMode(activeNoteState, 'off');
    plugin.settings.activeNoteMode = 'off';
    plugin.saveSettings?.();
    paintContextStrip();
  };
  contextPathEl.onclick = () => {
    const p = getEffectiveActivePath(activeNoteState);
    if (!p) return;
    const f = app.vault.getAbstractFileByPath(p);
    if (f) app.workspace.getLeaf(false).openFile(f);
  };

  const unsubLeaf = app.workspace.on?.('active-leaf-change', () => syncActiveFromWorkspace());
  const unsubOpen = app.workspace.on?.('file-open', () => syncActiveFromWorkspace());
  syncActiveFromWorkspace();

  // ---------- log ----------
  const logEl = shell.createDiv({ cls: 'me-soul-log' });
  logEl.toggleClass('is-quiet', !!controller.settings.quiet);

  // ---------- composer ----------
  const composer = shell.createDiv({ cls: 'me-soul-composer' });
  const suggestEl = composer.createDiv({ cls: 'me-soul-suggest' });
  suggestEl.style.display = 'none';

  const chipsEl = composer.createDiv({ cls: 'me-soul-chips' });
  const inputWrap = composer.createDiv({ cls: 'me-soul-input-wrap' });
  const skillPillEl = inputWrap.createDiv({ cls: 'me-soul-active-skill' });
  const inputEl = inputWrap.createEl('textarea', {
    cls: 'me-soul-input',
    attr: {
      rows: '1',
      placeholder: `跟${agentName}说…   @ 引用笔记 · / 技能 · 粘贴文件入 raw · 按住 🎤`,
    },
  });
  const row = composer.createDiv({ cls: 'me-soul-composer-row' });
  const hintEl = row.createDiv({ cls: 'me-soul-status' });
  const actionsEl = row.createDiv({ cls: 'me-soul-composer-actions' });
  const micBtn = actionsEl.createEl('button', {
    cls: 'me-soul-mic',
    attr: {
      type: 'button',
      'aria-label': '按住说话',
      title: '按住说话（xAI STT）· 松手填入输入框',
    },
    text: '🎤',
  });
  const sendBtn = actionsEl.createEl('button', { cls: 'me-soul-send', text: '↑' });

  /** @type {VoiceInputSession | null} */
  let voiceSession = null;
  let voiceBaseText = '';
  let voiceListening = false;

  function setStatus(t) {
    statusEl.setText(t);
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
    composer.toggleClass('is-voice-listening', on);
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
        hintEl.setText(s);
        if (s.includes('聆听') || s.includes('麦克风')) setStatus('听…');
      },
      onPartial: (text) => {
        const joined = voiceBaseText
          ? `${voiceBaseText.replace(/\s+$/, '')} ${text}`.trim()
          : text;
        inputEl.value = joined;
        autoGrow();
      },
      onError: (err) => {
        notify(err?.message || String(err));
        setStatus('就绪');
        hintEl.setText('');
      },
    });
    voiceSession = session;
    setVoiceUi(true);
    try {
      await session.start();
    } catch (e) {
      setVoiceUi(false);
      voiceSession = null;
      notify(e?.message || String(e));
      setStatus('就绪');
      hintEl.setText('');
    }
  }

  async function stopVoice(sendAfter = false) {
    if (!voiceSession) {
      setVoiceUi(false);
      return;
    }
    const session = voiceSession;
    voiceSession = null;
    try {
      const text = await session.stop();
      if (text) {
        const joined = voiceBaseText
          ? `${voiceBaseText.replace(/\s+$/, '')} ${text}`.trim()
          : text;
        inputEl.value = joined;
        autoGrow();
        if (sendAfter && plugin.settings.voiceAutoSend) {
          // defer so UI settles
          setTimeout(() => send(), 30);
        }
      }
    } catch (e) {
      notify(e?.message || String(e));
    } finally {
      setVoiceUi(false);
      setStatus('就绪');
      hintEl.setText('');
      inputEl.focus();
    }
  }

  function cancelVoice() {
    if (voiceSession) {
      voiceSession.cancel();
      voiceSession = null;
    }
    setVoiceUi(false);
    hintEl.setText('');
    setStatus('就绪');
  }

  // Push-to-talk: press & hold
  micBtn.addEventListener('pointerdown', (ev) => {
    if (ev.button != null && ev.button !== 0) return;
    ev.preventDefault();
    try {
      micBtn.setPointerCapture(ev.pointerId);
    } catch {
      /* */
    }
    startVoice();
  });
  micBtn.addEventListener('pointerup', (ev) => {
    ev.preventDefault();
    stopVoice(false);
  });
  micBtn.addEventListener('pointercancel', () => cancelVoice());
  micBtn.addEventListener('lostpointercapture', () => {
    if (voiceListening) stopVoice(false);
  });
  // Prevent focus steal / context menu noise
  micBtn.addEventListener('contextmenu', (e) => e.preventDefault());

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
      'me-care-check': '检查牵挂',
      'me-soul-promote': '清洗 Wiki→升格 Soul',
      memorized: '写入/重建向量记忆库',
      'me-reindex': '（别名）同 /memorized',
      'me-apply-pending': '合并已确认 pending',
      'me-apply-insight': '合并 insight',
    };
    return map[id] || '技能';
  }

  // ---------- messages ----------
  function appendWelcome() {
    const w = logEl.createDiv({ cls: 'me-soul-msg me-soul-agent me-soul-welcome' });
    const body = w.createDiv({ cls: 'me-soul-msg-body' });
    const engineName = plugin.settings.engine === 'openclaw' ? 'OpenClaw' : 'Grok Build';
    const rt =
      plugin.settings.engine === 'openclaw'
        ? null
        : resolveGrokRuntime(plugin.settings);
    const mobile =
      typeof navigator !== 'undefined' &&
      /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '');
    body.createDiv({
      cls: 'me-soul-text me-soul-welcome-hero',
      text: 'Vault 是身体，我是神经。',
    });
    body.createDiv({
      cls: 'me-soul-text me-soul-welcome-sub',
      text: rt
        ? `内核 ${engineName} · ${formatGrokRuntimeLabel(rt)} · 人区要你点头`
        : `内核 ${engineName} · 消化进 agent-inbox · 人区要你点头`,
    });
    if (mobile) {
      body.createDiv({
        cls: 'me-soul-text me-soul-mobile-note',
        text:
          '📱 手机端：可看对话台、用本地 vault 技能（写心迹/重建索引等）。本地 Grok 内核需电脑；若要手机对话，请在设置改为 OpenClaw Gateway（HTTP）并保证能连上。',
      });
    }
    const tips = body.createDiv({ cls: 'me-soul-welcome-tips' });
    for (const t of ['@ 引用笔记', '/ 技能', '粘贴文件 → raw', '👍👎 喂我成长']) {
      tips.createSpan({ cls: 'me-soul-tip', text: t });
    }
  }

  /**
   * @param {string} text
   * @param {{ path: string, kind?: string }[]} usedChips
   * @param {{ id?: string, label?: string } | null} [skill]
   * @param {{ persist?: boolean }} [opts]
   */
  function appendUser(text, usedChips, skill, opts = {}) {
    const div = logEl.createDiv({ cls: 'me-soul-msg me-soul-user' });
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
    scrollDown();
    if (opts.persist !== false) {
      recordMessage({
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
   * Replay a stored agent turn (fences → cards; errors as error row).
   * @param {import('./chat-history.js').ChatMessage} m
   */
  async function appendAgentFromHistory(m) {
    const div = logEl.createDiv({ cls: 'me-soul-msg me-soul-agent' });
    const body = div.createDiv({ cls: 'me-soul-msg-body' });
    if (m.error) {
      body.createDiv({ cls: 'me-soul-error', text: `出错了：${m.error}` });
    } else if (m.text && /:::(?:confirm|thought)\b/.test(m.text)) {
      const rendered = renderAgentMessage(m.text, { quiet: controller.settings.quiet });
      body.innerHTML = rendered.html;
      await wireConfirms(app, controller, body, Notice, plugin);
    } else if (m.text) {
      const el = body.createDiv({ cls: 'me-soul-stream-text' });
      await renderMarkdownInto(el, m.text);
    } else {
      body.createDiv({ cls: 'me-soul-text', text: '（空回复）' });
    }
    appendFooter(div, m.text || m.error || '');
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
    el.empty();
    if (MarkdownRenderer?.render) {
      try {
        await MarkdownRenderer.render(app, markdown, el, '', plugin);
        return;
      } catch {}
    }
    el.setText(markdown);
  }

  /** Streaming agent message builder. */
  function createAgentMessage() {
    const div = logEl.createDiv({ cls: 'me-soul-msg me-soul-agent' });
    const body = div.createDiv({ cls: 'me-soul-msg-body' });

    let thoughtEl = null; // current <details> body
    let thoughtBuf = '';
    let textEl = null; // current streaming text div
    let textBuf = '';
    const toolEls = new Map(); // toolCallId → { root, statusEl }

    function endText() {
      if (textEl && textBuf.trim()) {
        const el = textEl;
        const md = textBuf;
        renderMarkdownInto(el, md);
      } else if (textEl && !textBuf.trim()) {
        textEl.remove();
      }
      textEl = null;
      textBuf = '';
    }
    function endThought() {
      thoughtEl = null;
      thoughtBuf = '';
    }

    return {
      root: div,
      thought(t) {
        if (!t) return;
        endText();
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
          textEl = body.createDiv({ cls: 'me-soul-stream-text' });
          textBuf = '';
        }
        textBuf += t;
        textEl.setText(textBuf);
        scrollDown();
      },
      toolCall(u) {
        endThought();
        endText();
        const root = body.createDiv({ cls: 'me-soul-tool-row' });
        root.createSpan({ cls: 'me-soul-tool-icon', text: toolIcon(u.kind) });
        root.createSpan({ cls: 'me-soul-tool-title', text: u.title || u.kind || 'tool' });
        const st = root.createSpan({ cls: 'me-soul-tool-status is-running', text: '' });
        toolEls.set(u.toolCallId, { root, statusEl: st });
        scrollDown();
      },
      toolUpdate(u) {
        const t = toolEls.get(u.toolCallId);
        if (!t) return;
        const s = (u.status || '').toLowerCase();
        if (s === 'completed') {
          t.statusEl.removeClass('is-running');
          t.statusEl.addClass('is-done');
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
        endText();
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
      finalize(fullText) {
        endThought();
        endText();
        appendFooter(div, fullText);
        scrollDown();
        recordMessage({
          role: 'agent',
          text: fullText || '',
        });
      },
      fail(err) {
        endThought();
        endText();
        const msg = err?.message || String(err || 'unknown');
        body.createDiv({ cls: 'me-soul-error', text: `出错了：${msg}` });
        scrollDown();
        recordMessage({
          role: 'agent',
          text: '',
          error: msg,
        });
      },
    };
  }

  function appendFooter(msgDiv, fullText) {
    const foot = msgDiv.createDiv({ cls: 'me-soul-msg-foot' });
    const up = foot.createEl('button', { cls: 'me-soul-foot-btn', text: '👍' });
    const down = foot.createEl('button', { cls: 'me-soul-foot-btn', text: '👎' });
    const copy = foot.createEl('button', { cls: 'me-soul-foot-btn', text: '⧉' });
    up.onclick = async () => {
      await writeFeedback(app, '👍', fullText);
      up.addClass('is-voted');
      down.removeClass('is-voted');
      notify('已记录 👍 → feedback');
    };
    down.onclick = async () => {
      await writeFeedback(app, '👎', fullText);
      down.addClass('is-voted');
      up.removeClass('is-voted');
      notify('已记录 👎 → feedback');
    };
    copy.onclick = async () => {
      await navigator.clipboard.writeText(fullText || '');
      notify('已复制');
    };
  }

  // ---------- send ----------
  async function send() {
    if (busy) {
      plugin.acp?.cancel?.();
      return;
    }
    const text = inputEl.value.trim();
    const skill = activeSkill;
    const usedChips = buildSendChips(chips);
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

    inputEl.value = '';
    autoGrow();
    chips = [];
    activeSkill = null;
    renderChips();
    renderSkillPill();
    closeSuggest();

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
    const fullPrompt = await assembleMemoryPrompt(app, plugin, composed, text, usedChips);

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
      msg.finalize(res.agentText || '');
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
    msg.finalize(full);
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

    const fullPrompt = buildGrokSkillPrompt({
      skillId: skill.id,
      skillMd,
      userText: text || '',
      contextBlock,
      activePath,
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
      await wireConfirms(app, controller, bodyEl, Notice, plugin);
    }
    msg.finalize(full);
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
        appendUser(m.text || '', m.chips || [], m.skill || null, { persist: false });
      } else if (m.role === 'agent') {
        await appendAgentFromHistory(m);
      }
    }
    scrollDown();
  }

  // Restore previous transcript (or welcome). Fire-and-forget with care refresh.
  restoreOrWelcome()
    .then(() => refreshCare())
    .catch((e) => {
      console.warn(e);
      appendWelcome();
      refreshCare();
    });
  autoGrow();

  return {
    refreshCare,
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
async function assembleMemoryPrompt(app, plugin, composedUser, rawText, usedChips) {
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

async function writeFeedback(app, vote, text) {
  const dir = 'agent-inbox/soul/feedback';
  await ensureFolder(app, dir);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const path = `${dir}/${date}.md`;
  const excerpt = String(text || '').slice(0, 600);
  const entry = `\n## ${time} ${vote}\n\n> ${excerpt.replace(/\n/g, '\n> ')}\n`;
  const f = app.vault.getAbstractFileByPath(path);
  if (f) {
    const old = await app.vault.read(f);
    await app.vault.modify(f, old + entry);
  } else {
    await app.vault.create(path, `# Feedback ${date}\n${entry}`);
  }
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
