import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createActiveNoteState,
  onMarkdownFocus,
  setActiveNoteMode,
  getEffectiveActivePath,
  mergeActiveNoteChips,
  truncateNoteBody,
  formatContextSections,
  composeWithContext,
  resolveDigestSourcePath,
  resolveDigestSourceAfterMerge,
  looksLikeVaultPath,
  parseDigestIntent,
  collectMdPathsUnder,
  markdownPathFromLeaf,
  normalizeMdPath,
} from '../src/active-note.js';

describe('active-note modes', () => {
  it('follow updates when a new markdown path is reported', () => {
    let s = createActiveNoteState({ mode: 'follow' });
    s = onMarkdownFocus(s, '手记/a.md');
    assert.equal(getEffectiveActivePath(s), '手记/a.md');
    s = onMarkdownFocus(s, '项目库/b.md');
    assert.equal(getEffectiveActivePath(s), '项目库/b.md');
  });

  it('pin keeps pinned path when a different markdown path is reported', () => {
    let s = createActiveNoteState({ mode: 'follow', followedPath: '手记/a.md' });
    s = setActiveNoteMode(s, 'pin', { pinPath: '手记/a.md' });
    assert.equal(s.mode, 'pin');
    assert.equal(getEffectiveActivePath(s), '手记/a.md');
    s = onMarkdownFocus(s, '项目库/other.md');
    assert.equal(getEffectiveActivePath(s), '手记/a.md');
    assert.equal(s.followedPath, '手记/a.md'); // pin ignores updates to followed
  });

  it('off yields no active context path', () => {
    let s = createActiveNoteState({
      mode: 'follow',
      followedPath: '手记/a.md',
    });
    s = setActiveNoteMode(s, 'off');
    assert.equal(getEffectiveActivePath(s), null);
    s = onMarkdownFocus(s, '手记/b.md');
    assert.equal(getEffectiveActivePath(s), null);
  });

  it('null/agent leaf focus does not clear followed path', () => {
    let s = createActiveNoteState({ mode: 'follow', followedPath: '手记/a.md' });
    s = onMarkdownFocus(s, null);
    assert.equal(s.followedPath, '手记/a.md');
    assert.equal(markdownPathFromLeaf({ viewType: 'me-soul-chat', filePath: null }), null);
    assert.equal(
      markdownPathFromLeaf({ viewType: 'markdown', filePath: 'x.md' }),
      'x.md'
    );
  });
});

describe('active-note chips merge + compose', () => {
  it('same path as manual chip → single inclusion', () => {
    const merged = mergeActiveNoteChips(
      [{ path: '手记/a.md', kind: 'ref' }],
      '手记/a.md'
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].path, '手记/a.md');
  });

  it('different paths → both present; active first when new', () => {
    const merged = mergeActiveNoteChips(
      [{ path: 'wiki/b.md', kind: 'ref' }],
      '手记/a.md'
    );
    assert.equal(merged.length, 2);
    assert.equal(merged[0].kind, 'active');
    assert.equal(merged[0].path, '手记/a.md');
    assert.equal(merged[1].path, 'wiki/b.md');
  });

  it('off/null active → only manual chips', () => {
    assert.deepEqual(mergeActiveNoteChips([{ path: 'a.md' }], null), [
      { path: 'a.md' },
    ]);
  });

  it('formatContextSections labels active note and includes truncated body', () => {
    const long = 'X'.repeat(100);
    const section = formatContextSections(
      [{ path: '手记/a.md', kind: 'active', content: long }],
      { maxChars: 50 }
    );
    assert.match(section, /当前打开笔记（自动）/);
    assert.match(section, /手记\/a\.md/);
    assert.ok(section.includes('…') || section.length <= 200);
    assert.ok(section.length < long.length + 100);
  });

  it('composeWithContext attaches section after user text', () => {
    const out = composeWithContext('hello', [
      { path: 'n.md', kind: 'active', content: 'body text here' },
    ]);
    assert.match(out, /^hello\n\n## 附带上下文/);
    assert.match(out, /body text here/);
  });

  it('truncateNoteBody respects max', () => {
    const t = truncateNoteBody('abcdefghij', 8);
    assert.ok(t.length >= 8);
    assert.ok(t.includes('…') || t.length === 8);
  });
});

