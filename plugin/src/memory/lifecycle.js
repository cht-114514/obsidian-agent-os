/**
 * EverMemOS-style formation + consolidation after each assistant turn.
 */
import {
  BUFFER_PATH,
  parseBufferStore,
  serializeBufferStore,
  appendExchange,
  isBufferStale,
} from './buffer-store.js';
import { callFormationLlm } from './formation-llm.js';
import { formatMemCellMarkdown, newCellId } from './cell-format.js';
import { slugifyScene } from './scene-format.js';
import {
  CELLS_DIR,
  SCENES_DIR,
  buildMemCellVectorRows,
  buildSceneVectorRow,
  buildProfilePendingMarkdown,
  mergeCellIntoScene,
  sceneSummaryFromCell,
  embedMemCellTexts,
  DEFAULT_SCENE_THRESHOLD,
} from './consolidate.js';
import {
  loadVectorRows,
  saveVectorRows,
  embedConfigFromPlugin,
} from './index-ops.js';
import { searchVectors, removePath, upsertPath } from './vector-store.js';

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
 * @param {any} plugin
 */
export function memoryLlmConfigFromPlugin(plugin) {
  const s = plugin?.settings || {};
  return {
    enabled: s.memoryFormationEnabled !== false,
    baseUrl: (s.memoryLlmBaseUrl || s.embedBaseUrl || '').trim(),
    apiKey: (s.memoryLlmApiKey || s.embedApiKey || '').trim(),
    model: (s.memoryLlmModel || 'qwen3.7-flash').trim(),
    sceneThreshold: s.memorySceneThreshold ?? DEFAULT_SCENE_THRESHOLD,
  };
}

/**
 * Run formation after a successful assistant turn (fire-and-forget safe).
 * @param {any} app
 * @param {any} plugin
 * @param {{ sessionKey: string, userText: string, assistantText: string, ts?: number }} turn
 */
export async function runFormationAfterTurn(app, plugin, turn) {
  const cfg = memoryLlmConfigFromPlugin(plugin);
  if (!cfg.enabled || !cfg.apiKey) return { skipped: true, reason: 'disabled-or-no-key' };

  const userText = String(turn.userText || '').trim();
  const assistantText = String(turn.assistantText || '').trim();
  if (!userText && !assistantText) return { skipped: true, reason: 'empty' };

  const sessionKey = String(turn.sessionKey || 'default');
  const now = turn.ts || Date.now();

  const rawBuf = (await vaultRead(app, BUFFER_PATH)) || '{}';
  const store = parseBufferStore(rawBuf);
  const session = store[sessionKey] || { turns: [], updatedAt: now };
  const forceClose = isBufferStale(session, now);

  const llm = await callFormationLlm({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    bufferTurns: session.turns,
    userText,
    assistantText,
    forceClose,
  });

  if (llm.skipped) return llm;
  if (!llm.ok) {
    console.warn('mem formation failed', llm.error);
    return llm;
  }

  const result = llm.result;
  const userTurn = { role: 'user', text: userText, ts: now };
  const asstTurn = { role: 'assistant', text: assistantText, ts: now };

  if (result.action !== 'close') {
    session.turns = appendExchange(session.turns, userTurn, asstTurn);
    session.updatedAt = now;
    store[sessionKey] = session;
    await vaultWrite(app, BUFFER_PATH, serializeBufferStore(store));
    return { ok: true, action: 'continue' };
  }

  if (!result.episode) {
    session.turns = appendExchange(session.turns, userTurn, asstTurn);
    session.updatedAt = now;
    store[sessionKey] = session;
    await vaultWrite(app, BUFFER_PATH, serializeBufferStore(store));
    return { ok: false, error: 'close without episode' };
  }

  const datePrefix = new Date(now).toISOString().slice(0, 10);
  const cellId = newCellId(datePrefix);
  const sceneTitle = result.scene_title || '对话片段';
  const sceneSlug = slugifyScene(sceneTitle);
  const cellPath = `${CELLS_DIR}/${cellId}.md`;

  const cellMd = formatMemCellMarkdown({
    cellId,
    sessionId: sessionKey,
    created: new Date(now).toISOString(),
    sceneSlug,
    sceneTitle,
    episode: result.episode,
    facts: result.facts,
    foresight: result.foresight,
  });
  await vaultWrite(app, cellPath, cellMd);

  store[sessionKey] = { turns: [], updatedAt: now };
  await vaultWrite(app, BUFFER_PATH, serializeBufferStore(store));

  await consolidateMemCell(app, plugin, {
    cellPath,
    sceneSlug,
    sceneTitle,
    episode: result.episode,
    facts: result.facts,
    profileDeltas: result.profile_deltas,
    datePrefix,
    sceneThreshold: cfg.sceneThreshold,
  });

  return { ok: true, action: 'close', cellPath };
}

