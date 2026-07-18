/**
 * Obsidian Agent OS chat panel — streaming ACP (Grok Build) + local me-* skills.
 *
 * Interaction model (obsidian-cc inspired):
 *   @  → vault-wide fuzzy file search → reference chips
 *   /  → skill menu → pill mode (Backspace on empty input clears)
 *   paste/drop file → agent-inbox/raw/ + attachment chip
 *   👍 / 👎 / copy on every agent message → agent-inbox/soul/feedback/<date>.md
 */
import { renderAgentMessage } from './renderer.js';
import {
  buildDigestPrompt,
  ensureWikiDocument,
  setWikiStatus,
  buildDigestPending,
  wikiPreview,
  extractWikiMarkdown,
} from './digest.js';
import { buildTurnPrompt, loadSoulPack } from './memory/inject.js';
import {
  parseWikiIndex,
  serializeWikiIndex,
  shouldSkipRetrieve,
  upsertIndexItem,
  removeIndexItem,
  entryFromWikiFile,
} from './memory/retrieve.js';
import {
  retrieveRelevantMemory,
  reindexAllVectors,
  upsertVectorsForPath,
  removeVectorsForPath,
} from './memory/index-ops.js';
import { VoiceInputSession, resolveXaiApiKey } from './voice-stt.js';
import { checkWritePolicy } from './protocol-bridge.js';

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

  // ---------- header ----------
  const header = shell.createDiv({ cls: 'me-soul-header' });
  const brand = header.createDiv({ cls: 'me-soul-brand' });
  const soulDot = brand.createDiv({ cls: 'me-soul-dot' });
  const brandText = brand.createDiv({ cls: 'me-soul-brand-text' });
  const agentName = plugin.settings.agentName || 'Agent';
  brandText.createDiv({ cls: 'me-soul-title', text: agentName });
  const statusEl = brandText.createDiv({ cls: 'me-soul-subtitle', text: '就绪' });

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
  newBtn.onclick = () => {
    plugin.acp?.resetSession?.();
    logEl.empty();
    appendWelcome();
    notify('新会话已开启');
  };

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
      'me-reindex': '重建 wiki 索引',
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
    const mobile =
      typeof navigator !== 'undefined' &&
      /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '');
    body.createDiv({
      cls: 'me-soul-text me-soul-welcome-hero',
      text: 'Vault 是身体，我是神经。',
    });
    body.createDiv({
      cls: 'me-soul-text me-soul-welcome-sub',
      text: `内核 ${engineName} · 消化进 agent-inbox · 人区要你点头`,
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

  function appendUser(text, usedChips, skill) {
    const div = logEl.createDiv({ cls: 'me-soul-msg me-soul-user' });
    const body = div.createDiv({ cls: 'me-soul-msg-body' });
    if (skill || usedChips.length) {
      const meta = body.createDiv({ cls: 'me-soul-user-meta' });
      if (skill) meta.createSpan({ cls: 'me-soul-user-skill', text: skill.label });
      for (const c of usedChips) {
        meta.createSpan({ cls: 'me-soul-user-chip', text: `${c.kind === 'raw' ? '📎' : '🔗'} ${shortName(c.path)}` });
      }
    }
    if (text) body.createDiv({ cls: 'me-soul-user-text', text });
    scrollDown();
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
      },
      fail(err) {
        endThought();
        endText();
        body.createDiv({ cls: 'me-soul-error', text: `出错了：${err}` });
        scrollDown();
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
    const usedChips = chips.slice();
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
    const composed = await composeMessage(app, text, usedChips);
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

  async function runSkillFlow(skill, text, usedChips) {
    // Model-backed digest via Grok Build ACP
    if (skill.id === 'me-digest') {
      await runDigestWithGrok(text, usedChips);
      return;
    }
    if (skill.id === 'me-soul-promote') {
      await runSoulPromoteWithGrok(text, usedChips);
      return;
    }
    if (skill.id === 'me-reindex') {
      await runReindex();
      return;
    }
    const out = await runLocalSkill(app, skill.id, text, usedChips);
    const msg = createAgentMessage();
    if (!out) {
      await runChatFlow(`/${skill.id} ${text}`.trim(), usedChips);
      msg.root.remove();
      return;
    }
    const rendered = renderAgentMessage(out.reply || out, {
      quiet: controller.settings.quiet,
    });
    const body = msg.root.querySelector('.me-soul-msg-body');
    body.innerHTML = rendered.html;
    wireConfirms(app, controller, body, Notice, plugin);
    msg.finalize(out.reply || '');
  }

  /**
   * /me-digest: Grok generates full wiki (pending_review) → confirm.
   * Accept finalizes wiki; Reject deletes wiki.
   */
  async function runDigestWithGrok(text, usedChips) {
    const msg = createAgentMessage();
    const firstRef =
      usedChips.find((c) => c.kind === 'ref')?.path || usedChips[0]?.path || '';
    const bodyText = String(text || '').trim();
    const sourcePath =
      firstRef || bodyText.replace(/^@/, '').split(/\s+/)[0] || '';

    if (!sourcePath) {
      msg.fail('用法：/me-digest + @笔记');
      return;
    }

    const content = await vaultRead(app, sourcePath);
    if (content == null) {
      msg.fail(`读不到源文件：${sourcePath}`);
      return;
    }

    if (plugin.settings.engine === 'openclaw') {
      msg.fail('digest 需要 Grok Build 内核。请在 Obsidian Agent OS 设置里把引擎改为 Grok Build。');
      return;
    }

    setStatus('Grok 消化中…');
    msg.thought('正在用 Grok 编译 wiki（不是机械截断）…');

    let full = '';
    try {
      const client = plugin.getAcp();
      const prompt = buildDigestPrompt(sourcePath, content);
      await client.prompt(prompt, {
        onThought: (t) => msg.thought(t),
        onText: (t) => {
          full += t;
          msg.text(t);
        },
        onToolCall: (u) => msg.toolCall(u),
        onToolUpdate: (u) => msg.toolUpdate(u),
        onPermission: (req) => msg.permission(req),
      });
    } catch (e) {
      msg.fail(e?.message || String(e));
      return;
    }

    const date = todayStamp();
    const slug = slugify(sourcePath.split('/').pop());
    const wikiRel = `agent-inbox/wiki/sources/${date}-${slug}.md`;
    const pendingRel = `agent-inbox/pending/${date}-digest-${slug}.md`;

    const wikiDoc = ensureWikiDocument(full, {
      sourcePath,
      wikiStatus: 'pending_review',
      created: date,
    });

    if (!extractWikiMarkdown(full) && full.trim().length < 40) {
      msg.fail('模型没有返回可用的 wiki 正文，请重试 /me-digest');
      return;
    }

    try {
      await vaultWrite(app, wikiRel, wikiDoc);
      const pendingMd = buildDigestPending({
        date,
        title: `Digest ${sourcePath.split('/').pop()}`,
        wikiRel,
        sourcePath,
        preview: wikiPreview(wikiDoc),
      });
      await vaultWrite(app, pendingRel, pendingMd);
    } catch (e) {
      msg.fail(`写入失败：${e?.message || e}`);
      return;
    }

    const reply =
      thoughtFence('模型编译完成：wiki 处于 pending_review，等人点头才定稿。') +
      `\n已生成待审 wiki：\`${wikiRel}\`\n\n` +
      `- 源：\`[[${sourcePath}]]\`\n` +
      `- **Accept** → wiki 定稿（wiki_status: accepted）\n` +
      `- **Reject** → **删除**该 wiki 文件\n\n` +
      confirmFence({
        type: 'digest',
        path: pendingRel,
        title: `确认 digest: ${sourcePath.split('/').pop()}`,
        body: `待审 wiki：${wikiRel}\n预览：${wikiPreview(wikiDoc, 160)}`,
        actions: ['accept', 'reject'],
      });

    const bodyEl = msg.root.querySelector('.me-soul-msg-body');
    if (bodyEl) {
      bodyEl.empty();
      const rendered = renderAgentMessage(reply, { quiet: controller.settings.quiet });
      bodyEl.innerHTML = rendered.html;
      wireConfirms(app, controller, bodyEl, Notice, plugin);
    }
    msg.finalize(reply);
    setStatus('就绪');
  }

  async function runReindex() {
    const msg = createAgentMessage();
    setStatus('重建索引…');
    try {
      const folder = app.vault.getAbstractFileByPath('agent-inbox/wiki/sources');
      const files = folder?.children?.filter((c) => c.extension === 'md') || [];
      const items = [];
      /** @type {{ path: string, md: string }[]} */
      const acceptedFiles = [];
      for (const f of files) {
        const md = await app.vault.read(f);
        if (/wiki_status:\s*pending_review/.test(md)) continue;
        items.push(entryFromWikiFile(f.path, md));
        acceptedFiles.push({ path: f.path, md });
      }
      await vaultWrite(app, 'agent-inbox/wiki/index.md', serializeWikiIndex(items));

      let vectorLine = '';
      try {
        const vres = await reindexAllVectors(app, plugin, acceptedFiles);
        if (vres.skipped) {
          vectorLine =
            vres.reason === 'no-key'
              ? '\n向量索引：已跳过（未配置 Embed API Key）'
              : '\n向量索引：已关闭';
        } else {
          vectorLine = `\n向量索引：${vres.vectorChunks} 块（新 embed ${vres.embedded} · 复用 ${vres.reused} · ${vres.model}）→ agent-inbox/wiki/vectors.jsonl`;
        }
      } catch (ve) {
        vectorLine = `\n向量索引失败：${ve?.message || ve}（关键词索引已更新）`;
      }

      const summary = `已重建 wiki 索引：${items.length} 条 → agent-inbox/wiki/index.md${vectorLine}`;
      const body = msg.root.querySelector('.me-soul-msg-body');
      if (body) {
        body.empty();
        body.createDiv({ cls: 'me-soul-text', text: summary });
      }
      msg.finalize(`reindex ${items.length}`);
      notify(`索引 ${items.length} 条`);
    } catch (e) {
      msg.fail(e?.message || String(e));
    }
    setStatus('就绪');
  }

  /**
   * /me-soul-promote — semi-auto skill: scan insights/reflections/feedback → pending plan.
   */
  async function runSoulPromoteWithGrok(text, usedChips) {
    const msg = createAgentMessage();
    if (plugin.settings.engine === 'openclaw') {
      msg.fail('升格技能需要 Grok Build 内核');
      return;
    }
    setStatus('清洗记忆中…');
    msg.thought('扫描 insights / reflections / feedback，分类哪些应进 Soul…');

    const candidates = [];
    async function collectDir(dir, kind) {
      const folder = app.vault.getAbstractFileByPath(dir);
      if (!folder?.children) return;
      for (const f of folder.children) {
        if (f.extension !== 'md' || f.name === 'README.md') continue;
        const md = await app.vault.read(f);
        candidates.push({ kind, path: f.path, excerpt: md.slice(0, 1200) });
      }
    }
    await collectDir('agent-inbox/soul/insights/accepted', 'insight');
    await collectDir('agent-inbox/soul/insights/drafts', 'insight_draft');
    await collectDir('agent-inbox/soul/feedback', 'feedback');
    await collectDir('agent-inbox/wiki/reflections', 'reflection');

    if (!candidates.length) {
      msg.fail('没有可清洗的候选（insights/reflections/feedback 为空）');
      return;
    }

    const prompt = [
      '你是 Obsidian Agent OS 记忆清洗器。根据候选条目，决定如何升格进 Agent 人格文件。',
      '只输出 JSON（不要 markdown 围栏），格式：',
      '{ "updates": [ { "target": "profile"|"style"|"soul", "title": "...", "text": "...", "sources": ["path"] } ], "skipped": [ { "path": "...", "reason": "..." } ] }',
      '规则：',
      '- 知识性 wiki sources 不要进 soul；偏好/边界/语气 → profile 或 style 或 soul',
      '- text 要可直接追加到目标文件的一小节',
      '- 最多 8 条 updates',
      '',
      '候选：',
      JSON.stringify(candidates.slice(0, 20), null, 0),
      text ? `\n用户补充：${text}` : '',
    ].join('\n');

    let full = '';
    try {
      const client = plugin.getAcp();
      await client.prompt(prompt, {
        onThought: (t) => msg.thought(t),
        onText: (t) => {
          full += t;
          msg.text(t);
        },
        onToolCall: (u) => msg.toolCall(u),
        onToolUpdate: (u) => msg.toolUpdate(u),
        onPermission: (req) => msg.permission(req),
      });
    } catch (e) {
      msg.fail(e?.message || String(e));
      return;
    }

    let plan;
    try {
      const jsonMatch = full.match(/\{[\s\S]*\}/);
      plan = JSON.parse(jsonMatch ? jsonMatch[0] : full);
    } catch {
      msg.fail('模型未返回合法 JSON 计划，请重试 /me-soul-promote');
      return;
    }

    const date = todayStamp();
    const pendingRel = `agent-inbox/pending/${date}-soul-promote.md`;
    const updates = plan.updates || [];
    const pendingBody = [
      '---',
      'status: pending',
      'type: soul-promote',
      `title: Soul 清洗升格 ${date}`,
      `created: ${date}`,
      'path: agent-inbox/soul/profile.md',
      '---',
      '',
      '## 升格计划（Accept 后写入）',
      '',
      ...updates.map(
        (u, i) =>
          `### ${i + 1}. → ${u.target}\n**${u.title || ''}**\n\n${u.text || ''}\n\n来源：${(u.sources || []).join(', ')}\n`
      ),
      '',
      '## 跳过',
      '',
      ...((plan.skipped || []).map((s) => `- ${s.path}: ${s.reason}`) || ['- （无）']),
      '',
      '```json',
      JSON.stringify(plan, null, 2),
      '```',
      '',
    ].join('\n');

    try {
      await vaultWrite(app, pendingRel, pendingBody);
    } catch (e) {
      msg.fail(String(e.message || e));
      return;
    }

    const reply =
      thoughtFence(`扫到 ${candidates.length} 条候选，提议 ${updates.length} 条升格。`) +
      `\n计划已写入 \`${pendingRel}\`。\n\n` +
      confirmFence({
        type: 'soul-promote',
        path: pendingRel,
        title: '确认清洗升格 Soul',
        body: updates.length
          ? updates.map((u) => `${u.target}: ${u.title || u.text?.slice(0, 40)}`).join('；')
          : '无更新',
        actions: ['accept', 'reject'],
      });

    const bodyEl = msg.root.querySelector('.me-soul-msg-body');
    if (bodyEl) {
      bodyEl.empty();
      const rendered = renderAgentMessage(reply, { quiet: controller.settings.quiet });
      bodyEl.innerHTML = rendered.html;
      wireConfirms(app, controller, bodyEl, Notice, plugin);
    }
    msg.finalize(reply);
    setStatus('就绪');
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

  appendWelcome();
  refreshCare();
  autoGrow();

  return {
    refreshCare,
    destroy() {
      containerEl.empty();
    },
  };
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

async function composeMessage(app, text, chips) {
  if (!chips.length) return text;
  const parts = [text];
  const bodies = [];
  for (const c of chips) {
    if (c.kind === 'raw') {
      bodies.push(`- 附件（原始证据，已入 raw）：${c.path}`);
      continue;
    }
    try {
      const f = app.vault.getAbstractFileByPath(c.path);
      const content = f ? (await app.vault.read(f)).slice(0, 4000) : '(读取失败)';
      bodies.push(`### 引用：${c.path}\n\n${content}`);
    } catch {
      bodies.push(`### 引用：${c.path}\n\n(读取失败)`);
    }
  }
  parts.push('\n## 附带上下文\n');
  parts.push(bodies.join('\n\n'));
  return parts.join('\n');
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

/**
 * Run local me-* skill scripts via Node (desktop only).
 */
/**
 * Desktop Node require helper (optional). Prefer vault API skills when possible.
 */
function nodeRequire(id) {
  const candidates = [];
  try {
    if (typeof window !== 'undefined' && typeof window.require === 'function') {
      candidates.push(window.require);
    }
  } catch {}
  try {
    if (typeof globalThis !== 'undefined' && typeof globalThis.require === 'function') {
      candidates.push(globalThis.require);
    }
  } catch {}
  try {
    if (typeof require === 'function') candidates.push(require);
  } catch {}
  for (const r of candidates) {
    try {
      return r(id);
    } catch {
      /* next */
    }
  }
  return null;
}

function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function slugify(s) {
  return (
    String(s || '')
      .replace(/\.md$/i, '')
      .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'note'
  );
}

function thoughtFence(t) {
  return `:::thought\n${t}\n:::\n`;
}

function confirmFence({ type, path, title, body, actions = ['accept', 'edit', 'reject'] }) {
  return [
    `:::confirm type=${type} path=${path}`,
    `title: ${title}`,
    `body: ${body}`,
    `actions: [${actions.join(', ')}]`,
    ':::',
    '',
  ].join('\n');
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

/**
 * In-process skills via Obsidian vault API (no child_process).
 */

/** True when user is asking to discuss a note, not write a profile 心迹. */
function looksLikeNoteDiscussion(text, chips = []) {
  const hasChip = (chips || []).some((c) => c && (c.path || c.kind === 'ref' || c.kind === 'raw'));
  const t = String(text || '');
  const hasAt = /@\S+/.test(t) || /\[\[[^\]]+\]\]/.test(t);
  if (!hasChip && !hasAt) {
    // bare discussion verbs without a note → still might be chat; don't force insight redirect
    // only treat as note-discussion when a note is in play
    return false;
  }
  // discussion / analysis intents
  if (/讨论|聊聊|分析|看看|解读|讲解|讲讲|帮我看|读一下|总结一下|什么意思|讲下|说说这/.test(t)) {
    return true;
  }
  // note chip + short non-insight imperative often means "talk about this"
  if (hasChip && t && !/(偏好|习惯|边界|记住|以后|不要|别再|我希望|我更|风格|纠正)/.test(t)) {
    if (/^(讨论|聊聊|看看|分析)/.test(t.trim())) return true;
  }
  return false;
}

async function runLocalSkill(app, skillId, text, chips) {
  if (!skillId.startsWith('me-')) return null;
  if (!app?.vault) return null;

  const firstRef = chips.find((c) => c.kind === 'ref')?.path || chips[0]?.path || '';
  const bodyText = String(text || '').trim();
  const date = todayStamp();

  try {
    if (skillId === 'me-write-insight') {
      // This skill ONLY drafts profile-learning 心迹 — not note discussion, not a pedagogy mode.
      if (looksLikeNoteDiscussion(bodyText, chips)) {
        return {
          reply: [
            thoughtFence('你像是在讨论笔记，不是在写心迹。'),
            '**`/me-write-insight` 做什么**',
            '把「我对你的稳定判断」写成可确认草案（偏好 / 边界 / 纠正），供以后越用越懂你。',
            '',
            '**它不做什么**',
            '不聊某篇笔记、不做苏格拉底教学法、不代替普通对话。',
            '',
            '**若要讨论笔记**：先去掉「写一条心迹」技能 pill，再 `@笔记` +「讨论一下…」。',
            '',
            '**若要写心迹**（示例是内容，不是技能名）：',
            '```',
            '/me-write-insight 偏好：排查先诊断再动手，不要盲目试',
            '/me-write-insight 沟通边界 | 不喜欢空泛赞美开场',
            '```',
          ].join('\n'),
        };
      }
      if (!bodyText) {
        return {
          reply: [
            thoughtFence('心迹 = 我对你的稳定认知草案，不是讨论笔记的入口。'),
            '**本技能只做一件事**：把一句可沉淀的判断写进 `insights/drafts` + 确认卡。',
            '',
            '**正确用法（示例是「心迹内容」，不是技能功能名）**',
            '```',
            '/me-write-insight 偏好：排查先诊断再动手',
            '/me-write-insight 沟通边界 | 不喜欢空泛赞美开场',
            '/me-write-insight 学习：做对题后还要追问为什么',
            '```',
            '',
            '**常见误会**',
            '- 说明里的例子 ≠ 本技能在做「苏格拉底式教学」；那只是一条可记住的偏好文案。',
            '- 想讨论 `先猜后证.md` 这类笔记：取消技能 pill → `@先猜后证.md` → 「讨论一下」。',
            '',
            '成功后：drafts + pending 确认卡 → Accept → `/me-apply-insight @pending路径` 合并 profile。',
          ].join('\n'),
        };
      }
      let title = '心迹';
      let body = bodyText;
      if (bodyText.includes('|')) {
        const [t, ...rest] = bodyText.split('|');
        if (rest.length) {
          title = t.trim() || title;
          body = rest.join('|').trim();
        }
      }
      const slug = slugify(title);
      const draftRel = `agent-inbox/soul/insights/drafts/${date}-${slug}.md`;
      const pendingRel = `agent-inbox/pending/${date}-insight-${slug}.md`;
      const draftMd = [
        '---',
        'status: draft',
        'type: insight',
        `title: ${title}`,
        `created: ${date}`,
        '---',
        '',
        body,
        '',
      ].join('\n');
      const pendingMd = [
        '---',
        'status: pending',
        'type: insight',
        `title: ${title}`,
        `created: ${date}`,
        'path: agent-inbox/soul/profile.md',
        `source_paths: ${JSON.stringify([draftRel])}`,
        '---',
        '',
        '## 心迹草案',
        '',
        body,
        '',
        '## 合并计划',
        '',
        `- 确认后用 /me-apply-insight 合并到 profile`,
        `- 草案：\`${draftRel}\``,
        '',
      ].join('\n');
      await vaultWrite(app, draftRel, draftMd);
      await vaultWrite(app, pendingRel, pendingMd);
      return {
        reply: [
          thoughtFence('这一点像是稳定偏好，先写成心迹草案，你点头我再写进 profile。'),
          `已起草心迹：\`${draftRel}\``,
          '',
          confirmFence({
            type: 'insight',
            path: pendingRel,
            title,
            body,
          }),
        ].join('\n'),
      };
    }

    if (skillId === 'me-digest') {
      // Handled by runDigestWithGrok (Grok Build model). Should not reach here.
      return {
        reply: thoughtFence('请从 UI 走 /me-digest（Grok 编译）。') + '\n内部错误：机械 digest 已禁用。',
      };
    }

    if (skillId === 'me-care-check') {
      // Prefer node skill for full policy; fallback simple pending count via vault
      const spawned = await trySpawnSkill(app, skillId, ['--vault', app.vault.adapter?.basePath].filter(Boolean));
      if (spawned) return spawned;
      const pendingFolder = app.vault.getAbstractFileByPath('agent-inbox/pending');
      const files =
        pendingFolder?.children?.filter((c) => c.extension === 'md' && c.name !== 'README.md') || [];
      const careRel = 'agent-inbox/soul/pending-care.md';
      if (files.length === 0) {
        await vaultWrite(
          app,
          careRel,
          '---\ntitle: 待展示牵挂\ntype: pending-care\nitems: 0\n---\n\n# Pending Care\n\n当前无未读牵挂。\n'
        );
        return {
          reply: thoughtFence('扫了一圈，没什么非说不可的。') + '\n牵挂检查完成：0 条。',
        };
      }
      const evidence = files.slice(0, 5).map((f) => f.path);
      const md = [
        '---',
        'title: 待展示牵挂',
        'type: pending-care',
        `items: 1`,
        '---',
        '',
        '# Pending Care',
        '',
        '## 1. pending-some',
        '',
        `有 ${files.length} 条 pending 等你点头。`,
        '',
        '证据:',
        ...evidence.map((e) => `  - ${e}`),
        '',
      ].join('\n');
      await vaultWrite(app, careRel, md);
      return {
        reply:
          thoughtFence(`有 1 条牵挂值得说——${files.length} 条 pending。`) +
          `\n牵挂检查完成：1 条写入 \`${careRel}\`。`,
      };
    }

    if (skillId === 'me-apply-pending' || skillId === 'me-apply-insight') {
      const pend = (bodyText || firstRef || '').replace(/^@/, '');
      if (!pend) {
        return {
          reply: `:::thought\n需要 pending 路径。\n:::\n\n用法：\`/${skillId} agent-inbox/pending/xxx.md\``,
        };
      }
      // use protocol from bundle for state machine
      const { approvePendingMarkdown, applyPendingMarkdown, parsePendingMarkdown } = await import(
        './protocol-bridge.js'
      );
      // re-export names from confirm - check protocol-bridge exports
      let md = await vaultRead(app, pend);
      if (md == null) return { reply: `找不到 \`${pend}\`` };
      const rec = parsePendingMarkdown(md);
      if (rec.status !== 'approved' && rec.status !== 'applied') {
        return {
          reply: `:::thought\npending 状态是 ${rec.status}，需要先 Accept。\n:::\n\n打开确认卡点 Accept，或先批准再 apply。`,
        };
      }
      if (skillId === 'me-apply-insight') {
        // merge into profile
        const profileRel = 'agent-inbox/soul/profile.md';
        let profile = (await vaultRead(app, profileRel)) || '# Profile\n';
        const block = `\n\n## Insight ${date} — ${rec.title}\n\n${rec.body.trim()}\n`;
        if (!profile.includes(rec.body.trim().slice(0, 40))) {
          profile = profile.trimEnd() + block;
          await vaultWrite(app, profileRel, profile);
        }
        const acceptedRel = `agent-inbox/soul/insights/accepted/${date}-${slugify(rec.title)}.md`;
        await vaultWrite(
          app,
          acceptedRel,
          `---\nstatus: accepted\ntitle: ${rec.title}\n---\n\n${rec.body}\n`
        );
        if (rec.status === 'approved') {
          const applied = applyPendingMarkdown(md);
          if (applied.ok) await vaultWrite(app, pend, applied.markdown);
        }
        return {
          reply:
            thoughtFence('心迹进 profile 了——靠你点头，不是我偷记。') +
            `\n已合并 → \`${profileRel}\``,
        };
      }
      // me-apply-pending
      if (rec.status === 'approved') {
        const applied = applyPendingMarkdown(md);
        if (!applied.ok) return { reply: applied.error };
        await vaultWrite(app, pend, applied.markdown);
      }
      return {
        reply: thoughtFence('pending 已 applied；人区仍只读。') + `\n已应用 \`${pend}\``,
      };
    }

    return null;
  } catch (e) {
    return {
      reply: `:::thought\nskill 执行失败。\n:::\n\n${e?.message || String(e)}`,
    };
  }
}

/** Optional CLI fallback when basePath + child_process available */
async function trySpawnSkill(app, skillId, extraArgs) {
  const base = app?.vault?.adapter?.basePath || app?.vault?.adapter?.getBasePath?.();
  if (!base) return null;
  const r = nodeRequire('child_process');
  const path = nodeRequire('path');
  if (!r || !path) return null;
  const { spawn } = r;
  const { join } = path;
  const skillRoot = join(base, 'agent-inbox', 'me-soul', 'skills', skillId, 'run.mjs');
  return new Promise((resolve) => {
    try {
      const child = spawn('node', [skillRoot, '--vault', base, ...extraArgs], { cwd: base });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        if (code !== 0 && !stdout.trim()) return resolve(null);
        resolve({ reply: stdout.replace(/\n<!--[\s\S]*?-->\n?/g, '\n').trim() || stderr });
      });
    } catch {
      resolve(null);
    }
  });
}




async function updateWikiIndexOnAccept(app, wikiPath, plugin) {
  if (!wikiPath || !wikiPath.startsWith('agent-inbox/wiki/')) return;
  const md = await vaultRead(app, wikiPath);
  if (!md) return;
  const indexMd = (await vaultRead(app, 'agent-inbox/wiki/index.md')) || '';
  let items = parseWikiIndex(indexMd);
  const entry = entryFromWikiFile(wikiPath, md);
  entry.wiki_status = 'accepted';
  items = upsertIndexItem(items, entry);
  await vaultWrite(app, 'agent-inbox/wiki/index.md', serializeWikiIndex(items));
  if (plugin) {
    try {
      await upsertVectorsForPath(app, plugin, wikiPath, md);
    } catch (e) {
      console.warn('vector upsert on accept failed', e);
    }
  }
}

async function updateWikiIndexOnReject(app, wikiPath) {
  if (!wikiPath) return;
  const indexMd = (await vaultRead(app, 'agent-inbox/wiki/index.md')) || '';
  let items = parseWikiIndex(indexMd);
  items = removeIndexItem(items, wikiPath);
  await vaultWrite(app, 'agent-inbox/wiki/index.md', serializeWikiIndex(items));
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

async function wireConfirms(app, controller, root, Notice, plugin) {
  root.querySelectorAll('.me-soul-confirm').forEach((card) => {
    const path = card.getAttribute('data-path');
    const confirmType = card.getAttribute('data-type') || '';
    card.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-action');
        if (!path) return;
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
