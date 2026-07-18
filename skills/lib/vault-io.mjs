/**
 * Shared vault I/O for Obsidian Agent OS skills.
 * Enforces agent-inbox-only writes unless pending is approved.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTOCOL_DIR = resolve(__dirname, '../../packages/protocol/src');

export async function loadProtocol() {
  return import(pathToFileURL(join(PROTOCOL_DIR, 'index.js')).href);
}

export function defaultVaultRoot() {
  return process.env.ME_SOUL_VAULT || resolve(__dirname, '../../../..');
}

/**
 * @param {string} vaultRoot
 * @param {string} relPath
 */
export function abs(vaultRoot, relPath) {
  return resolve(vaultRoot, relPath);
}

/**
 * Safe write: checks policy via protocol, then writes.
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
export async function safeWrite(vaultRoot, relPath, content, opts = {}) {
  const { checkWritePolicy } = await loadProtocol();
  const policy = checkWritePolicy(relPath, opts);
  if (!policy.allowed) {
    return { ok: false, error: `write denied: ${relPath} (${policy.reason})` };
  }
  const full = abs(vaultRoot, relPath);
  // ensure still under vault
  if (!full.startsWith(resolve(vaultRoot))) {
    return { ok: false, error: 'path escapes vault' };
  }
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return { ok: true, path: relPath };
}

export function safeRead(vaultRoot, relPath) {
  const full = abs(vaultRoot, relPath);
  if (!existsSync(full)) return null;
  return readFileSync(full, 'utf8');
}

export function listRel(vaultRoot, relDir) {
  const full = abs(vaultRoot, relDir);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter((n) => !n.startsWith('.'))
    .map((n) => `${relDir.replace(/\/$/, '')}/${n}`);
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function thoughtFence(text) {
  return `:::thought\n${text}\n:::\n`;
}

export function confirmFence({ type, path, title, body, actions = ['accept', 'edit', 'reject'] }) {
  return [
    `:::confirm type=${type} path=${path}`,
    `title: ${title}`,
    `body: ${body}`,
    `actions: [${actions.join(', ')}]`,
    ':::',
    '',
  ].join('\n');
}

/**
 * Record write paths for audit logs.
 */
export function createWriteLog() {
  /** @type {string[]} */
  const paths = [];
  return {
    paths,
    track(p) {
      paths.push(p);
    },
  };
}
