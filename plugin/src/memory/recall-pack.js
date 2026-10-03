/**
 * Hybrid recall: scenes / episodes / facts / foresight / wiki (pure assembly).
 */
import { tokenize, shouldSkipRetrieve, scoreItem } from './retrieve.js';
import { searchVectors } from './vector-store.js';
import { parseMemCellMarkdown } from './cell-format.js';

/**
 * @param {{ text: string, start?: string, end?: string }} f
 * @param {string} [today] YYYY-MM-DD
 */
export function isForesightValid(f, today) {
  const t = today || new Date().toISOString().slice(0, 10);
  const start = f.start || '1970-01-01';
  const end = f.end || '2099-12-31';
  if (end && end < t) return false;
  if (start && start > t) return false;
  return true;
}

/**
 * @param {object[]} rows vector rows
 * @param {string} query
 * @param {number[]} queryVec
 * @param {any} cfg
 */
export function recallFromRows(rows, query, queryVec, cfg) {
  const q = String(query || '').trim();
  if (!q || shouldSkipRetrieve(q)) {
    return emptyRecallPack();
  }

  const model = cfg.embedModel || '';
  const minScore = cfg.embedMinScore ?? 0.28;
  const usable = (rows || []).filter((r) => !model || r.model === model);

  const wikiRows = usable.filter((r) => !r.kind || r.kind === 'wiki');
  const memRows = usable.filter((r) => r.kind && r.kind !== 'wiki');

  const wikiHits = queryVec?.length
    ? searchVectors(wikiRows, queryVec, { topK: cfg.wikiTopK ?? 2, minScore, model })
    : [];

  const memVectorHits = queryVec?.length
    ? searchVectors(memRows, queryVec, { topK: 12, minScore, model })
    : [];

  const qTokens = tokenize(q);
  /** @type {{ row: object, score: number, source: string }[]} */
  const ranked = [];

  for (const h of memVectorHits) {
    ranked.push({ row: h.row, score: h.score, source: 'vector' });
  }

  for (const r of memRows.filter((x) => x.kind === 'fact')) {
    const pseudo = {
      path: r.path,
      title: r.title || r.path,
      keywords: tokenize(r.text || ''),
      tags: [],
      wiki_status: 'accepted',
      updated: r.updated || '',
    };
    const ks = scoreItem(pseudo, qTokens);
    if (ks >= 2) ranked.push({ row: r, score: ks * 0.08, source: 'keyword' });
  }

  ranked.sort((a, b) => b.score - a.score);

  /** @type {Map<string, { slug: string, title: string, excerpt: string, score: number }>} */
  const scenes = new Map();
  /** @type {Map<string, { path: string, title: string, excerpt: string, score: number }>} */
  const episodes = new Map();
  /** @type {Map<string, { path: string, title: string, excerpt: string, score: number }>} */
  const facts = new Map();

  for (const h of ranked) {
    const row = h.row;
    const kind = row.kind || 'wiki';
    const excerpt = (row.text || '').slice(0, 1500);
    if (kind === 'scene') {
      const slug = row.scene_slug || row.path;
      if (!scenes.has(slug)) {
        scenes.set(slug, { slug, title: row.title || slug, excerpt, score: h.score });
      }
    } else if (kind === 'episode') {
      if (!episodes.has(row.path)) {
        episodes.set(row.path, {
          path: row.path,
          title: row.title || row.path,
          excerpt,
          score: h.score,
        });
      }
      if (row.scene_slug && !scenes.has(row.scene_slug)) {
        scenes.set(row.scene_slug, {
          slug: row.scene_slug,
          title: row.title || row.scene_slug,
          excerpt: row.title || '',
          score: h.score * 0.85,
        });
      }
    } else if (kind === 'fact') {
      const key = row.id || `${row.path}#${row.chunkIndex}`;
      if (!facts.has(key)) {
        facts.set(key, {
          path: row.path,
          title: row.title || row.path,
          excerpt,
          score: h.score,
        });
      }
    }
  }

  const wiki = wikiHits.map((h) => ({
    path: h.row.path,
    title: h.row.title || h.row.path,
    excerpt: (h.row.text || '').slice(0, 1500),
    score: h.score,
  }));

  return {
    scenes: [...scenes.values()].sort((a, b) => b.score - a.score).slice(0, 2),
    episodes: [...episodes.values()].sort((a, b) => b.score - a.score).slice(0, 2),
    facts: [...facts.values()].sort((a, b) => b.score - a.score).slice(0, 4),
    foresight: [],
    wiki,
  };
}

/**
 * @param {ReturnType<typeof recallFromRows>} pack
 * @param {Record<string, string>} cellBodies path -> md
 */
export function attachForesightFromCells(pack, cellBodies, today) {
  const paths = new Set([
    ...pack.episodes.map((e) => e.path),
    ...pack.facts.map((f) => f.path),
  ]);
  /** @type {{ path: string, text: string, start?: string, end?: string }[]} */
  const foresight = [];
  for (const p of paths) {
    const md = cellBodies[p];
    if (!md) continue;
    const cell = parseMemCellMarkdown(md);
    for (const f of cell.foresight || []) {
      if (!isForesightValid(f, today)) continue;
      foresight.push({ path: p, text: f.text, start: f.start, end: f.end });
    }
  }
  return { ...pack, foresight: foresight.slice(0, 4) };
}

export function emptyRecallPack() {
  return { scenes: [], episodes: [], facts: [], foresight: [], wiki: [] };
}
