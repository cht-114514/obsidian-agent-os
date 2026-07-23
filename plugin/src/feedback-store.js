/**
 * Feedback day-log store under agent-inbox/soul/feedback/YYYY-MM-DD.md
 *
 * Entry shape:
 * ## HH:mm 👍 <!--fb:f_xxx-->
 *
 * > excerpt…
 *
 * **用户反馈：**
 * note text…
 */

export const FEEDBACK_DIR = 'agent-inbox/soul/feedback';

/**
 * @returns {string}
 */
export function makeFeedbackId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `f_${t}_${r}`;
}

/**
 * @param {Date} [d]
 * @returns {{ date: string, time: string, path: string }}
 */
export function feedbackDayMeta(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { date, time, path: `${FEEDBACK_DIR}/${date}.md` };
}

/**
 * Normalize vote to emoji or null.
 * @param {string | null | undefined} vote
 * @returns {'👍' | '👎' | '📝' | null}
 */
export function normalizeVote(vote) {
  if (vote == null || vote === '') return null;
  const s = String(vote).trim();
  if (s === 'up' || s === '👍' || s === '+1') return '👍';
  if (s === 'down' || s === '👎' || s === '-1') return '👎';
  if (s === 'note' || s === '📝' || s === 'feedback') return '📝';
  if (s === '👍' || s === '👎' || s === '📝') return /** @type {any} */ (s);
  return null;
}

/**
 * @typedef {{
 *   id: string,
 *   time: string,
 *   vote: string,
 *   excerpt: string,
 *   note: string,
 *   raw: string,
 * }} FeedbackEntry
 */

/**
 * Parse a feedback day file into entries (by <!--fb:id-->).
 * @param {string} md
 * @returns {FeedbackEntry[]}
 */
