/**
 * Confirm / pending state machine.
 * status: pending → approved | rejected → applied (from approved only)
 */

/** @typedef {'pending'|'approved'|'rejected'|'applied'} ConfirmStatus */

const TRANSITIONS = {
  pending: new Set(['approved', 'rejected']),
  approved: new Set(['applied', 'pending']), // pending = un-approve/edit
  rejected: new Set(['pending']), // reopen
  applied: new Set([]),
};

/**
 * @param {ConfirmStatus} from
 * @param {ConfirmStatus} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  return TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * @param {{ status?: string, [k: string]: unknown }} record
 * @param {ConfirmStatus} to
 * @param {{ actor?: string, note?: string }} [opts]
 * @returns {{ ok: true, record: object } | { ok: false, error: string }}
 */
export function transitionConfirm(record, to, opts = {}) {
  const from = /** @type {ConfirmStatus} */ (record.status || 'pending');
  if (!canTransition(from, to)) {
    return { ok: false, error: `illegal transition ${from} → ${to}` };
  }
  const next = {
    ...record,
    status: to,
    updatedAt: new Date().toISOString(),
    lastActor: opts.actor || 'user',
    lastNote: opts.note || '',
    history: [
      ...(Array.isArray(record.history) ? record.history : []),
      { from, to, at: new Date().toISOString(), actor: opts.actor || 'user', note: opts.note || '' },
    ],
  };
  return { ok: true, record: next };
}

/**
 * Parse a pending markdown file (YAML-ish frontmatter + body).
 * @param {string} md
 * @returns {{ status: ConfirmStatus, type: string, path: string, title: string, body: string, source_paths: string[], raw: string }}
 */
export function parsePendingMarkdown(md) {
  const text = String(md || '');
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  /** @type {Record<string, string>} */
  const meta = {};
  let body = text;
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+)\s*:\s*(.*)$/);
      if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    body = fm[2];
  }
  let source_paths = [];
  if (meta.source_paths) {
    try {
      source_paths = JSON.parse(meta.source_paths);
    } catch {
      source_paths = meta.source_paths
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
  }
  return {
    status: /** @type {ConfirmStatus} */ (meta.status || 'pending'),
    type: meta.type || 'digest',
    path: meta.path || '',
    title: meta.title || 'pending',
    body: body.trim(),
    source_paths,
    created: meta.created || '',
    raw: text,
  };
}

/**
 * Serialize pending record to markdown with frontmatter.
 * @param {object} rec
 * @returns {string}
 */
export function serializePendingMarkdown(rec) {
  const source =
    Array.isArray(rec.source_paths) && rec.source_paths.length
      ? JSON.stringify(rec.source_paths)
      : '[]';
  return [
    '---',
    `status: ${rec.status || 'pending'}`,
    `type: ${rec.type || 'digest'}`,
    `title: ${rec.title || 'pending'}`,
    `created: ${rec.created || new Date().toISOString().slice(0, 10)}`,
    `path: ${rec.path || ''}`,
    `source_paths: ${source}`,
    '---',
    '',
    rec.body || '',
    '',
  ].join('\n');
}

/**
 * Approve path used by plugin + CLI — pure, no FS.
 * @param {string} pendingMd
 * @returns {{ ok: true, markdown: string, record: object } | { ok: false, error: string }}
 */
export function approvePendingMarkdown(pendingMd) {
  const rec = parsePendingMarkdown(pendingMd);
  const t = transitionConfirm(rec, 'approved', { actor: 'plugin' });
  if (!t.ok) return t;
  return { ok: true, markdown: serializePendingMarkdown(t.record), record: t.record };
}

/**
 * @param {string} pendingMd
 */
export function rejectPendingMarkdown(pendingMd) {
  const rec = parsePendingMarkdown(pendingMd);
  const t = transitionConfirm(rec, 'rejected', { actor: 'plugin' });
  if (!t.ok) return t;
  return { ok: true, markdown: serializePendingMarkdown(t.record), record: t.record };
}

/**
 * @param {string} pendingMd
 */
export function applyPendingMarkdown(pendingMd) {
  const rec = parsePendingMarkdown(pendingMd);
  if (rec.status !== 'approved') {
    return { ok: false, error: `cannot apply from status=${rec.status}` };
  }
  const t = transitionConfirm(rec, 'applied', { actor: 'skill' });
  if (!t.ok) return t;
  return { ok: true, markdown: serializePendingMarkdown(t.record), record: t.record };
}
