import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanModelOutput,
  captureEditorContext,
  applyToEditor,
} from '../src/editor-apply.js';
import { buildCommandBarPrompt } from '../src/agent-turn.js';
import { parseApplyResponse } from '../src/intent.js';

function mockEditor(initial = 'hello world') {
  let value = initial;
  let selFrom = 0;
  let selTo = 0;
  const lines = () => value.split('\n');

  function offsetToPos(off) {
    const ls = lines();
    let remain = off;
    for (let i = 0; i < ls.length; i++) {
      if (remain <= ls[i].length) return { line: i, ch: remain };
      remain -= ls[i].length + 1;
    }
    const last = ls.length - 1;
    return { line: last, ch: (ls[last] || '').length };
  }

  function posToOff(pos) {
    const ls = lines();
    let off = 0;
    for (let i = 0; i < pos.line; i++) off += ls[i].length + 1;
    return off + pos.ch;
  }

  return {
    getValue: () => value,
    getSelection: () => value.slice(selFrom, selTo),
    somethingSelected: () => selFrom !== selTo,
    getCursor: (side) => {
      if (side === 'to') return offsetToPos(selTo);
      return offsetToPos(selFrom);
    },
    setSelection: (from, to) => {
      selFrom = posToOff(from);
      selTo = posToOff(to ?? from);
    },
    selectRange: (fromOff, toOff) => {
      selFrom = fromOff;
      selTo = toOff;
    },
    replaceSelection: (text) => {
      value = value.slice(0, selFrom) + text + value.slice(selTo);
      selTo = selFrom + text.length;
      selFrom = selTo;
    },
    replaceRange: (text, from, to) => {
      const a = posToOff(from);
      const b = to ? posToOff(to) : a;
      value = value.slice(0, a) + text + value.slice(b);
      selFrom = a + text.length;
      selTo = selFrom;
    },
    _value: () => value,
  };
}

describe('cleanModelOutput', () => {
  it('strips full fences for edit modes', () => {
    assert.equal(
      cleanModelOutput('```\nfoo bar\n```', 'replace_selection'),
      'foo bar'
    );
    assert.equal(
      cleanModelOutput('```markdown\n# hi\n```', 'insert_at_cursor'),
      '# hi'
    );
  });

  it('strips common preambles in edit modes', () => {
    assert.equal(
      cleanModelOutput('以下是改写：\n正文', 'replace_selection'),
      '正文'
    );
  });

  it('keeps normal answers for show_only', () => {
    const s = '这段话的意思是……';
    assert.equal(cleanModelOutput(s, 'show_only'), s);
  });
});

describe('captureEditorContext + applyToEditor', () => {
  it('captures selection and applies replace', () => {
    const ed = mockEditor('alpha beta gamma');
    ed.selectRange(6, 10); // beta
    const cap = captureEditorContext(ed, { path: '手记/a.md' });
    assert.equal(cap.selection, 'beta');
    assert.equal(cap.hasSelection, true);
    assert.equal(cap.path, '手记/a.md');

    const r = applyToEditor(ed, 'replace_selection', 'BETA');
    assert.equal(r.applied, true);
    assert.equal(ed._value(), 'alpha BETA gamma');
  });

  it('inserts at cursor', () => {
    const ed = mockEditor('hello');
    ed.selectRange(5, 5);
    const r = applyToEditor(ed, 'insert_at_cursor', ' world');
    assert.equal(r.applied, true);
    assert.equal(ed._value(), 'hello world');
  });

  it('show_only does not mutate', () => {
    const ed = mockEditor('stay');
    const r = applyToEditor(ed, 'show_only', 'answer');
    assert.equal(r.applied, false);
    assert.equal(ed._value(), 'stay');
  });
});

describe('buildCommandBarPrompt — NL native', () => {
  it('asks model to understand NL and declare APPLY', () => {
    const prompt = buildCommandBarPrompt({
      userText: '把柯西不等式的内容写一下',
      capture: {
        path: '基础学科/数学.md',
        selection: '',
        hasSelection: false,
        cursor: { line: 0, ch: 0 },
        vicinityBefore: '前文',
        vicinityAfter: '',
        noteExcerpt: '笔记摘录一段',
      },
    });
    assert.match(prompt, /自然语言/);
    assert.match(prompt, /APPLY:/);
    assert.match(prompt, /禁止调用任何工具/);
    assert.match(prompt, /柯西不等式/);
    assert.doesNotMatch(prompt, /应用模式：/);
  });

  it('includes selection when present', () => {
    const prompt = buildCommandBarPrompt({
      userText: '改短一点',
      capture: {
        path: '手记/x.md',
        selection: '很长的一段话',
        hasSelection: true,
        cursor: { line: 0, ch: 0 },
        vicinityBefore: '',
        vicinityAfter: '',
        noteExcerpt: '',
      },
    });
    assert.match(prompt, /很长的一段话/);
    assert.match(prompt, /replace/);
  });
});

describe('end-to-end parse → apply', () => {
  it('model insert response lands in editor', () => {
    const ed = mockEditor('prefix\n');
    ed.selectRange(7, 7);
    const parsed = parseApplyResponse(
      'APPLY: insert\n\n## 柯西不等式\n\n正文'
    );
    assert.equal(parsed.mode, 'insert_at_cursor');
    const r = applyToEditor(ed, parsed.mode, parsed.body);
    assert.equal(r.applied, true);
    assert.match(ed._value(), /柯西不等式/);
  });
});
