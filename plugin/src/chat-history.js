/**
 * Persist chat transcripts under agent-inbox/sessions so remounting the panel
 * (switch note / leaf / homepage re-render) does not wipe the conversation.
 */

export const SESSION_PATH = 'agent-inbox/sessions/current.json';
export const ARCHIVE_DIR = 'agent-inbox/sessions/archive';

/** Soft caps to keep the vault file reasonable. */
export const MAX_MESSAGES = 120;
export const MAX_TEXT_CHARS = 120_000;

/**
 * @typedef {{ id?: string, label?: string }} SkillRef
 * @typedef {{ path: string, kind?: string }} ChipRef
 * @typedef {{
 *   id: string,
 *   role: 'user' | 'agent',
 *   text?: string,
 *   error?: string | null,
 *   skill?: SkillRef | null,
 *   chips?: ChipRef[],
 *   ts: number,
 * }} ChatMessage
 * @typedef {{
 *   version: 1,
 *   id: string,
 *   updatedAt: string,
 *   messages: ChatMessage[],
 * }} ChatSession
 */

/**
 * @returns {string}
 */
export function newId(prefix = 'm') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @returns {ChatSession}
 */
export function createEmptySession() {
  return {
    version: 1,
    id: newId('ses'),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
}

/**
 * @param {string | null | undefined} raw
 * @returns {ChatSession}
 */
export function parseSession(raw) {
  if (!raw || !String(raw).trim()) return createEmptySession();
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return createEmptySession();
    const messages = Array.isArray(data.messages)
      ? data.messages
          .filter((m) => m && (m.role === 'user' || m.role === 'agent'))
          .map(normalizeMessage)
      : [];
    return {
      version: 1,
      id: typeof data.id === 'string' && data.id ? data.id : newId('ses'),
      updatedAt:
        typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
      messages,
    };
  } catch {
    return createEmptySession();
  }
}

/**
 * @param {any} m
 * @returns {ChatMessage}
 */
function normalizeMessage(m) {
  const role = m.role === 'user' ? 'user' : 'agent';
  /** @type {ChatMessage} */
  const out = {
    id: typeof m.id === 'string' && m.id ? m.id : newId('m'),
    role,
    text: typeof m.text === 'string' ? m.text : '',
    ts: typeof m.ts === 'number' ? m.ts : Date.now(),
  };
  if (m.error) out.error = String(m.error);
  if (m.skill && typeof m.skill === 'object') {
    out.skill = {
      id: m.skill.id ? String(m.skill.id) : undefined,
      label: m.skill.label ? String(m.skill.label) : undefined,
    };
  }
  if (Array.isArray(m.chips)) {
    out.chips = m.chips
      .filter((c) => c && c.path)
      .map((c) => ({ path: String(c.path), kind: c.kind ? String(c.kind) : 'ref' }));
  }
  return out;
}

/**
 * @param {ChatSession} session
 * @returns {string}
 */
export function serializeSession(session) {
  const s = trimSession(session || createEmptySession());
  return `${JSON.stringify(s, null, 2)}\n`;
}

/**
 * Cap message count and per-message text size.
 * @param {ChatSession} session
 * @returns {ChatSession}
 */
export function trimSession(session) {
  const messages = (session.messages || []).slice(-MAX_MESSAGES).map((m) => {
    const text = String(m.text || '');
    if (text.length <= MAX_TEXT_CHARS) return m;
    return {
      ...m,
      text: `${text.slice(0, MAX_TEXT_CHARS)}\n\n…(截断，完整内容见当时生成的 vault 文件)`,
    };
  });
  return {
    version: 1,
    id: session.id || newId('ses'),
    updatedAt: new Date().toISOString(),
    messages,
  };
}

/**
 * @param {ChatSession} session
 * @param {Omit<ChatMessage, 'id' | 'ts'> & { id?: string, ts?: number }} msg
 * @returns {ChatSession}
 */
export function appendMessage(session, msg) {
  const next = {
    version: 1,
    id: session?.id || newId('ses'),
    updatedAt: new Date().toISOString(),
    messages: [
      ...(session?.messages || []),
      {
        id: msg.id || newId('m'),
        role: msg.role,
        text: msg.text || '',
        error: msg.error || null,
        skill: msg.skill || null,
        chips: msg.chips || [],
        ts: msg.ts || Date.now(),
      },
    ],
  };
  return trimSession(next);
}

/**
 * Filename-safe timestamp for archives.
 * @param {Date} [d]
 */
export function archiveStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * @param {any} app Obsidian App
 * @returns {Promise<ChatSession>}
 */
export async function loadSessionFromVault(app) {
  const f = app.vault.getAbstractFileByPath(SESSION_PATH);
  if (!f) return createEmptySession();
  try {
    const raw = await app.vault.read(f);
    return parseSession(raw);
  } catch {
    return createEmptySession();
  }
}

/**
 * @param {any} app
 * @param {string} dir
 */
async function ensureFolder(app, dir) {
  const parts = dir.split('/').filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try {
        await app.vault.createFolder(cur);
      } catch {
        /* race */
      }
    }
  }
}

/**
 * @param {any} app
 * @param {ChatSession} session
 */
export async function saveSessionToVault(app, session) {
  const body = serializeSession(session);
  await ensureFolder(app, SESSION_PATH.split('/').slice(0, -1).join('/'));
  const existing = app.vault.getAbstractFileByPath(SESSION_PATH);
  if (existing) await app.vault.modify(existing, body);
  else await app.vault.create(SESSION_PATH, body);
}

/**
 * Archive current (if non-empty) and return a fresh session.
 * @param {any} app
 * @param {ChatSession} session
 * @returns {Promise<ChatSession>}
 */
export async function rotateSession(app, session) {
  if (session?.messages?.length) {
    await ensureFolder(app, ARCHIVE_DIR);
    const name = `${archiveStamp()}-${(session.id || 'ses').slice(0, 12)}.json`;
    const path = `${ARCHIVE_DIR}/${name}`;
    const body = serializeSession(session);
    if (!app.vault.getAbstractFileByPath(path)) {
      try {
        await app.vault.create(path, body);
      } catch (e) {
        console.warn('archive session failed', e);
      }
    }
  }
  const empty = createEmptySession();
  await saveSessionToVault(app, empty);
  return empty;
}