describe('digest source resolution', () => {
  it('empty chips + active note → digest source equals active path', () => {
    const src = resolveDigestSourcePath({
      chips: [],
      activePath: '手记/target.md',
      bodyText: '',
      useActiveForDigest: true,
    });
    assert.equal(src, '手记/target.md');
  });

  it('explicit chip wins over active', () => {
    const src = resolveDigestSourcePath({
      chips: [{ path: 'explicit.md', kind: 'ref' }],
      activePath: '手记/target.md',
      useActiveForDigest: true,
    });
    assert.equal(src, 'explicit.md');
  });

  it('useActiveForDigest false ignores active', () => {
    const src = resolveDigestSourcePath({
      chips: [],
      activePath: '手记/target.md',
      bodyText: '',
      useActiveForDigest: false,
    });
    assert.equal(src, '');
  });

  it('panel wiring: @B wins when active A pre-merged first', () => {
    // Mirrors chat-panel: buildSendChips = mergeActiveNoteChips(manual, active)
    const merged = mergeActiveNoteChips(
      [{ path: 'B.md', kind: 'ref' }],
      'A.md'
    );
    assert.equal(merged[0].kind, 'active');
    assert.equal(merged[0].path, 'A.md');
    const src = resolveDigestSourcePath({
      chips: merged,
      activePath: 'A.md',
      useActiveForDigest: true,
    });
    assert.equal(src, 'B.md');
  });

  it('panel wiring: useActiveForDigest false ignores pre-merged active chip', () => {
    const merged = mergeActiveNoteChips([], 'A.md');
    assert.equal(merged[0].kind, 'active');
    const src = resolveDigestSourcePath({
      chips: merged,
      activePath: 'A.md',
      useActiveForDigest: false,
    });
    assert.equal(src, '');
  });

  it('resolveDigestSourceAfterMerge matches panel digest rules', () => {
    assert.equal(
      resolveDigestSourceAfterMerge({
        manualChips: [{ path: 'B.md', kind: 'ref' }],
        activePath: 'A.md',
        useActiveForDigest: true,
      }),
      'B.md'
    );
    assert.equal(
      resolveDigestSourceAfterMerge({
        manualChips: [],
        activePath: 'A.md',
        useActiveForDigest: true,
      }),
      'A.md'
    );
    assert.equal(
      resolveDigestSourceAfterMerge({
        manualChips: [],
        activePath: 'A.md',
        useActiveForDigest: false,
      }),
      ''
    );
  });
});

describe('pin remount seed', () => {
  it('setActiveNoteMode pin with pinPath injects path even from empty follow', () => {
    let s = createActiveNoteState({ mode: 'follow' });
    s = setActiveNoteMode(s, 'pin', { pinPath: '手记/pinned.md' });
    assert.equal(getEffectiveActivePath(s), '手记/pinned.md');
    s = onMarkdownFocus(s, 'other.md');
    assert.equal(getEffectiveActivePath(s), '手记/pinned.md');
  });
});

describe('normalizeMdPath', () => {
  it('rejects non-md', () => {
    assert.equal(normalizeMdPath('a.png'), null);
    assert.equal(normalizeMdPath('a.md'), 'a.md');
  });
});

describe('digest path vs NL + batch intent', () => {
  it('does not treat Chinese instructions as vault paths', () => {
    assert.equal(looksLikeVaultPath('把我的所有日记文件消化一下'), false);
    assert.equal(
      resolveDigestSourcePath({
        chips: [],
        bodyText: '把我的所有日记文件消化一下',
        useActiveForDigest: false,
      }),
      ''
    );
  });

  it('accepts real paths', () => {
    assert.equal(looksLikeVaultPath('手记/日记/2026-07-01.md'), true);
    assert.equal(looksLikeVaultPath('note.md'), true);
  });

  it('parseDigestIntent detects all diaries', () => {
    const i = parseDigestIntent('把我的所有日记文件消化一下');
    assert.equal(i.type, 'folder-glob');
    assert.ok(i.folders.some((f) => f.includes('日记')));
  });

  it('collectMdPathsUnder lists via callback', () => {
    const paths = collectMdPathsUnder(
      ['手记/日记'],
      (folder) =>
        folder === '手记/日记'
          ? ['手记/日记/a.md', '手记/日记/README.md', '手记/日记/b.md']
          : [],
      { limit: 10 }
    );
    assert.deepEqual(paths, ['手记/日记/a.md', '手记/日记/b.md']);
  });
});
