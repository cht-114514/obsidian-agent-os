import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderAgentMessage,
  composeWithRefs,
  formatSkillMenu,
  handleConfirmAccept,
  handleConfirmReject,
  filterPluginSafeWrites,
} from '../src/main.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(
  join(__dirname, '../../packages/protocol/fixtures/sample-agent-reply.md'),
  'utf8'
);

describe('plugin renderer', () => {
  it('renders thought and confirm from shipped parser path', () => {
    const { html, blocks } = renderAgentMessage(fixture, { quiet: false });
    assert.ok(blocks.some((b) => b.type === 'thought'));
    assert.ok(blocks.some((b) => b.type === 'confirm'));
    assert.match(html, /me-soul-thought/);
    assert.match(html, /me-soul-confirm/);
    assert.match(html, /偏好更新/);
  });

  it('quiet mode strips thought blocks', () => {
    const { blocks, html } = renderAgentMessage(fixture, { quiet: true });
    assert.equal(blocks.some((b) => b.type === 'thought'), false);
    assert.equal(html.includes('me-soul-thought'), false);
    assert.ok(blocks.some((b) => b.type === 'confirm'));
  });

  it('composeWithRefs attaches @ paths', () => {
    const msg = composeWithRefs('请消化', [
      { path: '手记/随记/a.md', excerpt: 'hello' },
    ]);
    assert.match(msg, /@手记\/随记\/a\.md/);
    assert.match(msg, /hello/);
  });

  it('formatSkillMenu lists me-digest', () => {
    const menu = formatSkillMenu(['me-digest', 'me-care-check']);
    assert.deepEqual(
      menu.map((m) => m.id),
      ['me-digest', 'me-care-check']
    );
  });

  it('renders memorized confirm with data-type for plugin embed wire', () => {
    const text = [
      ':::thought',
      '准备写入向量记忆。',
      ':::',
      '',
      ':::confirm type=memorized path=agent-inbox/wiki/vectors.jsonl',
      'title: 写入向量记忆库',
      'body: N 篇 wiki → vectors.jsonl',
      'actions: [accept, reject]',
      ':::',
    ].join('\n');
    const { html, blocks } = renderAgentMessage(text, { quiet: false });
    const conf = blocks.find((b) => b.type === 'confirm');
    assert.ok(conf);
    assert.equal(conf.attrs?.type || conf.meta?.type, 'memorized');
    assert.match(html, /data-type="memorized"/);
    assert.match(html, /data-path="agent-inbox\/wiki\/vectors\.jsonl"/);
  });
});

describe('plugin confirm actions', () => {
  const pending = `---
status: pending
type: digest
title: t
created: 2026-07-18
path: agent-inbox/wiki/x.md
source_paths: []
---

body
`;

  it('accept does not authorize silent human-zone writes', () => {
    const r = handleConfirmAccept(pending);
    assert.equal(r.ok, true);
    assert.match(r.markdown, /status: approved/);
    const human = filterPluginSafeWrites(['手记/日记/x.md', 'agent-inbox/pending/a.md']);
    assert.deepEqual(human.safe, ['agent-inbox/pending/a.md']);
    assert.equal(human.blocked.length, 1);
  });

  it('reject marks rejected', () => {
    const r = handleConfirmReject(pending);
    assert.equal(r.ok, true);
    assert.match(r.markdown, /status: rejected/);
  });
});
