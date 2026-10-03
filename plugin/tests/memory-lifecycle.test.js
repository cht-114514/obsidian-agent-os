import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFormationJson, normalizeFormationResult } from '../src/memory/formation-llm.js';
import { isForesightValid, recallFromRows, attachForesightFromCells } from '../src/memory/recall-pack.js';
import { appendExchange, isBufferStale } from '../src/memory/buffer-store.js';
import { buildTurnPrompt } from '../src/memory/inject.js';
import { formatMemCellMarkdown, parseMemCellMarkdown } from '../src/memory/cell-format.js';

describe('formation-llm', () => {
  it('parseFormationJson handles fenced JSON', () => {
    const r = parseFormationJson('```json\n{"action":"continue"}\n```');
    assert.equal(r.action, 'continue');
  });

  it('normalize close requires fields', () => {
    const r = normalizeFormationResult({
      action: 'close',
      episode: '用户讨论了数学复习计划。',
      facts: ['下周一模'],
      scene_title: '高考数学',
    });
    assert.equal(r.action, 'close');
    assert.equal(r.facts[0], '下周一模');
  });
});

describe('buffer-store', () => {
  it('isBufferStale after 6h', () => {
    const now = Date.now();
    const session = {
      turns: [{ role: 'user', text: 'hi', ts: now - 7 * 3600 * 1000 }],
      updatedAt: now,
    };
    assert.equal(isBufferStale(session, now), true);
  });

  it('appendExchange caps length', () => {
    let turns = [];
    for (let i = 0; i < 30; i++) {
      turns = appendExchange(turns, { role: 'user', text: `u${i}`, ts: i }, { role: 'assistant', text: `a${i}`, ts: i });
    }
    assert.ok(turns.length <= 24);
  });
});

describe('recall-pack', () => {
  it('filters expired foresight', () => {
    assert.equal(isForesightValid({ text: 'x', start: '2020-01-01', end: '2020-02-01' }, '2026-01-01'), false);
    assert.equal(isForesightValid({ text: 'x', start: '2026-01-01', end: '2027-01-01' }, '2026-06-01'), true);
  });

  it('recallFromRows returns fact hit', () => {
    const rows = [
      {
        id: 'c#fact-0',
        kind: 'fact',
        path: 'agent-inbox/wiki/memories/cells/a.md',
        text: '北京高考数学难度上升',
        model: 'm',
        embedding: [1, 0, 0],
        chunkIndex: 0,
        title: '数学',
        scene_slug: 'math',
      },
    ];
    const pack = recallFromRows(rows, '北京高考数学', [0.95, 0.05, 0], {
      embedModel: 'm',
      embedMinScore: 0.1,
      embedTopK: 3,
    });
    assert.ok(pack.facts.length >= 1);
  });

  it('attachForesightFromCells reads cell frontmatter', () => {
    const md = formatMemCellMarkdown({
      cellId: '2026-01-01-abc',
      sessionId: 's1',
      created: '2026-01-01T00:00:00Z',
      sceneSlug: 't',
      sceneTitle: 'T',
      episode: '叙事',
      facts: [],
      foresight: [{ text: '考试前少熬夜', start: '2026-01-01', end: '2027-01-01' }],
    });
    const cell = parseMemCellMarkdown(md);
    assert.equal(cell.foresight.length, 1);
    const pack = attachForesightFromCells(
      { scenes: [], episodes: [{ path: 'agent-inbox/wiki/memories/cells/a.md', title: 'a', excerpt: '', score: 1 }], facts: [], foresight: [], wiki: [] },
      { 'agent-inbox/wiki/memories/cells/a.md': md },
      '2026-06-01'
    );
    assert.equal(pack.foresight.length, 1);
  });
});

describe('inject memoryRecall', () => {
  it('buildTurnPrompt renders structured recall sections', () => {
    const p = buildTurnPrompt({
      identity: 'id',
      soul: 'soul',
      profile: 'prof',
      style: 'style',
      userMessage: '你好',
      memoryRecall: {
        scenes: [{ slug: 's', title: '场景A', excerpt: '摘要' }],
        facts: [{ path: 'c.md', excerpt: '事实一', title: 't' }],
        foresight: [{ path: 'c.md', text: '预判', start: '2026-01-01', end: '2027-01-01' }],
        wiki: [],
        episodes: [],
      },
    });
    assert.match(p, /主题场景/);
    assert.match(p, /原子事实/);
    assert.match(p, /未过期预判/);
  });
});
