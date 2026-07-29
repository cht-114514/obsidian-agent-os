/**
 * Markdown + LaTeX helpers for chat message bodies.
 * Obsidian's MarkdownRenderer can leave `$...$` raw unless MathJax is loaded
 * and finishRenderMath runs; models also emit \( \) / \[ \] which need normalizing.
 *
 * MathJax output (SVG/CHTML) is not meaningfully selectable — we put a
 * full-size transparent TeX overlay on top (so drag-select works like text),
 * paint a normal selection highlight on the host, and rewrite clipboard to TeX.
 */

/**
 * Convert common LaTeX delimiters models emit into Obsidian `$` / `$$` form.
 * Leaves existing `$` / `$$` alone. Skips fenced code blocks.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function normalizeMathDelimiters(markdown) {
  const src = String(markdown ?? '');
  if (!src) return '';

  // Split on fenced code blocks so we don't touch math-looking code
  const parts = src.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // fence
      let s = part;
      // Display: \[ ... \]  (incl. multiline)
      s = s.replace(/\\\[((?:\\.|[\s\S])*?)\\\]/g, (_, body) => {
        const inner = String(body).trim();
        return inner ? `\n$$\n${inner}\n$$\n` : _;
      });
      // Inline: \( ... \)
      s = s.replace(/\\\(((?:\\.|[\s\S])*?)\\\)/g, (_, body) => {
        const inner = String(body).trim();
        return inner ? `$${inner}$` : _;
      });
      // \begin{equation} ... \end{equation} → $$ ... $$
      s = s.replace(
        /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}([\s\S]*?)\\end\{\1\}/g,
        (_, _env, body) => `\n$$\n${String(body).trim()}\n$$\n`
      );
      return s;
    })
    .join('');
}

/**
 * True if string looks like it contains math delimiters worth typesetting.
 * @param {string} s
 */
