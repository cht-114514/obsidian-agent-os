/**
 * Non-vector fuzzy retrieval over wiki index.
 */

/**
 * Very light tokenization for zh/en.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  // english/numbers
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0]);
  // CJK runs → unigrams + bigrams
  const cjk = s.replace(/[^\u4e00-\u9fff]/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    if (!run) continue;
    for (let i = 0; i < run.length; i++) {
      out.add(run[i]);
      if (i + 1 < run.length) out.add(run.slice(i, i + 2));
    }
  }
  return [...out].filter((t) => t && t !== '的' && t !== '了' && t !== '是');
}

/**
 * Extract keywords from free text for index building.
 * @param {string} text
 * @param {number} max
 */
export function extractKeywords(text, max = 24) {
  const tokens = tokenize(text);
  // prefer longer tokens
  tokens.sort((a, b) => b.length - a.length || a.localeCompare(b));
  const seen = new Set();
  const kw = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    if (t.length < 2 && !/[\u4e00-\u9fff]/.test(t)) continue;
    seen.add(t);
    kw.push(t);
    if (kw.length >= max) break;
  }
  return kw;
}

/**
 * Parse simple YAML-ish list index.md
 * @param {string} md
 * @returns {{ path: string, title: string, keywords: string[], tags: string[], wiki_status: string, updated: string }[]}
 */
export function parseWikiIndex(md) {
  const items = [];
  const blocks = String(md || '').split(/\n(?=- path:)/);
  for (const b of blocks) {
    if (!/path:/.test(b)) continue;
    const path = (b.match(/path:\s*(.+)/) || [])[1]?.trim();
    if (!path) continue;
    const title = (b.match(/title:\s*(.+)/) || [])[1]?.trim() || path;
    const updated = (b.match(/updated:\s*(.+)/) || [])[1]?.trim() || '';
    const wiki_status = (b.match(/wiki_status:\s*(.+)/) || [])[1]?.trim() || 'accepted';
    let keywords = [];
    const kwLine = b.match(/keywords:\s*\[([^\]]*)\]/);
    if (kwLine) {
      keywords = kwLine[1]
        .split(',')
        .map((x) => x.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    let tags = [];
    const tagLine = b.match(/tags:\s*\[([^\]]*)\]/);
    if (tagLine) {
      tags = tagLine[1]
        .split(',')
        .map((x) => x.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    items.push({ path, title, keywords, tags, wiki_status, updated });
  }
  return items;
}

/**
 * Serialize index items to markdown.
 * @param {ReturnType<typeof parseWikiIndex>} items
 */
export function serializeWikiIndex(items) {
  const lines = [
    '---',
    'title: Wiki index',
    'type: wiki-index',
    `updated: ${new Date().toISOString().slice(0, 10)}`,
    'managed_by: obsidian-agent-os',
    '---',
    '',
    '# Wiki Index',
    '',
    '轻量关键词清单。digest Accept 时更新；`/me-reindex` 全量重建（并可同步 vectors.jsonl）。',
    '',
  ];
  for (const it of items || []) {
    lines.push(`- path: ${it.path}`);
    lines.push(`  title: ${it.title || it.path}`);
    lines.push(`  wiki_status: ${it.wiki_status || 'accepted'}`);
    lines.push(`  updated: ${it.updated || ''}`);
    lines.push(`  tags: [${(it.tags || []).join(', ')}]`);
    lines.push(`  keywords: [${(it.keywords || []).join(', ')}]`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Score one index entry against query tokens.
 */
export function scoreItem(item, queryTokens) {
  if (!queryTokens.length) return 0;
  let score = 0;
  const title = (item.title || '').toLowerCase();
  const path = (item.path || '').toLowerCase();
  const kw = new Set((item.keywords || []).map((k) => k.toLowerCase()));
  const tags = new Set((item.tags || []).map((t) => t.toLowerCase()));

  for (const t of queryTokens) {
    const tl = t.toLowerCase();
    if (title.includes(tl)) score += 5 * Math.min(tl.length, 4);
    if (path.includes(tl)) score += 2;
    if (kw.has(tl)) score += 4;
    if (tags.has(tl)) score += 3;
    // bigram soft
    for (const k of kw) {
      if (k.includes(tl) || tl.includes(k)) score += 1;
    }
  }
  if ((item.wiki_status || '') === 'pending_review') score *= 0.5;
  return score;
}

/**
 * @param {string} query
 * @param {ReturnType<typeof parseWikiIndex>} items
 * @param {{ topK?: number, minScore?: number }} [opts]
 */
export function retrieveWiki(query, items, opts = {}) {
  const topK = opts.topK ?? 3;
  const minScore = opts.minScore ?? 3;
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];

  const ranked = (items || [])
    .map((it) => ({ item: it, score: scoreItem(it, qTokens) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score || (b.item.updated || '').localeCompare(a.item.updated || ''));

  return ranked.slice(0, topK).map((x) => ({ ...x.item, score: x.score }));
}

/**
 * Whether to skip retrieval for trivial messages.
 * @param {string} text
 */
export function shouldSkipRetrieve(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (t.length <= 2) return true;
  if (/^(好|嗯|哦|ok|OK|谢谢|收到|哈哈)+$/.test(t)) return true;
  return false;
}

/**
 * Upsert one entry into index items list.
 */
export function upsertIndexItem(items, entry) {
  const list = [...(items || [])];
  const i = list.findIndex((x) => x.path === entry.path);
  if (i >= 0) list[i] = { ...list[i], ...entry };
  else list.push(entry);
  return list;
}

export function removeIndexItem(items, path) {
  return (items || []).filter((x) => x.path !== path);
}

/**
 * Build index entry from wiki markdown + path.
 */
export function entryFromWikiFile(path, md) {
  const title =
    (md.match(/^#\s+(.+)$/m) || [])[1]?.trim() ||
    path.split('/').pop().replace(/\.md$/, '');
  const status = (md.match(/^wiki_status:\s*(.+)$/m) || [])[1]?.trim() || 'accepted';
  const body = md.replace(/^---[\s\S]*?---\n/, '').slice(0, 800);
  return {
    path,
    title,
    wiki_status: status,
    updated: new Date().toISOString().slice(0, 10),
    tags: [],
    keywords: extractKeywords(`${title}\n${body}`),
  };
}
