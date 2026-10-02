/**
 * Vault access for the Mac service.
 *
 * The service — not the phone — performs note reads, searches, and agent-owned
 * writes. iCloud still does the syncing; this module only reads and writes the
 * same files Obsidian sees.
 *
 * Safety rules
 * ------------
 * 1. Every path is resolved against the vault root and rejected if it escapes
 *    it (`..`, absolute paths, symlinked components).
 * 2. Only markdown/text is readable, and never anything inside `.obsidian/`
 *    or another dot-directory. No binary exfiltration.
 * 3. Writes follow the same policy the plugin uses: `agent-inbox/` is
 *    free-write, human zones need an approved confirmation, everything else is
 *    denied.
 * 4. Every write is compare-and-set on the content fingerprint, so a
 *    confirmation that was shown against older text can never overwrite newer
 *    text.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { checkWritePolicy, isHumanZonePath, vaultRel, AGENT_INBOX } from '@obsidian-agent-os/protocol';

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.yml', '.yaml', '.csv']);
const MAX_READ_BYTES = 512 * 1024;
const DENIED_SEGMENTS = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.obsidian-mobile']);
/** Only these top-level folders may be enumerated/searched. */
const SKIP_TOP = new Set(['.obsidian', '.obsidian-mobile', '.trash', '.git', 'node_modules']);

export function fingerprintOf(content) {
  return `sha256:${createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex')}`;
}

export class VaultPathError extends Error {
  constructor(message, code = 'BAD_PATH') {
    super(message);
    this.code = code;
  }
}

/**
 * @param {{ root: string }} opts
 */
