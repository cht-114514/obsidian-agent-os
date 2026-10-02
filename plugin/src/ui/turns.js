/** Turn shaping for the chat thread. Pure: no DOM. */

export const USER_MESSAGE_SENTINEL = '## 用户本轮消息';

export function textOfMessage(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if (typeof message.text === 'string' && message.text) return message.text;
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => typeof part === 'string' || !/think|reason/i.test(String(part?.type || '')))
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  }
  return '';
}

/**
 * Drop the injected soul / skill preamble. The real user text follows the sentinel.
 * Text without a sentinel is returned unchanged.
 * @param {string} text
 */
export function stripInjectedContext(text) {
  const raw = String(text || '');
  const at = raw.lastIndexOf(USER_MESSAGE_SENTINEL);
  if (at < 0) return raw.trim();
  return raw.slice(at + USER_MESSAGE_SENTINEL.length).replace(/^\s*\n?/, '').trim();
}

export function newMessageId(prefix = 'm') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function timestampOf(row) {
  const value = row?.timestamp ?? row?.createdAt ?? row?.ts ?? row?.updatedAt;
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function thinkingOf(row) {
  if (!Array.isArray(row?.content)) return '';
  return row.content
    .filter((part) => part && /think|reason/i.test(String(part.type || '')))
    .map((part) => part.text || part.thinking || part.reasoning || '')
    .filter(Boolean)
    .join('\n');
}

function isToolRow(row) {
  return row?.role === 'tool' || row?.role === 'toolResult' || !!row?.toolName || !!row?.toolCallId;
}

function toolFromRow(row) {
  const ts = timestampOf(row);
  return {
    id: String(row.toolCallId || row.id || row.toolName || 'tool'),
    name: String(row.toolName || row.name || 'tool'),
    title: String(row.title || ''),
    phase: row.isError ? 'error' : 'done',
    args: typeof row.arguments === 'string' ? row.arguments : '',
    startedAt: ts,
    endedAt: ts,
  };
}

function makeMessage(role, text, extra = {}) {
  const id = extra.id || newMessageId(role === 'user' ? 'u' : 'a');
  return {
    id,
    role,
    text,
    ts: extra.ts || 0,
    turnId: extra.turnId || id,
    activity: extra.activity || null,
  };
}

/**
 * Collapse gateway history into chat turns.
 * Consecutive tool rows attach to the following assistant message.
 * @param {any} payload
 */
export function historyToTurns(payload) {
  const rows = payload?.messages || payload?.items || [];
  if (!Array.isArray(rows)) return [];
  /** @type {any[]} */
  const out = [];
  /** @type {any[]} */
  let tools = [];
  let reasoning = '';

  const flushTools = () => {
    if (!tools.length && !reasoning) return;
    out.push(
      makeMessage('assistant', '', {
        ts: tools[0]?.endedAt || 0,
        activity: { reasoning, status: '', tools, startedAt: tools[0]?.startedAt || 0 },
      })
    );
    tools = [];
    reasoning = '';
  };

  rows.forEach((row, index) => {
    if (isToolRow(row)) {
      tools.push(toolFromRow(row));
      return;
    }
    const role = row?.role === 'user' ? 'user' : row?.role === 'assistant' ? 'assistant' : '';
    if (!role) return;
    if (role === 'user') {
      flushTools();
      const text = stripInjectedContext(textOfMessage(row));
      if (!text) return;
      out.push(
        makeMessage('user', text, {
          id: String(row.id || `h-${index}`),
          ts: timestampOf(row),
        })
      );
      return;
    }
    const text = textOfMessage(row).trim();
    const thought = thinkingOf(row);
    const merged = [...tools];
    const prior = reasoning;
    tools = [];
    reasoning = '';
    if (!text && !merged.length && !thought && !prior) return;
    out.push(
      makeMessage('assistant', text, {
        id: String(row.id || `h-${index}`),
        ts: timestampOf(row),
        activity: {
          reasoning: thought || prior,
          status: '',
          tools: merged,
          startedAt: merged[0]?.startedAt || timestampOf(row) || 0,
        },
      })
    );
  });
  flushTools();
  return out;
}

/**
 * @param {number|string} ts
 * @param {number} [now]
 */
export function formatRelativeTime(ts, now = Date.now()) {
  const t = typeof ts === 'number' ? ts : Date.parse(String(ts || ''));
  if (!Number.isFinite(t) || t <= 0) return '';
  const delta = Math.max(0, now - t);
  const min = Math.floor(delta / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return '昨天';
  if (day < 7) return `${day} 天前`;
  const date = new Date(t);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

const DAY = 86400000;

/**
 * @param {number} ts
 * @param {number} [now]
 * @returns {'今天'|'昨天'|'本周'|'更早'|''}
 */
export function sessionBucket(ts, now = Date.now()) {
  if (!ts) return '';
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (ts >= today) return '今天';
  if (ts >= today - DAY) return '昨天';
  if (ts >= today - 6 * DAY) return '本周';
  return '更早';
}

/**
 * @param {number} ms
 */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