export function looksLikeMath(s) {
  const t = String(s ?? '');
  if (!t) return false;
  if (/\${1,2}[^$]+\${1,2}/.test(t)) return true;
  if (/\\\(|\\\[|\\begin\{(equation|align|gather|matrix|pmatrix|bmatrix)/.test(t)) {
    return true;
  }
  return false;
}

/**
 * Ordered math segments from markdown (after delimiter normalize; skips fences).
 * @param {string} markdown
 * @returns {{ latex: string, display: boolean }[]}
 */
export function extractMathSegments(markdown) {
  const md = normalizeMathDelimiters(markdown);
  if (!md) return [];
  const parts = md.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  /** @type {{ latex: string, display: boolean }[]} */
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue;
    const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
    let m;
    while ((m = re.exec(parts[i])) !== null) {
      if (m[1] != null) out.push({ latex: String(m[1]).trim(), display: true });
      else out.push({ latex: String(m[2] || '').trim(), display: false });
    }
  }
  return out.filter((s) => s.latex);
}

/**
 * @param {string} latex
 * @param {boolean} display
 */
export function formatLatexForCopy(latex, display) {
  const t = String(latex || '').trim();
  if (!t) return '';
  return display ? `$$${t}$$` : `$${t}$`;
}

/**
 * @param {Element | null | undefined} el
 * @returns {string}
 */
export function readTexAnnotation(el) {
  if (!el?.querySelector) return '';
  const ann =
    el.querySelector('annotation[encoding="application/x-tex"]') ||
    el.querySelector('annotation[encoding="TeX"]');
  return String(ann?.textContent || '').trim();
}

/**
 * Tag a rendered math host so selection/copy can recover TeX.
 * @param {Element} el
 * @param {string} latex
 * @param {boolean} display
 */
export function annotateMathElement(el, latex, display) {
  if (!el || typeof el.setAttribute !== 'function') return;
  const src = String(latex || '').trim();
  if (!src) return;
  el.setAttribute('data-me-soul-latex', src);
  el.setAttribute('data-me-soul-display', display ? '1' : '0');
  el.removeAttribute?.('title');
  if (el.classList) el.classList.add('me-soul-math-copyable');

  if (typeof document === 'undefined' || !el.appendChild) return;
  el.querySelectorAll?.(':scope > .me-soul-math-copytext')?.forEach?.((n) => n.remove());
  el.querySelectorAll?.(':scope > .me-soul-math-copy-btn')?.forEach?.((n) => n.remove());
  // Also clear non-:scope for older engines
  Array.from(el.children || [])
    .filter((c) => c.classList?.contains('me-soul-math-copytext') || c.classList?.contains('me-soul-math-copy-btn'))
    .forEach((c) => c.remove());

  const span = document.createElement('span');
  span.className = 'me-soul-math-copytext';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = formatLatexForCopy(src, !!display);
  el.appendChild(span);
}

/**
 * Match rendered .math / mjx nodes to markdown segments (document order).
 * @param {ParentNode} root
 * @param {string} markdown
 */
export function annotateRenderedMath(root, markdown) {
  if (!root?.querySelectorAll) return;
  const segments = extractMathSegments(markdown);
  /** @type {Element[]} */
  let targets = Array.from(root.querySelectorAll('.math'));
  if (!targets.length) {
    targets = Array.from(root.querySelectorAll('mjx-container')).filter(
      (el) => !el.parentElement?.closest?.('mjx-container, .math')
    );
  }

  const n = Math.min(segments.length, targets.length);
  for (let i = 0; i < n; i++) {
    annotateMathElement(targets[i], segments[i].latex, segments[i].display);
  }

  // Fill gaps from MathML TeX annotations
  for (const el of root.querySelectorAll('.math, mjx-container')) {
    if (el.getAttribute?.('data-me-soul-latex')) continue;
    const fromAnn = readTexAnnotation(el);
    if (!fromAnn) continue;
    const display =
      el.classList?.contains('math-block') ||
      el.getAttribute('display') === 'true' ||
      el.closest?.('.math-block') != null;
    annotateMathElement(el, fromAnn, display);
  }
}

/**
 * Rewrite a cloned DOM fragment so math hosts become `$latex$` text.
 * @param {ParentNode} frag
 * @returns {string}
 */
export function flattenDomLatexToText(frag) {
  if (!frag) return '';
  const root = /** @type {ParentNode} */ (frag);

  // Overlay spans already hold formatted TeX — promote to text before math hosts.
  root.querySelectorAll?.('.me-soul-math-copytext')?.forEach?.((n) => {
    const t = String(n.textContent || '');
    if (n.parentNode) n.replaceWith(document.createTextNode(t));
    else n.remove();
  });

  const replaceMath = (el) => {
    if (!el?.parentNode) return;
    const latex =
      el.getAttribute?.('data-me-soul-latex') || readTexAnnotation(el) || '';
    if (!latex) {
      el.remove();
      return;
    }
    const display =
      el.getAttribute?.('data-me-soul-display') === '1' ||
      el.classList?.contains('math-block') ||
      el.getAttribute?.('display') === 'true';
    el.replaceWith(
      document.createTextNode(formatLatexForCopy(latex, display))
    );
  };

  root.querySelectorAll?.('[data-me-soul-latex]')?.forEach?.(replaceMath);
  root.querySelectorAll?.('.math, mjx-container')?.forEach?.(replaceMath);

  return String(root.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * @param {Selection | null | undefined} sel
 * @param {ParentNode} root
 * @returns {string | null} plain text with LaTeX, or null to keep native copy
 */
export function selectionPlainWithLatex(sel, root) {
  if (!sel || !root || sel.rangeCount === 0) return null;

  const anchorEl =
    (sel.anchorNode?.nodeType === 1
      ? /** @type {Element} */ (sel.anchorNode)
      : sel.anchorNode?.parentElement) || null;
  const focusEl =
    (sel.focusNode?.nodeType === 1
      ? /** @type {Element} */ (sel.focusNode)
      : sel.focusNode?.parentElement) || null;

  const hostFromCaret =
    anchorEl?.closest?.('[data-me-soul-latex]') ||
    focusEl?.closest?.('[data-me-soul-latex]') ||
    null;

  // Click formula then ⌘C (collapsed caret inside SVG/CHTML) — native copy is empty.
  if (sel.isCollapsed) {
    if (hostFromCaret && root.contains(hostFromCaret)) {
      return formatLatexForCopy(
        hostFromCaret.getAttribute('data-me-soul-latex') || '',
        hostFromCaret.getAttribute('data-me-soul-display') === '1'
      );
    }
    return null;
  }

  const range = sel.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  const ancestorEl =
    ancestor.nodeType === 1
      ? /** @type {Element} */ (ancestor)
      : ancestor.parentElement;
  if (!ancestorEl || !root.contains(ancestorEl)) {
    // Selection may sit in SVG text under a math host still inside root
    if (hostFromCaret && root.contains(hostFromCaret)) {
      return formatLatexForCopy(
        hostFromCaret.getAttribute('data-me-soul-latex') || '',
        hostFromCaret.getAttribute('data-me-soul-display') === '1'
      );
    }
    return null;
  }

  const frag = range.cloneContents();
  const hasMath = !!(
    frag.querySelector?.(
      '[data-me-soul-latex], .me-soul-math-copytext, .math, mjx-container'
    ) || hostFromCaret
  );

  if (!hasMath) return null;

  // Selection only touched SVG glyphs — fragment has no math host, use caret host.
  if (
    hostFromCaret &&
    root.contains(hostFromCaret) &&
    !frag.querySelector?.(
      '[data-me-soul-latex], .me-soul-math-copytext, .math, mjx-container'
    )
  ) {
    // If the range is entirely inside one formula, copy just that TeX.
    const startHost = range.startContainer?.parentElement?.closest?.(
      '[data-me-soul-latex]'
    );
    const endHost = range.endContainer?.parentElement?.closest?.(
      '[data-me-soul-latex]'
    );
    if (startHost && startHost === endHost) {
      return formatLatexForCopy(
        startHost.getAttribute('data-me-soul-latex') || '',
        startHost.getAttribute('data-me-soul-display') === '1'
      );
    }
  }

  return flattenDomLatexToText(frag);
}

/**
 * Paint normal text-like selection highlight on formulas under the current range.
 * MathJax SVG itself rarely shows ::selection — we mirror it onto the host.
 * @param {ParentNode} root
 */
export function syncMathSelectionHighlight(root) {
  if (!root?.querySelectorAll) return;
  const hosts = root.querySelectorAll('[data-me-soul-latex]');
  hosts.forEach((h) => h.classList?.remove?.('is-math-selected'));

  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

  let range;
  try {
    range = sel.getRangeAt(0);
  } catch {
    return;
  }

  hosts.forEach((host) => {
    if (!root.contains?.(host)) return;
    try {
      if (typeof range.intersectsNode === 'function') {
        if (range.intersectsNode(host)) host.classList.add('is-math-selected');
        return;
      }
    } catch {
      /* intersectsNode can throw on detached nodes */
    }
    // Fallback: caret/endpoints inside host
    const a = sel.anchorNode;
    const f = sel.focusNode;
    if (host.contains?.(a) || host.contains?.(f)) {
      host.classList.add('is-math-selected');
    }
  });
}

/**
 * Wire selection highlight + ⌘C → TeX.
 * @param {{
 *   copyText?: (text: string) => Promise<boolean> | boolean,
 *   onCopied?: (text: string) => void,
 * }} [opts]
 */
export function wireMathCopy(root, opts = {}) {
  if (!root || typeof root.addEventListener !== 'function') return;
  const el = /** @type {HTMLElement} */ (root);

  if (el.dataset?.meSoulMathCopyWired === '1') return;
  if (el.dataset) el.dataset.meSoulMathCopyWired = '1';

  // Capture: Electron/Obsidian sometimes handle copy before bubble reaches us.
  el.addEventListener(
    'copy',
    (ev) => {
      try {
        const sel = window.getSelection?.();
        const text = selectionPlainWithLatex(sel, el);
        if (text == null) return;
        ev.clipboardData?.setData('text/plain', text);
        ev.preventDefault();
      } catch {
        /* native copy */
      }
    },
    true
  );

  const onSelChange = () => {
    try {
      syncMathSelectionHighlight(el);
    } catch {
      /* */
    }
  };
  document.addEventListener('selectionchange', onSelChange);
  // Best-effort cleanup when the message node is removed
  if (typeof MutationObserver === 'function') {
    const mo = new MutationObserver(() => {
      if (!el.isConnected) {
        document.removeEventListener('selectionchange', onSelChange);
        mo.disconnect();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // Double-click formula → select whole TeX (like double-clicking a word)
  el.addEventListener('dblclick', (ev) => {
    const host = /** @type {Element | null} */ (
      /** @type {Element} */ (ev.target)?.closest?.('[data-me-soul-latex]')
    );
    if (!host || !el.contains(host)) return;
    const tex = host.querySelector?.('.me-soul-math-copytext');
    if (!tex) return;
    ev.preventDefault();
    try {
      const range = document.createRange();
      range.selectNodeContents(tex);
      const sel = window.getSelection?.();
      sel?.removeAllRanges?.();
      sel?.addRange?.(range);
      host.classList.add('is-math-selected');
    } catch {
      /* */
    }
  });
}

/**
 * Render markdown into el with MathJax support.
 *
 * @param {{
 *   app: any,
 *   MarkdownRenderer: any,
 *   component: any,
 *   el: HTMLElement,
 *   markdown: string,
 *   sourcePath?: string,
 *   loadMathJax?: () => Promise<void>,
 *   finishRenderMath?: () => Promise<void>,
 *   renderMath?: (source: string, display: boolean) => HTMLElement,
 *   copyText?: (text: string) => Promise<boolean> | boolean,
 *   onCopied?: (text: string) => void,
 * }} opts
 */
export async function renderMarkdownWithMath(opts) {
  const {
    app,
    MarkdownRenderer,
    component,
    el,
    markdown,
    sourcePath,
    loadMathJax,
    finishRenderMath,
    renderMath,
    copyText,
    onCopied,
  } = opts;

  const md = normalizeMathDelimiters(markdown);
  el.empty();
  el.addClass('markdown-rendered');
  el.addClass('me-soul-md');

  if (looksLikeMath(md) && typeof loadMathJax === 'function') {
    try {
      await loadMathJax();
    } catch {
      /* MathJax optional if core already loaded */
    }
  }

  const path =
    sourcePath ||
    app?.workspace?.getActiveFile?.()?.path ||
    'agent-inbox/sessions/current.md';

  let rendered = false;
  if (MarkdownRenderer?.render) {
    try {
      await MarkdownRenderer.render(app, md, el, path, component);
      rendered = true;
    } catch {
      rendered = false;
    }
  } else if (MarkdownRenderer?.renderMarkdown) {
    // Older API
    try {
      await MarkdownRenderer.renderMarkdown(md, el, path, component);
      rendered = true;
    } catch {
      rendered = false;
    }
  }

  if (!rendered) {
    el.setText(md);
  }

  // Fallback when MD left raw $...$ / $$...$$ as text (no .math / mjx yet)
  if (typeof renderMath === 'function' && looksLikeMath(md)) {
    try {
      await hydrateRawMath(el, renderMath);
    } catch {
      /* keep raw if MathJax can't parse a fragment */
    }
  }

  if (typeof finishRenderMath === 'function') {
    try {
      await finishRenderMath();
    } catch {
      /* */
    }
  }

  // MathJax v3 global typeset if present (covers edge cases)
  try {
    const MJ = /** @type {any} */ (globalThis).MathJax;
    if (MJ?.typesetPromise) {
      await MJ.typesetPromise([el]);
    } else if (MJ?.typeset) {
      MJ.typeset([el]);
    }
  } catch {
    /* */
  }

  // Attach TeX sources so copy/selection yields `$...$` instead of empty SVG
  try {
    annotateRenderedMath(el, md);
    wireMathCopy(el, { copyText, onCopied });
  } catch {
    /* non-fatal */
  }

  // MathJax may finish a frame late — re-annotate once so copy metadata sticks.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      try {
        annotateRenderedMath(el, md);
      } catch {
        /* */
      }
    });
  }
}

/**
 * Walk text nodes; replace $$...$$ and $...$ with Obsidian renderMath nodes.
 * Skips code/pre/math already rendered.
 *
 * @param {HTMLElement} root
 * @param {(source: string, display: boolean) => HTMLElement} renderMath
 */
export async function hydrateRawMath(root, renderMath) {
  if (!root || typeof document === 'undefined') return;

  // If MathJax already fully typeset and no remaining `$` text, skip
  const hasTypeset = !!root.querySelector?.(
    'mjx-container, .math .MathJax, .MathJax, .MathJax_Display'
  );
  const raw = root.textContent || '';
  if (hasTypeset && !/\$[^$\n]+\$|\$\$/.test(raw)) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest('code, pre, .math, mjx-container, .MathJax, script, style, .cm-content')) {
        return NodeFilter.FILTER_REJECT;
      }
      const t = node.nodeValue || '';
      if (!t.includes('$')) return NodeFilter.FILTER_REJECT;
      // Need a real pair
      if (!/\$(?:\$)?[^$]+\$/.test(t) && !/\$\$[\s\S]+?\$\$/.test(t)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  /** @type {Text[]} */
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) {
    nodes.push(/** @type {Text} */ (n));
  }

  for (const textNode of nodes) {
    const text = textNode.nodeValue || '';
    const frag = splitTextToMathFrag(text, renderMath);
    if (!frag) continue;
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

/**
 * @param {string} text
 * @param {(source: string, display: boolean) => HTMLElement} renderMath
 * @returns {DocumentFragment | null}
 */
export function splitTextToMathFrag(text, renderMath) {
  // Match $$...$$ first, then $...$ (no nested)
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let last = 0;
  let m;
  /** @type {Array<{ type: 'text' | 'math', value: string, display?: boolean }>} */
  const parts = [];
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push({ type: 'text', value: text.slice(last, m.index) });
    }
    if (m[1] != null) {
      parts.push({ type: 'math', value: m[1].trim(), display: true });
    } else {
      parts.push({ type: 'math', value: String(m[2] || '').trim(), display: false });
    }
    last = m.index + m[0].length;
  }
  if (!parts.some((p) => p.type === 'math')) return null;
  if (last < text.length) {
    parts.push({ type: 'text', value: text.slice(last) });
  }

  const frag = document.createDocumentFragment();
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.value) frag.appendChild(document.createTextNode(p.value));
      continue;
    }
    try {
      const mathEl = renderMath(p.value, !!p.display);
      if (mathEl) {
        // Obsidian wraps with .math.math-inline / .math.math-block
        annotateMathElement(mathEl, p.value, !!p.display);
        frag.appendChild(mathEl);
      } else {
        frag.appendChild(
          document.createTextNode(formatLatexForCopy(p.value, !!p.display))
        );
      }
    } catch {
      frag.appendChild(
        document.createTextNode(formatLatexForCopy(p.value, !!p.display))
      );
    }
  }
  return frag;
}