export function createVault(opts) {
  const root = resolve(opts.root || '');
  const enabled = !!opts.root && existsSync(root);

  function ensureEnabled() {
    if (!enabled) {
      throw Object.assign(new Error('vault path is not configured or not readable'), {
        code: 'VAULT_UNAVAILABLE',
      });
    }
  }

  /** Resolve a vault-relative path, rejecting anything that escapes the root. */
  function resolveInside(relPath) {
    ensureEnabled();
    const raw = String(relPath ?? '');
    // Absolute paths are never vault-relative, however they are normalized.
    if (raw.startsWith('/') || raw.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(raw)) {
      throw new VaultPathError('absolute paths are not allowed');
    }
    if (raw.split(/[\\/]/).some((segment) => segment === '..')) {
      throw new VaultPathError('path traversal blocked');
    }
    const rel = vaultRel(raw);
    if (!rel) throw new VaultPathError('empty path');
    const absolute = resolve(root, rel);
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new VaultPathError('path escapes the vault');
    }
    for (const segment of rel.split('/')) {
      if (DENIED_SEGMENTS.has(segment)) throw new VaultPathError(`blocked path segment: ${segment}`);
    }
    return { rel, absolute };
  }

  function readNote(relPath, { maxBytes = MAX_READ_BYTES } = {}) {
    const { rel, absolute } = resolveInside(relPath);
    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
    if (rel.includes('.') && !TEXT_EXT.has(ext)) {
      throw new VaultPathError(`unsupported file type: ${ext || 'none'}`, 'UNSUPPORTED_TYPE');
    }
    if (!existsSync(absolute)) {
      throw Object.assign(new Error(`找不到 ${rel}`), { code: 'NOT_FOUND' });
    }
    const stat = statSync(absolute);
    if (!stat.isFile()) throw new VaultPathError(`${rel} is not a file`);
    if (stat.size > maxBytes) {
      const content = readFileSync(absolute, 'utf8').slice(0, maxBytes);
      return {
        path: rel,
        content,
        truncated: true,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        fingerprint: fingerprintOf(content),
        humanZone: isHumanZonePath(rel),
      };
    }
    const content = readFileSync(absolute, 'utf8');
    return {
      path: rel,
      content,
      truncated: false,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      fingerprint: fingerprintOf(content),
      humanZone: isHumanZonePath(rel),
    };
  }

  /** Compare-and-set write. `expectFingerprint` may be null only for creation. */
  async function writeNote(relPath, content, precondition = {}) {
    const { rel, absolute } = resolveInside(relPath);
    const policy = checkWritePolicy(rel, { approvedPending: !!precondition.approvedPending });
    if (!policy.allowed) {
      const error = Object.assign(new Error(policy.reason), { code: 'POLICY_DENIED', reason: policy.reason });
      error.requiresConfirmation = isHumanZonePath(rel) || rel.split('/').length > 0;
      throw error;
    }
    const exists = existsSync(absolute);
    if (exists) {
      const current = readFileSync(absolute, 'utf8');
      const currentFp = fingerprintOf(current);
      if (precondition.expectFingerprint === undefined) {
        throw Object.assign(new Error('写入前必须提供 expectFingerprint'), { code: 'PRECONDITION_REQUIRED' });
      }
      if (precondition.expectFingerprint !== currentFp) {
        // The note changed after the user was shown the diff: re-display.
        const error = Object.assign(new Error('笔记内容已经变化，请重新确认'), {
          code: 'PRECONDITION_FAILED',
        });
        error.current = { fingerprint: currentFp, content: current.slice(0, 20000) };
        throw error;
      }
    } else if (precondition.requireExisting) {
      throw Object.assign(new Error(`找不到 ${rel}`), { code: 'NOT_FOUND' });
    }
    await fsp.mkdir(dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, String(content ?? ''), 'utf8');
    const stat = statSync(absolute);
    return {
      path: rel,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      fingerprint: fingerprintOf(content),
      created: !exists,
    };
  }

  /** Markdown paths under a prefix, newest-first is not guaranteed; sorted asc. */
  function listNotes(prefix = '', limit = 2000) {
    ensureEnabled();
    const base = prefix ? resolveInside(prefix).absolute : root;
    const out = [];
    walk(base, out, limit);
    return out.slice(0, limit);
  }

  function walk(dir, out, limit) {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name.startsWith('.')) continue;
      if (SKIP_TOP.has(entry.name) && dir === root) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, out, limit);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
      if (!TEXT_EXT.has(ext)) continue;
      out.push(toRel(absolute));
    }
  }

  function toRel(absolute) {
    return relative(root, absolute).split(sep).join('/');
  }

  /** Filename + text search. Returns short excerpts only. */
  function searchNotes(query, limit = 12) {
    ensureEnabled();
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];
    const hits = [];
    for (const rel of listNotes('', 4000)) {
      if (hits.length >= limit) break;
      let content = '';
      try {
        content = readFileSync(join(root, rel), 'utf8');
      } catch {
        continue;
      }
      const lowerName = rel.toLowerCase();
      const index = content.toLowerCase().indexOf(needle);
      if (index < 0 && !lowerName.includes(needle)) continue;
      const excerpt =
        index >= 0
          ? content.slice(Math.max(0, index - 60), index + 140).replace(/\s+/g, ' ').trim()
          : '';
      hits.push({
        path: rel,
        title: rel.slice(rel.lastIndexOf('/') + 1).replace(/\.(md|markdown|txt)$/i, ''),
        excerpt,
        humanZone: isHumanZonePath(rel),
        mtimeMs: safeMtime(rel),
      });
    }
    return hits;
  }

  function safeMtime(rel) {
    try {
      return statSync(join(root, rel)).mtimeMs;
    } catch {
      return 0;
    }
  }

  return {
    root,
    enabled,
    agentInbox: AGENT_INBOX,
    resolveInside,
    readNote,
    writeNote,
    listNotes,
    searchNotes,
    toRel,
    status() {
      return {
        configured: !!opts.root,
        root,
        readable: enabled,
        notes: enabled ? listNotes('', 5000).length : 0,
      };
    },
    /** Shape used by the phone's confirm cards. */
    describeWrite(relPath, content) {
      const { rel } = resolveInside(relPath);
      const exists = existsSync(join(root, rel));
      const current = exists ? readFileSync(join(root, rel), 'utf8') : '';
      return {
        path: rel,
        exists,
        humanZone: isHumanZonePath(rel),
        currentFingerprint: exists ? fingerprintOf(current) : null,
        proposedFingerprint: fingerprintOf(content),
        currentBytes: current.length,
        proposedBytes: String(content ?? '').length,
      };
    },
  };
}
