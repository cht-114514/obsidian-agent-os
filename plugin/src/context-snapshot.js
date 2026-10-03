/**
 * Editor context for companion sends — frozen at send time only.
 */
import { MarkdownView } from 'obsidian';
import { truncateNoteBody, DEFAULT_ACTIVE_NOTE_MAX_CHARS, normalizeMdPath } from './active-note.js';
import { captureEditorContext } from './editor-apply.js';
import {
  contentVersionHash,
  formatSnapshotForPrompt,
  snapshotStillValid,
} from './context-snapshot-pure.js';

export { contentVersionHash, formatSnapshotForPrompt, snapshotStillValid };

/**
 * @param {import('obsidian').App} app
 * @param {{ mode?: 'follow'|'pin'|'off', pinnedPath?: string, maxChars?: number }} [opts]
 */
export function liveContextLabel(app, opts = {}) {
  const mode = opts.mode || 'follow';
  if (mode === 'off') {
    return { title: '未附带上下文', hasSelection: false, path: null, attached: false };
  }
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view?.file) {
    return { title: '未附带正文', hasSelection: false, path: null, attached: false };
  }
  const path = normalizeMdPath(view.file.path);
  if (mode === 'pin' && opts.pinnedPath) {
    const pin = normalizeMdPath(opts.pinnedPath);
    if (pin && pin !== path) {
      return {
        title: view.file.basename,
        hasSelection: !!(view.editor?.getSelection?.() || '').trim(),
        path,
        attached: false,
        hint: '已固定另一篇笔记',
      };
    }
  }
  const sel = (view.editor?.getSelection?.() || '').trim();
  return {
    title: view.file.basename,
    hasSelection: !!sel,
    path,
    attached: true,
  };
}

/**
 * Capture a frozen snapshot for one outbound turn.
 * @param {import('obsidian').App} app
 * @param {{ mode?: 'follow'|'pin'|'off', pinnedPath?: string, maxChars?: number }} [opts]
 */
export function captureContextSnapshot(app, opts = {}) {
  const mode = opts.mode || 'follow';
  const maxChars = opts.maxChars ?? DEFAULT_ACTIVE_NOTE_MAX_CHARS;
  if (mode === 'off') {
    return {
      attached: false,
      path: null,
      title: '',
      selection: '',
      hasSelection: false,
      cursor: { line: 0, ch: 0 },
      contentVersion: '',
      noteExcerpt: '',
      truncated: false,
      capturedAt: Date.now(),
    };
  }

  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view?.file || !view.editor) {
    return {
      attached: false,
      path: null,
      title: '',
      selection: '',
      hasSelection: false,
      cursor: { line: 0, ch: 0 },
      contentVersion: '',
      noteExcerpt: '',
      truncated: false,
      capturedAt: Date.now(),
    };
  }

  let path = normalizeMdPath(view.file.path);
  if (mode === 'pin' && opts.pinnedPath) {
    const pin = normalizeMdPath(opts.pinnedPath);
    if (pin) path = pin;
  }

  const fullBody = String(view.editor.getValue?.() || '');
  const { text: excerpt, truncated } = truncateWithFlag(fullBody, maxChars);
  const cap = captureEditorContext(view.editor, {
    path,
    noteBody: fullBody,
    noteExcerptChars: maxChars,
  });

  return {
    attached: true,
    path,
    title: view.file.basename,
    selection: cap.selection,
    hasSelection: cap.hasSelection,
    cursor: cap.cursor,
    contentVersion: contentVersionHash(fullBody),
    noteExcerpt: excerpt,
    truncated,
    vicinityBefore: cap.vicinityBefore,
    vicinityAfter: cap.vicinityAfter,
    capturedAt: Date.now(),
  };
}

function truncateWithFlag(body, maxChars) {
  const raw = String(body ?? '');
  if (raw.length <= maxChars) return { text: raw, truncated: false };
  const cut = truncateNoteBody(raw, maxChars);
  return { text: cut, truncated: true };
}
