/**
 * Me.Soul fence protocol parser.
 * Shipped pure module — no Obsidian / OpenClaw deps.
 *
 * Supports:
 *   :::thought ... :::
 *   :::confirm type=... path=... \n title: ... \n body: ... \n actions: [...] :::
 *   :::tool name=... ... :::
 *   :::attachment path=... :::
 * Plain text outside fences becomes text blocks.
 */

/**
 * @typedef {'thought'|'text'|'tool'|'confirm'|'attachment'} BlockType
 * @typedef {{ type: BlockType, content: string, attrs?: Record<string, string>, meta?: Record<string, unknown> }} Block
 */

// Find fences anywhere in remaining text (not only at ^).
const FENCE_OPEN = /:::(thought|confirm|tool|attachment)([^\n]*)\n?/i;

/**
 * Parse agent markdown into typed blocks.
 * @param {string} input
 * @returns {Block[]}
 */
export function parseFences(input) {
  if (input == null) return [];
  const src = String(input);
  if (!src.trim()) return [];

  /** @type {Block[]} */
  const blocks = [];
  let i = 0;

  while (i < src.length) {
    const rest = src.slice(i);
    const openMatch = rest.match(FENCE_OPEN);

    if (!openMatch || openMatch.index === undefined) {
      const text = rest;
      if (text.trim()) {
        blocks.push({ type: 'text', content: text.replace(/^\n+|\n+$/g, '') });
      }
      break;
    }

    if (openMatch.index > 0) {
      const leading = rest.slice(0, openMatch.index);
      if (leading.trim()) {
        blocks.push({ type: 'text', content: leading.replace(/^\n+|\n+$/g, '') });
      }
      i += openMatch.index;
    }

    const kind = openMatch[1].toLowerCase();
    const attrLine = (openMatch[2] || '').trim();
    const attrs = parseAttrs(attrLine);
    i += openMatch[0].length;

    const closeIdx = src.indexOf(':::', i);
    if (closeIdx === -1) {
      const content = src.slice(i);
      blocks.push(makeBlock(kind, content, attrs));
      break;
    }

    const content = src.slice(i, closeIdx).replace(/^\n+|\n+$/g, '');
    blocks.push(makeBlock(kind, content, attrs));
    i = closeIdx + 3;
    if (src[i] === '\n') i += 1;
  }

  return blocks;
}

/**
 * @param {string} kind
 * @param {string} content
 * @param {Record<string, string>} attrs
 * @returns {Block}
 */
function makeBlock(kind, content, attrs) {
  if (kind === 'confirm') {
    const meta = parseConfirmBody(content, attrs);
    return { type: 'confirm', content, attrs, meta };
  }
  if (kind === 'tool') {
    return {
      type: 'tool',
      content,
      attrs,
      meta: { name: attrs.name || attrs.tool || 'tool', result: content },
    };
  }
  if (kind === 'attachment') {
    return {
      type: 'attachment',
      content,
      attrs,
      meta: { path: attrs.path || content.trim() },
    };
  }
  return { type: /** @type {BlockType} */ (kind), content, attrs };
}

/**
 * @param {string} attrLine
 * @returns {Record<string, string>}
 */
export function parseAttrs(attrLine) {
  /** @type {Record<string, string>} */
  const attrs = {};
  if (!attrLine) return attrs;
  // key=value or key="value with spaces"
  const re = /(\w+)=("([^"]*)"|'([^']*)'|(\S+))/g;
  let m;
  while ((m = re.exec(attrLine)) !== null) {
    attrs[m[1]] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return attrs;
}

/**
 * @param {string} content
 * @param {Record<string, string>} attrs
 */
function parseConfirmBody(content, attrs) {
  const lines = content.split('\n');
  /** @type {Record<string, string>} */
  const fields = {};
  const bodyLines = [];
  let inBody = false;

  for (const line of lines) {
    const fm = line.match(/^(title|body|actions|path|type|status)\s*:\s*(.*)$/i);
    if (fm && !inBody) {
      const key = fm[1].toLowerCase();
      if (key === 'body') {
        inBody = true;
        if (fm[2]) bodyLines.push(fm[2]);
      } else {
        fields[key] = fm[2].trim();
      }
    } else if (inBody) {
      bodyLines.push(line);
    } else if (line.trim() && !fields.title) {
      // bare content becomes body
      inBody = true;
      bodyLines.push(line);
    }
  }

  let actions = ['accept', 'edit', 'reject'];
  if (fields.actions) {
    const raw = fields.actions.replace(/^\[|\]$/g, '');
    actions = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  }

  return {
    type: attrs.type || fields.type || 'pending',
    path: attrs.path || fields.path || '',
    title: fields.title || attrs.title || 'Confirm',
    body: bodyLines.join('\n').trim() || content.trim(),
    actions,
    status: fields.status || 'pending',
  };
}

/**
 * Serialize blocks back to fenced markdown (for round-trip tests).
 * @param {Block[]} blocks
 * @returns {string}
 */
export function serializeFences(blocks) {
  return blocks
    .map((b) => {
      if (b.type === 'text') return b.content;
      const attrStr = b.attrs
        ? Object.entries(b.attrs)
            .map(([k, v]) => `${k}=${/\s/.test(v) ? `"${v}"` : v}`)
            .join(' ')
        : '';
      const head = attrStr ? `:::${b.type} ${attrStr}` : `:::${b.type}`;
      return `${head}\n${b.content}\n:::`;
    })
    .join('\n\n');
}
