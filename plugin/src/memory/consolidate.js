/**
 * MemScene assignment + vector rows + profile pending (pure helpers + vault ops).
 */
import { embedTexts } from './embedder.js';
import { formatSceneMarkdown, parseSceneMarkdown, slugifyScene } from './scene-format.js';
import { serializePendingMarkdown } from '../../../packages/protocol/src/confirm.js';

export const SCENES_DIR = 'agent-inbox/wiki/memories/scenes';
export const CELLS_DIR = 'agent-inbox/wiki/memories/cells';
export const DEFAULT_SCENE_THRESHOLD = 0.72;

/**
 * Pick best scene row by cosine score.
 * @param {number[]} episodeVec
 * @param {{ row: object, score: number }[]} sceneHits
 */
export function pickSceneForEpisode(episodeVec, sceneHits, threshold = DEFAULT_SCENE_THRESHOLD) {
  if (!episodeVec?.length || !sceneHits?.length) return null;
  const best = sceneHits[0];
  if ((best?.score || 0) >= threshold) return best.row;
  return null;
}

/**
 * @param {string} title
 * @param {string} episode
 * @param {string[]} facts
 */
export function sceneSummaryFromCell(title, episode, facts) {
  const bits = [title, episode.slice(0, 200), ...(facts || []).slice(0, 2)];
  return bits.filter(Boolean).join(' · ').slice(0, 500);
}

/**
 * Build vector rows for one memcell.
 * @param {{ cellPath: string, sceneSlug: string, sceneTitle: string, episode: string, facts: string[], model: string, embeddings: { episode: number[], facts: number[][] } }} args
 */
export function buildMemCellVectorRows(args) {
  const { cellPath, sceneSlug, sceneTitle, episode, facts, model, embeddings } = args;
  const date = new Date().toISOString().slice(0, 10);
  /** @type {object[]} */
  const rows = [];
  if (embeddings.episode?.length) {
    rows.push({
      id: `${cellPath}#episode`,
      kind: 'episode',
      path: cellPath,
      scene_slug: sceneSlug,
      title: sceneTitle,
      text: episode,
      chunkIndex: -1,
      hash: 'episode',
      model,
      dim: embeddings.episode.length,
      embedding: embeddings.episode,
      updated: date,
    });
  }
  (facts || []).forEach((fact, i) => {
    const emb = embeddings.facts?.[i];
    if (!emb?.length) return;
    rows.push({
      id: `${cellPath}#fact-${i}`,
      kind: 'fact',
      path: cellPath,
      scene_slug: sceneSlug,
      title: sceneTitle,
      text: fact,
      chunkIndex: i,
      hash: `fact-${i}`,
      model,
      dim: emb.length,
      embedding: emb,
      updated: date,
    });
  });
  return rows;
}

/**
 * @param {{ slug: string, title: string, summary: string, model: string, embedding: number[] }} args
 */
export function buildSceneVectorRow(args) {
  const date = new Date().toISOString().slice(0, 10);
  const path = `${SCENES_DIR}/${args.slug}.md`;
  return {
    id: `${path}#scene`,
    kind: 'scene',
    path,
    scene_slug: args.slug,
    title: args.title,
    text: args.summary,
    chunkIndex: 0,
    hash: 'scene',
    model: args.model,
    dim: args.embedding.length,
    embedding: args.embedding,
    updated: date,
  };
}

/**
 * @param {{ target: string, text: string }[]} deltas
 * @param {string} cellPath
 * @param {string} datePrefix
 */
export function buildProfilePendingMarkdown(deltas, cellPath, datePrefix) {
  const plan = {
    updates: (deltas || []).map((d) => ({
      file: d.target === 'style' ? 'agent-inbox/soul/style.md' : 'agent-inbox/soul/profile.md',
      action: 'append_section',
      text: d.text,
    })),
  };
  const pendingPath = `agent-inbox/pending/${datePrefix}-soul-promote-memcell.md`;
  const body = [
    '由 MemCell 形成管线提议的 profile/style 增量。Accept 后请运行 soul-promote 合并技能或手改。',
    '',
    '```json',
    JSON.stringify(plan, null, 2),
    '```',
    '',
    `来源 MemCell：\`${cellPath}\``,
  ].join('\n');
  return {
    pendingPath,
    markdown: serializePendingMarkdown({
      status: 'pending',
      type: 'soul-promote',
      title: 'MemCell profile 增量',
      created: datePrefix,
      path: 'agent-inbox/soul/profile.md',
      source_paths: [cellPath],
      body,
    }),
  };
}

/**
 * Merge cell path into scene file content.
 * @param {string} existingMd
 * @param {string} cellPath
 * @param {string} title
 * @param {string} summarySnippet
 */
export function mergeCellIntoScene(existingMd, cellPath, title, summarySnippet) {
  const parsed = existingMd ? parseSceneMarkdown(existingMd) : null;
  const slug = parsed?.slug || slugifyScene(title);
  const cellPaths = [...new Set([...(parsed?.cellPaths || []), cellPath])];
  const summary = parsed?.summary
    ? `${parsed.summary}\n\n- ${summarySnippet}`.slice(0, 1200)
    : summarySnippet;
  return formatSceneMarkdown({
    slug,
    title: parsed?.title || title,
    summary,
    cellPaths,
    updated: new Date().toISOString().slice(0, 10),
  });
}

/**
 * Embed memcell texts (episode + facts).
 * @param {any} cfg embed config
 */
export async function embedMemCellTexts(cfg, episode, facts) {
  const texts = [episode, ...(facts || [])].filter(Boolean);
  if (!texts.length) return { episode: [], facts: [] };
  const embs = await embedTexts({
    baseUrl: cfg.embedBaseUrl,
    apiKey: cfg.embedApiKey,
    model: cfg.embedModel,
    texts,
  });
  const episodeEmb = embs[0] || [];
  const factEmbs = embs.slice(1);
  return { episode: episodeEmb, facts: factEmbs };
}
