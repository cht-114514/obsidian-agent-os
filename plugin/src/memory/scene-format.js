/**
 * MemScene markdown (thematic consolidation unit).
 */

import { slugifyScene } from './cell-format.js';

/**
 * @param {{
 *   slug: string,
 *   title: string,
 *   summary: string,
 *   cellPaths: string[],
 *   updated: string,
 * }} scene
 */
export function formatSceneMarkdown(scene) {
  const cells = (scene.cellPaths || []).map((p) => `  - ${p}`).join('\n');
  return [
    '---',
    'type: memscene',
    `scene_slug: ${scene.slug}`,
    `title: ${scene.title}`,
    `updated: ${scene.updated}`,
    'cell_paths:',
    cells || '  []',
    '---',
    '',
    `# ${scene.title}`,
    '',
    scene.summary || '（场景摘要待补充）',
    '',
  ].join('\n');
}

/**
 * @param {string} md
 */
export function parseSceneMarkdown(md) {
  const text = String(md || '');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  /** @type {Record<string, string>} */
  const meta = {};
  const cellPaths = [];
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^([\w_]+):\s*(.*)$/);
      if (m) meta[m[1]] = m[2].trim();
      const cell = line.match(/^\s*-\s+(agent-inbox\/[^\s]+)/);
      if (cell) cellPaths.push(cell[1]);
    }
  }
  const titleMatch = text.match(/^#\s+(.+)$/m);
  const body = text.replace(/^---[\s\S]*?---\n?/, '').replace(/^#\s+.+\n+/, '').trim();
  return {
    slug: meta.scene_slug || slugifyScene(meta.title || titleMatch?.[1] || ''),
    title: meta.title || titleMatch?.[1] || '',
    summary: body.split('\n')[0]?.trim() || body.slice(0, 400),
    cellPaths,
    updated: meta.updated || '',
  };
}

export { slugifyScene };
