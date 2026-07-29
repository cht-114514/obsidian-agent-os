/**
 * Grok Imagine (image_gen / image_edit) → vault agent-inbox/raw/ ingest helpers.
 *
 * ACP completion shape (observed):
 *   tool_call_update.status === 'completed'
 *   rawOutput.path = absolute session path
 *   content[0].content.text = JSON string with { path, filename, ... }
 */

export const RAW_DIR = 'agent-inbox/raw';

const IMAGINE_TOOL_NAMES = new Set(['image_gen', 'image_edit']);

/**
 * @param {any} u tool_call or tool_call_update
 * @returns {string}
 */
export function imagineToolName(u) {
  const meta = u?._meta?.['x.ai/tool'] || u?._meta?.['xai/tool'] || {};
  const fromMeta = String(meta.name || meta.kind || '').trim();
  if (fromMeta) return fromMeta;
  const title = String(u?.title || '').trim();
  if (IMAGINE_TOOL_NAMES.has(title)) return title;
  if (/^imagine\b/i.test(title)) return 'image_gen';
  const rawType = String(u?.rawOutput?.type || u?.rawInput?.variant || '').trim();
  if (rawType === 'ImageGen') return 'image_gen';
  if (rawType === 'ImageEdit') return 'image_edit';
  return '';
}

/**
 * @param {any} u
 * @returns {boolean}
 */
export function isImagineTool(u) {
  return IMAGINE_TOOL_NAMES.has(imagineToolName(u));
}

/**
 * @param {any} u completed tool_call_update
 * @returns {string|null} absolute filesystem path
 */
export function extractImagineImagePath(u) {
  if (!u) return null;
  const fromRaw = String(u.rawOutput?.path || '').trim();
  if (fromRaw && looksLikeAbsImagePath(fromRaw)) return fromRaw;

  const blocks = Array.isArray(u.content) ? u.content : [];
  for (const block of blocks) {
    const text =
      block?.content?.text ??
      block?.text ??
      (typeof block?.content === 'string' ? block.content : '');
    const path = pathFromContentText(text);
    if (path) return path;
  }
  return null;
}

/**
 * @param {unknown} text
 * @returns {string|null}
 */
export function pathFromContentText(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try {
    const j = JSON.parse(s);
    const p = String(j?.path || '').trim();
    if (p && looksLikeAbsImagePath(p)) return p;
  } catch {
    /* not JSON */
  }
  const m = s.match(
    /(\/(?:Users|home|var|tmp)[^\s"'<>]+\.(?:jpg|jpeg|png|webp|gif))/i
  );
  return m ? m[1] : null;
}

/**
 * @param {string} p
 */
export function looksLikeAbsImagePath(p) {
  if (!p || p[0] !== '/') return false;
  return /\.(jpe?g|png|webp|gif)$/i.test(p);
}

/**
 * @param {string} absPath
 * @returns {string} extension including dot
 */
export function imageExtFromPath(absPath) {
  const m = String(absPath || '').match(/(\.(jpe?g|png|webp|gif))$/i);
  return m ? m[1].toLowerCase().replace('.jpeg', '.jpg') : '.jpg';
}

/**
 * @param {string} [prompt]
 * @param {number} [now]
 */
export function buildImagineRawBasename(prompt = '', now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const slug = slugifyPrompt(prompt).slice(0, 40) || 'image';
  return `${ts}-imagine-${slug}`;
}

/**
 * @param {string} prompt
 */
export function slugifyPrompt(prompt) {
  return String(prompt || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Obsidian embed wiki link for a vault-relative path.
 * @param {string} vaultPath
 */
export function embedWikilink(vaultPath) {
  const p = String(vaultPath || '').trim();
  if (!p) return '';
  return `![[${p}]]`;
}

/**
 * Unique path under agent-inbox/raw/.
 * @param {{ getAbstractFileByPath: (p: string) => any }} vault
 * @param {string} basename no extension
 * @param {string} ext with leading dot
 */
export function uniqueRawPath(vault, basename, ext) {
  let path = `${RAW_DIR}/${basename}${ext}`;
  let n = 1;
  while (vault.getAbstractFileByPath(path)) {
    path = `${RAW_DIR}/${basename}-${n}${ext}`;
    n += 1;
  }
  return path;
}

/**
 * @returns {typeof import('fs') | null}
 */
function getFsSync() {
  const req =
    (typeof require === 'function' && require) ||
    (typeof window !== 'undefined' && window.require) ||
    (typeof globalThis !== 'undefined' && globalThis.require) ||
    null;
  if (!req) return null;
  try {
    return req('fs');
  } catch {
    return null;
  }
}

/**
 * Resolve Node fs for Obsidian (window.require) or Node ESM (createRequire).
 * @param {typeof import('fs') | null | undefined} injected
 * @returns {Promise<typeof import('fs') | null>}
 */
export async function resolveFs(injected) {
  if (injected) return injected;
  const sync = getFsSync();
  if (sync) return sync;
  try {
    if (typeof process !== 'undefined' && process.versions?.node) {
      const { createRequire } = await import('node:module');
      const { pathToFileURL } = await import('node:url');
      const req = createRequire(pathToFileURL(process.cwd() + '/package.json'));
      return req('fs');
    }
  } catch {
    /* */
  }
  return null;
}

/**
 * Copy an absolute session image into agent-inbox/raw/.
 *
 * @param {any} app Obsidian App
 * @param {string} absPath
 * @param {{
 *   prompt?: string,
 *   ensureFolder?: (app: any, dir: string) => Promise<void>,
 *   fs?: typeof import('fs'),
 * }} [opts]
 * @returns {Promise<{ vaultPath: string, bytes: number }>}
 */
export async function ingestImagineImageToRaw(app, absPath, opts = {}) {
  const src = String(absPath || '').trim();
  if (!looksLikeAbsImagePath(src)) {
    throw new Error(`无效的图片路径：${src || '(empty)'}`);
  }
  const fs = await resolveFs(opts.fs);
  if (!fs) {
    throw new Error('无法读取会话图片（需要桌面 Node fs）');
  }
  if (!fs.existsSync(src)) {
    throw new Error(`图片文件不存在：${src}`);
  }
  const buf = fs.readFileSync(src);
  const ext = imageExtFromPath(src);
  const basename = buildImagineRawBasename(opts.prompt || '');
  if (opts.ensureFolder) await opts.ensureFolder(app, RAW_DIR);
  else await ensureVaultFolder(app, RAW_DIR);
  const vaultPath = uniqueRawPath(app.vault, basename, ext);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  await app.vault.createBinary(vaultPath, ab);
  return { vaultPath, bytes: buf.length };
}

/**
 * @param {any} app
 * @param {string} dir
 */
async function ensureVaultFolder(app, dir) {
  const parts = String(dir).split('/').filter(Boolean);
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
