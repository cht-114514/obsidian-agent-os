/**
 * Vault-local JSONL vector store for wiki chunks.
 * Path: agent-inbox/wiki/vectors.jsonl
 */

export const VECTORS_PATH = 'agent-inbox/wiki/vectors.jsonl';

/**
 * Cosine similarity between two equal-length vectors.
 * @param {number[]} a
 * @param {number[]} b
 */
export function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom < 1e-12) return 0;
  return dot / denom;
}

/**
 * Parse JSONL content into rows.
 * @param {string} text
 * @returns {object[]}
 */
export function parseVectorsJsonl(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      // skip corrupt line
    }
  }
  return rows;
}

/**
 * Serialize rows to JSONL.
 * @param {object[]} rows
 */
export function serializeVectorsJsonl(rows) {
  return (rows || [])
    .map((r) => JSON.stringify(r))
    .join('\n')
    .concat((rows || []).length ? '\n' : '');
}

/**
 * Remove all chunks for a path.
 * @param {object[]} rows
 * @param {string} path
 */
export function removePath(rows, path) {
  return (rows || []).filter((r) => r.path !== path);
}

/**
 * Replace all chunks for a path with new ones.
 * @param {object[]} rows
 * @param {string} path
 * @param {object[]} newRows
 */
export function upsertPath(rows, path, newRows) {
  const kept = removePath(rows, path);
  return kept.concat(newRows || []);
}

/**
 * Search by cosine similarity.
 * @param {object[]} rows
 * @param {number[]} queryVec
 * @param {{ topK?: number, minScore?: number, model?: string }} [opts]
 * @returns {{ row: object, score: number }[]}
 */
export function searchVectors(rows, queryVec, opts = {}) {
  const topK = opts.topK ?? 3;
  const minScore = opts.minScore ?? 0.28;
  const model = opts.model || '';
  const scored = [];
  for (const row of rows || []) {
    if (model && row.model && row.model !== model) continue;
    if (!Array.isArray(row.embedding)) continue;
    const score = cosine(queryVec, row.embedding);
    if (score >= minScore) scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Merge keyword hits and vector hits into top-K retrieval results.
 * Keyword hit shape: { path, title, score, keywords? }
 * Vector hit shape: { row, score } where row has path, title, text
 *
 * @param {object[]} keywordHits
 * @param {{ row: object, score: number }[]} vectorHits
 * @param {{ topK?: number }} [opts]
 * @returns {{ path: string, title: string, excerpt: string, score: number, source: string }[]}
 */
export function mergeHits(keywordHits, vectorHits, opts = {}) {
  const topK = opts.topK ?? 3;
  /** @type {Map<string, { path: string, title: string, excerpt: string, score: number, source: string, v?: number, k?: number }>} */
  const byPath = new Map();

  const kScores = (keywordHits || []).map((h) => h.score || 0);
  const vScores = (vectorHits || []).map((h) => h.score || 0);
  const kMax = Math.max(1, ...kScores, 1);
  const vMax = Math.max(1e-6, ...vScores, 1e-6);

  for (const h of keywordHits || []) {
    const path = h.path;
    if (!path) continue;
    const kn = (h.score || 0) / kMax;
    const prev = byPath.get(path);
    const entry = {
      path,
      title: h.title || path,
      excerpt: h.excerpt || '',
      score: 0.35 * kn,
      source: 'keyword',
      k: kn,
      v: prev?.v || 0,
    };
    if (prev) {
      entry.v = prev.v || 0;
      entry.excerpt = prev.excerpt || entry.excerpt;
      if (prev.v) entry.source = 'hybrid';
      entry.score = 0.65 * (entry.v || 0) + 0.35 * kn;
      entry.title = prev.title || entry.title;
    }
    byPath.set(path, entry);
  }

  for (const h of vectorHits || []) {
    const row = h.row || {};
    const path = row.path;
    if (!path) continue;
    const vn = (h.score || 0) / vMax;
    const prev = byPath.get(path);
    const entry = {
      path,
      title: row.title || path,
      excerpt: row.text || '',
      score: 0.65 * vn,
      source: 'vector',
      v: vn,
      k: prev?.k || 0,
    };
    if (prev) {
      entry.k = prev.k || 0;
      entry.source = entry.k ? 'hybrid' : 'vector';
      entry.score = 0.65 * vn + 0.35 * (entry.k || 0);
      // prefer vector chunk text when present
      if (!entry.excerpt) entry.excerpt = prev.excerpt || '';
      entry.title = row.title || prev.title || path;
    }
    byPath.set(path, entry);
  }

  return [...byPath.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ path, title, excerpt, score, source }) => ({
      path,
      title,
      excerpt,
      score,
      source,
    }));
}

/**
 * Build vector rows for one wiki file from chunks + embeddings.
 * @param {{ path: string, title: string, model: string, chunks: { index: number, text: string, hash: string }[], embeddings: number[][] }} args
 */
export function buildRowsForFile(args) {
  const { path, title, model, chunks, embeddings } = args;
  const date = new Date().toISOString().slice(0, 10);
  const rows = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const emb = embeddings[i];
    if (!emb?.length) continue;
    rows.push({
      id: `${path}#${c.index}`,
      path,
      title: title || path,
      chunkIndex: c.index,
      text: c.text,
      hash: c.hash,
      model,
      dim: emb.length,
      embedding: emb,
      updated: date,
    });
  }
  return rows;
}

/**
 * Which chunks need re-embedding (hash or model mismatch).
 * @param {object[]} existingRows for this path
 * @param {{ index: number, text: string, hash: string }[]} chunks
 * @param {string} model
 */
export function planChunkEmbeds(existingRows, chunks, model) {
  const byIndex = new Map((existingRows || []).map((r) => [r.chunkIndex, r]));
  /** @type {{ chunk: object, reuse?: number[] }[]} */
  const plan = [];
  for (const c of chunks) {
    const old = byIndex.get(c.index);
    if (old && old.hash === c.hash && old.model === model && Array.isArray(old.embedding)) {
      plan.push({ chunk: c, reuse: old.embedding });
    } else {
      plan.push({ chunk: c });
    }
  }
  return plan;
}
