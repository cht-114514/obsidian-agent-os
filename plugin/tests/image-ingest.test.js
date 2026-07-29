import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImagineRawBasename,
  embedWikilink,
  extractImagineImagePath,
  imagineToolName,
  isImagineTool,
  pathFromContentText,
  slugifyPrompt,
  uniqueRawPath,
} from '../src/image-ingest.js';

describe('image-ingest', () => {
  it('detects image_gen from ACP meta', () => {
    const u = {
      title: 'imagine: a tiny red circle',
      _meta: { 'x.ai/tool': { name: 'image_gen', kind: 'image_gen' } },
    };
    assert.equal(imagineToolName(u), 'image_gen');
    assert.equal(isImagineTool(u), true);
  });

  it('detects image_edit from rawOutput type', () => {
    const u = { rawOutput: { type: 'ImageEdit', path: '/tmp/x.jpg' } };
    assert.equal(imagineToolName(u), 'image_edit');
    assert.equal(isImagineTool(u), true);
  });

  it('extracts path from rawOutput (live ACP shape)', () => {
    const abs =
      '/Users/chen/.grok/sessions/%2FUsers%2Fchen%2FMe.Inc/019fa162/images/1.jpg';
    const u = {
      status: 'completed',
      rawOutput: {
        type: 'ImageGen',
        path: abs,
        filename: '1.jpg',
        session_folder: 'images',
      },
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: JSON.stringify({
              path: abs,
              filename: '1.jpg',
              message: 'Image generated and saved to ' + abs,
            }),
          },
        },
      ],
    };
    assert.equal(extractImagineImagePath(u), abs);
  });

  it('pathFromContentText parses JSON and regex fallback', () => {
    const abs = '/Users/chen/.grok/sessions/abc/images/2.png';
    assert.equal(pathFromContentText(JSON.stringify({ path: abs })), abs);
    assert.equal(
      pathFromContentText(`saved to ${abs}. Do not read it.`),
      abs
    );
  });

  it('builds raw basename and wikilink', () => {
    const name = buildImagineRawBasename('A Tiny Rocket!!', 0);
    assert.match(name, /imagine-a-tiny-rocket$/);
    assert.equal(embedWikilink('agent-inbox/raw/x.jpg'), '![[agent-inbox/raw/x.jpg]]');
    assert.equal(slugifyPrompt('你好 World'), '你好-world');
  });

  it('uniqueRawPath avoids collisions', () => {
    const existing = new Set(['agent-inbox/raw/foo.jpg']);
    const vault = {
      getAbstractFileByPath: (p) => (existing.has(p) ? {} : null),
    };
    assert.equal(uniqueRawPath(vault, 'foo', '.jpg'), 'agent-inbox/raw/foo-1.jpg');
  });
});
