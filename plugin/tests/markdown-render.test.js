import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMathDelimiters,
  looksLikeMath,
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
