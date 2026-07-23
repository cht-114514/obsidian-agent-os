/**
 * Apply modes for the IDE command bar.
 *
 * Intent is **model-native natural language** — we do not regex-classify the
 * user prompt. The model declares what to do via a one-line APPLY header.
 *
 * @typedef {'replace_selection' | 'insert_at_cursor' | 'show_only'} ApplyMode
 */

/** @type {readonly ApplyMode[]} */
export const APPLY_MODES = Object.freeze([
  'replace_selection',
  'insert_at_cursor',
  'show_only',
]);

/**
 * Human label for UI chrome (optional / rare).
 * @param {ApplyMode} mode
 * @returns {string}
 */
export function applyModeLabel(mode) {
  switch (mode) {
    case 'replace_selection':
      return '替换选区';
    case 'insert_at_cursor':
      return '插入光标处';
    case 'show_only':
    default:
      return '仅展示';
  }
}

/**
 * @param {unknown} mode
 * @returns {mode is ApplyMode}
 */
export function isApplyMode(mode) {
  return APPLY_MODES.includes(/** @type {ApplyMode} */ (mode));
}

/**
 * Map free-form model tokens → ApplyMode.
 * @param {string} token
 * @returns {ApplyMode | null}
 */
export function normalizeApplyToken(token) {
  const t = String(token || '')
    .trim()
    .toLowerCase()
    .replace(/[- ]+/g, '_');
  if (
    t === 'replace' ||
    t === 'replace_selection' ||
    t === 'rewrite' ||
    t === 'edit'
  ) {
    return 'replace_selection';
  }
  if (
    t === 'insert' ||
    t === 'insert_at_cursor' ||
    t === 'write' ||
    t === 'continue' ||
    t === 'append'
  ) {
    return 'insert_at_cursor';
  }
  if (
    t === 'show' ||
    t === 'show_only' ||
    t === 'answer' ||
    t === 'reply' ||
    t === 'ask' ||
    t === 'chat'
  ) {
    return 'show_only';
  }
  return null;
}

/**
 * Parse model output that may start with:
 *   APPLY: insert|replace|show
 * followed by a blank line and body.
 *
 * If the header is missing → show_only + full text (safe; user can still apply).
 *
 * @param {string} raw
 * @param {{ hasSelection?: boolean }} [opts]
 * @returns {{ mode: ApplyMode, body: string, declared: boolean }}
 */
export function parseApplyResponse(raw, opts = {}) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  if (!text.trim()) {
    return { mode: 'show_only', body: '', declared: false };
  }

  // Allow optional markdown bold / backticks around APPLY line
  const headerRe =
    /^\s*(?:`{0,3})?\s*APPLY\s*[:：]\s*([A-Za-z_]+)[^\n]*\n(?:\s*\n)?([\s\S]*)$/i;
  const m = text.match(headerRe);
  if (m) {
    let mode = normalizeApplyToken(m[1]);
    if (!mode) mode = 'show_only';
    // Can't replace without a selection — demote to insert
    if (mode === 'replace_selection' && !opts.hasSelection) {
      mode = 'insert_at_cursor';
    }
    return {
      mode,
      body: String(m[2] ?? '').replace(/^\uFEFF/, ''),
      declared: true,
    };
  }

  // No header: do not guess with keyword rules — show only
  return {
    mode: 'show_only',
    body: text,
    declared: false,
  };
}

/**
 * While streaming, hide a complete APPLY header from the preview when possible.
 * @param {string} raw
 * @returns {string}
 */
export function stripApplyHeaderForPreview(raw) {
  const text = String(raw ?? '');
  const m = text.match(
    /^\s*(?:`{0,3})?\s*APPLY\s*[:：]\s*[A-Za-z_]+[^\n]*\n(?:\s*\n)?([\s\S]*)$/i
  );
  if (m) return m[1];
  // Incomplete header still streaming — hide partial first line if it looks like APPLY
  if (/^\s*(?:`{0,3})?\s*APP?L?Y?\s*[:：]?[^\n]*$/i.test(text) && !text.includes('\n')) {
    return '';
  }
  return text;
}
