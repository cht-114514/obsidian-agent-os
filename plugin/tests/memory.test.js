import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnPrompt, truncateText, loadSoulPack } from '../src/memory/inject.js';
import {
  tokenize,
  parseWikiIndex,
  serializeWikiIndex,
  retrieveWiki,
  shouldSkipRetrieve,
  entryFromWikiFile,
  upsertIndexItem,
  scoreItem,
} from '../src/memory/retrieve.js';

describe('inject', () => {
  it('buildTurnPrompt includes soul sections and user message', () => {
    const p = buildTurnPrompt({
      identity: '# ID\nObsidian Agent OS',
      soul: '# SOUL\n边界：不乱写四主区',
      profile: '# Profile\n偏好：先诊断',
      style: '# Style\n简洁',
      retrieved: [{ path: 'agent-inbox/wiki/sources/a.md', title: 'A', excerpt: '高考数学' }],
      userMessage: '北京高考数学难在哪？',
    });
    assert.match(p, /## IDENTITY/);
    assert.match(p, /## SOUL/);
    assert.match(p, /## PROFILE/);
    assert.match(p, /## STYLE/);
    assert.match(p, /相关记忆/);
    assert.match(p, /高考数学/);
    assert.match(p, /用户本轮消息/);
    assert.match(p, /北京高考数学难在哪/);
  });

  it('truncateText respects max', () => {
    const s = 'x'.repeat(100);
    assert.equal(truncateText(s, 50).length <= 50, true);
  });

  it('loadSoulPack missing files still returns keys', async () => {
    const pack = await loadSoulPack(async () => null);
    assert.equal(pack.identity, null);
    assert.equal(pack.soul, null);
  });
});

describe('retrieve', () => {
  it('retrieveWiki ranks title keyword hits', () => {
    const items = [
      {
        path: 'agent-inbox/wiki/sources/math.md',
        title: '2026北京高考数学难度',
        keywords: ['高考', '数学', '难度'],
        tags: [],
        wiki_status: 'accepted',
        updated: '2026-07-18',
      },
      {
        path: 'agent-inbox/wiki/sources/space.md',
        title: '航天笔记',
        keywords: ['航天', '火箭'],
        tags: [],
        wiki_status: 'accepted',
        updated: '2026-07-18',
      },
    ];
    const hits = retrieveWiki('北京高考数学到底难在哪', items, { topK: 2, minScore: 1 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].path, 'agent-inbox/wiki/sources/math.md');
  });

  it('shouldSkipRetrieve for trivial', () => {
    assert.equal(shouldSkipRetrieve('好'), true);
    assert.equal(shouldSkipRetrieve('北京高考数学'), false);
  });

  it('parse/serialize roundtrip', () => {
    const items = [
      {
        path: 'a.md',
        title: 'T',
        keywords: ['k1', 'k2'],
        tags: ['t'],
        wiki_status: 'accepted',
        updated: '2026-07-18',
      },
    ];
    const md = serializeWikiIndex(items);
    const again = parseWikiIndex(md);
    assert.equal(again.length, 1);
    assert.equal(again[0].path, 'a.md');
    assert.ok(again[0].keywords.includes('k1'));
  });

  it('entryFromWikiFile extracts title', () => {
    const e = entryFromWikiFile(
      'agent-inbox/wiki/sources/x.md',
      '---\nwiki_status: accepted\n---\n\n# Hello Title\n\nbody'
    );
    assert.equal(e.title, 'Hello Title');
    assert.equal(e.wiki_status, 'accepted');
  });
});