/**
 * @param {any} app
 * @param {any} plugin
 */
async function consolidateMemCell(app, plugin, args) {
  const embedCfg = embedConfigFromPlugin(plugin);
  const summarySnippet = sceneSummaryFromCell(args.sceneTitle, args.episode, args.facts);

  let rows = await loadVectorRows(app);
  let sceneSlug = args.sceneSlug;
  let scenePath = `${SCENES_DIR}/${sceneSlug}.md`;

  if (embedCfg.embedApiKey) {
    try {
      const { episode, facts } = await embedMemCellTexts(
        embedCfg,
        args.episode,
        args.facts
      );
      if (episode.length) {
        const sceneRows = rows.filter((r) => r.kind === 'scene' && r.model === embedCfg.embedModel);
        const sceneHits = searchVectors(sceneRows, episode, {
          topK: 1,
          minScore: 0.2,
          model: embedCfg.embedModel,
        });
        const matched = sceneHits[0];
        if (matched && (matched.score || 0) >= (args.sceneThreshold ?? DEFAULT_SCENE_THRESHOLD)) {
          sceneSlug = matched.row.scene_slug || sceneSlug;
          scenePath = matched.row.path || scenePath;
        }

        rows = removePath(rows, args.cellPath);
        const cellRows = buildMemCellVectorRows({
          cellPath: args.cellPath,
          sceneSlug,
          sceneTitle: args.sceneTitle,
          episode: args.episode,
          facts: args.facts,
          model: embedCfg.embedModel,
          embeddings: { episode, facts },
        });
        rows = rows.concat(cellRows);

        const existingSceneMd = await vaultRead(app, scenePath);
        const sceneMd = mergeCellIntoScene(
          existingSceneMd,
          args.cellPath,
          args.sceneTitle,
          summarySnippet
        );
        await vaultWrite(app, scenePath, sceneMd);

        const sceneSummary = sceneMd.replace(/^---[\s\S]*?---\n?/, '').slice(0, 600);
        const sceneRow = buildSceneVectorRow({
          slug: sceneSlug,
          title: args.sceneTitle,
          summary: sceneSummary,
          model: embedCfg.embedModel,
          embedding: episode,
        });
        rows = upsertPath(rows, scenePath, [sceneRow]);
        await saveVectorRows(app, rows);
      }
    } catch (e) {
      console.warn('mem consolidate embed failed', e);
    }
  } else {
    const existingSceneMd = await vaultRead(app, scenePath);
    const sceneMd = mergeCellIntoScene(
      existingSceneMd,
      args.cellPath,
      args.sceneTitle,
      summarySnippet
    );
    await vaultWrite(app, scenePath, sceneMd);
  }

  if (args.profileDeltas?.length) {
    const { pendingPath, markdown } = buildProfilePendingMarkdown(
      args.profileDeltas,
      args.cellPath,
      args.datePrefix
    );
    const existing = await vaultRead(app, pendingPath);
    if (!existing) await vaultWrite(app, pendingPath, markdown);
  }
}
