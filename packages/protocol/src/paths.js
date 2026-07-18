/**
 * Default vault write-policy helpers.
 * Human zones require approved pending; agent-inbox is free-write.
 * Fork HUMAN_ZONES to match your vault top-level folders.
 */

export const HUMAN_ZONES = ['手记', '项目库', '资料库', '基础学科'];
export const AGENT_INBOX = 'agent-inbox';

/**
 * Normalize to vault-relative POSIX path (no leading slash).
 * @param {string} p
 */
export function vaultRel(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/+/g, '/');
}

/**
 * @param {string} relPath vault-relative
 * @returns {boolean}
 */
export function isAgentInboxPath(relPath) {
  const p = vaultRel(relPath);
  return p === AGENT_INBOX || p.startsWith(`${AGENT_INBOX}/`);
}

/**
 * @param {string} relPath
 * @returns {boolean}
 */
export function isHumanZonePath(relPath) {
  const p = vaultRel(relPath);
  return HUMAN_ZONES.some((z) => p === z || p.startsWith(`${z}/`));
}

/**
 * Whether a write is allowed without an approved pending record.
 * @param {string} relPath
 * @param {{ approvedPending?: boolean }} [opts]
 * @returns {{ allowed: boolean, reason: string }}
 */
export function checkWritePolicy(relPath, opts = {}) {
  const p = vaultRel(relPath);
  if (!p) return { allowed: false, reason: 'empty path' };
  if (p.includes('..')) return { allowed: false, reason: 'path traversal blocked' };
  if (isAgentInboxPath(p)) return { allowed: true, reason: 'agent-inbox free-write' };
  if (isHumanZonePath(p)) {
    if (opts.approvedPending) {
      return { allowed: true, reason: 'human zone with approved pending' };
    }
    return { allowed: false, reason: 'human zone requires approved pending' };
  }
  // other top-level (AGENTS.md, 00-首页, tmp, etc.) — deny by default for skills
  if (opts.approvedPending) {
    return { allowed: true, reason: 'non-inbox with approved pending' };
  }
  return { allowed: false, reason: 'outside agent-inbox requires approved pending' };
}

/**
 * Assert all planned write paths are legal.
 * @param {string[]} paths
 * @param {{ approvedPending?: boolean }} [opts]
 */
export function assertWritesAllowed(paths, opts = {}) {
  const bad = [];
  for (const p of paths) {
    const r = checkWritePolicy(p, opts);
    if (!r.allowed) bad.push({ path: p, reason: r.reason });
  }
  return { ok: bad.length === 0, violations: bad };
}
