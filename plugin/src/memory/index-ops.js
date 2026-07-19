/**
 * Vault-backed vector memory: reindex + pure embedding retrieve.
 * Keyword index.md is no longer used.
 */
import { chunkMarkdown } from './chunk.js';
import { embedTexts, DEFAULT_EMBED_SETTINGS } from './embedder.js';
import {
  VECTORS_PATH,
  parseVectorsJsonl,
  serializeVectorsJsonl,
  upsertPath,
  removePath,
  searchVectors,
  buildRowsForFile,
  planChunkEmbeds,
} from './vector-store.js';

/**
 * @param {any} app
 * @param {string} rel
 */
async function vaultRead(app, rel) {
  const f = app.vault.getAbstractFileByPath(rel);
  if (!f) return null;
  try {
    return await app.vault.read(f);
  } catch {
    return null;
  }
}

/**
 * @param {any} app
 * @param {string} rel
 * @param {string} content
 */
async function vaultWrite(app, rel, content) {
  const existing = app.vault.getAbstractFileByPath(rel);
  if (existing) {
    await app.vault.modify(existing, content);
    return;
  }
  const parts = rel.split('/');
  let dir = '';
  for (let i = 0; i < parts.length - 1; i++) {
    dir = dir ? `${dir}/${parts[i]}` : parts[i];
    if (!app.vault.getAbstractFileByPath(dir)) {
      await app.vault.createFolder(dir);
    }
  }
  await app.vault.create(rel, content);
}

/**
 * @param {any} app
 * @param {string} rel
 */
async function vaultDeleteIfExists(app, rel) {
  const f = app.vault.getAbstractFileByPath(rel);
  if (f) {
    try {
      await app.vault.delete(f);
    } catch (e) {
      console.warn('delete failed', rel, e);
    }
  }
}

/**
 * @param {any} app
 * @returns {Promise<object[]>}
 */
export async function loadVectorRows(app) {
  const text = (await vaultRead(app, VECTORS_PATH)) || '';
  return parseVectorsJsonl(text);
}

/**
 * @param {any} app
 * @param {object[]} rows
 */
export async function saveVectorRows(app, rows) {
  await vaultWrite(app, VECTORS_PATH, serializeVectorsJsonl(rows));
}

/**
 * @param {any} plugin
 */
export function embedConfigFromPlugin(plugin) {
  const s = plugin?.settings || {};
  return {
    // Embedding is required for memory retrieve
    embedEnabled: true,
    embedBaseUrl: s.embedBaseUrl || DEFAULT_EMBED_SETTINGS.embedBaseUrl,
    embedApiKey: s.embedApiKey || '',
    embedModel: s.embedModel || DEFAULT_EMBED_SETTINGS.embedModel,
    embedTopK: s.embedTopK ?? DEFAULT_EMBED_SETTINGS.embedTopK,
    embedMinScore: s.embedMinScore ?? DEFAULT_EMBED_SETTINGS.embedMinScore,
    retrieveMode: 'vector',
  };
}

/**
 * Embed + upsert one wiki file into the store.
 * @param {any} app
 * @param {any} plugin
 * @param {string} wikiPath
 * @param {string} md
 * @param {{ rows?: object[] }} [state]
 */
