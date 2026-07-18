/**
 * Wiki text chunking + content hashing for embedding index.
 */

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * Strip YAML frontmatter.
 * @param {string} md
 */
export function stripFrontmatter(md) {
  return String(md || '').replace(FRONTMATTER_RE, '');
}

/**
 * FNV-1a 32-bit hex — pure JS, works in Obsidian desktop/mobile without node crypto.
 * @param {string} s
 */
export function hashText(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Chunk wiki markdown into retrieval units.
 * Prefer ## sections; fall back to paragraphs; merge short blocks.
 *
 * @param {string} md
 * @param {{ path?: string, title?: string, targetChars?: number, overlap?: number, minChars?: number }} [opts]
 * @returns {{ index: number, text: string, hash: string }[]}
 */
export function chunkMarkdown(md, opts = {}) {
  const target = opts.targetChars ?? 550;
  const overlap = opts.overlap ?? 80;
  const minChars = opts.minChars ?? 40;
  const path = opts.path || '';
  const body = stripFrontmatter(md).trim();
  if (!body) return [];

  const title =
    opts.title ||
    (body.match(/^#\s+(.+)$/m) || [])[1]?.trim() ||
    path.split('/').pop()?.replace(/\.md$/, '') ||
    '';

  /** @type {string[]} */
  let pieces = [];
  const sections = body.split(/(?=^##\s+)/m).map((s) => s.trim()).filter(Boolean);
  if (sections.length > 1 || /^##\s+/m.test(body)) {
    for (const sec of sections) {
      pieces.push(...splitBySize(sec, target, overlap));
    }
  } else {
    pieces = splitBySize(body, target, overlap);
  }

  // merge tiny tails into previous
  /** @type {string[]} */
  const merged = [];
  for (const p of pieces) {
    const t = p.trim();
    if (!t) continue;
    if (merged.length && t.length < minChars) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}\n\n${t}`;
    } else {
      merged.push(t);
    }
  }

  return merged.map((text, index) => {
    const withTitle = title && !text.startsWith('#') ? `${title}\n\n${text}` : text;
    return {
      index,
      text: withTitle,
      hash: hashText(`${path}\n${index}\n${withTitle}`),
    };
  });
}

/**
 * @param {string} text
 * @param {number} target
 * @param {number} overlap
 */
function splitBySize(text, target, overlap) {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= target) return [t];

  /** @type {string[]} */
  const out = [];
  // Prefer paragraph boundaries
  const paras = t.split(/\n{2,}/);
  let buf = '';
  for (const para of paras) {
    const p = para.trim();
    if (!p) continue;
    if (!buf) {
      buf = p;
      continue;
    }
    if (buf.length + 2 + p.length <= target) {
      buf = `${buf}\n\n${p}`;
    } else {
      out.push(buf);
      // overlap: take tail of previous
      const tail = buf.slice(Math.max(0, buf.length - overlap));
      buf = tail ? `${tail}\n\n${p}` : p;
      if (buf.length > target * 1.8) {
        // hard-split very long paragraph
        out.push(...hardSplit(buf, target, overlap));
        buf = '';
      }
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.flatMap((block) =>
    block.length > target * 1.5 ? hardSplit(block, target, overlap) : [block]
  );
}

/**
 * @param {string} text
 * @param {number} target
 * @param {number} overlap
 */
function hardSplit(text, target, overlap) {
  /** @type {string[]} */
  const out = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + target);
    out.push(text.slice(i, end));
    if (end >= text.length) break;
    i = Math.max(i + 1, end - overlap);
  }
  return out;
}
