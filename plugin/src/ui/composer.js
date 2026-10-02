import { formatElapsed } from './turns.js';

/**
 * What the primary control and the submit path should do.
 * @param {boolean} busy
 * @param {'primary'|'submit'} intent
 * @returns {'send'|'abort'|'ignore'}
 */
export function nextComposerAction(busy, intent) {
  if (intent === 'submit') return busy ? 'ignore' : 'send';
  if (intent === 'primary') return busy ? 'abort' : 'send';
  return 'ignore';
}

/** Phones insert a newline on Enter. Desktop sends. */
export function enterInsertsNewline(mobile) {
  return !!mobile;
}

const THINKING_ZH = {
  off: '关闭',
  none: '关闭',
  minimal: '极少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  ultra: '超高',
  max: '最高',
};

function thinkingLabel(level) {
  const id = String(level?.id || '').trim().toLowerCase();
  if (THINKING_ZH[id]) return THINKING_ZH[id];
  const raw = String(level?.label || '').trim();
  return THINKING_ZH[raw.toLowerCase()] || raw || '默认';
}

function chipLabel(model, level) {
  const name = model?.label || model?.name || (model?.id ? String(model.id).split('/').pop() : '模型');
  const short = name.length > 16 ? `${name.slice(0, 15)}…` : name;
  const think = level ? thinkingLabel(level) : '使用默认';
  return `${short} · ${think}`;
}

/**
 * Run the action on press, before iOS dismisses the keyboard.
 * A send tap otherwise blurs the textarea, the bar jumps down, and the
 * finger-up lands on empty space. The thinking sheet is positioned above the
 * bar, so opening it on press does not put 取消 under the finger.
 */
function bindTap(el, fn) {
  let stamp = 0;
  const fire = () => {
    const now = Date.now();
    if (now - stamp < 700) return;
    stamp = now;
    fn();
  };
  const primary = (event) =>
    !(event.pointerType === 'mouse' && typeof event.button === 'number' && event.button !== 0);
  const onPress = (event) => {
    if (event?.pointerType && !primary(event)) return;
    if (event?.cancelable) event.preventDefault();
    event?.stopPropagation();
    fire();
  };
  el.addEventListener('pointerdown', onPress, true);
  el.addEventListener('touchstart', onPress, { capture: true, passive: false });
  el.addEventListener(
    'pointerup',
    (event) => {
      if (!primary(event)) return;
      event.stopPropagation();
      fire();
    },
    true
  );
  el.addEventListener(
    'touchend',
    (event) => {
      event.stopPropagation();
      fire();
    },
    true
  );
  el.addEventListener('click', (event) => {
    event.stopPropagation();
    fire();
  });
}

