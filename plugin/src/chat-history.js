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

/**
 * Short label for history UI.
 * @param {ChatSession} session
 * @param {string} [path]
 */
export function summarizeSession(session, path = '') {
  const msgs = session?.messages || [];
  const firstUser = msgs.find((m) => m.role === 'user');
  const title = String(firstUser?.text || '空会话')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
  return {
    path: path || SESSION_PATH,
    id: session?.id || '',
    updatedAt: session?.updatedAt || '',
    messageCount: msgs.length,
    title: title || '空会话',
  };
}

/**
 * Map vault session → command-bar in-memory turns.
 * @param {ChatSession} session
 * @returns {Array<{ role: 'user' | 'assistant', text: string }>}
 */
export function sessionToCmdbarTurns(session) {
  return (session?.messages || []).map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    text: String(m.text || ''),
  }));
}

/**
 * Build bounded, explicit context for a model turn.
 * Empty messages are ignored so failed turns do not evict meaningful context.
 * @param {ChatSession} session
 * @param {{ currentUserText?: string, maxTurns?: number, maxChars?: number }} [opts]
 */
export function formatRecentConversation(session, opts = {}) {
  const current = String(opts.currentUserText || '').trim();
  const maxTurns = Math.max(2, Number(opts.maxTurns) || 10);
  const maxChars = Math.max(1000, Number(opts.maxChars) || 10_000);
  let messages = (session?.messages || [])
    .map((m) => ({
      role: m.role === 'user' ? '用户' : '助手',
      text: String(m.text || '').trim(),
    }))
    .filter((m) => m.text);

  // appendUser persists the current turn before the prompt is assembled.
  const last = messages[messages.length - 1];
  if (last?.role === '用户' && current && last.text === current) {
    messages = messages.slice(0, -1);
  }
  messages = messages.slice(-maxTurns);

  const blocks = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const perTurn = 3200;
    const text =
      m.text.length <= perTurn
        ? m.text
        : `${m.text.slice(0, 2400)}\n…（中段截断）…\n${m.text.slice(-700)}`;
    const block = `### ${m.role}\n${text}`;
    if (blocks.length && used + block.length > maxChars) break;
    blocks.unshift(block);
    used += block.length;
  }
  return blocks.join('\n\n');
}

/**
 * @param {any} app
 * @param {string} path
 * @returns {Promise<ChatSession>}
 */
export async function loadSessionFromPath(app, path) {
  const p = String(path || '').trim();
  if (!p) return createEmptySession();
  const f = app.vault.getAbstractFileByPath(p);
  if (!f) return createEmptySession();
  try {
    const raw = await app.vault.read(f);
    return parseSession(raw);
  } catch {
    return createEmptySession();
  }
}

/**
 * List archived session files (newest first).
 * @param {any} app
 * @returns {Promise<Array<ReturnType<typeof summarizeSession>>>}
 */
export async function listArchivedSessions(app) {
  await ensureFolder(app, ARCHIVE_DIR);
  const folder = app.vault.getAbstractFileByPath(ARCHIVE_DIR);
  if (!folder || !folder.children) return [];

  /** @type {Array<{ path: string, mtime: number }>} */
  const files = [];
  for (const child of folder.children) {
    const p = child?.path || '';
    if (!p.endsWith('.json')) continue;
    files.push({
      path: p,
      mtime: typeof child.stat?.mtime === 'number' ? child.stat.mtime : 0,
    });
  }
  files.sort((a, b) => b.mtime - a.mtime);

  /** @type {Array<ReturnType<typeof summarizeSession>>} */
  const out = [];
  for (const f of files) {
    try {
      const session = await loadSessionFromPath(app, f.path);
      out.push(summarizeSession(session, f.path));
    } catch {
      out.push({
        path: f.path,
        id: '',
        updatedAt: '',
        messageCount: 0,
        title: f.path.split('/').pop() || f.path,
      });
    }
  }
  return out;
}

/**
 * Delete a session JSON (archive or current).
 * @param {any} app
 * @param {string} path
 */
export async function deleteSessionFile(app, path) {
  const p = String(path || '').trim();
  if (!p) return false;
  const f = app.vault.getAbstractFileByPath(p);
  if (!f) return false;
  await app.vault.delete(f);
  return true;
}

/**
 * Content fingerprint for duplicate detection (ignores session id / timestamps).
 * @param {ChatSession} session
 */
export function sessionContentFingerprint(session) {
  return (session?.messages || [])
    .map((m) => `${m.role === 'user' ? 'u' : 'a'}:${String(m.text || '')}`)
    .join('\n\u001e\n');
}

/**
 * Make an archived session the current one (promote, not copy).
 * Parks the present disk current first if it has different content, then
 * deletes the source archive so reloads do not multiply history entries.
 * @param {any} app
 * @param {string} archivePath
 * @param {ChatSession} [currentSession] unused; disk current is SSOT
 * @returns {Promise<ChatSession>}
 */
export async function restoreArchivedSession(app, archivePath, _currentSession) {
  const incoming = await loadSessionFromPath(app, archivePath);
  if (!incoming.messages?.length) {
    throw new Error('该归档为空或无法读取');
  }
  // Disk is the shared SSOT. The mounted panel may be stale when command bar
  // has updated current.json while an existing fullscreen leaf stayed open.
  const diskCurrent = await loadSessionFromVault(app);
  const sameContent =
    !!diskCurrent.messages?.length &&
    sessionContentFingerprint(diskCurrent) === sessionContentFingerprint(incoming);
  if (diskCurrent.messages?.length && !sameContent) {
    await rotateSession(app, diskCurrent);
  }
  // Keep stable-ish identity when re-opening the same conversation
  const next = {
    ...incoming,
    id: sameContent && diskCurrent.id ? diskCurrent.id : newId('ses'),
    updatedAt: new Date().toISOString(),
  };
  await saveSessionToVault(app, next);
  // Promote: drop source archive so the same chat is not listed twice
  await deleteSessionFile(app, archivePath);
  return next;
}
