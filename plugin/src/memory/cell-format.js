/**
 * MemCell markdown serialization / parsing (pure).
 */

/**
 * @param {string} title
 */
export function slugifyScene(title) {
  const t = String(title || 'scene')
    .trim()
    .slice(0, 48);
  const ascii = t
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii && /[a-z0-9]/.test(ascii)) return ascii.slice(0, 40) || 'scene';
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return `scene-${h.toString(16)}`;
}

/**
 * @param {{
 *   cellId: string,
 *   sessionId: string,
 *   created: string,
 *   sceneSlug: string,
 *   sceneTitle: string,
 *   episode: string,
 *   facts: string[],
 *   foresight: { text: string, start?: string, end?: string }[],
 * }} cell
 */
export function formatMemCellMarkdown(cell) {
  const factsYaml = (cell.facts || []).map((f) => `  - ${yamlQuote(f)}`).join('\n');
  const foresightJson = JSON.stringify(cell.foresight || []);
  return [
    '---',
    'type: memcell',
    `cell_id: ${cell.cellId}`,
    `session_id: ${yamlQuote(cell.sessionId)}`,
    `created: ${cell.created}`,
    `scene_slug: ${cell.sceneSlug}`,
    `scene_title: ${yamlQuote(cell.sceneTitle)}`,
    'facts:',
    factsYaml || '  []',
    `foresight_json: ${yamlQuote(foresightJson)}`,
    '---',
    '',
    `# MemCell ${cell.cellId}`,
    '',
    '## Episode',
    '',
    cell.episode || '（无叙事）',
    '',
    '## Facts',
    '',
    ...(cell.facts || []).map((f) => `- ${f}`),
    '',
    '## Foresight',
    '',
    ...(cell.foresight || []).map(
      (f) =>
        `- ${f.text}${f.start || f.end ? ` （${f.start || '…'} → ${f.end || '…'}）` : ''}`
    ),
    '',
  ].join('\n');
}

function yamlQuote(s) {
  const t = String(s ?? '');
  if (!/[:#\n"'&]/.test(t) && t.length < 60) return t;
  return `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * @param {string} md
 */
export function parseMemCellMarkdown(md) {
  const text = String(md || '');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  /** @type {Record<string, string>} */
  const meta = {};
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^([\w_]+):\s*(.*)$/);
      if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  let foresight = [];
  const foresightRaw = meta.foresight_json || meta.foresight;
  if (foresightRaw) {
    try {
      let raw = foresightRaw;
      if (raw.startsWith('"') && raw.endsWith('"')) {
        raw = JSON.parse(raw);
      }
      foresight = JSON.parse(raw);
    } catch {
      foresight = [];
    }
  }
  const foresightSec = text.match(/## Foresight\s*\n+([\s\S]*?)(?=\n## |\n*$)/);
  if (foresightSec && !foresight.length) {
    for (const line of foresightSec[1].split('\n')) {
      const m = line.match(/^-\s+(.+?)(?:\s*（([^）]*)→\s*([^）]*)）)?\s*$/);
      if (!m) continue;
      foresight.push({
        text: m[1].trim(),
        start: (m[2] || '').trim(),
        end: (m[3] || '').trim(),
      });
    }
  }
  const facts = [];
  if (fm) {
    const block = fm[1];
    const factsSec = block.match(/facts:\n([\s\S]*?)(?=\n\w|$)/);
    if (factsSec) {
      for (const line of factsSec[1].split('\n')) {
        const m = line.match(/^\s*-\s+(.+)$/);
        if (m) facts.push(m[1].trim().replace(/^["']|["']$/g, ''));
      }
    }
  }
  const episodeMatch = text.match(/## Episode\s*\n+([\s\S]*?)(?=\n## |\n*$)/);
  return {
    cell_id: meta.cell_id || '',
    session_id: meta.session_id || '',
    created: meta.created || '',
    scene_slug: meta.scene_slug || '',
    scene_title: meta.scene_title || '',
    facts,
    foresight,
    episode: episodeMatch ? episodeMatch[1].trim() : '',
  };
}

/**
 * @param {string} datePrefix YYYY-MM-DD
 * @param {string} [suffix]
 */
export function newCellId(datePrefix, suffix) {
  const s = (suffix || Math.random().toString(36).slice(2, 8)).replace(/[^a-z0-9]/gi, '');
  return `${datePrefix}-${s}`;
}
