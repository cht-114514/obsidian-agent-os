import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown, hashText, stripFrontmatter } from '../src/memory/chunk.js';
import { embedTexts } from '../src/memory/embedder.js';
import {
  cosine,
  parseVectorsJsonl,
  serializeVectorsJsonl,
  upsertPath,
  removePath,
  searchVectors,
  mergeHits,
  buildRowsForFile,
  planChunkEmbeds,
} from '../src/memory/vector-store.js';

describe('chunk', () => {
  it('strips frontmatter', () => {
    const md = '---\ntitle: t\n---\n\n# Hello\n\nbody';
    assert.equal(stripFrontmatter(md).includes('title:'), false);
    assert.ok(stripFrontmatter(md).includes('# Hello'));
  });

  it('chunks long markdown into multiple pieces', () => {
    const paras = Array.from({ length: 20 }, (_, i) => `段落${i}：${'内容'.repeat(40)}`).join(
      '\n\n'
    );
    const md = `---\ntitle: x\n---\n\n# 长文\n\n${paras}`;
    const chunks = chunkMarkdown(md, { path: 'agent-inbox/wiki/sources/a.md', targetChars: 200 });
    assert.ok(chunks.length >= 2);
    assert.ok(chunks.every((c) => c.hash && c.text));
    assert.notEqual(chunks[0].hash, chunks[1].hash);
  });

  it('hashText is stable', () => {
    assert.equal(hashText('abc'), hashText('abc'));
    assert.notEqual(hashText('abc'), hashText('abd'));
  });
});

describe('vector-store math', () => {
  it('cosine of identical unit vectors is ~1', () => {
    const v = [1, 0, 0];
    assert.ok(Math.abs(cosine(v, v) - 1) < 1e-9);
  });

  it('cosine of orthogonal is 0', () => {
    assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
  });

  it('searchVectors ranks nearest first', () => {
    const rows = [
      { path: 'a', model: 'bge-m3', embedding: [1, 0, 0], text: 'A' },
      { path: 'b', model: 'bge-m3', embedding: [0.9, 0.1, 0], text: 'B' },
      { path: 'c', model: 'bge-m3', embedding: [0, 1, 0], text: 'C' },
    ];
    const hits = searchVectors(rows, [1, 0, 0], { topK: 2, minScore: 0.1, model: 'bge-m3' });
    assert.equal(hits[0].row.path, 'a');
    assert.equal(hits.length, 2);
  });

  it('filters by model', () => {
    const rows = [
      { path: 'a', model: 'bge-m3', embedding: [1, 0], text: 'A' },
      { path: 'b', model: 'other', embedding: [1, 0], text: 'B' },
    ];
    const hits = searchVectors(rows, [1, 0], { topK: 5, minScore: 0.1, model: 'bge-m3' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].row.path, 'a');
  });

  it('jsonl roundtrip', () => {
    const rows = [{ path: 'p', embedding: [0.1, 0.2] }];
    const text = serializeVectorsJsonl(rows);
    assert.deepEqual(parseVectorsJsonl(text), rows);
  });

  it('upsert/remove path', () => {
    let rows = [
      { path: 'a', chunkIndex: 0 },
      { path: 'b', chunkIndex: 0 },
    ];
    rows = upsertPath(rows, 'a', [{ path: 'a', chunkIndex: 0 }, { path: 'a', chunkIndex: 1 }]);
    assert.equal(rows.filter((r) => r.path === 'a').length, 2);
    rows = removePath(rows, 'a');
    assert.equal(rows.every((r) => r.path === 'b'), true);
  });

  it('planChunkEmbeds reuses matching hash+model', () => {
    const chunks = [
      { index: 0, text: 't0', hash: 'h0' },
      { index: 1, text: 't1', hash: 'h1' },
    ];
    const existing = [
      { chunkIndex: 0, hash: 'h0', model: 'bge-m3', embedding: [1, 2] },
    ];
    const plan = planChunkEmbeds(existing, chunks, 'bge-m3');
    assert.deepEqual(plan[0].reuse, [1, 2]);
    assert.equal(plan[1].reuse, undefined);
  });

  it('buildRowsForFile attaches embeddings', () => {
    const rows = buildRowsForFile({
      path: 'p.md',
      title: 'T',
      model: 'bge-m3',
      chunks: [{ index: 0, text: 'hi', hash: 'x' }],
      embeddings: [[0.1, 0.2, 0.3]],
    });
    assert.equal(rows[0].dim, 3);
    assert.equal(rows[0].id, 'p.md#0');
  });

  it('mergeHits prefers hybrid score and dedupes path', () => {
    const keywordHits = [{ path: 'a.md', title: 'A', score: 10 }];
    const vectorHits = [
      { row: { path: 'a.md', title: 'A', text: 'chunk' }, score: 0.9 },
      { row: { path: 'b.md', title: 'B', text: 'other' }, score: 0.5 },
    ];
    const m = mergeHits(keywordHits, vectorHits, { topK: 3 });
    assert.ok(m.length >= 1);
    const a = m.find((x) => x.path === 'a.md');
    assert.ok(a);
    assert.ok(a.excerpt.includes('chunk') || a.source === 'hybrid' || a.source === 'vector');
  });
});

describe('embedder', () => {
  it('batches and maps OpenAI-shaped response', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      const input = calls[0].body.input;
      const n = Array.isArray(input) ? input.length : 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: Array.from({ length: n }, (_, i) => ({
              index: i,
              embedding: [i + 0.1, 0.2],
            })),
          };
        },
      };
    };
    const out = await embedTexts({
      baseUrl: 'https://www.dmxapi.cn/v1',
      apiKey: 'test-key',
      model: 'bge-m3',
      texts: ['a', 'b'],
      fetchImpl,
    });
    assert.equal(out.length, 2);
    assert.equal(out[0][0], 0.1);
    assert.ok(calls[0].url.endsWith('/embeddings'));
    assert.equal(calls[0].body.model, 'bge-m3');
  });

  it('throws without api key', async () => {
    await assert.rejects(
      () =>
        embedTexts({
          baseUrl: 'https://www.dmxapi.cn/v1',
          apiKey: '',
          model: 'bge-m3',
          texts: ['x'],
        }),
      /API Key/
    );
  });
});
