/**
 * Mobile keyboard inset: with visualViewport, track the live gap each frame.
 * --keyboard-height is only used when visualViewport is unavailable.
 * @param {CSSStyleDeclaration} bodyStyle
 * @param {VisualViewport|null} viewport
 * @param {number} innerHeight
 * @returns {number}
 */
export function resolveMobileKeyboardPx(bodyStyle, viewport, innerHeight, opts = {}) {
  const focused = opts.focused !== false;
  let safeBottom = 0;
  try {
    const safeRaw = bodyStyle.getPropertyValue('--safe-area-inset-bottom').trim();
    const safeParsed = parseFloat(safeRaw);
    if (Number.isFinite(safeParsed) && safeParsed > 0) safeBottom = safeParsed;
  } catch {
    /* ignore */
  }
  const threshold = Math.max(80, safeBottom + 48);

  if (viewport && innerHeight) {
    const gap = Math.max(0, innerHeight - viewport.height - (viewport.offsetTop || 0));
    if (gap <= threshold) return 0;
    return Math.round(gap);
  }

  let css = 0;
  try {
    const raw = bodyStyle.getPropertyValue('--keyboard-height').trim();
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) css = Math.round(parsed);
  } catch {
    /* ignore */
  }
  if (!focused) return 0;
  if (css > 0) return css;
  return 0;
}

/**
 * @param {DOMRect} rect
 * @param {CSSStyleDeclaration} style
 * @param {number} [viewportHeight]
 * @returns {number}
 */
/**
 * One bottom offset for the composer.
 * Keyboard open: 8px above the keyboard, no home-indicator padding.
 * Keyboard closed: safe area once. A visible navbar already includes it.
 */
export function composerOffsetPx({ keyboardPx = 0, safeBottom = 0, navStack = 0, hideNavbar = false } = {}) {
  const keyboard = Number(keyboardPx) || 0;
  if (keyboard > 0) return Math.round(keyboard + 8);
  if (hideNavbar) return Math.round(8 + Math.max(0, Number(safeBottom) || 0));
  return Math.round(Math.max(0, Number(navStack) || 0) + 8);
}

export function navbarReservePx(rect, style, viewportHeight = 0) {
  const visible =
    style.display !== 'none' && style.visibility !== 'hidden' && rect.height > 8;
  if (!visible) return 0;
  let fromTop = 0;
  if (viewportHeight > 0 && rect.top > 0 && rect.top < viewportHeight) {
    fromTop = Math.round(viewportHeight - rect.top);
  }
  const marginBottom = parseFloat(style.marginBottom) || 0;
  const fromBox = Math.round(rect.height + marginBottom);
  return Math.max(fromTop, fromBox);
}
