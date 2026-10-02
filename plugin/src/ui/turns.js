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
 * Tool rows and assistant fragments between two user messages become one turn.
 * @param {any} payload
 */
export function historyToTurns(payload) {
  const rows = payload?.messages || payload?.items || [];
  if (!Array.isArray(rows)) return [];
  /** @type {any[]} */
  const out = [];
  /** @type {null | { id: string, ts: number, texts: string[], tools: any[], reasoning: string, fromAssistant: boolean }} */
  let pending = null;

  const flushAssistant = () => {
    if (!pending) return;
    const snapshot = pending;
    pending = null;
    const text = snapshot.texts.map((part) => part.trim()).filter(Boolean).join('\n\n');
    const reasoning = snapshot.reasoning.trim();
    if (!text && !snapshot.tools.length && !reasoning) return;
    out.push(
      makeMessage('assistant', text, {
        id: snapshot.id,
        ts: snapshot.ts || snapshot.tools[0]?.endedAt || 0,
        activity: {
          reasoning,
          status: '',
          tools: snapshot.tools,
          startedAt: snapshot.tools[0]?.startedAt || snapshot.ts || 0,
        },
      })
    );
  };

  const ensurePending = (row, index) => {
    const ts = timestampOf(row);
    if (!pending) {
      pending = {
        id: String(row?.id || `h-${index}`),
        ts: ts || 0,
        texts: [],
        tools: [],
        reasoning: '',
        fromAssistant: false,
      };
      return;
    }
    if (ts) pending.ts = ts;
  };

  rows.forEach((row, index) => {
    if (isToolRow(row)) {
      ensurePending(row, index);
      pending.tools.push(toolFromRow(row));
      return;
    }
    const role = row?.role === 'user' ? 'user' : row?.role === 'assistant' ? 'assistant' : '';
    if (!role) return;
    if (role === 'user') {
      flushAssistant();
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
    if (!text && !thought && !pending?.tools.length) return;
    ensurePending(row, index);
    if (!pending.fromAssistant && row.id) pending.id = String(row.id);
    pending.fromAssistant = true;
    if (text) pending.texts.push(text);
    if (thought) pending.reasoning = pending.reasoning ? `${pending.reasoning}\n${thought}` : thought;
  });
  flushAssistant();
  return out;
}

function mergeKey(role, text) {
  return `${role}\u0000${String(text ?? '').replace(/\s+/g, ' ').trim()}`;
}

/**
 * Merge gateway history into the local transcript without clobbering anything
 * the phone has that the Mac has not seen yet.
 *
 * History wins for content it knows about; local-only messages (a message typed
 * while offline, a draft still streaming) are kept in place. The local user
 * message id is preserved when the text matches, so an in-flight turn keeps its
 * identity across a reload.
 *
 * Pure: no DOM, no storage.
 * @param {any[]} local
 * @param {any[]} incoming
 */
export function mergeTranscript(local, incoming) {
  const remote = Array.isArray(incoming) ? incoming : [];
  const mine = Array.isArray(local) ? local : [];
  if (!remote.length) return mine;
  if (!mine.length) return remote;

  // Everything the Mac knows starts out "already accounted for"; local-only
  // rows are the ones to keep. A remote row only lands in the output when it
  // could not be paired with a local row.
  const consumed = new Set(remote);
  const replaced = new Set();
  const localUserByKey = new Map();
  for (const message of mine) {
    if (message?.role !== 'user') continue;
    const key = mergeKey('user', message.text);
    if (!localUserByKey.has(key)) localUserByKey.set(key, message);
  }

  const pairs = [];
  for (const message of mine) {
    if (message?.role !== 'user') continue;
    const key = mergeKey('user', message.text);
    if (localUserByKey.get(key) !== message) continue;
    const position = remote.findIndex((row) => row?.role === 'user' && mergeKey('user', row.text) === key);
    if (position < 0) continue;
    const remoteUser = remote[position];
    const next = remote[position + 1];
    const reply = next && next.role === 'assistant' ? next : null;
    const draft = mine.find((row) => row?.role === 'assistant' && row.turnId === message.turnId);
    // The Mac's copy of the turn is now represented by the local pair.
    consumed.add(remoteUser);
    if (reply) consumed.add(reply);
    if (draft) replaced.add(draft);
    pairs.push({ local: message, remoteUser, reply, draft });
  }

  const out = [];
  let pairIndex = 0;
  for (const message of mine) {
    if (replaced.has(message)) continue;
    if (message?.role === 'user') {
      const pair = pairs[pairIndex];
      if (pair && pair.local === message) {
        pairIndex += 1;
        out.push({ ...message, ts: pair.remoteUser.ts || message.ts });
        if (pair.reply && pair.draft) {
          // Adopt the Mac's reply in place of the local placeholder.
          out.push({ ...pair.reply, id: pair.draft.id, turnId: message.turnId });
        }
        continue;
      }
    }
    out.push({ ...message });
  }

  for (const row of remote) {
    if (consumed.has(row)) continue;
    out.push({ ...row });
  }

  // Stable sort on timestamp; local-only rows keep their relative order.
  return out
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const delta = (a.message.ts || 0) - (b.message.ts || 0);
      if (delta !== 0) return delta;
      return a.index - b.index;
    })
    .map((row) => row.message);
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
