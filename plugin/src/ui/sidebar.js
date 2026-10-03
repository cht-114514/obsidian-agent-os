import { formatRelativeTime, sessionBucket, stripInjectedContext } from './turns.js';

export function sessionKey(row) {
  return row?.key || row?.sessionKey || row?.id || '';
}

/** Chat the person can open. Cron, subagent, and harness rows belong to the gateway. */
export function isUserSession(row) {
  const key = sessionKey(row).toLowerCase();
  const rest = key.split(':').slice(2).join(':');
  if (!rest) return false;
  if (/^(cron|subagent|acp|harness|node|heartbeat)(:|$)/.test(rest)) return false;
  if (rest.includes(':run:')) return false;
  if (row?.kind && /cron|system|subagent|acp|harness/i.test(String(row.kind))) return false;
  return true;
}

export function sessionLabel(row) {
  const named = row?.displayName || row?.label || row?.title || row?.derivedTitle;
  if (named && named !== row?.key && named !== '新会话') return String(named);
  const preview = sessionPreview(row);
  if (preview && !/^\[?openclaw heartbeat/i.test(preview)) return preview.slice(0, 28);
  const key = sessionKey(row);
  if (row?.isMain || key.endsWith(':main')) return '主会话';
  return '会话';
}

export function sessionPreview(row) {
  const raw = row?.lastMessagePreview || row?.preview || row?.lastMessage || '';
  const text = stripInjectedContext(typeof raw === 'string' ? raw : raw?.text || '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function sessionTime(row) {
  const when = row?.updatedAt || row?.lastActivityAt || row?.createdAt;
  if (typeof when === 'number') return when < 1e12 ? when * 1000 : when;
  if (typeof when === 'string') {
    const parsed = Date.parse(when);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * @param {any[]} sessions
 * @param {{ query?: string, now?: number }} [opts]
 */
export function groupSessions(sessions, opts = {}) {
  const now = opts.now || Date.now();
  const q = String(opts.query || '').trim().toLowerCase();
  const buckets = new Map([
    ['今天', []],
    ['昨天', []],
    ['本周', []],
    ['更早', []],
  ]);
  for (const row of sessions || []) {
    const key = sessionKey(row);
    if (!key || !isUserSession(row)) continue;
    const label = sessionLabel(row);
    const preview = sessionPreview(row);
    if (q && !`${label} ${preview} ${key}`.toLowerCase().includes(q)) continue;
    const bucket = sessionBucket(sessionTime(row), now) || '更早';
    buckets.get(bucket)?.push(row);
  }
  return [...buckets.entries()].filter(([, rows]) => rows.length);
}

/**
 * @param {HTMLElement} el
 * @param {{ onNew: () => void, onSelect: (key: string) => void, onDelete?: (key: string) => void, onBack?: () => void }} handlers
 */
export function mountSidebar(el, handlers) {
  el.empty();
  const head = el.createDiv({ cls: 'aos-side-head' });
  const id = head.createDiv({ cls: 'aos-identity' });
  const avatar = id.createSpan({ cls: 'aos-avatar', text: 'A' });
  const names = id.createDiv({ cls: 'aos-identity-copy' });
  const nameEl = names.createDiv({ cls: 'aos-identity-name', text: 'Agent' });
  const sub = names.createDiv({ cls: 'aos-identity-sub' });
  sub.createSpan({ cls: 'aos-status-dot' });
  const subText = sub.createSpan({ cls: 'aos-status-text', text: '未连接' });
  head.createEl('button', {
    cls: 'aos-new',
    text: '新会话',
    attr: { type: 'button' },
  }).onclick = () => handlers.onNew();

  const search = el.createEl('input', {
    cls: 'aos-search',
    attr: { type: 'search', placeholder: '搜索会话', 'aria-label': '搜索会话' },
  });
  const list = el.createDiv({ cls: 'aos-session-list' });
  const foot = el.createDiv({ cls: 'aos-side-foot' });
  foot.createEl('button', {
    cls: 'aos-side-back',
    text: '返回笔记',
    attr: { type: 'button' },
  }).onclick = () => handlers.onBack?.();
  let query = '';
  let last = null;
  let armedKey = '';
  search.addEventListener('input', () => {
    query = search.value || '';
    armedKey = '';
    if (last) paint(last);
  });

  function paint(state) {
    last = state;
    const open = state.open !== false;
    el.toggleClass('is-open', open);
    avatar.setText((state.agentName || 'A').slice(0, 1));
    nameEl.setText(state.agentName || 'Agent');
    const live = state.connection === 'live';
    sub.toggleClass('is-live', live);
    sub.toggleClass('is-wait', state.connection === 'pairing' || state.connection === 'connecting');
    subText.setText(live ? '已连接' : state.connection === 'pairing' ? '等待批准' : state.connection === 'connecting' ? '正在连接' : '未连接');
    list.empty();
    const groups = groupSessions(state.sessions, { query, now: state.now });
    if (!groups.length) {
      const text = state.sessionsLoading
        ? '正在读取会话'
        : state.syncHint
          ? '会话列表没有加载出来'
          : query
            ? '没有匹配的会话'
            : '还没有会话';
      list.createDiv({ cls: 'aos-session-empty', text });
      return;
    }
    for (const [title, rows] of groups) {
      list.createDiv({ cls: 'aos-session-label', text: title });
      for (const row of rows) {
        const key = sessionKey(row);
        const item = list.createDiv({
          cls: `aos-session${key === state.activeKey ? ' is-active' : ''}`,
        });
        const copy = item.createDiv({ cls: 'aos-session-copy' });
        copy.createDiv({ cls: 'aos-session-title', text: sessionLabel(row) });
        const preview = sessionPreview(row);
        const title = sessionLabel(row);
        if (preview && preview !== title && !title.startsWith(preview.slice(0, 12))) {
          copy.createDiv({ cls: 'aos-session-preview', text: preview });
        }
        const meta = item.createDiv({ cls: 'aos-session-meta' });
        const when = formatRelativeTime(sessionTime(row), state.now);
        if (when) meta.createSpan({ text: when });
        if (row.active || row.hasActiveRun || row.needsAttention) meta.createSpan({ cls: 'aos-session-dot' });
        const armed = armedKey === key;
        const remove = item.createEl('button', {
          cls: `aos-session-delete${armed ? ' is-armed' : ''}`,
          text: armed ? '确认' : '删除',
          attr: { type: 'button', 'aria-label': armed ? '确认删除会话' : '删除会话' },
        });
        remove.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (armedKey !== key) {
            armedKey = key;
            paint(state);
            return;
          }
          armedKey = '';
          handlers.onDelete?.(key);
        });
        item.addEventListener('click', (event) => {
          if (event.target?.closest?.('.aos-session-delete')) return;
          armedKey = '';
          handlers.onSelect(key);
        });
      }
    }
  }

  return {
    update: paint,
    query: () => query,
    destroy() {},
  };
}
