/**
 * Vault-backed vector index ops: load/save, reindex path, hybrid retrieve.
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
  mergeHits,
  buildRowsForFile,
  planChunkEmbeds,
} from './vector-store.js';
import { parseWikiIndex, retrieveWiki } from './retrieve.js';

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
    embedEnabled: s.embedEnabled !== false,
    embedBaseUrl: s.embedBaseUrl || DEFAULT_EMBED_SETTINGS.embedBaseUrl,
    embedApiKey: s.embedApiKey || '',
    embedModel: s.embedModel || DEFAULT_EMBED_SETTINGS.embedModel,
    embedTopK: s.embedTopK ?? DEFAULT_EMBED_SETTINGS.embedTopK,
    embedMinScore: s.embedMinScore ?? DEFAULT_EMBED_SETTINGS.embedMinScore,
    retrieveMode: s.retrieveMode || DEFAULT_EMBED_SETTINGS.retrieveMode,
  };
}

/**
 * Embed + upsert one wiki file into the store.
 * @param {any} app
 * @param {any} plugin
 * @param {string} wikiPath
 * @param {string} md
 * @param {{ rows?: object[] }} [state] pass rows to avoid reload when batching
 */
export async function upsertVectorsForPath(app, plugin, wikiPath, md, state = {}) {
  const cfg = embedConfigFromPlugin(plugin);
  if (!cfg.embedEnabled || !cfg.embedApiKey) {
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
 * Full rebuild of vectors for a list of { path, md }.
 * @param {any} app
 * @param {any} plugin
 * @param {{ path: string, md: string }[]} files
 */
export async function reindexAllVectors(app, plugin, files) {
  const cfg = embedConfigFromPlugin(plugin);
  if (!cfg.embedEnabled) {
    return { skipped: true, reason: 'disabled', vectorChunks: 0, embedded: 0 };
  }
  if (!cfg.embedApiKey) {
    return { skipped: true, reason: 'no-key', vectorChunks: 0, embedded: 0 };
  }

  let rows = await loadVectorRows(app);
  // Drop rows for other models entirely on full reindex of active set? Keep other paths removed if not in files
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
  // Remove vectors for paths no longer in sources
  rows = rows.filter((r) => keepPaths.has(r.path));
  await saveVectorRows(app, rows);
  return {
    ok: true,
    vectorChunks: rows.length,
    embedded,
    reused,
    model: cfg.embedModel,
  };
}

/**
 * Hybrid / keyword / vector retrieval for prompt injection.
 * @param {any} app
 * @param {any} plugin
 * @param {string} query
 * @returns {Promise<{ path: string, title?: string, excerpt: string, score?: number, source?: string }[]>}
 */
export async function retrieveRelevantMemory(app, plugin, query) {
  const cfg = embedConfigFromPlugin(plugin);
  const mode = cfg.retrieveMode || 'hybrid';
  const topK = cfg.embedTopK ?? 3;

  const indexMd = (await vaultRead(app, 'agent-inbox/wiki/index.md')) || '';
  const items = parseWikiIndex(indexMd);

  /** @type {object[]} */
  let keywordHits = [];
  if (mode !== 'vector') {
    keywordHits = retrieveWiki(query, items, { topK: 5 });
  }

  /** @type {{ row: object, score: number }[]} */
  let vectorHits = [];
  if (mode !== 'keyword' && cfg.embedEnabled && cfg.embedApiKey) {
    try {
      const rows = await loadVectorRows(app);
      const usable = rows.filter((r) => r.model === cfg.embedModel);
      if (usable.length) {
        const [qVec] = await embedTexts({
          baseUrl: cfg.embedBaseUrl,
          apiKey: cfg.embedApiKey,
          model: cfg.embedModel,
          texts: [query],
        });
        vectorHits = searchVectors(usable, qVec, {
          topK: 8,
          minScore: cfg.embedMinScore,
          model: cfg.embedModel,
        });
      }
    } catch (e) {
      console.warn('vector retrieve failed, fallback keyword', e);
    }
  }

  if (mode === 'keyword' || (!vectorHits.length && keywordHits.length)) {
    // Enrich keyword hits with file excerpts
    const out = [];
    for (const h of keywordHits.slice(0, topK)) {
      const md = await vaultRead(app, h.path);
      const excerpt = md
        ? md.replace(/^---[\s\S]*?---\n/, '').slice(0, 1500)
        : '';
      out.push({
        path: h.path,
        title: h.title,
        excerpt,
        score: h.score,
        source: 'keyword',
      });
    }
    return out;
  }

  if (mode === 'vector') {
    return vectorHits.slice(0, topK).map((h) => ({
      path: h.row.path,
      title: h.row.title,
      excerpt: (h.row.text || '').slice(0, 1500),
      score: h.score,
      source: 'vector',
    }));
  }

  // hybrid: merge, then fill missing excerpts from vault
  const merged = mergeHits(keywordHits, vectorHits, { topK });
  for (const m of merged) {
    if (!m.excerpt) {
      const md = await vaultRead(app, m.path);
      m.excerpt = md
        ? md.replace(/^---[\s\S]*?---\n/, '').slice(0, 1500)
        : '';
    } else {
      m.excerpt = m.excerpt.slice(0, 1500);
    }
  }
  return merged;
}
