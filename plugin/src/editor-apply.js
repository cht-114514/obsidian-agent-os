/**
 * Pure helpers for capturing editor context and applying agent text.
 * Editor interface matches Obsidian CodeMirror Editor API surface we use.
 *
 * @typedef {{
 *   getSelection: () => string,
 *   getCursor: (side?: 'from'|'to') => { line: number, ch: number },
 *   getValue: () => string,
 *   replaceSelection: (text: string) => void,
 *   replaceRange: (text: string, from: {line:number,ch:number}, to?: {line:number,ch:number}) => void,
 *   setCursor?: (pos: {line:number,ch:number}) => void,
 *   somethingSelected?: () => boolean,
 * }} EditorLike
 *
 * @typedef {{
 *   path: string | null,
 *   selection: string,
 *   hasSelection: boolean,
 *   cursor: { line: number, ch: number },
 *   vicinityBefore: string,
 *   vicinityAfter: string,
 *   noteExcerpt: string,
 * }} EditorCapture
 */

import { truncateNoteBody } from './active-note.js';

export const DEFAULT_VICINITY_CHARS = 400;
export const DEFAULT_NOTE_EXCERPT_CHARS = 6000;

/**
 * Strip chatty wrappers / fences so insert/replace lands clean prose.
 * @param {string} text
 * @param {'replace_selection'|'insert_at_cursor'|'show_only'} [mode]
 * @returns {string}
 */
export function cleanModelOutput(text, mode = 'show_only') {
  let s = String(text ?? '').replace(/^\uFEFF/, '');
  if (mode !== 'insert_at_cursor') {
    s = s.trim();
  } else {
    // Keep intentional leading whitespace/newlines for insert; drop trailing only later
    s = s.replace(/^\uFEFF/, '');
  }
  if (!s.trim()) return '';

  // Full-string fenced block
  const fullFence = s.trim().match(/^```(?:[\w+-]*)?\r?\n([\s\S]*?)\r?\n```\s*$/);
  if (fullFence) {
    s = fullFence[1];
    if (mode !== 'insert_at_cursor') s = s.trim();
  } else {
    const open = s.trim().match(/^```(?:[\w+-]*)?\r?\n([\s\S]*?)(?:\r?\n```)?\s*$/);
    if (open && (mode === 'replace_selection' || mode === 'insert_at_cursor')) {
      s = open[1].replace(/\r?\n```\s*$/, '');
      if (mode !== 'insert_at_cursor') s = s.trim();
    }
  }

  // Common model preambles for edit modes
  if (mode === 'replace_selection' || mode === 'insert_at_cursor') {
    s = s
      .replace(
        /^(以下是改写|以下是|改写后|修改后|结果如下|输出：|Output:)[：:\s]*/i,
        ''
      )
      .replace(/^["「『]|["」』]$/g, '');
    if (mode === 'replace_selection') s = s.trim();
    else s = s.replace(/\s+$/, ''); // insert: only trim trailing
  }

  return s;
}

/**
 * Capture selection + local context from an editor.
 * @param {EditorLike | null | undefined} editor
 * @param {{
 *   path?: string | null,
 *   noteBody?: string,
 *   vicinityChars?: number,
 *   noteExcerptChars?: number,
 * }} [opts]
 * @returns {EditorCapture}
 */
export function captureEditorContext(editor, opts = {}) {
  const path = opts.path ?? null;
  const vicinityChars = opts.vicinityChars ?? DEFAULT_VICINITY_CHARS;
  const noteExcerptChars = opts.noteExcerptChars ?? DEFAULT_NOTE_EXCERPT_CHARS;

  if (!editor) {
    return {
      path,
      selection: '',
      hasSelection: false,
      cursor: { line: 0, ch: 0 },
      vicinityBefore: '',
      vicinityAfter: '',
      noteExcerpt: truncateNoteBody(opts.noteBody || '', noteExcerptChars),
    };
  }

  const selection = String(editor.getSelection?.() || '');
  const hasSelection = selection.length > 0;
  const cursor = editor.getCursor?.('from') || editor.getCursor?.() || { line: 0, ch: 0 };
  const full = String(editor.getValue?.() || opts.noteBody || '');

  let vicinityBefore = '';
  let vicinityAfter = '';
  if (full) {
    const offset = posToOffset(full, cursor);
    vicinityBefore = full.slice(Math.max(0, offset - vicinityChars), offset);
    const endOff = hasSelection
      ? offset + selection.length
      : offset;
    // When selection present, after starts past selection
    const selEnd = hasSelection ? findSelectionEndOffset(full, offset, selection) : endOff;
    vicinityAfter = full.slice(selEnd, selEnd + vicinityChars);
  }

  return {
    path,
    selection,
    hasSelection,
    cursor: { line: cursor.line ?? 0, ch: cursor.ch ?? 0 },
    vicinityBefore,
    vicinityAfter,
    noteExcerpt: truncateNoteBody(opts.noteBody || full, noteExcerptChars),
  };
}

/**
 * @param {string} full
 * @param {{ line: number, ch: number }} pos
 */
function posToOffset(full, pos) {
  const lines = full.split('\n');
  let off = 0;
  const line = Math.max(0, Math.min(pos.line || 0, lines.length - 1));
  for (let i = 0; i < line; i++) {
    off += lines[i].length + 1;
  }
  off += Math.min(pos.ch || 0, (lines[line] || '').length);
  return off;
}

/**
 * @param {string} full
 * @param {number} startOff
 * @param {string} selection
 */
function findSelectionEndOffset(full, startOff, selection) {
  if (full.startsWith(selection, startOff)) return startOff + selection.length;
  const idx = full.indexOf(selection, Math.max(0, startOff - 2));
  if (idx >= 0) return idx + selection.length;
  return startOff + selection.length;
}

/**
 * Apply model text to the editor according to mode.
 * @param {EditorLike} editor
 * @param {'replace_selection'|'insert_at_cursor'|'show_only'} mode
 * @param {string} text
 * @returns {{ applied: boolean, mode: string, text: string }}
 */
export function applyToEditor(editor, mode, text) {
  const cleaned = cleanModelOutput(text, mode);
  if (!editor || mode === 'show_only' || !cleaned) {
    return { applied: false, mode, text: cleaned };
  }

  if (mode === 'replace_selection') {
    const sel = editor.getSelection?.() || '';
    if (sel) {
      editor.replaceSelection(cleaned);
    } else {
      // No selection — insert at cursor instead of wiping content
      const cur = editor.getCursor?.() || { line: 0, ch: 0 };
      editor.replaceRange(cleaned, cur);
    }
    return { applied: true, mode: 'replace_selection', text: cleaned };
  }

  if (mode === 'insert_at_cursor') {
    const cur = editor.getCursor?.('to') || editor.getCursor?.() || { line: 0, ch: 0 };
    editor.replaceRange(cleaned, cur);
    return { applied: true, mode: 'insert_at_cursor', text: cleaned };
  }

  return { applied: false, mode, text: cleaned };
}
