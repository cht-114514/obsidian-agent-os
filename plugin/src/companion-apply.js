/**
 * Confirmed writes from companion replies (snapshot-anchored).
 */
import { checkWritePolicy, vaultRel } from '@obsidian-agent-os/protocol';
import { parseApplyResponse, stripApplyHeaderForPreview } from './intent.js';
import { cleanModelOutput, applyToEditor } from './editor-apply.js';
import { snapshotStillValid } from './context-snapshot.js';
import { MarkdownView } from 'obsidian';

/**
 * @param {import('obsidian').App} app
 * @param {string} path
 */
export async function readNoteBody(app, path) {
  const rel = vaultRel(path);
  const file = app.vault.getAbstractFileByPath(rel);
  if (!file || !app.vault.read) return null;
  try {
    return await app.vault.read(file);
  } catch {
    return null;
  }
}

/**
 * @param {import('obsidian').App} app
 * @param {ReturnType<import('./context-snapshot.js').captureContextSnapshot>} snap
 * @param {string} assistantText
 */
export async function buildApplyPreview(app, snap, assistantText) {
  const parsed = parseApplyResponse(assistantText);
  const mode = parsed.mode;
  const body = stripApplyHeaderForPreview(parsed.body || assistantText);
  const cleaned = cleanModelOutput(body, mode === 'replace_selection' ? 'replace_selection' : mode === 'insert_at_cursor' ? 'insert_at_cursor' : 'show_only');
  return {
    mode,
    cleaned,
    canApply: mode !== 'show_only' && !!cleaned && !!snap?.attached && !!snap.path,
    title: snap?.title || snap?.path || '笔记',
  };
}

/**
 * @param {import('obsidian').App} app
 * @param {any} plugin
 * @param {{
 *   snapshot: any,
 *   text: string,
 *   mode: string,
 *   onNotice?: (m: string) => void,
 * }} opts
 */
export async function applyCompanionEdit(app, plugin, opts) {
  const snap = opts.snapshot;
  const onNotice = opts.onNotice || (() => {});
  if (!snap?.attached || !snap.path) {
    onNotice('没有可写入的笔记上下文');
    return { ok: false };
  }
  const rel = vaultRel(snap.path);
  const current = await readNoteBody(app, rel);
  if (current == null) {
    onNotice('找不到目标笔记');
    return { ok: false };
  }
  const valid = snapshotStillValid(snap, current);
  if (!valid.ok) {
    onNotice('笔记已变化，请重新生成或更新预览后再应用');
    return { ok: false, reason: valid.reason };
  }
  const policy = checkWritePolicy(rel, { approvedPending: false });
  if (!policy.allowed) {
    onNotice('需要先通过确认卡批准写入（四主区）');
    return { ok: false, reason: policy.reason };
  }
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  const activePath = view?.file?.path ? vaultRel(view.file.path) : '';
  if (activePath && activePath !== rel) {
    const file = app.vault.getAbstractFileByPath(rel);
    if (file) await app.workspace.getLeaf().openFile(file);
  }
  const mdView = app.workspace.getActiveViewOfType(MarkdownView);
  if (!mdView?.editor || vaultRel(mdView.file?.path || '') !== rel) {
    onNotice('请打开目标笔记后再应用');
    return { ok: false };
  }
  const again = await readNoteBody(app, rel);
  const valid2 = snapshotStillValid(snap, again || '');
  if (!valid2.ok) {
    onNotice('笔记在打开过程中已变化，请更新预览');
    return { ok: false };
  }
  const mode =
    opts.mode === 'replace_selection'
      ? 'replace_selection'
      : opts.mode === 'insert_at_cursor'
        ? 'insert_at_cursor'
        : 'show_only';
  const result = applyToEditor(mdView.editor, mode, opts.text);
  if (!result.applied) {
    onNotice('未能写入编辑器');
    return { ok: false };
  }
  onNotice('已应用到笔记');
  return { ok: true };
}
