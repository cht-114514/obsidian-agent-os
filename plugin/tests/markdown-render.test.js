import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMathDelimiters,
  looksLikeMath,
  extractMathSegments,
  formatLatexForCopy,
  flattenDomLatexToText,
  selectionPlainWithLatex,
  syncMathSelectionHighlight,
} from '../src/markdown-render.js';

describe('normalizeMathDelimiters', () => {
  it('converts \\( \\) to $ $', () => {
    const out = normalizeMathDelimiters('面积为 \\(a^2\\) 即可');
    assert.equal(out, '面积为 $a^2$ 即可');
  });

  it('converts \\[ \\] to $$ $$', () => {
    const out = normalizeMathDelimiters('见\n\\[E=mc^2\\]\n完');
    assert.match(out, /\$\$\s*E=mc\^2\s*\$\$/);
  });

  it('converts equation environments', () => {
    const out = normalizeMathDelimiters(
      'x:\n\\begin{equation}\nx+1=2\n\\end{equation}\n'
    );
    assert.match(out, /\$\$\s*x\+1=2\s*\$\$/);
  });

  it('does not alter fenced code', () => {
    const src = '```js\nconst x = "\\(a\\)"\n```\n\\(b\\)';
    const out = normalizeMathDelimiters(src);
    assert.match(out, /const x = "\\\(a\\\)"/);
    assert.match(out, /\$b\$/);
  });

  it('keeps existing $ delimiters', () => {
    const src = '有 $a+b$ 与 $$c$$';
    assert.equal(normalizeMathDelimiters(src), src);
  });
});

describe('looksLikeMath', () => {
  it('detects dollar and latex delimiters', () => {
    assert.equal(looksLikeMath('plain'), false);
    assert.equal(looksLikeMath('$a$'), true);
    assert.equal(looksLikeMath('\\(a\\)'), true);
    assert.equal(looksLikeMath('\\begin{matrix}1\\end{matrix}'), true);
  });
});

describe('extractMathSegments + formatLatexForCopy', () => {
  it('extracts inline and display in order', () => {
    const segs = extractMathSegments('见 $a^2$ 与 $$\\frac{1}{2}$$ 完');
    assert.deepEqual(segs, [
      { latex: 'a^2', display: false },
      { latex: '\\frac{1}{2}', display: true },
    ]);
  });

  it('skips fenced code math-looking strings', () => {
    const segs = extractMathSegments('```\n$a$\n```\n真 $b$');
    assert.deepEqual(segs, [{ latex: 'b', display: false }]);
  });

  it('formats delimiters for clipboard', () => {
    assert.equal(formatLatexForCopy('a^2', false), '$a^2$');
    assert.equal(formatLatexForCopy('a+b', true), '$$a+b$$');
  });
});

describe('flattenDomLatexToText + selectionPlainWithLatex', () => {
  const hasDom = typeof document !== 'undefined';

  (hasDom ? it : it.skip)('promotes math-copytext overlay to plain TeX', () => {
    const root = document.createElement('div');
    const host = document.createElement('span');
    host.className = 'math';
    host.setAttribute('data-me-soul-latex', 'a^2');
    host.setAttribute('data-me-soul-display', '0');
    const overlay = document.createElement('span');
    overlay.className = 'me-soul-math-copytext';
    overlay.textContent = '$a^2$';
    host.appendChild(overlay);
    root.appendChild(document.createTextNode('见 '));
    root.appendChild(host);
    root.appendChild(document.createTextNode(' 完'));
    const frag = document.createDocumentFragment();
    frag.appendChild(root.cloneNode(true));
    const out = flattenDomLatexToText(frag);
    assert.match(out, /见 \$a\^2\$ 完/);
  });

  it('syncMathSelectionHighlight is a no-op without selection APIs', () => {
    // Smoke: function exists and tolerates empty root-like object
    const root = { querySelectorAll: () => [] };
    assert.doesNotThrow(() => syncMathSelectionHighlight(root));
  });
});
