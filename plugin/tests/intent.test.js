import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseApplyResponse,
  stripApplyHeaderForPreview,
  normalizeApplyToken,
  applyModeLabel,
  isApplyMode,
  APPLY_MODES,
} from '../src/intent.js';

describe('normalizeApplyToken', () => {
  it('maps common aliases', () => {
    assert.equal(normalizeApplyToken('insert'), 'insert_at_cursor');
    assert.equal(normalizeApplyToken('replace'), 'replace_selection');
    assert.equal(normalizeApplyToken('show'), 'show_only');
    assert.equal(normalizeApplyToken('write'), 'insert_at_cursor');
    assert.equal(normalizeApplyToken('nope'), null);
  });
});

describe('parseApplyResponse — model-declared mode', () => {
  it('parses insert body', () => {
    const raw = 'APPLY: insert\n\n柯西不等式内容……';
    const r = parseApplyResponse(raw);
    assert.equal(r.mode, 'insert_at_cursor');
    assert.equal(r.declared, true);
    assert.equal(r.body.trim(), '柯西不等式内容……');
  });

  it('parses replace when selection exists', () => {
    const raw = 'APPLY: replace\n\n改写后的段落';
    const r = parseApplyResponse(raw, { hasSelection: true });
    assert.equal(r.mode, 'replace_selection');
    assert.equal(r.body.trim(), '改写后的段落');
  });

  it('demotes replace → insert without selection', () => {
    const raw = 'APPLY: replace\n\n正文';
    const r = parseApplyResponse(raw, { hasSelection: false });
    assert.equal(r.mode, 'insert_at_cursor');
  });

  it('parses show', () => {
    const raw = 'APPLY: show\n\n这是解释。';
    const r = parseApplyResponse(raw);
    assert.equal(r.mode, 'show_only');
    assert.equal(r.body.trim(), '这是解释。');
  });

  it('missing header → show_only, no keyword guessing', () => {
    const raw = '把柯西不等式写一下\n\n（模型忘了 header）';
    const r = parseApplyResponse(raw, { hasSelection: false });
    assert.equal(r.mode, 'show_only');
    assert.equal(r.declared, false);
    assert.match(r.body, /柯西/);
  });

  it('accepts Chinese colon', () => {
    const raw = 'APPLY：insert\n\nhello';
    assert.equal(parseApplyResponse(raw).mode, 'insert_at_cursor');
  });
});

describe('stripApplyHeaderForPreview', () => {
  it('strips complete header', () => {
    assert.equal(
      stripApplyHeaderForPreview('APPLY: insert\n\nbody text'),
      'body text'
    );
  });

  it('hides incomplete APPLY line while streaming', () => {
    assert.equal(stripApplyHeaderForPreview('APPLY: ins'), '');
  });
});

describe('applyMode helpers', () => {
  it('labels and type guard', () => {
    assert.equal(applyModeLabel('show_only'), '仅展示');
    assert.ok(isApplyMode('insert_at_cursor'));
    assert.equal(isApplyMode('nope'), false);
    assert.equal(APPLY_MODES.length, 3);
  });
});
