/**
 * Session pick rules for multi-device sync (companion + fullscreen).
 */
import { isUserSession, sessionKey } from '../ui/sidebar.js';

const ACTIVE_TURN = new Set(['preparing', 'queued', 'sending']);

/**
 * @param {any[]} messages
 */
export function lastUserMessageAt(messages) {
  let best = 0;
  for (const row of messages || []) {
    if (row?.role !== 'user') continue;
    const t = Number(row.ts) || 0;
    if (t > best) best = t;
  }
  return best;
}

/**
 * @param {any[]} sessions
 * @param {{ key: string, label?: string }[]} sessions from server
 */
export function scoreSession(row, localTranscript) {
  const key = sessionKey(row);
  const users = lastUserMessageAt(localTranscript);
  if (users) return { key, ts: users };
  const previewTs = Number(row?.updatedAt || row?.lastActivityAt || 0);
  const ts = previewTs < 1e12 ? previewTs * 1000 : previewTs;
  return { key, ts };
}

/**
 * Pick default session after server list refresh.
 * @param {{
 *   sessions: any[],
 *   activeKey: string,
 *   messages: any[],
 *   composerDraft?: string,
 *   getTranscript?: (key: string) => any[],
 *   listPending?: (key?: string) => any[],
 *   explicitNewSession?: boolean,
 * }} ctx
 * @returns {{ key: string | null, reason: string }}
 */
export function chooseSession(ctx) {
  const draft = String(ctx.composerDraft || '').trim();
  const active = ctx.activeKey || '';
  const pending = ctx.listPending?.(active) || [];
  const inFlight = pending.some((p) => ACTIVE_TURN.has(p.status));
  const localUsers = (ctx.messages || []).some((m) => m.role === 'user' && String(m.text || '').trim());
  const emptyExplicit =
    ctx.explicitNewSession && !localUsers && !draft && !inFlight;

  if (draft || inFlight || (localUsers && active)) {
    return { key: active || null, reason: 'keep_local' };
  }
  if (emptyExplicit) {
    return { key: active || null, reason: 'keep_new' };
  }

  const candidates = (ctx.sessions || []).filter((row) => isUserSession(row));
  if (!candidates.length) return { key: active || null, reason: 'no_candidates' };

  let bestKey = '';
  let bestTs = -1;
  for (const row of candidates) {
    const key = sessionKey(row);
    if (!key) continue;
    const local = ctx.getTranscript?.(key) || (key === active ? ctx.messages : []);
    const { ts } = scoreSession(row, local);
    if (ts > bestTs) {
      bestTs = ts;
      bestKey = key;
    }
  }
  if (!bestKey) {
    const main = candidates.find((r) => sessionKey(r).endsWith(':main'));
    return { key: sessionKey(main || candidates[0]) || active, reason: 'fallback_main' };
  }
  if (bestKey === active) return { key: active, reason: 'already_best' };
  return { key: bestKey, reason: 'recent_user' };
}

export function isEphemeralLocalKey(key) {
  const k = String(key || '');
  return /:aos-[a-z0-9]+$/i.test(k);
}
