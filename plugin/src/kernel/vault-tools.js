/**
 * Vault tools executed inside Obsidian. The gateway only sees descriptors;
 * reads and writes go through the injected vault adapter (app.vault).
 */
import { checkWritePolicy, vaultRel } from '@obsidian-agent-os/protocol';

export const VAULT_COMMANDS = [
  'vault.search',
  'vault.read',
  'vault.list',
  'vault.write',
  'vault.active_note',
];

export const VAULT_TOOL_DEFS = [
  {
    pluginId: 'obsidian-agent-os',
    name: 'vault_search',
    command: 'vault.search',
    description: 'Search vault notes by filename or text. Returns paths and short excerpts.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    pluginId: 'obsidian-agent-os',
    name: 'vault_read',
    command: 'vault.read',
    description: 'Read one vault note by relative path.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    pluginId: 'obsidian-agent-os',
    name: 'vault_list',
    command: 'vault.list',
    description: 'List markdown paths under an optional prefix.',
    parameters: {
      type: 'object',
      properties: { prefix: { type: 'string' } },
    },
  },
  {
    pluginId: 'obsidian-agent-os',
    name: 'vault_active_note',
    command: 'vault.active_note',
    description: 'Return the note currently open in Obsidian, if any.',
    parameters: { type: 'object', properties: {} },
  },
  {
    pluginId: 'obsidian-agent-os',
    name: 'vault_write',
    command: 'vault.write',
    description:
      'Write a note. agent-inbox is written immediately. Human zones (手记, 项目库, 资料库, 基础学科) become a pending file the user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
];

function slug(path) {
  return vaultRel(path)
    .split('/')
    .pop()
    .replace(/\.md$/i, '')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, '-')
    .slice(0, 48) || 'note';
}

function today(now) {
  const d = now ? new Date(now) : new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function buildPendingWrite(path, content, now) {
  const rel = vaultRel(path);
  const pendingPath = `agent-inbox/pending/${today(now)}-write-${slug(rel)}.md`;
  const markdown = [
    '---',
    'type: write',
    `path: ${rel}`,
    'status: pending',
    'managed_by: obsidian-agent-os',
    '---',
    '',
    content == null ? '' : String(content),
    '',
  ].join('\n');
  return { pendingPath, markdown, target: rel };
}

/**
 * @param {string} command
 * @param {Record<string, any>} params
 * @param {{
 *   read: (path: string) => Promise<string>,
 *   write: (path: string, content: string) => Promise<void>,
 *   list: (prefix?: string) => Promise<string[]>,
 *   search?: (query: string, limit: number) => Promise<{ path: string, title?: string, excerpt?: string }[]>,
 *   activeNote?: () => { path: string, name?: string } | null,
 * }} vault
 * @param {{ now?: number }} [opts]
 */
export async function executeVaultCommand(command, params = {}, vault, opts = {}) {
  if (command === 'vault.search') {
    const query = String(params.query || '').trim();
    const limit = Math.max(1, Math.min(20, Number(params.limit) || 8));
    if (!query) return { ok: false, error: 'query required' };
    if (vault.search) {
      const hits = await vault.search(query, limit);
      return { ok: true, hits: hits.slice(0, limit) };
    }
    const paths = await vault.list('');
    const q = query.toLowerCase();
    const hits = [];
    for (const path of paths) {
      if (hits.length >= limit) break;
      if (path.toLowerCase().includes(q)) hits.push({ path, excerpt: '' });
    }
    return { ok: true, hits };
  }

  if (command === 'vault.list') {
    const prefix = vaultRel(params.prefix || '');
    const paths = await vault.list(prefix);
    return { ok: true, paths: paths.slice(0, 200) };
  }

  if (command === 'vault.read') {
    const path = vaultRel(params.path);
    if (!path || path.includes('..')) return { ok: false, error: 'invalid path' };
    const content = await vault.read(path);
    return { ok: true, path, content };
  }

  if (command === 'vault.active_note') {
    const note = vault.activeNote?.() || null;
    return { ok: true, note };
  }

  if (command === 'vault.write') {
    const path = vaultRel(params.path);
    const content = params.content == null ? '' : String(params.content);
    if (!path || path.includes('..')) return { ok: false, error: 'invalid path' };
    const policy = checkWritePolicy(path);
    if (!policy.allowed) {
      const pending = buildPendingWrite(path, content, opts.now);
      await vault.write(pending.pendingPath, pending.markdown);
      return {
        ok: true,
        mode: 'pending',
        path: pending.pendingPath,
        target: pending.target,
        reason: policy.reason,
        hint: 'Emit a :::confirm fence so the user can accept this pending write.',
      };
    }
    await vault.write(path, content);
    return { ok: true, mode: 'written', path };
  }

  return { ok: false, error: `unknown vault command ${command}` };
}