function ringSvg(pct) {
  const r = 8;
  const c = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(1, pct)) * c;
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="${r}" class="aos-ring-track"/><circle cx="10" cy="10" r="${r}" class="aos-ring-value" stroke-dasharray="${dash.toFixed(2)} ${c.toFixed(2)}"/></svg>`;
}

/**
 * @param {HTMLElement} el
 * @param {{
 *   mobile?: boolean,
 *   skills?: { id: string }[],
 *   onSend: (text: string) => void,
 *   onAbort?: () => void,
 *   onNew?: () => void,
 *   onThinking?: (id: string) => void,
 *   onModel?: (id: string) => void,
 *   onNotice?: (message: string) => void,
 * }} opts
 */
export function mountComposer(el, opts) {
  el.empty();
  const dock = el.createDiv({ cls: 'aos-dock' });
  const progress = dock.createDiv({ cls: 'aos-progress' });
  progress.hidden = true;
  const progressLabel = progress.createSpan({ cls: 'aos-progress-label', text: '思考中' });
  const progressTime = progress.createSpan({ cls: 'aos-progress-time', text: '0:00' });
  const progressStop = progress.createEl('button', {
    cls: 'aos-progress-stop',
    text: '停止',
    attr: { type: 'button' },
  });

  const card = dock.createDiv({ cls: 'aos-composer' });
  const input = card.createEl('textarea', {
    cls: 'aos-input',
    attr: { rows: '1', placeholder: '发消息' },
  });
  const bar = card.createDiv({ cls: 'aos-composer-bar' });
  const plus = bar.createEl('button', {
    cls: 'aos-icon-btn aos-composer-new',
    text: '+',
    attr: { type: 'button', 'aria-label': '新会话' },
  });
  if (opts.mobile) plus.hidden = true;
  plus.hidden = true;
  const ring = bar.createEl('button', {
    cls: 'aos-ring',
    attr: { type: 'button', 'aria-label': '上下文用量' },
  });
  ring.hidden = true;
  const chip = bar.createEl('button', {
    cls: 'aos-chip',
    text: '模型 · 使用默认',
    attr: { type: 'button', 'aria-label': '思考档位和模型' },
  });
  chip.hidden = false;
  bar.createDiv({ cls: 'aos-bar-spacer' });
  const action = bar.createEl('button', {
    cls: 'aos-send',
    attr: { type: 'button', 'aria-label': '发送' },
  });
  action.innerHTML = '<span aria-hidden="true">↑</span>';

  const menu = dock.createDiv({ cls: 'aos-slash' });
  menu.hidden = true;
  const sheet = dock.createDiv({ cls: 'aos-sheet' });
  sheet.hidden = true;
  let pickerMask = null;

  let busy = false;
  let thinking = [];
  let thinkingId = '';
  let models = [];
  let modelId = '';
  let startedAt = 0;
  let clock = 0;
  /** Texts currently being saved/sent; guards against double submission. */
  let composing = false;
  const submitPending = new Set();

  function paintAction() {
    action.toggleClass('is-stop', busy);
    action.setAttr('aria-label', busy ? '停止' : '发送');
    action.innerHTML = busy ? '<span aria-hidden="true">■</span>' : '<span aria-hidden="true">↑</span>';
    paintSendEnabled();
  }

  function paintSendEnabled() {
    if (busy) {
      action.removeClass('is-disabled');
      action.disabled = false;
      return;
    }
    const empty = !input.value.trim();
    action.toggleClass('is-disabled', empty);
    action.disabled = empty;
  }

  function grow() {
    input.style.height = 'auto';
    const line = 24;
    const next = Math.min(input.scrollHeight, line * 6);
    input.style.height = `${Math.max(line, next)}px`;
  }

  function closeSheet() {
    sheet.hidden = true;
    sheet.empty();
    if (pickerMask) {
      pickerMask.remove();
      pickerMask = null;
    }
  }

  function paintChip() {
    const model = models.find((item) => item.id === modelId);
    const level = thinking.find((item) => item.id === thinkingId);
    chip.setText(chipLabel(model, level));
    const fullModel = model?.id || '未选择模型';
    const fullThink = level ? thinkingLabel(level) : '使用默认';
    chip.setAttr('title', `${fullModel} · ${fullThink}`);
    chip.hidden = false;
  }

  function levelsFor(model) {
    const raw = Array.isArray(model?.thinkingLevels) ? model.thinkingLevels : [];
    return raw
      .map((level) => {
        if (typeof level === 'string') return { id: level, label: level };
        const id = String(level?.id || '').trim();
        return id ? { id, label: level.label || id } : null;
      })
      .filter(Boolean);
  }

  function openPicker() {
    input.blur();
    closeSheet();
    const draftModel = modelId;
    const draftThinking = thinkingId;
    let modelDraft = draftModel;
    let thinkingDraft = draftThinking;
    const mask = document.createElement('div');
    mask.className = 'aos-model-mask';
    pickerMask = mask;
    const panel = document.createElement('div');
    panel.className = 'aos-model-panel';
    mask.appendChild(panel);
    const head = document.createElement('div');
    head.className = 'aos-picker-head';
    const title = document.createElement('div');
    title.className = 'aos-sheet-title';
    title.textContent = '模型与思考';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'aos-sheet-cancel';
    close.textContent = '关闭';
    close.addEventListener('click', () => closeSheet());
    head.appendChild(title);
    head.appendChild(close);
    const search = document.createElement('input');
    search.className = 'aos-picker-search';
    search.type = 'search';
    search.placeholder = '搜索模型';
    search.setAttribute('aria-label', '搜索模型');
    const scroller = document.createElement('div');
    scroller.className = 'aos-picker-scroll';
    const think = document.createElement('div');
    think.className = 'aos-picker-think';
    const foot = document.createElement('div');
    foot.className = 'aos-picker-foot';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'aos-picker-apply';
    apply.textContent = '应用';
    foot.appendChild(apply);
    panel.append(head, search, scroller, think, foot);
    document.body.appendChild(mask);
    mask.addEventListener('click', (event) => {
      if (event.target === mask) closeSheet();
    });

    const paint = () => {
      scroller.replaceChildren();
      think.replaceChildren();
      const q = search.value.trim().toLowerCase();
      const hits = models.filter((model) => {
        const blob = `${model.label || ''} ${model.id || ''} ${model.provider || ''}`.toLowerCase();
        return !q || blob.includes(q);
      });
      if (!hits.length) {
        const empty = document.createElement('div');
        empty.className = 'aos-picker-empty';
        empty.textContent = models.length ? '没有匹配的模型' : '还没有模型目录';
        scroller.appendChild(empty);
      }
      for (const model of hits) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `aos-model-row${model.id === modelDraft ? ' is-current' : ''}`;
        const copy = document.createElement('span');
        copy.className = 'aos-picker-copy';
        const name = document.createElement('span');
        name.className = 'aos-picker-name';
        name.textContent = model.label || model.id || '';
        copy.appendChild(name);
        if (model.provider) {
          const provider = document.createElement('span');
          provider.className = 'aos-picker-provider';
          provider.textContent = model.provider;
          copy.appendChild(provider);
        }
        const mark = document.createElement('span');
        mark.className = 'aos-picker-check';
        mark.textContent = model.id === modelDraft ? '✓' : '';
        button.append(copy, mark);
        button.addEventListener('click', () => {
          modelDraft = model.id;
          const nextLevels = levelsFor(model);
          if (thinkingDraft && !nextLevels.some((level) => level.id === thinkingDraft)) thinkingDraft = '';
          paint();
        });
        scroller.appendChild(button);
      }
      const label = document.createElement('div');
      label.className = 'aos-picker-label';
      label.textContent = '思考强度';
      think.appendChild(label);
      const currentModel = models.find((item) => item.id === modelDraft);
      const levels = currentModel ? levelsFor(currentModel) : [];
      const rows = levels.length ? levels : [{ id: '', label: '使用默认' }];
      const choices = document.createElement('div');
      choices.className = 'aos-picker-choices';
      for (const level of rows) {
        const selected = level.id === thinkingDraft || (!level.id && !thinkingDraft);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `aos-think-row${selected ? ' is-current' : ''}`;
        button.textContent = level.id ? thinkingLabel(level) : '使用默认';
        button.addEventListener('click', () => {
          thinkingDraft = level.id;
          paint();
        });
        choices.appendChild(button);
      }
      think.appendChild(choices);
    };
    search.addEventListener('input', paint);
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      try {
        if (opts.onApply) {
          await opts.onApply({ model: modelDraft, thinking: thinkingDraft });
        } else {
          if (modelDraft !== modelId) opts.onModel?.(modelDraft);
          opts.onThinking?.(thinkingDraft || '');
        }
        modelId = modelDraft;
        thinkingId = thinkingDraft;
        thinking = levelsFor(models.find((item) => item.id === modelId) || {});
        paintChip();
        closeSheet();
      } catch (error) {
        apply.disabled = false;
        opts.onNotice?.(error?.message || '没有保存');
      }
    });
    paint();
  }

  function closeOverlays() {
    closeSheet();
    menu.hidden = true;
  }

  function openSheet(title, rows) {
    sheet.empty();
    sheet.hidden = false;
    sheet.createDiv({ cls: 'aos-sheet-title', text: title });
    for (const row of rows) {
      const button = sheet.createEl('button', {
        cls: 'aos-sheet-item',
        text: row.label,
        attr: { type: 'button' },
      });
      bindTap(button, () => {
        closeSheet();
        row.onSelect();
      });
    }
    const cancel = sheet.createEl('button', {
      cls: 'aos-sheet-cancel',
      text: '取消',
      attr: { type: 'button' },
    });
    bindTap(cancel, () => closeSheet());
  }

  function showMenu(query) {
    const q = query.toLowerCase();
    const hits = (opts.skills || []).filter((skill) => skill.id.includes(q)).slice(0, 8);
    menu.empty();
    if (!hits.length) {
      menu.hidden = true;
      return;
    }
    menu.hidden = false;
    for (const skill of hits) {
      const item = menu.createEl('button', {
        cls: 'aos-slash-item',
        text: `/${skill.id}`,
        attr: { type: 'button' },
      });
      item.onclick = () => {
        input.value = `/${skill.id} `;
        menu.hidden = true;
        grow();
        input.focus();
      };
    }
  }

  /**
   * Clear the input only after the message was durably saved. If the caller
   * reports a storage failure, the text stays in the composer so nothing the
   * user typed can be lost.
   */
  async function submit() {
    if (composing) return;
    if (nextComposerAction(busy, 'submit') !== 'send') return;
    const text = input.value.trim();
    if (!text) return;
    if (submitPending.has(text)) return;
    submitPending.add(text);
    let result;
    try {
      result = await opts.onSend(text);
    } catch (error) {
      result = { ok: false, error };
      opts.onNotice?.(error?.message || '没有发出去');
    }
    submitPending.delete(text);
    if (result && result.ok === false) {
      input.value = text;
      grow();
      input.focus();
      return;
    }
    if (input.value.trim() === text) {
      input.value = '';
      grow();
      paintSendEnabled();
    }
    menu.hidden = true;
  }

  function tick() {
    progressTime.setText(formatElapsed(Date.now() - startedAt));
  }

  input.addEventListener('compositionstart', () => {
    composing = true;
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    paintSendEnabled();
  });
  input.addEventListener('input', () => {
    const value = input.value;
    if (value.startsWith('/') && !value.includes('\n')) showMenu(value.slice(1).split(/\s/)[0]);
    else menu.hidden = true;
    grow();
    paintSendEnabled();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || composing) return;
    if (enterInsertsNewline(opts.mobile)) return;
    event.preventDefault();
    submit();
  });
  bindTap(action, () => {
    const next = nextComposerAction(busy, 'primary');
    if (next === 'abort') opts.onAbort?.();
    else if (next === 'send') submit();
  });
  bindTap(progressStop, () => opts.onAbort?.());
  bindTap(plus, () => opts.onNew?.());
  bindTap(chip, () => openPicker());

  paintAction();
  grow();
  paintSendEnabled();

  return {
    setBusy(next) {
      busy = !!next;
      paintAction();
      if (!busy) {
        progress.hidden = true;
        clearInterval(clock);
        clock = 0;
      }
    },
    setProgress(state) {
      const on = !!state?.on;
      progress.hidden = !on;
      if (!on) {
        clearInterval(clock);
        clock = 0;
        return;
      }
      progressLabel.setText(state.label || '思考中');
      startedAt = state.startedAt || startedAt || Date.now();
      tick();
      if (!clock) clock = setInterval(tick, 1000);
    },
    setPlaceholder(text) {
      input.setAttr('placeholder', text || '发消息');
    },
    setUsage(usage) {
      const limit = Number(usage?.limit);
      const used = Number(usage?.used);
      if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) {
        ring.hidden = true;
        return;
      }
      const pct = Math.max(0, Math.min(1, used / limit));
      ring.hidden = false;
      ring.innerHTML = ringSvg(pct);
      ring.setAttr('aria-label', `上下文 ${Math.round(pct * 100)}%`);
    },
    setThinking(levels, current) {
      thinking = Array.isArray(levels) ? levels : [];
      thinkingId = current || '';
      paintChip();
    },
    setModels(list, current) {
      models = Array.isArray(list) ? list : [];
      modelId = current || '';
      const model = models.find((item) => item.id === modelId);
      if (model) thinking = levelsFor(model);
      paintChip();
    },
    insertText(text) {
      input.value = text;
      grow();
      input.focus();
    },
    focus() {
      input.focus();
    },
    blur() {
      input.blur();
    },
    closeOverlays,
    destroy() {
      clearInterval(clock);
      closeSheet();
    },
  };
}
