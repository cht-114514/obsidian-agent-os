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
    cls: 'aos-icon-btn',
    text: '+',
    attr: { type: 'button', 'aria-label': '新会话' },
  });
  const ring = bar.createEl('button', {
    cls: 'aos-ring',
    attr: { type: 'button', 'aria-label': '上下文用量' },
  });
  ring.hidden = true;
  const chip = bar.createEl('button', {
    cls: 'aos-chip',
    text: '默认',
    attr: { type: 'button', 'aria-label': '思考档位和模型' },
  });
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

  let busy = false;
  let thinking = [];
  let thinkingId = '';
  let models = [];
  let modelId = '';
  let startedAt = 0;
  let clock = 0;

  function paintAction() {
    action.toggleClass('is-stop', busy);
    action.setAttr('aria-label', busy ? '停止' : '发送');
    action.innerHTML = busy ? '<span aria-hidden="true">■</span>' : '<span aria-hidden="true">↑</span>';
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
      button.onclick = () => {
        closeSheet();
        row.onSelect();
      };
    }
    const cancel = sheet.createEl('button', {
      cls: 'aos-sheet-cancel',
      text: '取消',
      attr: { type: 'button' },
    });
    cancel.onclick = () => closeSheet();
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

  function submit() {
    if (nextComposerAction(busy, 'submit') !== 'send') return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    menu.hidden = true;
    grow();
    opts.onSend(text);
  }

  function tick() {
    progressTime.setText(formatElapsed(Date.now() - startedAt));
  }

  input.addEventListener('input', () => {
    const value = input.value;
    if (value.startsWith('/') && !value.includes('\n')) showMenu(value.slice(1).split(/\s/)[0]);
    else menu.hidden = true;
    grow();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (enterInsertsNewline(opts.mobile)) return;
    event.preventDefault();
    submit();
  });
  action.onclick = () => {
    const next = nextComposerAction(busy, 'primary');
    if (next === 'abort') opts.onAbort?.();
    else if (next === 'send') submit();
  };
  progressStop.onclick = () => opts.onAbort?.();
  plus.onclick = () => opts.onNew?.();
  chip.onclick = () => {
    const rows = [];
    for (const level of thinking) {
      rows.push({
        label: level.id === thinkingId ? `${thinkingLabel(level)} · 当前` : thinkingLabel(level),
        onSelect: () => {
          thinkingId = level.id;
          chip.setText(thinkingLabel(level));
          opts.onThinking?.(level.id);
        },
      });
    }
    for (const model of models) {
      const id = model.id || model;
      const label = model.label || model.name || id;
      rows.push({
        label: id === modelId ? `模型 ${label} · 当前` : `模型 ${label}`,
        onSelect: () => {
          modelId = id;
          opts.onModel?.(id);
        },
      });
    }
    if (!rows.length) return;
    openSheet('思考与模型', rows);
  };

  paintAction();
  grow();

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
      const found = thinking.find((level) => level.id === thinkingId);
      chip.setText(found ? thinkingLabel(found) : '默认');
      chip.hidden = !thinking.length && !models.length;
    },
    setModels(list, current) {
      models = Array.isArray(list) ? list : [];
      modelId = current || '';
      chip.hidden = !thinking.length && !models.length;
    },
    insertText(text) {
      input.value = text;
      grow();
      input.focus();
    },
    focus() {
      input.focus();
    },
    destroy() {
      clearInterval(clock);
    },
  };
}
