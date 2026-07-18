import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDigestPrompt,
  extractWikiMarkdown,
  ensureWikiDocument,
  setWikiStatus,
  buildDigestPending,
  wikiPreview,
} from '../src/digest.js';

describe('digest helpers', () => {
  it('buildDigestPrompt includes source and asks for full wiki', () => {
    const p = buildDigestPrompt('项目库/x.md', '# Hello\n\nworld');
    assert.match(p, /项目库\/x\.md/);
    assert.match(p, /wiki-source/);
    assert.match(p, /pending_review/);
    assert.match(p, /# Hello/);
    assert.match(p, /不要机械截断|禁止机械截断|写完整/);
  });

  it('extractWikiMarkdown strips fences', () => {
    const raw = '```markdown\n---\ntype: wiki-source\n---\n\n# T\n```';
    const md = extractWikiMarkdown(raw);
    assert.match(md, /^---/);
    assert.match(md, /# T/);
  });

  it('ensureWikiDocument forces pending_review and source_paths', () => {
    const doc = ensureWikiDocument('# Only body\n\n结论', {
      sourcePath: '手记/a.md',
      wikiStatus: 'pending_review',
      created: '2026-07-18',
    });
    assert.match(doc, /wiki_status: pending_review/);
    assert.match(doc, /source_paths: \["手记\/a\.md"\]/);
    assert.match(doc, /# Only body/);
  });

  it('setWikiStatus flips to accepted', () => {
    const doc = ensureWikiDocument('# X', {
      sourcePath: 's.md',
      wikiStatus: 'pending_review',
    });
    const done = setWikiStatus(doc, 'accepted');
    assert.match(done, /wiki_status: accepted/);
  });

  it('buildDigestPending documents accept/reject semantics', () => {
    const p = buildDigestPending({
      date: '2026-07-18',
      title: 't',
      wikiRel: 'agent-inbox/wiki/sources/x.md',
      sourcePath: '项目库/y.md',
      preview: '预览',
    });
    assert.match(p, /type: digest/);
    assert.match(p, /删除/);
    assert.match(p, /accepted/);
  });
});
