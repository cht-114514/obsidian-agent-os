import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseFences, serializeFences } from '../src/fence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, '../fixtures/sample-agent-reply.md'), 'utf8');

describe('parseFences', () => {
  it('parses golden fixture into thought/text/confirm/tool/attachment', () => {
    const blocks = parseFences(fixture);
    const types = blocks.map((b) => b.type);
    assert.deepEqual(types, ['thought', 'text', 'confirm', 'tool', 'attachment']);

    const thought = blocks.find((b) => b.type === 'thought');
    assert.match(thought.content, /可确认清单/);

    const text = blocks.find((b) => b.type === 'text');
    assert.match(text.content, /消化了你的笔记/);

    const confirm = blocks.find((b) => b.type === 'confirm');
    assert.equal(confirm.attrs.type, 'insight');
    assert.equal(
      confirm.attrs.path,
      'agent-inbox/soul/insights/drafts/2026-07-18-prefers-socratic.md'
    );
    assert.equal(confirm.meta.title, '偏好更新');
    assert.match(confirm.meta.body, /苏格拉底/);
    assert.ok(confirm.meta.actions.includes('accept'));

    const tool = blocks.find((b) => b.type === 'tool');
    assert.equal(tool.meta.name, 'Read');

    const att = blocks.find((b) => b.type === 'attachment');
    assert.equal(att.meta.path, 'agent-inbox/pending/2026-07-18-digest-demo.md');
  });

  it('round-trips thought+confirm via serializeFences → parseFences', () => {
    const original = parseFences(fixture);
    const again = parseFences(serializeFences(original));
    assert.equal(again.filter((b) => b.type === 'thought').length, 1);
    assert.equal(again.filter((b) => b.type === 'confirm').length, 1);
    assert.equal(
      again.find((b) => b.type === 'confirm').attrs.path,
      original.find((b) => b.type === 'confirm').attrs.path
    );
  });

  it('returns empty for blank input', () => {
    assert.deepEqual(parseFences(''), []);
    assert.deepEqual(parseFences('   \n'), []);
  });

  it('treats plain text without fences as single text block', () => {
    const blocks = parseFences('hello only');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
    assert.equal(blocks[0].content, 'hello only');
  });
});
