/**
 * Markdown + LaTeX helpers for chat message bodies.
 * Obsidian's MarkdownRenderer can leave `$...$` raw unless MathJax is loaded
 * and finishRenderMath runs; models also emit \( \) / \[ \] which need normalizing.
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
        frag.appendChild(mathEl);
      } else {
        frag.appendChild(
          document.createTextNode(p.display ? `$$${p.value}$$` : `$${p.value}$`)
        );
      }
    } catch {
      frag.appendChild(
        document.createTextNode(p.display ? `$$${p.value}$$` : `$${p.value}$`)
      );
    }
  }
  return frag;
}
