/**
 * Pure active-note context helpers (no Obsidian runtime).
 * Modes: follow | pin | off
 */

/**
 * @typedef {'follow' | 'pin' | 'off'} ActiveNoteMode
 * @typedef {{ path: string, kind?: string }} ContextChip
 * @typedef {{
 *   mode: ActiveNoteMode,
 *   followedPath: string | null,
 *   pinnedPath: string | null,
 * }} ActiveNoteState
 */

export const DEFAULT_ACTIVE_NOTE_MAX_CHARS = 8000;

/**
 * @param {Partial<ActiveNoteState>} [init]
 * @returns {ActiveNoteState}
 */
export function createActiveNoteState(init = {}) {
  return {
    mode: init.mode || 'follow',
    followedPath: init.followedPath ?? null,
    pinnedPath: init.pinnedPath ?? null,
  };
}

/**
 * Report a workspace markdown path change.
 * - follow: update followedPath when path is a non-empty md path
 * - pin / off: ignore path updates for selection
 * Non-markdown / null path must NOT clear followedPath (agent leaf focus).
 *
 * @param {ActiveNoteState} state
 * @param {string | null | undefined} markdownPath vault-relative .md path or null
 * @returns {ActiveNoteState}
 */
export function onMarkdownFocus(state, markdownPath) {
  const next = { ...state };
  const p = normalizeMdPath(markdownPath);
  if (!p) return next;
  if (next.mode === 'follow') {
    next.followedPath = p;
  }
  return next;
}

/**
 * @param {ActiveNoteState} state
 * @param {ActiveNoteMode} mode
 * @param {{ pinPath?: string | null }} [opts]
 * @returns {ActiveNoteState}
 */
export function setActiveNoteMode(state, mode, opts = {}) {
  const next = { ...state, mode };
  if (mode === 'pin') {
    const pin =
      normalizeMdPath(opts.pinPath) ||
      state.pinnedPath ||
      state.followedPath ||
      null;
    next.pinnedPath = pin;
  }
  if (mode === 'follow' && !next.followedPath && next.pinnedPath) {
    next.followedPath = next.pinnedPath;
  }
  return next;
}

/**
 * Effective note path for context injection, or null if off / none.
 * @param {ActiveNoteState} state
 * @returns {string | null}
 */
export function getEffectiveActivePath(state) {
  if (!state || state.mode === 'off') return null;
  if (state.mode === 'pin') return state.pinnedPath || state.followedPath || null;
  return state.followedPath || null;
}

/**
 * @param {string | null | undefined} p
 * @returns {string | null}
 */