export async function upsertVectorsForPath(app, plugin, wikiPath, md, state = {}) {
  const cfg = embedConfigFromPlugin(plugin);
  if (!cfg.embedApiKey) {
    return { skipped: true, reason: 'no-key', rows: state.rows };
  }
  if (/wiki_status:\s*pending_review/.test(md || '')) {
    let rows = state.rows || (await loadVectorRows(app));
    rows = removePath(rows, wikiPath);
    if (!state.rows) await saveVectorRows(app, rows);
    return { skipped: true, reason: 'pending', rows };
  }

  let rows = state.rows || (await loadVectorRows(app));
  const title =
    (md.match(/^#\s+(.+)$/m) || [])[1]?.trim() ||
    wikiPath.split('/').pop()?.replace(/\.md$/, '') ||
    wikiPath;
  const chunks = chunkMarkdown(md, { path: wikiPath, title });
  if (!chunks.length) {
    rows = removePath(rows, wikiPath);
    if (!state.rows) await saveVectorRows(app, rows);
    return { ok: true, embedded: 0, reused: 0, rows };
  }

  const existing = rows.filter((r) => r.path === wikiPath);
  const plan = planChunkEmbeds(existing, chunks, cfg.embedModel);
  const needEmbed = plan.filter((p) => !p.reuse);
  /** @type {number[][]} */
  let newEmbs = [];
  if (needEmbed.length) {
    newEmbs = await embedTexts({
      baseUrl: cfg.embedBaseUrl,
      apiKey: cfg.embedApiKey,
      model: cfg.embedModel,
      texts: needEmbed.map((p) => p.chunk.text),
    });
  }
  let ei = 0;
  /** @type {number[][]} */
  const embeddings = [];
  for (const p of plan) {
    if (p.reuse) embeddings.push(p.reuse);
    else embeddings.push(newEmbs[ei++]);
  }
  const fileRows = buildRowsForFile({
    path: wikiPath,
    title,
    model: cfg.embedModel,
    chunks,
    embeddings,
  });
  rows = upsertPath(rows, wikiPath, fileRows);
  if (!state.rows) await saveVectorRows(app, rows);
  return {
    ok: true,
    embedded: needEmbed.length,
    reused: plan.length - needEmbed.length,
    rows,
  };
}

/**
 * @param {any} app
 * @param {string} wikiPath
 * @param {{ rows?: object[] }} [state]
 */
export async function removeVectorsForPath(app, wikiPath, state = {}) {
  let rows = state.rows || (await loadVectorRows(app));
  rows = removePath(rows, wikiPath);
  if (!state.rows) await saveVectorRows(app, rows);
  return { rows };
}

/**
 * Full rebuild of vectors for accepted wiki sources. Drops legacy index.md.
 * @param {any} app
 * @param {any} plugin
 * @param {{ path: string, md: string }[]} files
 */
export async function reindexAllVectors(app, plugin, files) {
  const cfg = embedConfigFromPlugin(plugin);
  if (!cfg.embedApiKey) {
    return { skipped: true, reason: 'no-key', vectorChunks: 0, embedded: 0 };
  }

  let rows = await loadVectorRows(app);
  const keepPaths = new Set(files.map((f) => f.path));
  rows = rows.filter((r) => keepPaths.has(r.path) && r.model === cfg.embedModel);

  let embedded = 0;
  let reused = 0;
  for (const f of files) {
    const res = await upsertVectorsForPath(app, plugin, f.path, f.md, { rows });
    if (res.rows) rows = res.rows;
    embedded += res.embedded || 0;
    reused += res.reused || 0;
  }
  rows = rows.filter((r) => keepPaths.has(r.path));
  await saveVectorRows(app, rows);

  // Keyword index is obsolete — remove if present
  await vaultDeleteIfExists(app, 'agent-inbox/wiki/index.md');

  return {
    ok: true,
    vectorChunks: rows.length,
    embedded,
    reused,
    model: cfg.embedModel,
  };
}

/**
 * Pure vector retrieval for prompt injection (embedding required).
 * @param {any} app
 * @param {any} plugin
 * @param {string} query
 * @returns {Promise<{ path: string, title?: string, excerpt: string, score?: number, source?: string }[]>}
 */
export async function retrieveRelevantMemory(app, plugin, query) {
  const cfg = embedConfigFromPlugin(plugin);
  const topK = cfg.embedTopK ?? 3;

  if (!cfg.embedApiKey) {
    console.warn('retrieveRelevantMemory: no embed API key — skip vector memory');
    return [];
  }

  const q = String(query || '').trim();
  if (!q) return [];

  try {
    const rows = await loadVectorRows(app);
    const usable = rows.filter((r) => r.model === cfg.embedModel && Array.isArray(r.embedding));
    if (!usable.length) return [];

    const [qVec] = await embedTexts({
      baseUrl: cfg.embedBaseUrl,
      apiKey: cfg.embedApiKey,
      model: cfg.embedModel,
      texts: [q],
    });
    if (!qVec?.length) return [];

    const hits = searchVectors(usable, qVec, {
      topK,
      minScore: cfg.embedMinScore,
      model: cfg.embedModel,
    });

    // Prefer live wiki file excerpt when path still exists; else chunk text
    const out = [];
    for (const h of hits) {
      const path = h.row.path;
      let excerpt = (h.row.text || '').slice(0, 1500);
      try {
        const md = await vaultRead(app, path);
        if (md) {
          excerpt = md.replace(/^---[\s\S]*?---\n/, '').slice(0, 1500);
        }
      } catch {
        /* keep chunk text */
      }
      out.push({
        path,
        title: h.row.title || path,
        excerpt,
        score: h.score,
        source: 'vector',
      });
    }
    return out;
  } catch (e) {
    console.warn('vector retrieve failed', e);
    return [];
  }
}
