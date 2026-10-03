/**
 * Session buffer for unclosed MemCell turns (vault JSON).
 */

export const BUFFER_PATH = 'agent-inbox/wiki/memories/buffer.json';

/** @typedef {{ role: 'user'|'assistant', text: string, ts: number }} BufferTurn */

/**
 * @param {string} raw
 * @returns {Record<string, { turns: BufferTurn[], updatedAt: number }>}
 */
export function parseBufferStore(raw) {
  try {
    const j = JSON.parse(String(raw || '{}'));
    if (!j || typeof j !== 'object') return {};
    /** @type {Record<string, { turns: BufferTurn[], updatedAt: number }>} */
    const out = {};
    for (const [k, v] of Object.entries(j.sessions || j)) {
      if (!v || typeof v !== 'object') continue;
      const turns = Array.isArray(v.turns) ? v.turns : [];
      out[k] = {
        turns: turns
          .map((t) => ({
            role: t.role === 'assistant' ? 'assistant' : 'user',
            text: String(t.text || '').slice(0, 4000),
            ts: Number(t.ts) || 0,
          }))
          .filter((t) => t.text),
        updatedAt: Number(v.updatedAt) || 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, { turns: BufferTurn[], updatedAt: number }>} store
 */
export function serializeBufferStore(store) {
  return JSON.stringify({ sessions: store || {} }, null, 2) + '\n';
}

/**
 * @param {BufferTurn[]} turns
 * @param {BufferTurn} user
 * @param {BufferTurn} assistant
 */
export function appendExchange(turns, user, assistant) {
  const list = [...(turns || [])];
  if (user?.text) list.push(user);
  if (assistant?.text) list.push(assistant);
  return list.slice(-24);
}

export const STALE_BUFFER_MS = 6 * 60 * 60 * 1000;

/**
 * @param {{ turns: BufferTurn[], updatedAt: number }} session
 * @param {number} [now]
 */
export function isBufferStale(session, now = Date.now()) {
  if (!session?.turns?.length) return false;
  const first = session.turns[0]?.ts || session.updatedAt || 0;
  return now - first > STALE_BUFFER_MS;
}