export function parseFeedbackFile(md) {
  const text = String(md || '');
  if (!text.trim()) return [];

  // Split on ## headers that look like feedback sections
  const parts = text.split(/(?=^##\s+)/m);
  /** @type {FeedbackEntry[]} */
  const out = [];
  for (const part of parts) {
    const m = part.match(
      /^##\s+(\d{1,2}:\d{2})\s+(\S+)\s+<!--fb:([a-zA-Z0-9_]+)-->\s*\n([\s\S]*)$/
    );
    if (!m) continue;
    const time = m[1];
    const vote = m[2];
    const id = m[3];
    const body = m[4] || '';
    let excerpt = '';
    let note = '';
    const noteSplit = body.split(/\n\*\*用户反馈：\*\*\s*\n/);
    const head = noteSplit[0] || '';
    if (noteSplit.length > 1) {
      note = noteSplit.slice(1).join('\n**用户反馈：**\n').trim();
    }
    // quoted excerpt lines
    const lines = head.split('\n');
    const q = [];
    for (const line of lines) {
      if (/^>\s?/.test(line)) q.push(line.replace(/^>\s?/, ''));
    }
    excerpt = q.join('\n').trim();
    out.push({ id, time, vote, excerpt, note, raw: part });
  }
  return out;
}

/**
 * Build one section markdown (includes leading newline for append).
 * @param {{
 *   id: string,
 *   time: string,
 *   vote: string,
 *   excerpt?: string,
 *   note?: string,
 * }} opts
 */
export function formatFeedbackEntry(opts) {
  const vote = normalizeVote(opts.vote) || opts.vote || '📝';
  const time = opts.time || '00:00';
  const id = opts.id;
  const excerpt = String(opts.excerpt || '').slice(0, 600);
  const note = String(opts.note || '').trim();
  const quoted = excerpt
    ? excerpt
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
    : '> （无摘录）';
  let body = `\n## ${time} ${vote} <!--fb:${id}-->\n\n${quoted}\n`;
  if (note) {
    body += `\n**用户反馈：**\n${note}\n`;
  }
  return body;
}

/**
 * Remove or replace a section by id. Pure.
 * @param {string} md
 * @param {string} id
 * @param {string | null} replacement full section text or null to delete
 * @returns {{ md: string, found: boolean }}
 */
export function replaceFeedbackSection(md, id, replacement) {
  const text = String(md || '');
  const re = new RegExp(
    `(?:^|\\n)(##\\s+\\d{1,2}:\\d{2}\\s+\\S+\\s+<!--fb:${escapeRe(id)}-->\\s*\\n[\\s\\S]*?)(?=\\n##\\s+|$)`,
    'm'
  );
  const m = text.match(re);
  if (!m) return { md: text, found: false };

  const fullMatch = m[0];
  // preserve leading newline style
  let next;
  if (replacement == null || replacement === '') {
    next = text.replace(fullMatch, (chunk) => {
      // keep a single newline if we strip mid-file
      return chunk.startsWith('\n') ? '\n' : '';
    });
    // clean triple newlines
    next = next.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
    if (next && !next.startsWith('#')) {
      /* keep */
    }
  } else {
    const repl = replacement.startsWith('\n') ? replacement : `\n${replacement}`;
    // if match started without newline at BOF
    if (!fullMatch.startsWith('\n') && text.indexOf(fullMatch) === 0) {
      next = text.replace(fullMatch, replacement.replace(/^\n/, ''));
    } else {
      next = text.replace(fullMatch, repl.startsWith('\n') ? repl : `\n${repl}`);
    }
  }
  return { md: next, found: true };
}

/**
 * Update vote emoji in a section (keep excerpt/note). Pure.
 * @param {string} md
 * @param {string} id
 * @param {string} vote emoji
 */
export function setVoteInFile(md, id, vote) {
  const entries = parseFeedbackFile(md);
  const e = entries.find((x) => x.id === id);
  if (!e) return { md, found: false };
  const v = normalizeVote(vote) || vote;
  const { time } = feedbackDayMeta(); // keep original time from entry
  const section = formatFeedbackEntry({
    id,
    time: e.time,
    vote: v,
    excerpt: e.excerpt,
    note: e.note,
  });
  return replaceFeedbackSection(md, id, section);
}

/**
 * Attach or replace user note on entry. Pure.
 * @param {string} md
 * @param {string} id
 * @param {string} note
 * @param {string} [vote]
 */
export function setNoteInFile(md, id, note, vote) {
  const entries = parseFeedbackFile(md);
  const e = entries.find((x) => x.id === id);
  if (!e) return { md, found: false };
  const section = formatFeedbackEntry({
    id,
    time: e.time,
    vote: vote ? normalizeVote(vote) || vote : e.vote,
    excerpt: e.excerpt,
    note,
  });
  return replaceFeedbackSection(md, id, section);
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Vault-backed helpers (need Obsidian app-like adapter).
 * @typedef {{
 *   vault: {
 *     getAbstractFileByPath: (p: string) => any,
 *     read: (f: any) => Promise<string>,
 *     modify: (f: any, c: string) => Promise<void>,
 *     create: (p: string, c: string) => Promise<any>,
 *     createFolder?: (p: string) => Promise<any>,
 *     adapter?: { exists?: (p: string) => Promise<boolean> },
 *   }
 * }} AppLike
 */

/**
 * @param {AppLike} app
 * @param {string} dir
 */
async function ensureFolder(app, dir) {
  const parts = dir.split('/').filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try {
        await app.vault.createFolder?.(cur);
      } catch {
        /* exists */
      }
    }
  }
}

/**
 * @param {AppLike} app
 * @param {{
 *   id: string,
 *   vote: string,
 *   excerpt?: string,
 *   note?: string,
 *   date?: Date,
 * }} opts
 */
export async function appendFeedbackEntry(app, opts) {
  const meta = feedbackDayMeta(opts.date);
  await ensureFolder(app, FEEDBACK_DIR);
  const entry = formatFeedbackEntry({
    id: opts.id,
    time: meta.time,
    vote: opts.vote,
    excerpt: opts.excerpt,
    note: opts.note,
  });
  const f = app.vault.getAbstractFileByPath(meta.path);
  if (f) {
    const old = await app.vault.read(f);
    // if id already exists, replace instead of duplicate
    const existing = parseFeedbackFile(old).find((e) => e.id === opts.id);
    if (existing) {
      const section = formatFeedbackEntry({
        id: opts.id,
        time: existing.time,
        vote: opts.vote,
        excerpt: opts.excerpt != null ? opts.excerpt : existing.excerpt,
        note: opts.note != null ? opts.note : existing.note,
      });
      const { md } = replaceFeedbackSection(old, opts.id, section);
      await app.vault.modify(f, md);
      return { path: meta.path, id: opts.id, created: false };
    }
    await app.vault.modify(f, old + entry);
  } else {
    await app.vault.create(meta.path, `# Feedback ${meta.date}\n${entry}`);
  }
  return { path: meta.path, id: opts.id, created: true };
}

/**
 * @param {AppLike} app
 * @param {string} id
 * @param {string | null} vote null = delete entry
 * @param {{ date?: Date, note?: string, excerpt?: string }} [opts]
 */
export async function updateFeedbackVote(app, id, vote, opts = {}) {
  const meta = feedbackDayMeta(opts.date);
  const f = app.vault.getAbstractFileByPath(meta.path);
  if (!f) return { ok: false, reason: 'missing-file' };
  const old = await app.vault.read(f);

  if (vote == null) {
    const { md, found } = replaceFeedbackSection(old, id, null);
    if (!found) return { ok: false, reason: 'not-found' };
    await app.vault.modify(f, md.startsWith('#') ? md : md.trimStart());
    // if file only has title left, keep it
    return { ok: true, deleted: true };
  }

  const entries = parseFeedbackFile(old);
  const e = entries.find((x) => x.id === id);
  if (!e) return { ok: false, reason: 'not-found' };

  const section = formatFeedbackEntry({
    id,
    time: e.time,
    vote,
    excerpt: opts.excerpt != null ? opts.excerpt : e.excerpt,
    note: opts.note != null ? opts.note : e.note,
  });
  const { md, found } = replaceFeedbackSection(old, id, section);
  if (!found) return { ok: false, reason: 'not-found' };
  await app.vault.modify(f, md);
  return { ok: true, deleted: false };
}