export function normalizeMdPath(p) {
  if (p == null) return null;
  const s = String(p).replace(/\\/g, '/').replace(/^\.?\//, '').trim();
  if (!s) return null;
  if (!/\.md$/i.test(s)) return null;
  return s;
}

/**
 * Merge active-note path into manual chips (dedupe by path).
 * Active note is kind: 'active' and placed first when new.
 *
 * @param {ContextChip[]} manualChips
 * @param {string | null} activePath
 * @returns {ContextChip[]}
 */
export function mergeActiveNoteChips(manualChips, activePath) {
  const chips = Array.isArray(manualChips) ? manualChips.slice() : [];
  const active = normalizeMdPath(activePath);
  if (!active) return chips;
  if (chips.some((c) => c && c.path === active)) {
    return chips.map((c) =>
      c && c.path === active && !c.kind ? { ...c, kind: c.kind || 'ref' } : c
    );
  }
  return [{ path: active, kind: 'active' }, ...chips];
}

/**
 * Truncate note body for prompt attachment.
 * Prefer head-heavy slice with ellipsis when over max.
 *
 * @param {string} body
 * @param {number} [maxChars]
 * @returns {string}
 */
export function truncateNoteBody(body, maxChars = DEFAULT_ACTIVE_NOTE_MAX_CHARS) {
  const s = String(body ?? '');
  let max = Number(maxChars);
  if (!Number.isFinite(max) || max <= 0) max = DEFAULT_ACTIVE_NOTE_MAX_CHARS;
  if (s.length <= max) return s;
  if (max < 40) return s.slice(0, Math.max(1, max - 1)) + '…';
  const head = Math.floor(max * 0.75);
  const tail = Math.max(20, max - head - 10);
  return `${s.slice(0, head)}\n\n…\n\n${s.slice(-tail)}`;
}

/**
 * Build labeled context section for active / ref chips.
 * Pure: pass preloaded { path, content } map or content on each item.
 *
 * @param {Array<{ path: string, kind?: string, content?: string }>} chips
 * @param {{ maxChars?: number }} [opts]
 * @returns {string} empty if no chips; otherwise "## 附带上下文\n..." block body (without leading user text)
 */
export function formatContextSections(chips, opts = {}) {
  const maxChars = opts.maxChars ?? DEFAULT_ACTIVE_NOTE_MAX_CHARS;
  const list = Array.isArray(chips) ? chips : [];
  if (!list.length) return '';

  const parts = [];
  for (const c of list) {
    if (!c?.path) continue;
    if (c.kind === 'raw') {
      parts.push(`- 附件（原始证据，已入 raw）：${c.path}`);
      continue;
    }
    const title =
      c.kind === 'active'
        ? `### 当前打开笔记（自动）\n路径：\`${c.path}\``
        : `### 引用：${c.path}`;
    const body = truncateNoteBody(c.content ?? '', maxChars);
    parts.push(`${title}\n\n${body || '(空)'}`);
  }
  if (!parts.length) return '';
  return `## 附带上下文\n\n${parts.join('\n\n')}`;
}

/**
 * Compose user message + context sections.
 * @param {string} text
 * @param {Array<{ path: string, kind?: string, content?: string }>} chips
 * @param {{ maxChars?: number }} [opts]
 */
export function composeWithContext(text, chips, opts = {}) {
  const user = String(text ?? '');
  const section = formatContextSections(chips, opts);
  if (!section) return user;
  if (!user.trim()) return section;
  return `${user}\n\n${section}`;
}

/**
 * True if token looks like a vault path, not a natural-language sentence.
 * @param {string} token
 */
export function looksLikeVaultPath(token) {
  const t = String(token || '').trim();
  if (!t || t.length > 240) return false;
  // Must look like a path or .md file — never a Chinese sentence without slashes
  if (/\.md$/i.test(t)) return true;
  if (t.includes('/') || t.includes('\\')) return true;
  // bare folder-ish tokens without whitespace
  if (!/\s/.test(t) && /^[\w.\u4e00-\u9fff-]+$/.test(t) && t.length < 80) {
    // still reject pure imperative phrases
    if (/消化|记住|帮我|所有|全部|一下|什么|怎么|请/.test(t)) return false;
    return true;
  }
  return false;
}

/**
 * Detect batch digest intents from free text (e.g. 所有日记).
 * @param {string} text
 * @returns {{ type: 'single' } | { type: 'folder-glob', folders: string[], label: string }}
 */
export function parseDigestIntent(text) {
  const t = String(text || '').trim();
  if (!t) return { type: 'single' };
  if (/日记/.test(t) && /(所有|全部|批量|都|全部消化|消化一下)/.test(t)) {
    return {
      type: 'folder-glob',
      folders: ['手记/日记', '手记/手写日记'],
      label: '日记',
    };
  }
  if (/(所有|全部).*(笔记|手记)/.test(t) && /消化|digest/i.test(t)) {
    return {
      type: 'folder-glob',
      folders: ['手记'],
      label: '手记',
    };
  }
  return { type: 'single' };
}

/**
 * Digest source path: first **manual** chip (not raw/active), else active path
 * when allowed, else body token **only if it looks like a path**.
 *
 * Kind `active` is never treated as an explicit user @ — mirrors chat-panel
 * wiring where buildSendChips() pre-merges the active note.
 *
 * @param {{
 *   chips?: ContextChip[],
 *   activePath?: string | null,
 *   bodyText?: string,
 *   useActiveForDigest?: boolean,
 * }} args
 * @returns {string}
 */
export function resolveDigestSourcePath(args = {}) {
  const chips = args.chips || [];
  // Explicit user refs only (skip auto-injected active + raw attachments)
  const explicitChip = chips.find(
    (c) => c && c.path && c.kind !== 'raw' && c.kind !== 'active'
  );
  if (explicitChip?.path) {
    return String(explicitChip.path).replace(/^@/, '').split(/\s+/)[0];
  }

  if (args.useActiveForDigest !== false) {
    const fromArg = normalizeMdPath(args.activePath);
    if (fromArg) return fromArg;
    const fromChip = normalizeMdPath(
      chips.find((c) => c && c.kind === 'active')?.path
    );
    if (fromChip) return fromChip;
  }

  const body = String(args.bodyText || '').trim();
  if (!body) return '';
  // Prefer @path token in body
  const at = body.match(/@([^\s]+)/);
  if (at) {
    const p = at[1];
    const asMd = /\.md$/i.test(p) ? p : `${p}.md`;
    if (looksLikeVaultPath(p) || looksLikeVaultPath(asMd)) {
      return /\.md$/i.test(p) ? p : asMd;
    }
  }
  const token = body.replace(/^@/, '').split(/\s+/)[0] || '';
  if (!looksLikeVaultPath(token)) return '';
  return token;
}

/**
 * Collect .md paths under folders (recursive, vault-relative).
 * Pure helper: pass a listAllMdPaths(folder) → string[] function.
 *
 * @param {string[]} folders
 * @param {(folder: string) => string[]} listMdUnder
 * @param {{ limit?: number, excludeNames?: string[] }} [opts]
 * @returns {string[]}
 */
export function collectMdPathsUnder(folders, listMdUnder, opts = {}) {
  const limit = opts.limit ?? 500;
  const exclude = new Set(opts.excludeNames || ['README.md', '00-入口.md']);
  const out = [];
  const seen = new Set();
  for (const folder of folders || []) {
    let paths = [];
    try {
      paths = listMdUnder(folder) || [];
    } catch {
      paths = [];
    }
    for (const p of paths) {
      const name = String(p).split('/').pop();
      if (exclude.has(name)) continue;
      if (!/\.md$/i.test(p)) continue;
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Panel-style digest source resolution: merge active into chips for chat, then
 * resolve digest source (legacy helper; Grok skill /me-digest now resolves paths itself).
 *
 * @param {{
 *   manualChips?: ContextChip[],
 *   activePath?: string | null,
 *   bodyText?: string,
 *   useActiveForDigest?: boolean,
 * }} args
 */
export function resolveDigestSourceAfterMerge(args = {}) {
  const manual = args.manualChips || [];
  const activePath = normalizeMdPath(args.activePath);
  const useActive = args.useActiveForDigest !== false;
  // Chat send merges active for context; digest must still prefer @ manual
  const merged = mergeActiveNoteChips(manual, useActive ? activePath : null);
  // When useActiveForDigest is false, do not pass activePath (and no active chip)
  return resolveDigestSourcePath({
    chips: useActive ? merged : manual,
    activePath: useActive ? activePath : null,
    bodyText: args.bodyText,
    useActiveForDigest: useActive,
  });
}

/**
 * Whether a workspace leaf kind should update followed markdown.
 * @param {{ viewType?: string, filePath?: string | null }} leaf
 * @returns {string | null} markdown path to report, or null to keep cache
 */
export function markdownPathFromLeaf(leaf) {
  if (!leaf) return null;
  const vt = String(leaf.viewType || '');
  // Agent / homepage leaves must not clear context
  if (
    vt === 'me-soul-chat' ||
    vt.includes('me-soul') ||
    vt.includes('agent-os') ||
    vt === 'empty'
  ) {
    return null;
  }
  if (vt === 'markdown' || vt === 'MarkdownView') {
    return normalizeMdPath(leaf.filePath);
  }
  // Unknown view with md path still ok
  return normalizeMdPath(leaf.filePath);
}
